/**
 * SWE-bench Lite harness (v3).
 *
 * Runs the v3 agent against SWE-bench Lite tasks (300-task Python bug-fix subset) and scores
 * pass@1 using the official test-patch evaluation method. Each task runs through the v3 CLI
 * one-shot `run` command with the full-access, non-interactive composition:
 *   - full access: permission mode `full` + `--workspace-grant read write exec`;
 *   - no ask-user: the `run` command excludes the interaction ToolBindings, so the agent
 *     never stalls on a human prompt during a task;
 *   - plain workspace backend ALWAYS (spec 069): `--workspace-backend plain` on every
 *     platform; the benchmark fails fast if the installed CLI lacks the flag.
 *
 * Usage:
 *   node scripts/swe-bench-harness.mjs [options]
 *
 * Options:
 *   --download       Fetch SWE-bench Lite test rows from HuggingFace to results/corpora
 *   --corpus <path>  Path to SWE-bench Lite JSONL corpus (default: results/corpora/swe-bench-lite.jsonl)
 *   --limit <n>      Run only the first N tasks
 *   --task <id>      Run a single task by instance ID
 *   --timeout <ms>   Per-task timeout in ms (default: 300000 = 5 min)
 *   --output <path>  Output results JSON path (default: results/swe-bench-results.json)
 *   --concurrency <n> Max parallel tasks (default: 1)
 *
 * Environment:
 *   Provider via BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY/BASE_URL/COMPATIBILITY_MODE, otherwise
 *   the CLI resolves `~/.best-agent/provider.json`, then dimcode OAuth.
 *
 * Corpus format (JSONL, one object per line):
 *   { "instance_id": "...", "repo": "...", "base_commit": "...", "problem_statement": "...",
 *     "test_patch": "...", "patch": "..." }
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { writeBenchmarkHistory, resolveCandidateId } from "./benchmark-history.mjs";
import { describeBenchmarkProvider } from "./benchmark-provider.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchmarksDir = resolve(repoRoot, "results");
const corporaDir = resolve(benchmarksDir, "corpora");
/** Supported SWE-bench datasets: lite (300, rule-filtered) and verified (500, human-verified). */
const DATASETS = Object.freeze({
  lite: {
    huggingface: "princeton-nlp/SWE-bench_Lite",
    label: "SWE-bench Lite",
    file: "swe-bench-lite.jsonl",
  },
  verified: {
    huggingface: "princeton-nlp/SWE-bench_Verified",
    label: "SWE-bench Verified",
    file: "swe-bench-verified.jsonl",
  },
});
const defaultCorpusPath = (dataset) => resolve(corporaDir, DATASETS[dataset].file);
const DEFAULTS = {
  concurrency: 1,
  dataset: "lite",
  corpusPath: undefined, // resolved from --dataset once parsed
  outputPath: resolve(benchmarksDir, "swe-bench-results.json"),
  taskTimeout: 300_000,
  backend: "plain",
  maxModelCycles: undefined,
  reasoningEffort: undefined,
};
const GIT_NETWORK_RETRY_ATTEMPTS = 3;
const GIT_NETWORK_RETRY_DELAY_MS = 1_000;
const FULL_ACCESS_GRANTS = ["read", "write", "exec"];
/** Bound on the persisted CLI stdout tail for per-task agent-trace diagnostics
 *  (tool-call sequence / model loops). Keeps fragment JSON bounded. */
const AGENT_TRACE_TAIL_BYTES = 100_000;
const traceEncoder = new TextEncoder();

/** Upstream-intermittent transport failures worth one automatic retry. */
function isRetryableTransportFailure(cliResult) {
  const err = String(cliResult.stderr ?? "");
  return (
    err.includes("must be passed back") ||
    err.includes("ECONNRESET") ||
    err.includes("Bad Gateway") ||
    err.includes("Cannot connect")
  );
}

function traceTail(stdout) {
  const text = String(stdout ?? "");
  if (traceEncoder.encode(text).byteLength <= AGENT_TRACE_TAIL_BYTES) {
    return { agentTrace: text, agentTraceBytes: text.length };
  }
  const sliced = text.slice(-AGENT_TRACE_TAIL_BYTES);
  return { agentTrace: sliced, agentTraceBytes: text.length, agentTraceTruncated: true };
}

/**
 * Resolves how to invoke the installed best-agent CLI:
 *   - npm JS package (@best-agent/cli/dist/index.js): node entry, spawn via process.execPath
 *   - local monorepo build (apps/cli/dist/index.js): node entry
 *   - native SEA binary (node_modules/.bin/best-agent): direct executable
 * Returns `{ prefix: string[] }` so the final invocation is `[...prefix, ...cliArgs]`.
 */
function resolveCliInvocation() {
  for (const entry of [
    resolve(repoRoot, "node_modules", "@best-agent", "cli", "dist", "index.js"),
    resolve(repoRoot, "apps", "cli", "dist", "index.js"),
  ]) {
    if (existsSync(entry)) return { prefix: [process.execPath, entry], kind: "node" };
  }
  const launcher = resolve(repoRoot, "node_modules", ".bin", "best-agent");
  if (existsSync(launcher)) return { prefix: [launcher], kind: "binary" };
  return undefined;
}

/** Probes whether the installed CLI accepts `--workspace-backend <backend>` (spec 069).
 *  Published releases before the plain-backend flag fail arg parsing with
 *  "Unsupported v3 run option: --workspace-backend."; newer releases parse the flag and then
 *  fail on provider resolution instead (a different error), so the probe never makes a model
 *  call and never spends tokens. */
async function cliSupportsWorkspaceBackend(invocation) {
  const probe = await runCliProcess({
    args: [...invocation.prefix, "run", "--workspace-backend", "plain", "probe"],
    cwd: tmpdir(),
    timeoutMs: 15_000,
    env: { ...process.env, BEST_AGENT_PROVIDER_KIND: "probe-does-not-resolve" },
  });
  const message = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  return !message.includes("Unsupported v3 run option: --workspace-backend");
}

/** Probes whether the installed CLI accepts `--max-model-cycles <n>` (same probe pattern:
 *  unsupported versions fail arg parsing before any provider resolution or model call). */
async function cliSupportsMaxModelCycles(invocation) {
  const probe = await runCliProcess({
    args: [...invocation.prefix, "run", "--max-model-cycles", "600", "probe"],
    cwd: tmpdir(),
    timeoutMs: 15_000,
    env: { ...process.env, BEST_AGENT_PROVIDER_KIND: "probe-does-not-resolve" },
  });
  const message = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  return !message.includes("Unsupported v3 run option: --max-model-cycles");
}

