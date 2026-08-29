/**
 * SWE-bench harness (v3).
 *
 * Runs the v3 agent against a frozen SWE-bench corpus and scores the terminal patch with the
 * pinned official SWE-bench Docker evaluator. Each task runs through the v3 CLI
 * one-shot `run` command with the full-access, non-interactive composition:
 *   - full access: permission mode `full` + `--workspace-grant read write exec`;
 *   - no ask-user: the `run` command excludes the interaction ToolBindings, so the agent
 *     never stalls on a human prompt during a task;
 *   - closed tool surface: network ToolBindings are excluded and macOS Seatbelt denies
 *     network access from exec subprocesses.
 *
 * Usage:
 *   node scripts/swe-bench-harness.mjs [options]
 *
 * Options:
 *   --corpus <path>  Frozen local JSONL corpus (defaults to the official manifest dataset path)
 *   --limit <n>      Run only the first N tasks
 *   --task <id>      Run a single task by instance ID
 *   --tasks <ids>    Run a predeclared comma-separated task set
 *   --generation-only Freeze predictions without starting the Docker evaluator
 *   --timeout <ms>   Per-task timeout in ms (default: 300000 = 5 min)
 *   --output <path>  Output results JSON path (default: docs/benchmarks/swe-bench-results.json)
 *   --concurrency <n> Max parallel tasks (default: 1)
 *   --official-manifest <path> Pinned official evaluator/dataset manifest
 *
 * Environment:
 *   Provider via BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY/BASE_URL/COMPATIBILITY_MODE, otherwise
 *   the CLI resolves `~/.best-agent/provider.json`, then dimcode OAuth.
 *   SWE_BENCH_OFFICIAL_MANIFEST may provide the official manifest path.
 *
 * Corpus format (JSONL, one object per line):
 *   { "instance_id": "...", "repo": "...", "base_commit": "...", "problem_statement": "...",
 *     ... }
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
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { writeBenchmarkHistory, resolveCandidateId } from "./benchmark-history.mjs";
import { describeBenchmarkProvider } from "./benchmark-provider.mjs";
import {
  createInfrastructureInconclusive,
  createFrozenPrediction,
  evaluateFrozenPrediction,
  freezeOfficialImageManifest,
  loadOfficialEvaluatorManifest,
  projectBenchmarkTaskDisposition,
  summarizeOfficialEvaluations,
  verifyOfficialDatasetManifest,
  writeFrozenPrediction,
} from "./swe-bench-official-evaluator.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliInvocation = resolveCliInvocation(process.env);
const benchmarksDir = resolve(repoRoot, "docs", "benchmarks");
const DEFAULTS = {
  concurrency: 1,
  corpusPath: undefined,
  outputPath: resolve(benchmarksDir, "swe-bench-results.json"),
  taskTimeout: 300_000,
  officialManifestPath:
    process.env.SWE_BENCH_OFFICIAL_MANIFEST === undefined
      ? undefined
      : resolve(process.env.SWE_BENCH_OFFICIAL_MANIFEST),
};
const FULL_ACCESS_GRANTS = ["read", "write", "exec"];
const PATCH_CAPTURE_MAX_BUFFER_BYTES = 17 * 1024 * 1024;

export function parseBenchmarkArgs(argv) {
  const parsed = {
    ...DEFAULTS,
    limit: undefined,
    taskId: undefined,
    taskIds: undefined,
    generationOnly: false,
    offset: 0,
    shard: undefined,
    shardTotal: undefined,
    mergeShards: false,
    outputPathWasSet: false,
    tag: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--corpus":
        parsed.corpusPath = resolve(argv[++i]);
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
          .map((value) => value.trim())
          .filter(Boolean);
        if (parsed.taskIds.length === 0 || new Set(parsed.taskIds).size !== parsed.taskIds.length) {
          throw new Error("--tasks must contain unique comma-separated instance IDs.");
        }
        break;
      case "--generation-only":
        parsed.generationOnly = true;
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
      case "--official-manifest":
        parsed.officialManifestPath = resolve(argv[++i]);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node scripts/swe-bench-harness.mjs [options]\n" +
            "  --corpus <path>     frozen local corpus JSONL (defaults to manifest dataset)\n" +
            "  --limit <n>         run the first n tasks (0 = all)\n" +
            "  --offset <n>        skip the first n tasks\n" +
            "  --shard <i> --shard-total <n>   run tasks where index % n == i (parallel shards)\n" +
            "  --merge-shards      combine swe-bench-results.shard-*.json into the aggregate report\n" +
            "  --task <id>         run one task by instance id\n" +
            "  --tasks <ids>       run a predeclared comma-separated task set\n" +
            "  --generation-only   freeze predictions and defer official Docker evaluation\n" +
            "  --timeout <ms>      per-task timeout (default 300000)\n" +
            "  --concurrency <n>   parallel tasks (default 1)\n" +
            "  --official-manifest <path>  pinned official SWE-bench evaluator manifest\n" +
            "  --output <path>     results JSON path (default docs/benchmarks/swe-bench-results.json)\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (argsShardInvalid(parsed)) {
    throw new Error("--shard requires --shard-total; --shard must be 0 <= shard < shard-total.");
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer.");
  }
  if (!Number.isFinite(parsed.taskTimeout) || parsed.taskTimeout <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds.");
  }
  if (parsed.taskId !== undefined && parsed.taskIds !== undefined) {
    throw new Error("--task and --tasks are mutually exclusive.");
  }
  return parsed;
}

export function resolveCliEntrypoint(environment = process.env) {
  const configured = environment.BEST_AGENT_CLI_PATH;
  if (configured === undefined || configured.length === 0) {
    return resolve(repoRoot, "apps/cli/dist/index.js");
  }
  if (!isAbsolute(configured)) {
    throw new Error("BEST_AGENT_CLI_PATH must be an absolute path.");
  }
  return configured;
}

export function resolveCliInvocation(environment = process.env) {
  const entrypoint = resolveCliEntrypoint(environment);
  return /\.[cm]?js$/u.test(entrypoint) ? [process.execPath, entrypoint] : [entrypoint];
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

  const args = parseBenchmarkArgs(process.argv.slice(2));

  if (args.mergeShards) {
    mergeShardReports(args.outputPath);
    return;
  }

  if (!args.officialManifestPath) {
    throw new Error(
      "A pinned official evaluator manifest is required through --official-manifest or SWE_BENCH_OFFICIAL_MANIFEST.",
    );
  }
  const officialManifest = loadOfficialEvaluatorManifest(args.officialManifestPath);
  args.corpusPath ??= officialManifest.dataset.localDatasetJsonlPath;
  verifyOfficialDatasetManifest(officialManifest);

  if (!existsSync(cliInvocation[cliInvocation.length - 1])) {
    throw new Error(
      `v3 CLI build not found at ${cliInvocation[cliInvocation.length - 1]}. Run \`pnpm build\` first.`,
    );
  }

  if (!existsSync(args.corpusPath)) {
    process.stderr.write(`Corpus not found at ${args.corpusPath}\n`);
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
  } else if (args.taskIds) {
    const selected = new Set(args.taskIds);
    tasks = allTasks.filter((task) => selected.has(task.instance_id));
    if (tasks.length !== selected.size) {
      const found = new Set(tasks.map((task) => task.instance_id));
      throw new Error(
        `Task set contains unknown instances: ${args.taskIds.filter((id) => !found.has(id)).join(", ")}`,
      );
    }
  } else {
    // Slicing and sharding are applied in corpus order. Shards use index % shardTotal so
    // parallel CI jobs each cover a disjoint, evenly-distributed subset of the corpus.
    if (args.offset) tasks = tasks.slice(args.offset);
    if (args.shard !== undefined) {
      tasks = tasks.filter((_, index) => index % args.shardTotal === args.shard);
    }
    if (args.limit) tasks = tasks.slice(0, args.limit);
  }

  // Model/shard runs write to tagged/shard-specific files so parallel CI jobs never
  // overwrite each other; --merge-shards combines them into the aggregate report.
  if (args.tag && !args.outputPathWasSet) {
    args.outputPath = args.outputPath.replace(/\.json$/u, `.${sanitize(args.tag)}.json`);
  }
  if (args.shard !== undefined && !args.outputPathWasSet) {
    args.outputPath = args.outputPath.replace(/\.json$/u, `.shard-${args.shard}.json`);
  }

  if (resolve(officialManifest.dataset.localDatasetJsonlPath) !== resolve(args.corpusPath)) {
    throw new Error(
      "The prompt corpus must be the same frozen local JSONL selected by the official evaluator manifest.",
    );
  }

  const candidateId = resolveCandidateId(repoRoot, ["SWE_BENCH_CANDIDATE_ID"]);
  const provider = describeBenchmarkProvider();
  const evaluationBatchId = sanitize(
    process.env.SWE_BENCH_EVALUATION_BATCH_ID ??
      `${candidateId}-${args.tag ?? "local"}-${new Date().toISOString()}`,
  );
  const outputStem = args.outputPath.replace(/\.json$/u, "");
  const predictionDir = `${outputStem}.predictions`;
  const officialEvaluationDir = `${outputStem}.official-evaluation`;
  if (
    existsSync(args.outputPath) ||
    existsSync(predictionDir) ||
    existsSync(officialEvaluationDir)
  ) {
    throw new Error("Refusing to overwrite an existing benchmark result or evaluation artifact.");
  }
  mkdirSync(predictionDir, { recursive: true });
  mkdirSync(officialEvaluationDir, { recursive: true });
  const evaluationContext = Object.freeze({
    evaluationBatchId,
    manifestPath: args.officialManifestPath,
    predictionDir,
    officialEvaluationDir,
    modelNameOrPath: `${provider.kind}/${provider.model}`,
  });
  const imageManifestPath = resolve(officialEvaluationDir, "image-manifest.json");

  process.stdout.write(
    `${officialManifest.dataset.profileId}: running ${tasks.length} / ${allTasks.length} tasks\n`,
  );

  const results = [];
  const startTime = performance.now();

  for (let i = 0; i < tasks.length; i += args.concurrency) {
    const batch = tasks.slice(i, i + args.concurrency);
    // Each model attempt is fully isolated (clone → agent in its own temp dir). Wrap every
    // task so an unexpected rejection in one task can never abort the rest of the batch or
    // the whole CI job — the run must complete all scheduled tasks and produce a report.
    const batchResults = await Promise.all(
      batch.map((task) => runTaskSafe(task, args.taskTimeout, evaluationContext)),
    );
    results.push(...batchResults);

    process.stderr.write(
      `generation> ${results.length}/${tasks.length} attempts complete, ${results.filter((result) => result.predictionPath).length} frozen predictions\n`,
    );
  }

  const predictionPaths = results
    .map((result) => result.predictionPath)
    .filter((path) => typeof path === "string");
  if (predictionPaths.length > 0 && !args.generationOnly) {
    try {
      await freezeOfficialImageManifest({
        manifestPath: args.officialManifestPath,
        predictionPaths,
        outputPath: imageManifestPath,
      });
    } catch (error) {
      process.stderr.write(
        `Official image manifest admission failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      for (let index = 0; index < results.length; index += 1) {
        if (!results[index].predictionPath) continue;
        const officialEvaluation = createInfrastructureInconclusive({
          manifestPath: args.officialManifestPath,
          predictionPath: results[index].predictionPath,
        });
        results[index] = {
          ...results[index],
          officialEvaluation,
          evaluationError: officialEvaluation.reason,
          verification: "official-evaluator-admission-failed",
        };
      }
    }
    if (existsSync(imageManifestPath)) {
      for (let i = 0; i < results.length; i += args.concurrency) {
        const batch = results.slice(i, i + args.concurrency);
        const evaluated = await Promise.all(
          batch.map((result) =>
            evaluateGeneratedTaskSafe(result, evaluationContext, imageManifestPath),
          ),
        );
        results.splice(i, evaluated.length, ...evaluated);
        const progressSummary = summarizeOfficialEvaluations(results);
        process.stderr.write(
          `evaluation> ${Math.min(i + batch.length, results.length)}/${results.length} visited, ${progressSummary.officialResolved} official resolved, ${progressSummary.officialInconclusive} inconclusive\n`,
        );
      }
    }
  }

  const wallMs = performance.now() - startTime;
  const errored = results.filter((r) => r.error).length;
  const environmentBlocked = results.filter((r) => r.environmentBlocked).length;
  const timedOut = results.filter((r) => r.timedOut).length;
  const officialSummary = summarizeBenchmarkResults(results, args.generationOnly);

  const report = {
    benchmark: officialManifest.dataset.profileId,
    candidateId,
    generatedAt: new Date().toISOString(),
    provider,
    composition: {
      fullAccess: true,
      permissionMode: "full",
      interactionTools: false,
      workspaceBackend: "sandbox",
      excludedToolScopes: ["network"],
      networkToolSchemas: false,
      execNetworkIsolation: true,
      taskTimeoutMs: args.taskTimeout,
      ...(args.shard !== undefined ? { shard: args.shard, shardTotal: args.shardTotal } : {}),
    },
    corpus: {
      path: args.corpusPath,
      totalTasks: allTasks.length,
      tasksRun: tasks.length,
    },
    evaluation: {
      schemaVersion: 1,
      method: args.generationOnly
        ? "official-swe-bench-docker-deferred"
        : "official-swe-bench-docker",
      manifestPath: args.officialManifestPath,
      evaluationBatchId,
      imageManifestPath:
        predictionPaths.length > 0 && !args.generationOnly ? imageManifestPath : null,
    },
    summary: {
      resolved: officialSummary.officialResolved,
      errored,
      environmentBlocked,
      timedOut,
      ...officialSummary,
      wallMs: Number(wallMs.toFixed(1)),
      avgTaskMs: Number((wallMs / tasks.length).toFixed(1)),
    },
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

export function summarizeBenchmarkResults(results, deferred = false) {
  const summary = summarizeOfficialEvaluations(results);
  return deferred ? { ...summary, passAt1: null } : summary;
}

/** Combines one complete, homogeneous shard set into a composite report. A shard set uses
 *  independent image snapshots, so its aggregate is never labeled pass@1. */
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
      throw new Error(
        `merge-shards: cannot read fragment ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  assertCompleteShardReports(reports);

  const tasks = reports.flatMap((report) => report.tasks ?? []);
  if (new Set(tasks.map((task) => task.instance_id)).size !== tasks.length) {
    throw new Error("merge-shards: duplicate task instance across fragments.");
  }
  const officialSummary = summarizeOfficialEvaluations(tasks);
  const resolved = officialSummary.officialResolved;
  const errored = tasks.filter((task) => task.error).length;
  const environmentBlocked = tasks.filter((task) => task.environmentBlocked).length;
  const timedOut = tasks.filter((task) => task.timedOut).length;
  const byModel = {};
  for (const report of reports) {
    const key = `${report.provider?.kind ?? "?"}/${report.provider?.model ?? "?"}`;
    byModel[key] ??= { resolved: 0, total: 0 };
    byModel[key].total += (report.tasks ?? []).length;
    byModel[key].resolved += summarizeOfficialEvaluations(report.tasks ?? []).officialResolved;
  }

  const deferred = reports[0].evaluation.method === "official-swe-bench-docker-deferred";
  const aggregate = {
    benchmark: reports[0]?.benchmark ?? "swe-bench",
    candidateId: reports[0]?.candidateId ?? "workspace",
    generatedAt: new Date().toISOString(),
    mergedFrom: fragments,
    composition: {
      fullAccess: true,
      permissionMode: "full",
      interactionTools: false,
      workspaceBackend: "sandbox",
      excludedToolScopes: ["network"],
      networkToolSchemas: false,
      execNetworkIsolation: true,
      fragments: reports.length,
    },
    corpus: {
      totalTasks: reports[0].corpus.totalTasks,
      tasksRun: tasks.length,
    },
    evaluation: {
      schemaVersion: 1,
      method: deferred
        ? "official-swe-bench-docker-deferred-composite"
        : "official-swe-bench-docker-composite",
      evaluationBatchIds: reports.map((report) => report.evaluation.evaluationBatchId),
    },
    byModel,
    summary: {
      resolved,
      errored,
      environmentBlocked,
      timedOut,
      ...officialSummary,
      passAt1: null,
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
  if (existsSync(jsonPath) || existsSync(markdownPath)) {
    throw new Error("merge-shards: refusing to overwrite an existing aggregate report.");
  }
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

function assertCompleteShardReports(reports) {
  const first = reports[0];
  const shardTotal = first?.composition?.shardTotal;
  if (!Number.isInteger(shardTotal) || shardTotal <= 0 || reports.length !== shardTotal) {
    throw new Error("merge-shards: fragment count does not match shardTotal.");
  }
  const expected = {
    benchmark: first.benchmark,
    candidateId: first.candidateId,
    provider: JSON.stringify(first.provider),
    corpusPath: first.corpus?.path,
    corpusTotal: first.corpus?.totalTasks,
    manifestPath: first.evaluation?.manifestPath,
    workspaceBackend: first.composition?.workspaceBackend,
    excludedToolScopes: JSON.stringify(first.composition?.excludedToolScopes),
    networkToolSchemas: first.composition?.networkToolSchemas,
    execNetworkIsolation: first.composition?.execNetworkIsolation,
  };
  const indices = [];
  for (const report of reports) {
    if (
      report.evaluation?.schemaVersion !== 1 ||
      !["official-swe-bench-docker", "official-swe-bench-docker-deferred"].includes(
        report.evaluation?.method,
      ) ||
      report.evaluation?.method !== first.evaluation?.method ||
      report.benchmark !== expected.benchmark ||
      report.candidateId !== expected.candidateId ||
      JSON.stringify(report.provider) !== expected.provider ||
      report.corpus?.path !== expected.corpusPath ||
      report.corpus?.totalTasks !== expected.corpusTotal ||
      report.evaluation?.manifestPath !== expected.manifestPath ||
      report.composition?.workspaceBackend !== expected.workspaceBackend ||
      JSON.stringify(report.composition?.excludedToolScopes) !== expected.excludedToolScopes ||
      report.composition?.networkToolSchemas !== expected.networkToolSchemas ||
      report.composition?.execNetworkIsolation !== expected.execNetworkIsolation ||
      report.composition?.shardTotal !== shardTotal ||
      !Number.isInteger(report.composition?.shard)
    ) {
      throw new Error("merge-shards: fragments do not share one admitted configuration.");
    }
    indices.push(report.composition.shard);
  }
  indices.sort((left, right) => left - right);
  if (indices.some((index, position) => index !== position)) {
    throw new Error("merge-shards: shard set is incomplete or duplicated.");
  }
}

async function runTask(task, timeoutMs, evaluationContext) {
  const taskDir = mkdtempSync(`${tmpdir()}/swe-bench-${sanitize(task.instance_id)}-`);
  const startMs = performance.now();
  try {
    // Clone the repo at the base commit (shallow).
    const cloneResult = runGitCommand({
      args: ["clone", "--depth", "1", `https://github.com/${task.repo}.git`, "repo"],
      cwd: taskDir,
    });
    if (cloneResult.status !== 0) {
      return taskResult(task, startMs, {
        error: `Clone failed: ${describeGitFailure(cloneResult)}`,
        benchmarkInconclusive: true,
      });
    }

    const repoDir = resolve(taskDir, "repo");
    if (task.base_commit) {
      const fetchResult = runGitCommand({
        args: ["fetch", "--depth", "1", "origin", task.base_commit],
        cwd: repoDir,
      });
      if (fetchResult.status !== 0) {
        return taskResult(task, startMs, {
          error: `Base commit fetch failed: ${describeGitFailure(fetchResult)}`,
          benchmarkInconclusive: true,
        });
      }
      const checkout = spawnSync("git", ["checkout", task.base_commit], {
        cwd: repoDir,
        encoding: "utf8",
      });
      if (checkout.status !== 0) {
        return taskResult(task, startMs, {
          error: `Base commit checkout failed: ${describeGitFailure(checkout)}`,
          benchmarkInconclusive: true,
        });
      }
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" });
      if (head.status !== 0 || head.stdout.trim() !== task.base_commit) {
        return taskResult(task, startMs, {
          error: "Checked-out HEAD does not match the frozen SWE-bench base commit.",
          benchmarkInconclusive: true,
        });
      }
      const isolation = isolateFrozenGitCommit(repoDir);
      if (isolation.status !== 0) {
        return taskResult(task, startMs, {
          error: `Frozen repository isolation failed: ${describeGitFailure(isolation)}`,
          benchmarkInconclusive: true,
        });
      }
    } else {
      return taskResult(task, startMs, {
        error: "Frozen SWE-bench task is missing base_commit.",
        benchmarkInconclusive: true,
      });
    }

    // Build the prompt from the issue description.
    const prompt = [
      "You are fixing a bug in a Python repository. Here is the issue description:",
      "",
      task.problem_statement,
      "",
      "Use the issue description above as the full problem statement. Make reasonable assumptions and continue.",
      "You have these workspace tools available: read, write, edit, search, stat, list, mkdir, remove, exec, apply_patch.",
      "Use the exact tool names above to inspect the repository and edit the necessary source files. Do not modify test files.",
      "You have no web access: do not call web_search, web_fetch, or any other web tool. Solve the bug by reading the repository code directly and applying the fix yourself.",
      "You MUST actually edit the source files with the write/edit/apply_patch tools — never respond with only a textual description of the fix. Inspect the code, apply the minimal correct change, then verify it.",
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
      "--no-base-instructions",
      "--workspace",
      repoDir,
      // SWE-bench tasks on complex repos (astropy) routinely need hundreds of model cycles;
      // raise the anti-runaway guard well above the CLI default of 200 so a hard task is not
      // killed at max-model-cycles before the agent finishes editing.
      "--max-model-cycles",
      "600",
      ...FULL_ACCESS_GRANTS.flatMap((grant) => ["--workspace-grant", grant]),
      "--workspace-backend",
      "sandbox",
      "--tool-exclude",
      "network",
      prompt,
    ];
    const cliResult = await runCliProcess({
      // Run the CLI through node (the .js entrypoint is not directly executable).
      args: [...cliInvocation, ...cliArgs],
      cwd: repoDir,
      timeoutMs,
      env: {
        ...process.env,
        // Align the plan run-duration cap with the harness per-task timeout.
        BEST_AGENT_PROVIDER_TIMEOUT_MS: String(timeoutMs),
      },
    });
    if (cliResult.timedOut) {
      return taskResult(task, startMs, { timedOut: true });
    }

    // Capture the exact base-to-terminal-worktree patch without trusting or mutating the
    // repository index, which the model may have staged or committed during the attempt.
    const agentPatch = captureTerminalPatch({
      repoDir,
      baseCommit: task.base_commit,
      temporaryIndexPath: resolve(taskDir, "terminal-patch.index"),
    });
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
      });
    }

    const attemptId = sanitize(`${evaluationContext.evaluationBatchId}-${task.instance_id}`);
    const prediction = createFrozenPrediction({
      schemaVersion: 1,
      evaluationBatchId: evaluationContext.evaluationBatchId,
      attemptId,
      instanceId: task.instance_id,
      modelNameOrPath: evaluationContext.modelNameOrPath,
      modelPatch: agentPatch,
    });
    const predictionPath = resolve(
      evaluationContext.predictionDir,
      `${sanitize(task.instance_id)}.json`,
    );
    writeFrozenPrediction(predictionPath, prediction);
    return taskResult(task, startMs, {
      patchLines: agentPatch.split("\n").length,
      predictionPath,
      patchSha256: prediction.modelPatchSha256,
      agentPatch:
        agentPatch.length > 10_000 ? agentPatch.slice(0, 10_000) + "\n... (truncated)" : agentPatch,
    });
  } catch (error) {
    return taskResult(task, startMs, {
      error: error instanceof Error ? error.message : String(error),
      benchmarkInconclusive: true,
    });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
}