function parseArgs(argv) {
  const parsed = {
    ...DEFAULTS,
    download: false,
    limit: undefined,
    taskId: undefined,
    taskIds: undefined,
    offset: 0,
    shard: undefined,
    shardTotal: undefined,
    mergeShards: false,
    reevaluate: undefined,
    outputPathWasSet: false,
    tag: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--download":
        parsed.download = true;
        break;
      case "--reevaluate":
        parsed.reevaluate = argv[++i] ? resolve(argv[i]) : undefined;
        break;
      case "--corpus":
        parsed.corpusPath = resolve(argv[++i]);
        break;
      case "--dataset":
        parsed.dataset = argv[++i];
        if (!Object.hasOwn(DATASETS, parsed.dataset)) {
          throw new Error(`--dataset must be ${Object.keys(DATASETS).join(" or ")}.`);
        }
        break;
      case "--limit":
        parsed.limit = Number(argv[++i]);
        break;
      case "--task":
        parsed.taskId = argv[++i];
        break;
      case "--tasks":
        parsed.taskIds = String(argv[++i] ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--offset":
        parsed.offset = Number(argv[++i]);
        break;
      case "--shard":
        parsed.shard = Number(argv[++i]);
        break;
      case "--shard-total":
        parsed.shardTotal = Number(argv[++i]);
        break;
      case "--tag":
        parsed.tag = argv[++i];
        break;
      case "--merge-shards":
        parsed.mergeShards = true;
        break;
      case "--timeout":
        parsed.taskTimeout = Number(argv[++i]);
        break;
      case "--output":
        parsed.outputPath = resolve(argv[++i]);
        parsed.outputPathWasSet = true;
        break;
      case "--concurrency":
        parsed.concurrency = Number(argv[++i]);
        break;
      case "--backend":
        parsed.backend = argv[++i];
        if (!["sandbox", "plain"].includes(parsed.backend)) {
          throw new Error("--backend must be plain (default) or sandbox.");
        }
        break;
      case "--max-model-cycles":
        parsed.maxModelCycles = Number(argv[++i]);
        break;
      case "--reasoning-effort":
        parsed.reasoningEffort = argv[++i];
        if (!/^(low|medium|high|xhigh|max|none)$/u.test(String(parsed.reasoningEffort))) {
          throw new Error("--reasoning-effort must be low, medium, high, xhigh, max, or none.");
        }
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node scripts/swe-bench-harness.mjs [options]\n" +
            "  --download          fetch the corpus (default lite)\n" +
            "  --dataset <name>    lite (300) | verified (500); default lite\n" +
            "  --corpus <path>     corpus JSONL (default results/corpora/swe-bench-<dataset>.jsonl)\n" +
            "  --limit <n>         run the first n tasks (0 = all)\n" +
            "  --offset <n>        skip the first n tasks\n" +
            "  --shard <i> --shard-total <n>   run tasks where index % n == i (parallel shards)\n" +
            "  --merge-shards      combine swe-bench-results.shard-*.json into the aggregate report\n" +
            "  --task <id>         run one task by instance id\n" +
            "  --tasks <id,id,...>  run exactly the listed instance ids (skip already-verified tasks)\n" +
            "  --timeout <ms>      per-task timeout (default 300000)\n" +
            "  --concurrency <n>   parallel tasks (default 1)\n" +
            "  --backend <mode>    plain (default) or sandbox. Benchmarks are ONLY comparable\n" +
            "                       under plain (spec 069); sandbox is a macOS-only dev override\n" +
            "                       and fails on the installed CLI lacking --workspace-backend\n" +
            "  --max-model-cycles <n>  anti-runaway model-cycle cap; auto when omitted (600 when\n" +
            "                       the installed CLI supports --max-model-cycles, else CLI default)\n" +
            "  --reasoning-effort <e>  low|medium|high|xhigh|max|none (default: model catalog, e.g.\n" +
            "                       deepseek-v4-flash -> high). Requires a CLI that carries the\n" +
            "                       provider file's reasoningEffort in `run`.\n" +
            "  --output <path>     results JSON path (default results/swe-bench-results.json)\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (parsed.corpusPath === undefined) {
    parsed.corpusPath = defaultCorpusPath(parsed.dataset);
  }
  if (argsShardInvalid(parsed)) {
    throw new Error("--shard requires --shard-total; --shard must be 0 <= shard < shard-total.");
  }
  return parsed;
}

function argsShardInvalid(parsed) {
  const hasShard = parsed.shard !== undefined;
  const hasShardTotal = parsed.shardTotal !== undefined;
  if (hasShard !== hasShardTotal) return true;
  if (!hasShard) return false;
  return (
    !Number.isInteger(parsed.shard) ||
    !Number.isInteger(parsed.shardTotal) ||
    parsed.shardTotal <= 0 ||
    parsed.shard < 0 ||
    parsed.shard >= parsed.shardTotal
  );
}

async function main() {
  mkdirSync(benchmarksDir, { recursive: true });
  mkdirSync(corporaDir, { recursive: true });

  const args = parseArgs(process.argv.slice(2));

  if (args.download) {
    await downloadCorpus(args.dataset);
    return;
  }

  if (args.mergeShards) {
    mergeShardReports(args.outputPath);
    return;
  }

  if (args.reevaluate) {
    await runReevaluate({
      fragmentDir: args.reevaluate,
      corpusPath: args.corpusPath,
      concurrency: args.concurrency,
      outputPath: args.outputPath,
    });
    return;
  }

  const cliInvocation = resolveCliInvocation();
  if (!cliInvocation) {
    throw new Error(
      "No best-agent CLI found. Run `npm install` (installs @best-agent/cli) or build the monorepo CLI first.",
    );
  }

  // Backend: the benchmark environment is ALWAYS `--workspace-backend plain` (spec 069),
  // on every platform. There is no sandbox fallback — a run that silently used a different
  // workspace backend would not be comparable. If the installed CLI predates the flag, fail
  // fast before spending any task time or tokens.
  const backendSupported = await cliSupportsWorkspaceBackend(cliInvocation);
  const maxCyclesSupported = await cliSupportsMaxModelCycles(cliInvocation);
  if (args.backend === "plain" && !backendSupported) {
    throw new Error(
      "--backend plain (default) requested but the installed CLI does not support " +
        "--workspace-backend (spec 069). Install/publish a newer @best-agent/cli that ships the flag.",
    );
  }
  const maxModelCycles = args.maxModelCycles ?? (maxCyclesSupported ? 600 : undefined);
  // Optional explicit reasoning effort: write a temp provider config (env/effective config
  // + effort) and point BEST_AGENT_PROVIDER_CONFIG at it. Requires the CLI to carry
  // reasoningEffort from the provider file in `run` (the v3-run.ts passthrough).
  let providerConfigOverride;
  if (args.reasoningEffort !== undefined) {
    providerConfigOverride = writeProviderConfigWithEffort(args.reasoningEffort);
    process.stderr.write(
      `note: reasoning effort ${args.reasoningEffort} injected via ${providerConfigOverride}\n`,
    );
  }
  const runOptions = {
    invocation: cliInvocation,
    backend: args.backend,
    maxModelCycles,
    providerConfigOverride,
  };

  if (!existsSync(args.corpusPath)) {
    process.stderr.write(`Corpus not found at ${args.corpusPath}\n`);
    process.stderr.write("Run with --download to fetch SWE-bench Lite from HuggingFace.\n");
    process.exit(1);
  }

  const allTasks = loadCorpus(args.corpusPath);
  let tasks = allTasks;

  if (args.taskId) {
    tasks = allTasks.filter((t) => t.instance_id === args.taskId);
    if (tasks.length === 0) {
      process.stderr.write(`Task ${args.taskId} not found in corpus.\n`);
      process.exit(1);
    }
  } else if (args.taskIds && args.taskIds.length > 0) {
    const wanted = new Set(args.taskIds);
    tasks = allTasks.filter((t) => wanted.has(t.instance_id));
    const missing = args.taskIds.filter((id) => !tasks.some((t) => t.instance_id === id));
    if (missing.length > 0) {
      process.stderr.write(`Tasks not found in corpus: ${missing.join(", ")}\n`);
      process.exit(1);
    }
    if (args.shard !== undefined) {
      tasks = tasks.filter((_, index) => index % args.shardTotal === args.shard);
    }
  } else {
    // Order: offset -> limit -> shard. `limit` bounds the total batch BEFORE sharding, so
    // sequential batches (offset/limit) can each be split across parallel shard jobs and
    // cover disjoint, contiguous corpus slices (e.g. offset=0/limit=125, then offset=125).
    // Shards use index % shardTotal so parallel CI jobs each cover a disjoint, evenly
    // distributed subset of the batch.
    if (args.offset) tasks = tasks.slice(args.offset);
    if (args.limit) tasks = tasks.slice(0, args.limit);
    if (args.shard !== undefined) {
      tasks = tasks.filter((_, index) => index % args.shardTotal === args.shard);
    }
  }

  // Model/shard runs write to tagged/shard-specific files so parallel CI jobs never
  // overwrite each other; --merge-shards combines them into the aggregate report.
  if (args.tag && !args.outputPathWasSet) {
    args.outputPath = args.outputPath.replace(/\.json$/u, `.${sanitize(args.tag)}.json`);
  }
  if (args.shard !== undefined && !args.outputPathWasSet) {
    args.outputPath = args.outputPath.replace(/\.json$/u, `.shard-${args.shard}.json`);
  }

  process.stdout.write(`SWE-bench Lite (v3): running ${tasks.length} / ${allTasks.length} tasks\n`);

  const results = [];
  const startTime = performance.now();

  for (let i = 0; i < tasks.length; i += args.concurrency) {
    const batch = tasks.slice(i, i + args.concurrency);
    // Each task is fully isolated (clone → agent → eval in its own temp dir). Wrap every
    // task so an unexpected rejection in one task can never abort the rest of the batch or
    // the whole CI job — the run must complete all scheduled tasks and produce a report.
    const batchResults = await Promise.all(
      batch.map((task) => runTaskSafe(task, args.taskTimeout, runOptions)),
    );
    results.push(...batchResults);

    const solved = results.filter((r) => r.resolved).length;
    process.stderr.write(
      `progress> ${results.length}/${tasks.length} complete, ${solved} resolved (${ratio(solved, results.length)} pass@1)\n`,
    );
  }

  const wallMs = performance.now() - startTime;
  const resolved = results.filter((r) => r.resolved).length;
  const errored = results.filter((r) => r.error || r.evaluationError).length;
  const environmentBlocked = results.filter((r) => r.environmentBlocked).length;
  const timedOut = results.filter((r) => r.timedOut).length;
  const relayOverloaded = results.filter((r) => r.failureKind === "relay-overloaded").length;

  const report = {
    benchmark: "swe-bench-lite",
    candidateId: resolveCandidateId(repoRoot, ["SWE_BENCH_CANDIDATE_ID"]),
    generatedAt: new Date().toISOString(),
    provider: describeBenchmarkProvider(),
    composition: {
      fullAccess: true,
      permissionMode: "full",
      interactionTools: false,
      workspaceBackend: runOptions.backend,
      maxModelCycles: runOptions.maxModelCycles ?? "cli-default",
      ...(runOptions.providerConfigOverride === undefined
        ? {}
        : { reasoningEffort: args.reasoningEffort }),
      taskTimeoutMs: args.taskTimeout,
      ...(args.shard !== undefined ? { shard: args.shard, shardTotal: args.shardTotal } : {}),
    },
    corpus: {
      path: args.corpusPath,
      dataset: args.dataset,
      label: DATASETS[args.dataset].label,
      totalTasks: allTasks.length,
      tasksRun: tasks.length,
    },
    summary: {
      resolved,
      errored,
      environmentBlocked,
      timedOut,
      relayOverloaded,
      passAt1: ratio(resolved, tasks.length),
      wallMs: Number(wallMs.toFixed(1)),
      avgTaskMs: Number((wallMs / tasks.length).toFixed(1)),
    },
    byRepo: computeByRepo(results),
    tasks: results,
  };

  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const markdownText = renderMarkdown(report);
  const markdownPath = args.outputPath.replace(/\.json$/u, ".md");
  writeFileSync(args.outputPath, jsonText);
  writeFileSync(markdownPath, markdownText);

  writeBenchmarkHistory({
    benchmarksDir,
    candidateId: report.candidateId,
    family: "swe-bench",
    generatedAt: report.generatedAt,
    jsonText,
    markdownText,
  });

  process.stdout.write(jsonText);
  process.stdout.write(`wrote> ${args.outputPath}\n`);
  process.stdout.write(`wrote> ${markdownPath}\n`);
}

/** Combines `swe-bench-results.shard-*.json` / `swe-bench-results-<model>.json` fragments
 *  into one aggregate report. Fragments are matched by a prefix derived from the output
 *  path, so model and shard matrices never clobber the aggregate. */
function mergeShardReports(outputPath) {
  const outputDir = dirname(outputPath);
  const outputBase = basename(outputPath, ".json");
  const fragments = readdirSync(outputDir)
    .filter(
      (entry) =>
        entry.endsWith(".json") &&
        entry.startsWith(`${outputBase}.`) &&
        entry !== `${outputBase}.json`,
    )
    .sort();
  if (fragments.length === 0) {
    process.stderr.write(`merge-shards: no fragment files found for ${outputBase}.*.json\n`);
    process.exit(1);
  }

  const reports = [];
  for (const entry of fragments) {
    try {
      reports.push(JSON.parse(readFileSync(resolve(outputDir, entry), "utf8")));
    } catch (error) {
      process.stderr.write(
        `merge-shards: cannot read fragment ${entry}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (reports.length === 0) {
    process.stderr.write("merge-shards: no readable fragments.\n");
    process.exit(1);
  }

  const tasks = reports.flatMap((report) => report.tasks ?? []);
  const resolved = tasks.filter((task) => task.resolved).length;
  const errored = tasks.filter((task) => task.error || task.evaluationError).length;
  const environmentBlocked = tasks.filter((task) => task.environmentBlocked).length;
  const timedOut = tasks.filter((task) => task.timedOut).length;
  const relayOverloaded = tasks.filter((task) => task.failureKind === "relay-overloaded").length;
  const byModel = {};
  for (const report of reports) {
    const key = `${report.provider?.kind ?? "?"}/${report.provider?.model ?? "?"}`;
    byModel[key] ??= { resolved: 0, total: 0 };
    byModel[key].total += (report.tasks ?? []).length;
    byModel[key].resolved += (report.tasks ?? []).filter((task) => task.resolved).length;
  }

  const aggregate = {
    benchmark: "swe-bench-lite",
    candidateId: reports[0]?.candidateId ?? "workspace",
    generatedAt: new Date().toISOString(),
    mergedFrom: fragments,
    composition: {
      fullAccess: true,
      permissionMode: "full",
      interactionTools: false,
      fragments: reports.length,
    },
    corpus: {
      totalTasks: reports.reduce((sum, report) => sum + (report.corpus?.totalTasks ?? 0), 0),
      tasksRun: tasks.length,
    },
    byModel,
    byRepo: computeByRepo(tasks),
    summary: {
      resolved,
      errored,
      environmentBlocked,
      timedOut,
      relayOverloaded,
      passAt1: ratio(resolved, tasks.length),
      avgTaskMs: Number(
        (
          tasks.reduce((sum, task) => sum + (task.wallMs ?? 0), 0) / Math.max(tasks.length, 1)
        ).toFixed(1),
      ),
      wallMs: Number(
        reports.reduce((sum, report) => sum + (report.summary?.wallMs ?? 0), 0).toFixed(1),
      ),
    },
    tasks,
  };

  const jsonText = `${JSON.stringify(aggregate, null, 2)}\n`;
  const markdownText = renderMarkdown(aggregate);
  const jsonPath = resolve(outputDir, `${outputBase}.json`);
  const markdownPath = resolve(outputDir, `${outputBase}.md`);
  writeFileSync(jsonPath, jsonText);
  writeFileSync(markdownPath, markdownText);

  writeBenchmarkHistory({
    benchmarksDir,
    candidateId: aggregate.candidateId,
    family: "swe-bench",
    generatedAt: aggregate.generatedAt,
    jsonText,
    markdownText,
  });

  process.stdout.write(jsonText);
  process.stdout.write(`wrote> ${jsonPath}\n`);
  process.stdout.write(`wrote> ${markdownPath}\n`);
}

async function runTask(task, timeoutMs, runOptions) {
  const { invocation, backend, maxModelCycles } = runOptions;
  const taskDir = mkdtempSync(`${tmpdir()}/swe-bench-${sanitize(task.instance_id)}-`);
  const startMs = performance.now();
  try {
    // Clone the repo at the base commit (shallow).
    const cloneResult = await runGitNetworkCommand({
      args: ["clone", "--depth", "1", `https://github.com/${task.repo}.git`, "repo"],
      cwd: taskDir,
    });
    if (cloneResult.status !== 0) {
      return taskResult(task, startMs, {
        error: `Clone failed: ${describeGitFailure(cloneResult)}`,
      });
    }

    const repoDir = resolve(taskDir, "repo");
    if (task.base_commit) {
      const fetchResult = await runGitNetworkCommand({
        args: ["fetch", "--depth", "1", "origin", task.base_commit],
        cwd: repoDir,
      });
      if (fetchResult.status === 0) {
        spawnSync("git", ["checkout", task.base_commit], { cwd: repoDir, encoding: "utf8" });
      }
    }

    // Build the prompt from the issue description.
    const prompt = [
      "You are fixing a bug in a Python repository. Here is the issue description:",
      "",
      task.problem_statement,
      "",
      ...(task.hints_text && task.hints_text.trim().length > 0
        ? [
            "Additional hints from the issue thread:",
            task.hints_text.trim(),
            "",
          ]
        : []),
      "Use the issue description above as the full problem statement. Make reasonable assumptions and continue.",
      "You have these workspace tools available: read, write, edit, search, stat, list, mkdir, remove, exec, apply_patch.",
      "Use the exact tool names above to inspect the repository and edit the necessary source files. Do not modify test files.",
      "You have no web access: do not call web_search, web_fetch, or any other web tool. Solve the bug by reading the repository code directly and applying the fix yourself.",
      "You MUST actually edit the source files with the write/edit/apply_patch tools — never respond with only a textual description of the fix. Inspect the code, apply the minimal correct change, then verify it.",
      "Verification: after editing, run the relevant EXISTING tests in the repository (e.g. `python tests/runtests.py <related_module>` for Django, or pytest for other repos) to confirm your change works and does not break related behavior. If the repository needs dependencies first, install them with pip. A fix that only looks right but breaks existing tests is wrong.",
      "After making your changes, explain what you changed and why.",
    ].join("\n");

    // Run the v3 CLI one-shot `run` with the task repo as the workspace, full access grants,
    // and no interaction tools (the `run` command excludes ask_user/tool_approve).
    //
    // The agent runs FIRST on the clean base-commit checkout: creating the evaluation venv
    // before the agent would pollute the workspace (`.swe-bench-venv/` etc.) and destabilize
    // the model's tool use. Test-environment setup happens after the agent's diff is captured.
    const cliArgs = [
      "run",
      "--workspace",
      repoDir,
      // SWE-bench tasks on complex repos (astropy) routinely need hundreds of model cycles;
      // raise the anti-runaway guard well above the CLI default of 200 so a hard task is not
      // killed at max-model-cycles before the agent finishes editing. Skipped when the
      // installed CLI predates the flag (CLI default 200 applies).
      ...(maxModelCycles === undefined ? [] : ["--max-model-cycles", String(maxModelCycles)]),
      ...FULL_ACCESS_GRANTS.flatMap((grant) => ["--workspace-grant", grant]),
      // Spec 069: benchmark plain workspace backend — the sandbox (Seatbelt) is
      // macOS-only and unusable on Linux CI; benchmark workspaces are disposable
      // repo clones on ephemeral runners, so OS-level containment is unnecessary.
      // Skipped when the installed CLI predates the flag (sandbox backend applies,
      // macOS runners only).
      ...(backend === "plain" ? ["--workspace-backend", "plain"] : []),
      prompt,
    ];
    let cliResult = await runCliProcess({
      // Run through the resolved CLI invocation (node JS entry or native binary).
      args: [...invocation.prefix, ...cliArgs],
      cwd: repoDir,
      timeoutMs,
      env: {
        ...process.env,
        // Align the plan run-duration cap with the harness per-task timeout.
        BEST_AGENT_PROVIDER_TIMEOUT_MS: String(timeoutMs),
        // Optional wire-level request dump for the reasoning_content 400 investigation.
        ...(process.env.DEBUG_PROMPTS === "1"
          ? { BEST_AGENT_DEBUG_PROMPTS: "1" }
          : {}),
        // Explicit reasoning effort override via a temp provider config file.
        ...(runOptions.providerConfigOverride === undefined
          ? {}
          : { BEST_AGENT_PROVIDER_CONFIG: runOptions.providerConfigOverride }),
      },
    });
    if (cliResult.timedOut) {
      return taskResult(task, startMs, { timedOut: true });
    }

    // One automatic task-level retry for upstream-intermittent transport failures
    // (dimcode relay / provider): reasoning_content pass-back 400s, ECONNRESET and
    // Bad Gateway are upstream instabilities, not agent behavior. The workspace is
    // reset to the base commit so the retry starts fully clean.
    let retriedTransport = false;
    if (cliResult.status !== 0 && isRetryableTransportFailure(cliResult)) {
      process.stderr.write(
        `retry> ${task.instance_id} failed with upstream transport error; retrying once after workspace reset\n`,
      );
      spawnSync("git", ["checkout", "--", "."], { cwd: repoDir, encoding: "utf8" });
      spawnSync("git", ["clean", "-fd"], { cwd: repoDir, encoding: "utf8" });
      const retriedCliResult = await runCliProcess({
        args: [...invocation.prefix, ...cliArgs],
        cwd: repoDir,
        timeoutMs,
        env: {
          ...process.env,
          BEST_AGENT_PROVIDER_TIMEOUT_MS: String(timeoutMs),
          ...(process.env.DEBUG_PROMPTS === "1" ? { BEST_AGENT_DEBUG_PROMPTS: "1" } : {}),
          ...(runOptions.providerConfigOverride === undefined
            ? {}
            : { BEST_AGENT_PROVIDER_CONFIG: runOptions.providerConfigOverride }),
        },
      });
      if (!retriedCliResult.timedOut) {
        cliResult = retriedCliResult;
        retriedTransport = true;
      }
    }

    // Capture the diff the agent produced.
    const diffResult = spawnSync("git", ["diff"], { cwd: repoDir, encoding: "utf8" });
    const agentPatch = diffResult.stdout ?? "";
    if (!agentPatch.trim()) {
      // Record what the model actually "answered" (the CLI prints the final assistant text
      // to stdout on a completed run) so a no-diff completion is diagnosable: did the model
      // give a textual fix, claim it edited, or stop for another reason?
      const finalAnswer = (cliResult.stdout ?? "").trim().slice(-1500);
      return taskResult(task, startMs, {
        error: "Agent produced no diff",
        cliExitCode: cliResult.status,
        ...(finalAnswer.length === 0 ? {} : { finalAnswer }),
        // Keep the full stderr so provider/tool diagnostics (model-failure detail, tool
        // closure) are preserved for investigation.
        cliError: (cliResult.stderr ?? "").trim().slice(-2000),
        ...traceTail(cliResult.stdout),
      });
    }

    // Test-environment setup and test-patch evaluation run only after the agent finished.
    const evaluationEnvironment = prepareEvaluationEnvironment(repoDir, task);
    if (!evaluationEnvironment.ready) {
      return taskResult(task, startMs, {
        environmentBlocked: true,
        environmentError: evaluationEnvironment.error,
        // Keep the agent's diff even when the evaluation environment fails, so an
        // env-blocked run is still salvageable offline once the environment is fixed.
        patchLines: agentPatch.split("\n").length,
        agentPatch:
          agentPatch.length > 10_000
            ? agentPatch.slice(0, 10_000) + "\n... (truncated)"
            : agentPatch,
        ...traceTail(cliResult.stdout),
      });
    }

    // Apply test patch and run tests.
    const evaluation = await evaluateWithTestPatch(
      repoDir,
      task,
      evaluationEnvironment.pythonCommand,
    );
    const matchedReferencePatch =
      Boolean(task.patch) && normalizePatch(agentPatch) === normalizePatch(task.patch);
    const resolved = evaluation.resolved;

    return taskResult(task, startMs, {
      resolved,
      ...(retriedTransport ? { retriedTransport: true } : {}),
      patchLines: agentPatch.split("\n").length,
      agentPatch:
        agentPatch.length > 10_000 ? agentPatch.slice(0, 10_000) + "\n... (truncated)" : agentPatch,
      ...traceTail(cliResult.stdout),
      // The CLI prints one diagnostic line per tool call/closure to stderr; keep the
      // tail so the agent's tool-call sequence is diagnosable on failed runs too.
      cliStderrTail: (cliResult.stderr ?? "").trim().slice(-2_000),
      ...(evaluation.error ? { evaluationError: evaluation.error } : {}),
      ...(evaluation.method ? { verification: evaluation.method } : {}),
      ...(evaluation.failToPassCount !== undefined
        ? { failToPassCount: evaluation.failToPassCount }
        : {}),
      ...(matchedReferencePatch && !evaluation.resolved
        ? { verification: "reference-patch-match" }
        : {}),
    });
  } catch (error) {
    return taskResult(task, startMs, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
}

/** Runs the CLI as a detached process group so a per-task timeout can kill the whole tree.
 *  spawnSync's timeout only signals the direct child; the CLI's sandbox grandchildren can
 *  keep the stdio pipe open and delay the return for a second full timeout (observed ~2x).
 *  Returns an async equivalent of the spawnSync result plus a timedOut flag. */
function runCliProcess({ args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        // Kill the whole process group (negative pid) so sandbox grandchildren die too.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      // The child may need a moment to die; resolve the timeout promptly regardless.
      settle({ status: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      settle({ status: null, signal: null, stdout, stderr, timedOut: false, error });
    });
    child.on("close", (code, signal) => {
      settle({ status: code, signal, stdout, stderr, timedOut: false });
    });
  });
}

/** Catastrophic-failure wrapper: an unexpected throw inside runTask must still produce a
 *  per-task record instead of rejecting the batch (which would abort the whole CI job). */
async function runTaskSafe(task, timeoutMs, runOptions) {
  try {
    return await runTask(task, timeoutMs, runOptions);
  } catch (error) {
    return taskResult(task, performance.now(), {
      error: `Harness failure: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function runGitNetworkCommand({ args, cwd }) {
  let lastResult;
  for (let attempt = 1; attempt <= GIT_NETWORK_RETRY_ATTEMPTS; attempt += 1) {
    lastResult = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
    if (lastResult.status === 0) return lastResult;
    if (!isRetryableGitNetworkFailure(lastResult) || attempt === GIT_NETWORK_RETRY_ATTEMPTS) {
      return lastResult;
    }
    await delay(GIT_NETWORK_RETRY_DELAY_MS * attempt);
  }
  return lastResult;
}

function isRetryableGitNetworkFailure(result) {
  const output = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  return /connection reset by peer|recv failure|remote end hung up unexpectedly|could not resolve host|failed to connect|connection timed out|operation timed out|tls connection was non-properly terminated|http\/2 stream/i.test(
    output,
  );
}

function describeGitFailure(result) {
  return `${result?.stderr ?? ""}${result?.stdout ?? ""}`.slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prepareEvaluationEnvironment(repoDir, corpusTask) {
  const venvDir = resolve(repoDir, ".swe-bench-venv");
  const pythonCommand = resolvePythonCommand(corpusTask);
  const createVenvResult = spawnSync(pythonCommand, ["-m", "venv", venvDir], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (createVenvResult.status !== 0) {
    return {
      ready: false,
      error: summarizeCommandFailure(`${pythonCommand} -m venv ${venvDir}`, createVenvResult),
    };
  }

  const venvPython = resolve(venvDir, "bin", "python");
  const installPytestResult = spawnSync(venvPython, ["-m", "pip", "install", "pytest"], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (installPytestResult.status !== 0) {
    return {
      ready: false,
      error: summarizeCommandFailure(`${venvPython} -m pip install pytest`, installPytestResult),
    };
  }

  // When the repo pins its runtime dependencies in a requirements file, install those pins
  // first so old-era SWE-bench tasks (e.g. flask 1.1 needing werkzeug<2) evaluate against the
  // intended dependency versions instead of today's latest.
  const requirementsPaths = ["requirements.txt", "dev-requirements.txt", "requirements-dev.txt"];
  for (const requirementsPath of requirementsPaths) {
    if (!existsSync(resolve(repoDir, requirementsPath))) continue;
    const installRequirementsResult = spawnSync(
      venvPython,
      ["-m", "pip", "install", "-r", requirementsPath],
      { cwd: repoDir, encoding: "utf8", timeout: 180_000 },
    );
    // A requirements file that cannot install is not fatal: the editable project install may
    // still succeed, and pytest can still exercise the changed files.
    if (installRequirementsResult.status !== 0) {
      process.stderr.write(
        `warn> requirements install failed for ${requirementsPath}: ${summarizeCommandFailure(
          `${venvPython} -m pip install -r ${requirementsPath}`,
          installRequirementsResult,
        )}\n`,
      );
    }
  }

  const installProjectResult = installEditableProject(repoDir, venvPython);
  if (!installProjectResult.ready) {
    return { ready: false, error: installProjectResult.error };
  }

  return { ready: true, pythonCommand: venvPython };
}

/** Lightweight extraction of `[build-system] requires` from pyproject.toml.
 *  Returns the quoted dependency strings, or undefined when the section is
 *  absent/malformed. Used to install build deps before `--no-build-isolation`
 *  so old-era repos (astropy et al.) can build without the modern isolated
 *  build env that breaks their setup.py. */
function pyprojectBuildRequires(repoDir) {
  const path = resolve(repoDir, "pyproject.toml");
  if (!existsSync(path)) return undefined;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const sectionMatch = text.match(/\[build-system\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return undefined;
  const section = sectionMatch[1];
  const requiresMatch = section.match(/requires\s*=\s*\[([\s\S]*?)\]/);
  if (!requiresMatch) return undefined;
  const requires = [...requiresMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return requires.length > 0 ? requires : undefined;
}

function installEditableProject(repoDir, venvPython) {
  const command = `${venvPython} -m pip install -e .`;
  const args = ["-m", "pip", "install", "-e", "."];
  const installResult = spawnSync(venvPython, args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (installResult.status === 0) return { ready: true };

  // Old-era repos (2020-2023 SWE-bench) often fail under modern build isolation because the
  // isolated build env pulls the latest setuptools, which breaks their setup.py. Fall back to
  // --no-build-isolation with a pinned legacy setuptools installed into the venv first, plus
  // the repo's declared [build-system] requires (e.g. astropy needs extension_helpers), since
  // --no-build-isolation does not auto-install build dependencies.
  const constraintsPath = resolve(dirname(dirname(venvPython)), "swe-bench-build-constraints.txt");
  // Verified combo (python3.10, metadata stage passes, astropy 12907):
  // setuptools 66.1.1 + setuptools_scm 7.1.0 + vcs_versioning 2.x + oldest-supported-numpy.
  // setuptools < 58 removed `ignore_egg_info_in_manifest`, >= 68 removed
  // `setuptools.dep_util`; setuptools_scm >= 8 pulls vcs_versioning whose older
  // egg_info integration breaks on modern setuptools. Pin both, not just < 68.
  writeFileSync(constraintsPath, "setuptools==66.1.1\nsetuptools_scm==7.1.0\n");
  const installLegacyResult = spawnSync(
    venvPython,
    // numpy<2: astropy-era (2019) setup.py compiles C extensions directly against
    // whatever numpy is installed; numpy 2.x breaks those builds
    // (numpy_2_0_migration_guide "copy" keyword, observed on astropy-7336).
    ["-m", "pip", "install", "setuptools==66.1.1", "setuptools_scm==7.1.0", "wheel", "numpy<2"],
    { cwd: repoDir, encoding: "utf8", timeout: 120_000 },
  );
  if (installLegacyResult.status !== 0) {
    return { ready: false, error: summarizeCommandFailure(command, installResult) };
  }
  const buildRequires = pyprojectBuildRequires(repoDir);
  if (buildRequires !== undefined) {
    const installBuildResult = spawnSync(
      venvPython,
      ["-m", "pip", "install", ...buildRequires],
      {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 180_000,
        // Keep the legacy setuptools pin (PIP_CONSTRAINT) so a bare `setuptools`
        // in [build-system] requires cannot upgrade it past the APIs old repos use
        // (e.g. setuptools.dep_util, removed in newer setuptools).
        env: { ...process.env, PIP_CONSTRAINT: constraintsPath },
      },
    );
    if (installBuildResult.status !== 0) {
      process.stderr.write(
        `warn> build-system requires install failed: ${summarizeCommandFailure(
          `${venvPython} -m pip install ${buildRequires.join(" ")}`,
          installBuildResult,
        )}\n`,
      );
    }
  }
  // CFLAGS: macOS 14/15 SDK rejects implicit function declarations in astropy-era
  // vendored C (cfitsio getcwd) — downgrade to warnings so legacy extensions build.
  const legacyEnv = {
    ...process.env,
    PIP_CONSTRAINT: constraintsPath,
    CFLAGS: "-Wno-implicit-function-declaration",
  };
  const retryResult = spawnSync(
    venvPython,
    ["-m", "pip", "install", "-e", ".", "--no-build-isolation"],
    {
      cwd: repoDir,
      encoding: "utf8",
      env: legacyEnv,
      timeout: 180_000,
    },
  );
  if (retryResult.status === 0) return { ready: true };
  return {
    ready: false,
    error: summarizeCommandFailure(
      `${command} with --no-build-isolation`,
      retryResult,
    ),
  };
}

/** Per-repo evaluation plan. django needs its own test runner (`tests/runtests.py`,
 *  which configures DJANGO_SETTINGS_MODULE + django.setup()); the other SWE-bench repos
 *  run plain pytest with node-id targets. */
function evaluationPlanFor(task, repoDir, venvPython) {
  if ((task.repo ?? "") === "django/django") {
    return {
      kind: "runtests",
      targets: (entries) => toRuntestsLabels(entries),
      run: (labels) => ({ command: venvPython, args: ["tests/runtests.py", ...labels, "--verbosity", "1"] }),
    };
  }
  return {
    kind: "pytest",
    targets: (entries) => toPytestNodeIds(entries, repoDir),
    run: (targets) => ({ command: venvPython, args: ["-m", "pytest", "--tb=short", "-q", ...targets] }),
  };
}

/** Converts old-format ids to django runtests labels (`module.Class.test_name`). Entries
 *  that cannot be converted (bare descriptions like "Regression for #9362", or unknown
 *  shapes) are DROPPED — passing them through makes runtests treat the test name as a module
 *  and fail the whole batch with a false negative. */
function toRuntestsLabels(entries) {
  const labels = [];
  for (const entry of entries) {
    if (entry.includes("::")) {
      labels.push(entry);
      continue;
    }
    const match = entry.match(/^(.+?) \(([\w.]+)\)$/u);
    if (match) labels.push(`${match[2]}.${match[1]}`);
    // else: skip unconvertible entries
  }
  return labels;
}

/** Converts test-patch file paths into django runtests module labels. Django's runtests
 *  takes test labels (module, module.Class.test), NOT file paths — passing a file path
 *  makes build_suite return null and the whole evaluation crashes with
 *  `'NoneType' object is not iterable` (observed on test-files tasks like django-11141). */
function toRuntestsFileLabels(files) {
  const labels = [];
  for (const file of files) {
    const match = file.match(/^tests\/(.+)\.py$/u);
    if (match && !match[1].endsWith("/__init__")) {
      labels.push(match[1].replace(/\//g, "."));
    }
  }
  return labels;
}

async function evaluateWithTestPatch(repoDir, task, evaluationPythonCommand) {
  if (!task.test_patch) return { resolved: false };

  const testPatchPath = resolve(repoDir, "__test_patch.diff");
  writeFileSync(testPatchPath, task.test_patch);

  const applyTest = spawnSync("git", ["apply", "--allow-empty", "__test_patch.diff"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (applyTest.status !== 0) {
    return { resolved: false, error: "Test patch did not apply cleanly." };
  }

  // Prefer the official SWE-bench FAIL_TO_PASS test ids: they are the precise regression
  // signal and avoid false negatives from running every modified test file. Fall back to
  // the test files touched by the test patch when the ids are absent.
  const plan = evaluationPlanFor(task, repoDir, evaluationPythonCommand);
  const failToPass = plan.targets(parseFailToPass(task));
  const passToPass = plan.targets(parsePassToPass(task));
  const patchFiles = extractTestFilesFromPatch(task.test_patch);
  const targets =
    failToPass.length > 0
      ? failToPass
      : plan.kind === "runtests"
        ? toRuntestsFileLabels(patchFiles)
        : patchFiles;
  if (targets.length === 0) {
    return { resolved: false, error: "No FAIL_TO_PASS ids or test files found." };
  }

  // FAIL_TO_PASS must pass (the reported regression is fixed).
  const failCommand = plan.run(targets);
  const failResult = spawnSync(failCommand.command, failCommand.args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (failResult.status !== 0) {
    return {
      resolved: false,
      method: failToPass.length > 0 ? "fail-to-pass" : "test-files",
      failToPassCount: failToPass.length,
      error: summarizeCommandFailure(`${evaluationPythonCommand} ${plan.kind}`, failResult),
    };
  }

  // PASS_TO_PASS must still pass (no regressions) when the corpus provides the ids.
  if (passToPass.length > 0) {
    const passCommand = plan.run(passToPass);
    const passResult = spawnSync(passCommand.command, passCommand.args, {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 300_000,
    });
    if (passResult.status !== 0) {
      return {
        resolved: false,
        method: "fail-to-pass+pass-to-pass",
        failToPassCount: failToPass.length,
        error: summarizeCommandFailure(
          `${evaluationPythonCommand} ${plan.kind} (PASS_TO_PASS)`,
          passResult,
        ),
      };
    }
  }

  return {
    resolved: true,
    method: failToPass.length > 0 ? "fail-to-pass" : "test-files",
    failToPassCount: failToPass.length,
    kind: plan.kind,
  };
}

/** Re-evaluates stored agent patches offline (no model calls). Given fragment tasks with
 *  `agentPatch`, clones the repo at the corpus base commit, applies the agent patch + test
 *  patch, and runs the fixed evaluation. Salvages runs whose agents produced fixes but whose
 *  evaluation was broken by the old pytest invocation. */
async function runReevaluate({ fragmentDir, corpusPath, concurrency, outputPath }) {
  const corpusTasks = loadCorpus(corpusPath);
  const byId = new Map(corpusTasks.map((task) => [task.instance_id, task]));

  const fragmentFiles = readdirSync(fragmentDir)
    .filter((entry) => entry.endsWith(".json") && entry.startsWith("swe-bench-results"))
    .sort();
  const fragments = [];
  for (const file of fragmentFiles) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(fragmentDir, file), "utf8"));
      fragments.push(...(parsed.tasks ?? []));
    } catch (error) {
      process.stderr.write(
        `reevaluate: cannot read fragment ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (fragments.length === 0) {
    process.stderr.write(`reevaluate: no fragment tasks found in ${fragmentDir}\n`);
    process.exit(1);
  }

  const salvageable = fragments.filter(
    (task) =>
      task.agentPatch &&
      !String(task.agentPatch).includes("... (truncated)") &&
      byId.has(task.instance_id),
  );
  process.stdout.write(
    `Re-evaluating ${salvageable.length} agent patches (from ${fragments.length} fragment tasks, no model calls)\n`,
  );

  const results = [];
  for (let i = 0; i < salvageable.length; i += concurrency) {
    const batch = salvageable.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((task) => reevaluateOneTask(task, byId.get(task.instance_id))),
    );
    results.push(...batchResults);
    const solved = results.filter((r) => r.resolved).length;
    process.stderr.write(
      `progress> ${results.length}/${salvageable.length} reevaluated, ${solved} resolved\n`,
    );
  }

  const resolved = results.filter((r) => r.resolved).length;
  const report = {
    benchmark: "swe-bench-verified",
    candidateId: resolveCandidateId(repoRoot, ["SWE_BENCH_CANDIDATE_ID"]),
    generatedAt: new Date().toISOString(),
    reevaluatedFrom: fragmentFiles,
    reevaluated: true,
    composition: {
      fullAccess: true,
      permissionMode: "full",
      interactionTools: false,
      agentRuns: false,
      note: "offline re-evaluation of stored agent patches (fixed evaluation)",
    },
    corpus: {
      totalTasks: corpusTasks.length,
      tasksRun: results.length,
    },
    summary: {
      resolved,
      errored: results.filter((r) => r.failureKind === "test-failed" || r.failureKind === "other").length,
      environmentBlocked: results.filter((r) => r.environmentBlocked).length,
      timedOut: results.filter((r) => r.timedOut).length,
      relayOverloaded: 0,
      passAt1: ratio(resolved, results.length),
      avgTaskMs: Number(
        (results.reduce((sum, r) => sum + (r.reevalWallMs ?? 0), 0) / Math.max(results.length, 1)).toFixed(1),
      ),
    },
    byRepo: computeByRepo(results),
    tasks: results,
  };

  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const markdownText = renderMarkdown(report);
  const markdownPath = outputPath.replace(/\.json$/u, ".md");
  writeFileSync(outputPath, jsonText);
  writeFileSync(markdownPath, markdownText);
  process.stdout.write(jsonText);
  process.stdout.write(`wrote> ${outputPath}\n`);
  process.stdout.write(`wrote> ${markdownPath}\n`);
}

/** Re-evaluates one stored agent patch: clone at base commit -> apply agent patch -> venv
 *  -> fixed evaluation. No model calls. */
async function reevaluateOneTask(fragmentTask, corpusTask) {
  const taskDir = mkdtempSync(`${tmpdir()}/swe-bench-reeval-`);
  const startMs = performance.now();
  try {
    const repoDir = resolve(taskDir, "repo");
    const cloneResult = await runGitNetworkCommand({
      args: ["clone", "--depth", "1", `https://github.com/${corpusTask.repo}.git`, "repo"],
      cwd: taskDir,
    });
    if (cloneResult.status !== 0) {
      return reevalResult(fragmentTask, startMs, {
        failureKind: "clone-failed",
        error: `Clone failed: ${describeGitFailure(cloneResult)}`,
      });
    }
    if (corpusTask.base_commit) {
      const fetchResult = await runGitNetworkCommand({
        args: ["fetch", "--depth", "1", "origin", corpusTask.base_commit],
        cwd: repoDir,
      });
      if (fetchResult.status === 0) {
        spawnSync("git", ["checkout", corpusTask.base_commit], { cwd: repoDir, encoding: "utf8" });
      }
    }

    writeFileSync(resolve(repoDir, "__agent_patch.diff"), fragmentTask.agentPatch);
    const applyAgent = spawnSync("git", ["apply", "--allow-empty", "__agent_patch.diff"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    if (applyAgent.status !== 0) {
      return reevalResult(fragmentTask, startMs, {
        failureKind: "patch-not-applied",
        error: `Agent patch did not apply: ${summarizeCommandFailure("git apply", applyAgent)}`,
      });
    }

    const evaluationEnvironment = prepareEvaluationEnvironment(repoDir, corpusTask);
    if (!evaluationEnvironment.ready) {
      return reevalResult(fragmentTask, startMs, {
        environmentBlocked: true,
        failureKind: "env-blocked",
        environmentError: evaluationEnvironment.error,
      });
    }

    const evaluation = await evaluateWithTestPatch(repoDir, corpusTask, evaluationEnvironment.pythonCommand);
    return reevalResult(fragmentTask, startMs, {
      resolved: evaluation.resolved,
      patchLines: String(fragmentTask.agentPatch).split("\n").length,
      ...(evaluation.error ? { evaluationError: evaluation.error } : {}),
      ...(evaluation.method ? { verification: evaluation.method } : {}),
      ...(evaluation.failToPassCount !== undefined
        ? { failToPassCount: evaluation.failToPassCount }
        : {}),
    });
  } catch (error) {
    return reevalResult(fragmentTask, startMs, {
      failureKind: "harness-error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
}

function reevalResult(fragmentTask, startMs, extra = {}) {
  const result = taskResult(fragmentTask, startMs, extra);
  if (extra.failureKind) result.failureKind = extra.failureKind;
  result.reevaluated = true;
  result.reevalWallMs = Number((performance.now() - startMs).toFixed(1));
  return result;
}

/** Parses the corpus FAIL_TO_PASS field (a JSON-encoded array of test ids). */
function parseFailToPass(task) {
  if (typeof task.FAIL_TO_PASS !== "string") return [];
  try {
    const value = JSON.parse(task.FAIL_TO_PASS);
    return Array.isArray(value)
      ? value.filter((id) => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Parses the corpus PASS_TO_PASS field (a JSON-encoded array of test ids). */
function parsePassToPass(task) {
  if (typeof task.PASS_TO_PASS !== "string") return [];
  try {
    const value = JSON.parse(task.PASS_TO_PASS);
    return Array.isArray(value)
      ? value.filter((id) => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Converts old-format SWE-bench test ids (`test_name (module.Class)`) into pytest node ids
 *  (`path/to/test/file.py::Class::test_name`). Entries already in node-id form (containing
 *  `::`) pass through unchanged. The HuggingFace corpus uses the old format; passing it
 *  verbatim to pytest makes pytest fail with "file or directory not found" — the harness
 *  bug that made every evaluation fail at collection. */
function toPytestNodeIds(entries, repoDir) {
  const nodeIds = [];
  for (const entry of entries) {
    if (entry.includes("::")) {
      nodeIds.push(entry);
      continue;
    }
    const match = entry.match(/^(.+?) \(([\w.]+)\)$/u);
    if (!match) {
      nodeIds.push(entry);
      continue;
    }
    const testName = match[1];
    const moduleClass = match[2];
    const lastDot = moduleClass.lastIndexOf(".");
    const modulePath = moduleClass.slice(0, lastDot);
    const className = moduleClass.slice(lastDot + 1);
    const file = findTestFile(repoDir, modulePath);
    if (file) nodeIds.push(`${file}::${className}::${testName}`);
    else nodeIds.push(entry); // cannot resolve; leave the raw id (pytest will report loudly)
  }
  return nodeIds;
}

/** Resolves a dotted test module (`aggregation.tests`) to its file path relative to the repo
 *  root. Tries common SWE-bench layouts (tests/, test/, or repo-root) then a bounded search. */
function findTestFile(repoDir, modulePath) {
  const relPath = `${modulePath.replaceAll(".", "/")}.py`;
  for (const candidate of [
    relPath,
    `tests/${relPath}`,
    `test/${relPath}`,
    `tests/${modulePath.replaceAll(".", "/")}/__init__.py`,
  ]) {
    if (existsSync(resolve(repoDir, candidate))) return candidate;
  }
  // Bounded fallback search: any .py whose path ends with the module-relative path.
  const stack = [repoDir];
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === ".swe-bench-venv") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        scanned += 1;
        const relative = full.slice(repoDir.length + 1);
        if (relative.endsWith(relPath)) return relative;
        if (scanned > 20_000) return undefined;
      }
    }
  }
  return undefined;
}

function extractTestFilesFromPatch(patch) {
  const files = new Set();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) files.add(match[1]);
  }
  return [...files].filter((f) => f.includes("test"));
}

function normalizePatch(patch) {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n")
    .trim();
}

function summarizeCommandFailure(command, result) {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const output = stderr || stdout || result.error?.message || `${command} failed`;
  if (output.length <= 1600) return `${command} failed: ${output}`;
  return `${command} failed: ${output.slice(0, 800)}\n...\n${output.slice(-800)}`;
}

/** True when the CLI failure is the dimcode relay's `get_channel_failed` (upstream channel
 *  pool overloaded — server-side, unrelated to the task/model quality). These tasks are
 *  counted separately in the report so a run's pass@1 is not polluted by relay capacity. */
function isRelayOverloadError(result) {
  return /channel not found|获取重试渠道|get_channel_failed/iu.test(
    `${result.cliError ?? ""}${result.error ?? ""}`,
  );
}

/** Classifies a task outcome into a stable failureKind for reporting. */
function classifyFailure(result) {
  if (result.resolved) return "resolved";
  if (result.timedOut) return "timed-out";
  if (result.environmentBlocked) return "env-blocked";
  if (isRelayOverloadError(result)) return "relay-overloaded";
  if (result.evaluationError) return "test-failed";
  if (result.error === "Agent produced no diff" || result.failureKind === "no-diff") {
    return "no-diff";
  }
  if (result.cliError) return "model-failure";
  if (result.error) return "other";
  return "unknown";
}

function taskResult(task, startMs, extra = {}) {
  const result = {
    instance_id: task.instance_id,
    repo: task.repo,
    wallMs: Number((performance.now() - startMs).toFixed(1)),
    resolved: false,
    timedOut: false,
    error: undefined,
    ...extra,
  };
  result.failureKind = classifyFailure(result);
  return result;
}

async function downloadCorpus(dataset = "lite") {
  const spec = DATASETS[dataset] ?? DATASETS.lite;
  const corpusPath = defaultCorpusPath(dataset);
  process.stdout.write(`Downloading ${spec.label} corpus from HuggingFace...\n`);
  mkdirSync(corporaDir, { recursive: true });

  const baseUrl = new URL("https://datasets-server.huggingface.co/rows");
  baseUrl.searchParams.set("dataset", spec.huggingface);
  baseUrl.searchParams.set("config", "default");
  baseUrl.searchParams.set("split", "test");
  baseUrl.searchParams.set("length", "100");
  const downloadResult = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sys, urllib.request",
        "base_url = sys.argv[1]",
        "output_path = sys.argv[2]",
        "lines = []",
        "offset = 0",
        "while True:",
        "    with urllib.request.urlopen(f'{base_url}&offset={offset}', timeout=120) as response:",
        "        rows = json.load(response).get('rows', [])",
        "    if not rows:",
        "        break",
        "    lines.extend(json.dumps(row['row'], ensure_ascii=False) for row in rows)",
        "    if len(rows) < 100:",
        "        break",
        "    offset += 100",
        "if not lines:",
        "    raise SystemExit(2)",
        "with open(output_path, 'w', encoding='utf-8') as handle:",
        "    handle.write('\\n'.join(lines) + '\\n')",
        "print(len(lines))",
      ].join("\n"),
      baseUrl.toString(),
      corpusPath,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );

  if (downloadResult.status !== 0) {
    process.stderr.write(`Failed to download ${spec.label} rows from HuggingFace.\n`);
    process.stderr.write(
      downloadResult.stderr?.trim() || downloadResult.stdout?.trim() || "(no error output)\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `Downloaded ${Number(downloadResult.stdout.trim())} tasks to ${corpusPath}\n`,
  );
}

function loadCorpus(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function renderMarkdown(report) {
  const label = report.corpus?.label ?? "SWE-bench";
  const lines = [
    `# ${label} Results`,
    "",
    `- **Candidate:** ${report.candidateId}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Corpus:** ${report.corpus.tasksRun} / ${report.corpus.totalTasks} tasks`,
    "- **Composition:** full access, no interaction tools (ask_user/tool_approve excluded)",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| pass@1 | **${report.summary.passAt1}** |`,
    `| Resolved | ${report.summary.resolved} |`,
    `| Errored | ${report.summary.errored} |`,
    `| Environment Blocked | ${report.summary.environmentBlocked ?? 0} |`,
    `| Relay Overloaded | ${report.summary.relayOverloaded ?? 0} |`,
    `| Timed Out | ${report.summary.timedOut} |`,
    `| Avg Task Time | ${(report.summary.avgTaskMs / 1000).toFixed(1)}s |`,
    `| Total Time | ${(report.summary.wallMs / 1000).toFixed(1)}s |`,
    "",
    "## Per-Repo Results",
    "",
    "| Repo | Tasks | Resolved | pass@1 | Env Blocked | Errored | Avg Time |",
    "|------|-------|----------|--------|-------------|---------|----------|",
  ];

  const byRepo = report.byRepo ?? {};
  for (const [repo, entry] of Object.entries(byRepo)) {
    lines.push(
      `| ${repo} | ${entry.total} | ${entry.resolved} | ${entry.passAt1} | ${entry.environmentBlocked} | ${entry.errored} | ${(entry.avgTaskMs / 1000).toFixed(1)}s |`,
    );
  }

  lines.push(
    "",
    "## Per-Task Results",
    "",
    "| Instance | Repo | Resolved | Time | Error |",
    "|----------|------|----------|------|-------|",
  );

  for (const task of report.tasks) {
    const status = task.resolved
      ? "✅"
      : task.environmentBlocked
        ? "⚠️"
        : task.timedOut
          ? "⏰"
          : task.error
            ? "❌"
            : "—";
    const time = `${(task.wallMs / 1000).toFixed(1)}s`;
    const error = (task.environmentError || task.error || task.evaluationError || "").slice(0, 60);
    lines.push(`| ${task.instance_id} | ${task.repo} | ${status} | ${time} | ${error} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function ratio(value, total) {
  if (!total) return 0;
  return Number((value / total).toFixed(3));
}

/** Per-repo breakdown of task outcomes: totals, resolved, pass@1, and time. */
function computeByRepo(tasks) {
  const byRepo = {};
  for (const task of tasks) {
    const repo = task.repo ?? "unknown";
    const entry = (byRepo[repo] ??= {
      total: 0,
      resolved: 0,
      errored: 0,
      environmentBlocked: 0,
      timedOut: 0,
      wallMs: 0,
    });
    entry.total += 1;
    if (task.resolved) entry.resolved += 1;
    if (task.error) entry.errored += 1;
    if (task.environmentBlocked) entry.environmentBlocked += 1;
    if (task.timedOut) entry.timedOut += 1;
    entry.wallMs += task.wallMs ?? 0;
  }
  for (const repo of Object.keys(byRepo)) {
    const entry = byRepo[repo];
    entry.passAt1 = ratio(entry.resolved, entry.total);
    entry.avgTaskMs = Number((entry.wallMs / Math.max(entry.total, 1)).toFixed(1));
  }
  return Object.fromEntries(
    Object.entries(byRepo).sort((a, b) => b[1].total - a[1].total),
  );
}

/** Resolves the effective provider config file path: BEST_AGENT_PROVIDER_CONFIG override,
 *  else ~/.best-agent/provider.json. */
function providerConfigPath() {
  const override = process.env.BEST_AGENT_PROVIDER_CONFIG;
  if (override !== undefined && override.trim() !== "") return resolve(override);
  const home = homedir();
  return home ? resolve(home, ".best-agent", "provider.json") : undefined;
}

/** Writes a temporary provider config that adds `reasoningEffort` to the effective provider
 *  (env BEST_AGENT_PROVIDER_* first, else the existing provider file), and returns its path
 *  for BEST_AGENT_PROVIDER_CONFIG. Requires a CLI that carries reasoningEffort from the
 *  provider file in `run` (the v3-run.ts passthrough); older CLIs silently send the
 *  model-catalog default instead. */
function writeProviderConfigWithEffort(effort) {
  const env = process.env;
  let existing;
  const existingPath = providerConfigPath();
  if (existingPath !== undefined) {
    try {
      existing = JSON.parse(readFileSync(existingPath, "utf8"));
    } catch {
      existing = undefined;
    }
  }
  const kind = env.BEST_AGENT_PROVIDER_KIND || existing?.kind;
  const model = env.BEST_AGENT_PROVIDER_MODEL || existing?.model;
  const apiKey = env.BEST_AGENT_PROVIDER_API_KEY || existing?.apiKey;
  const baseURL = env.BEST_AGENT_PROVIDER_BASE_URL || existing?.baseURL || existing?.baseUrl;
  const compat = env.BEST_AGENT_PROVIDER_COMPATIBILITY_MODE || existing?.compatibilityMode;
  if (!kind || !model || !apiKey) {
    throw new Error(
      "--reasoning-effort requires provider env (BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY) " +
        "or an existing provider config file.",
    );
  }
  const config = { kind, model, apiKey };
  if (baseURL) config.baseURL = baseURL;
  if (compat) config.compatibilityMode = compat;
  config.reasoningEffort = effort;
  const path = resolve(tmpdir(), `bench-provider-${effort}-${process.pid}.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function resolvePythonCommand(task = undefined) {
  // SWE-bench instances pin era-appropriate runtimes, and the macOS system
  // python3.11 is wrong for both ends of the Django range: Python >= 3.10
  // removed the gettext `codeset` parameter (breaks Django < 4 at import,
  // observed as a full-suite TypeError), Python >= 3.9 changed the argparse
  // invalid-choice message format (`argument {foo}:` prefix), and Django 5
  // requires >= 3.10. Choose the candidate order per task instead of always
  // using the newest.
  // Non-django repos (astropy/matplotlib/sphinx/sympy/pytest/scikit-learn, all
  // 2019-2023 era) prefer 3.9 too: their setup.py uses setuptools/distutils
  // private attributes that Python 3.11's stdlib distutils no longer provides
  // (`ignore_egg_info_in_manifest` AttributeError under --no-build-isolation,
  // observed as 25 environmentBlocked astropy tasks in b1).
  const repo = task?.repo;
  const djangoMajor =
    repo === "django/django" ? Number.parseInt(String(task?.version ?? ""), 10) : Number.NaN;
  const candidates =
    repo === "django/django" && djangoMajor >= 4
      ? ["python3.11", "python3.10", "python3.9", "python3"]
      : ["python3.9", "python3.10", "python3.11", "python3"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status === 0) return candidate;
  }
  throw new Error("SWE-bench harness requires python3.9 or newer to be installed.");
}

function sanitize(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