export function captureTerminalPatch(options) {
  const env = { ...process.env, GIT_INDEX_FILE: resolve(options.temporaryIndexPath) };
  const commandRunner = options.commandRunner ?? spawnSync;
  const commands = [
    ["read-tree", options.baseCommit],
    ["add", "-A", "--", "."],
    [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      options.baseCommit,
      "--",
    ],
  ];
  let patch = "";
  for (const args of commands) {
    const result = commandRunner("git", args, {
      cwd: options.repoDir,
      encoding: "utf8",
      env,
      maxBuffer: PATCH_CAPTURE_MAX_BUFFER_BYTES,
    });
    if (result.status !== 0) {
      throw new Error(`Terminal patch capture failed (${args[0]}): ${describeGitFailure(result)}`);
    }
    if (args[0] === "diff") patch = result.stdout ?? "";
  }
  return patch;
}

async function evaluateGeneratedTask(result, evaluationContext, imageManifestPath) {
  if (!result.predictionPath) return result;
  const officialOutputDir = resolve(
    evaluationContext.officialEvaluationDir,
    sanitize(result.instance_id),
  );
  const officialEvaluation = await evaluateFrozenPrediction({
    manifestPath: evaluationContext.manifestPath,
    predictionPath: result.predictionPath,
    outputDir: officialOutputDir,
    imageManifestPath,
  });
  return {
    ...result,
    wallMs: Number((result.wallMs + officialEvaluation.wallMs).toFixed(1)),
    officialEvaluation,
    verification: "official-swe-bench-docker",
    ...(officialEvaluation.verdict === "inconclusive"
      ? { evaluationError: officialEvaluation.reason }
      : {}),
  };
}

async function evaluateGeneratedTaskSafe(result, evaluationContext, imageManifestPath) {
  try {
    return await evaluateGeneratedTask(result, evaluationContext, imageManifestPath);
  } catch (error) {
    if (!result.predictionPath) return result;
    const officialEvaluation = createInfrastructureInconclusive({
      manifestPath: evaluationContext.manifestPath,
      predictionPath: result.predictionPath,
    });
    return {
      ...result,
      officialEvaluation,
      evaluationError: `${officialEvaluation.reason}: ${error instanceof Error ? error.message : String(error)}`,
      verification: "official-swe-bench-docker",
    };
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
async function runTaskSafe(task, timeoutMs, evaluationContext) {
  try {
    return await runTask(task, timeoutMs, evaluationContext);
  } catch (error) {
    return taskResult(task, performance.now(), {
      error: `Harness failure: ${error instanceof Error ? error.message : String(error)}`,
      benchmarkInconclusive: true,
    });
  }
}

function runGitCommand({ args, cwd }) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
}

export function isolateFrozenGitCommit(repoDir) {
  const script = [
    "set -eu",
    "git remote remove origin",
    "git for-each-ref --format='%(refname)' refs/heads refs/remotes refs/tags | while IFS= read -r ref; do git update-ref -d \"$ref\"; done",
    "if git symbolic-ref -q refs/remotes/origin/HEAD >/dev/null; then git symbolic-ref -d refs/remotes/origin/HEAD; fi",
    "git reflog expire --expire=now --all",
    "git gc --prune=now",
    "test -z \"$(git remote)\"",
    "test -z \"$(git for-each-ref --format='%(refname)' refs/heads refs/remotes refs/tags)\"",
    "test -z \"$(git fsck --unreachable --no-reflogs 2>&1)\"",
  ].join("\n");
  return spawnSync("/bin/sh", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function describeGitFailure(result) {
  return `${result?.stderr ?? ""}${result?.stdout ?? ""}`.slice(0, 500);
}

function taskResult(task, startMs, extra = {}) {
  return {
    instance_id: task.instance_id,
    repo: task.repo,
    wallMs: Number((performance.now() - startMs).toFixed(1)),
    timedOut: false,
    error: undefined,
    ...extra,
  };
}

function loadCorpus(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      for (const key of ["instance_id", "repo", "base_commit", "problem_statement"]) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw new Error(`Frozen corpus row has invalid ${key}.`);
        }
      }
      return {
        instance_id: row.instance_id,
        repo: row.repo,
        base_commit: row.base_commit,
        problem_statement: row.problem_statement,
      };
    });
}

function renderMarkdown(report) {
  const lines = [
    "# SWE-bench Results",
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
    `| Official pass@1 | **${report.summary.passAt1 ?? "inconclusive"}** |`,
    `| Official pass@1 denominator | ${report.summary.passAt1Denominator ?? report.corpus.tasksRun} |`,
    `| Official Resolved | ${report.summary.officialResolved ?? 0} |`,
    `| Official Test Failed | ${report.summary.officialTestFailed ?? 0} |`,
    `| Official Inconclusive | ${report.summary.officialInconclusive ?? 0} |`,
    `| Official Coverage | ${report.summary.officialCoverage ?? 0} |`,
    `| Errored | ${report.summary.errored} |`,
    `| Environment Blocked | ${report.summary.environmentBlocked ?? 0} |`,
    `| Timed Out | ${report.summary.timedOut} |`,
    `| Avg Task Time | ${(report.summary.avgTaskMs / 1000).toFixed(1)}s |`,
    `| Total Time | ${(report.summary.wallMs / 1000).toFixed(1)}s |`,
    "",
    "## Per-Task Results",
    "",
    "| Instance | Repo | Resolved | Time | Error |",
    "|----------|------|----------|------|-------|",
  ];

  for (const task of report.tasks) {
    const disposition = projectBenchmarkTaskDisposition(task);
    const status =
      disposition === "resolved"
        ? "✅"
        : disposition === "test-failed"
          ? "❌"
          : disposition === "inconclusive"
            ? "⚠️"
            : "—";
    const time = `${(task.wallMs / 1000).toFixed(1)}s`;
    const error = (
      task.officialEvaluation?.reason ||
      task.environmentError ||
      task.error ||
      task.evaluationError ||
      ""
    ).slice(0, 60);
    lines.push(`| ${task.instance_id} | ${task.repo} | ${status} | ${time} | ${error} |`);
  }

  lines.push("");
  return lines.join("\n");
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
