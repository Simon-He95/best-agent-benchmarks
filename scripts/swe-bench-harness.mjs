/**
 * SWE-bench harness (v3).
 *
 * Runs the v3 agent against a frozen SWE-bench corpus and freezes terminal predictions for
 * later admission and official Docker evaluation. Each task runs through the v3 CLI
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
 *   --generation-only Required: freeze predictions without starting the Docker evaluator
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
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { writeBenchmarkHistory, resolveCandidateId } from "./benchmark-history.mjs";
import { describeBenchmarkProvider } from "./benchmark-provider.mjs";
import {
  createFrozenPrediction,
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
  if (!parsed.generationOnly) {
    throw new Error(
      "Generation is the only harness mode; use evaluate-official.mjs for admitted Docker evaluation.",
    );
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
  // overwrite each other; formal population admission consumes the immutable task receipts.
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
  const taskArtifactDir = `${outputStem}.tasks`;
  if (existsSync(args.outputPath) || existsSync(predictionDir) || existsSync(taskArtifactDir)) {
    throw new Error("Refusing to overwrite an existing benchmark generation artifact.");
  }
  mkdirSync(predictionDir, { recursive: true });
  mkdirSync(taskArtifactDir, { recursive: true });
  const formalRunId = process.env.SWE_BENCH_FORMAL_RUN_ID ?? `diagnostic-${evaluationBatchId}`;
  const evaluationContext = Object.freeze({
    candidateId,
    evaluationBatchId,
    formalRunId,
    manifestPath: args.officialManifestPath,
    predictionDir,
    taskArtifactDir,
    modelNameOrPath: `${provider.kind}/${provider.model}`,
  });

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
      `generation> ${results.length}/${tasks.length} attempts complete, ${results.filter((result) => result.prediction !== undefined).length} frozen predictions\n`,
    );
  }

  const wallMs = performance.now() - startTime;
  const errored = results.filter((r) => r.error).length;
  const environmentBlocked = results.filter((r) => r.environmentBlocked).length;
  const timedOut = results.filter((r) => r.timedOut).length;
  const officialSummary = summarizeBenchmarkResults(results, true);

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
      formalRunId,
      ...(args.shard !== undefined ? { shard: args.shard, shardTotal: args.shardTotal } : {}),
    },
    corpus: {
      path: args.corpusPath,
      totalTasks: allTasks.length,
      tasksRun: tasks.length,
    },
    evaluation: {
      schemaVersion: 1,
      method: "official-swe-bench-docker-deferred",
      manifestPath: args.officialManifestPath,
      evaluationBatchId,
      imageManifestPath: null,
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
  writeJsonTextDurable(args.outputPath, jsonText);
  writeFileSync(markdownPath, markdownText, { flag: "wx" });

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

async function runTask(task, timeoutMs, evaluationContext) {
  const taskDir = mkdtempSync(`${tmpdir()}/swe-bench-${sanitize(task.instance_id)}-`);
  const startMs = performance.now();
  const artifactDir = resolve(evaluationContext.taskArtifactDir, sanitize(task.instance_id));
  mkdirSync(artifactDir, { recursive: false });
  const claimPath = resolve(artifactDir, "claim.json");
  const receiptPath = resolve(artifactDir, "receipt.json");
  const evidencePath = resolve(artifactDir, "attempt-evidence.jsonl");
  const stdoutPath = resolve(artifactDir, "stdout.txt");
  const stderrPath = resolve(artifactDir, "stderr.txt");
  const processReceiptPath = resolve(artifactDir, "process-receipt.json");
  const diagnosticPatchPath = resolve(artifactDir, "diagnostic.patch");
  writeJsonExclusive(claimPath, {
    schemaVersion: 1,
    instanceId: task.instance_id,
    repo: task.repo,
    baseCommit: task.base_commit,
    candidateId: evaluationContext.candidateId,
    evaluationBatchId: evaluationContext.evaluationBatchId,
    formalRunId: evaluationContext.formalRunId,
    timeoutMs,
  });
  const finish = (disposition, failureStage, extra = {}) => {
    const result = taskResult(task, startMs, {
      disposition,
      ...(failureStage === undefined ? {} : { failureStage }),
      claim: artifactReference(claimPath),
      ...(existsSync(evidencePath) ? { evidence: artifactReference(evidencePath) } : {}),
      ...(existsSync(stdoutPath) ? { stdout: artifactReference(stdoutPath) } : {}),
      ...(existsSync(stderrPath) ? { stderr: artifactReference(stderrPath) } : {}),
      ...(existsSync(processReceiptPath)
        ? { processReceipt: artifactReference(processReceiptPath) }
        : {}),
      ...(existsSync(diagnosticPatchPath)
        ? { diagnosticPatch: artifactReference(diagnosticPatchPath) }
        : {}),
      ...extra,
    });
    writeJsonExclusive(receiptPath, {
      schemaVersion: 1,
      ...result,
      receiptPath: relative(repoRoot, receiptPath),
    });
    return { ...result, taskReceiptPath: relative(repoRoot, receiptPath) };
  };
  let failureStage = "clone";
  try {
    // Clone the repo at the base commit (shallow).
    const cloneResult = runGitCommand({
      args: ["clone", "--depth", "1", `https://github.com/${task.repo}.git`, "repo"],
      cwd: taskDir,
    });
    if (cloneResult.status !== 0) {
      return finish("generation-inconclusive", failureStage, {
        error: `Clone failed: ${describeGitFailure(cloneResult)}`,
        benchmarkInconclusive: true,
      });
    }

    const repoDir = resolve(taskDir, "repo");
    if (task.base_commit) {
      failureStage = "fetch";
      const fetchResult = runGitCommand({
        args: ["fetch", "--no-auto-maintenance", "--depth", "1", "origin", task.base_commit],
        cwd: repoDir,
      });
      if (fetchResult.status !== 0) {
        return finish("generation-inconclusive", failureStage, {
          error: `Base commit fetch failed: ${describeGitFailure(fetchResult)}`,
          benchmarkInconclusive: true,
        });
      }
      failureStage = "checkout";
      const checkout = spawnSync("git", ["checkout", task.base_commit], {
        cwd: repoDir,
        encoding: "utf8",
      });
      if (checkout.status !== 0) {
        return finish("generation-inconclusive", failureStage, {
          error: `Base commit checkout failed: ${describeGitFailure(checkout)}`,
          benchmarkInconclusive: true,
        });
      }
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" });
      if (head.status !== 0 || head.stdout.trim() !== task.base_commit) {
        return finish("generation-inconclusive", failureStage, {
          error: "Checked-out HEAD does not match the frozen SWE-bench base commit.",
          benchmarkInconclusive: true,
        });
      }
      failureStage = "isolation";
      const isolation = isolateFrozenGitCommit(repoDir);
      if (isolation.status !== 0) {
        return finish("generation-inconclusive", failureStage, {
          error: `Frozen repository isolation failed: ${describeGitFailure(isolation)}`,
          benchmarkInconclusive: true,
        });
      }
    } else {
      return finish("generation-inconclusive", "task-admission", {
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
      "--attempt-evidence",
      evidencePath,
      prompt,
    ];
    failureStage = "cli-run";
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
    writeFileSync(stdoutPath, cliResult.stdout, { flag: "wx" });
    writeFileSync(stderrPath, cliResult.stderr, { flag: "wx" });
    writeJsonExclusive(processReceiptPath, {
      schemaVersion: 1,
      status: cliResult.status,
      signal: cliResult.signal,
      timedOut: cliResult.timedOut,
      stdoutOverflow: cliResult.stdoutOverflow,
      stderrOverflow: cliResult.stderrOverflow,
      stdout: artifactReference(stdoutPath),
      stderr: artifactReference(stderrPath),
      ...(cliResult.error === undefined
        ? {}
        : {
            spawnError:
              cliResult.error instanceof Error ? cliResult.error.message : String(cliResult.error),
          }),
    });
    if (cliResult.error !== undefined) {
      return finish("generation-inconclusive", "cli-spawn", {
        error: cliResult.error instanceof Error ? cliResult.error.message : String(cliResult.error),
        benchmarkInconclusive: true,
      });
    }
    if (cliResult.stdoutOverflow || cliResult.stderrOverflow) {
      return finish("generation-inconclusive", "process-output", {
        error: "CLI process output exceeded the admitted bound.",
        benchmarkInconclusive: true,
      });
    }
    const evidenceAdmission = inspectAttemptEvidence(evidencePath);
    if (cliResult.timedOut) {
      let diagnosticError;
      try {
        const diagnosticPatch = captureTerminalPatch({
          repoDir,
          baseCommit: task.base_commit,
          temporaryIndexPath: resolve(taskDir, "timeout-diagnostic.index"),
        });
        if (diagnosticPatch.length > 0) {
          writeFileSync(diagnosticPatchPath, diagnosticPatch, { flag: "wx" });
        }
      } catch (error) {
        diagnosticError = error instanceof Error ? error.message : String(error);
      }
      if (!evidenceAdmission.prefixValid) {
        return finish("generation-inconclusive", "evidence", {
          error: `Timed-out attempt evidence is malformed: ${evidenceAdmission.reason}`,
          benchmarkInconclusive: true,
        });
      }
      return finish("model-timeout", undefined, {
        timedOut: true,
        ...(diagnosticError === undefined ? {} : { diagnosticError }),
      });
    }
    if (cliResult.status !== 0 || cliResult.signal !== null) {
      return finish("generation-inconclusive", "process", {
        error: `CLI did not complete normally (status=${cliResult.status}, signal=${cliResult.signal}).`,
        benchmarkInconclusive: true,
      });
    }
    if (!evidenceAdmission.complete || evidenceAdmission.rootStatus !== "completed") {
      return finish("generation-inconclusive", "evidence", {
        error: `Completed CLI evidence was not admitted: ${evidenceAdmission.reason}, rootStatus=${evidenceAdmission.rootStatus ?? "missing"}`,
        benchmarkInconclusive: true,
      });
    }

    // Capture the exact base-to-terminal-worktree patch without trusting or mutating the
    // repository index, which the model may have staged or committed during the attempt.
    failureStage = "patch-freeze";
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
      return finish("no-diff", undefined, {
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
    return finish("frozen-prediction", undefined, {
      patchLines: agentPatch.split("\n").length,
      prediction: artifactReference(predictionPath),
      patchSha256: prediction.modelPatchSha256,
      agentPatch:
        agentPatch.length > 10_000 ? agentPatch.slice(0, 10_000) + "\n... (truncated)" : agentPatch,
    });
  } catch (error) {
    if (existsSync(receiptPath)) throw error;
    return finish("generation-inconclusive", failureStage, {
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

/** Runs the CLI as a detached process group so a per-task timeout can kill the whole tree.
 *  spawnSync's timeout only signals the direct child; the CLI's sandbox grandchildren can
 *  keep the stdio pipe open and delay the return for a second full timeout (observed ~2x).
 *  Returns an async equivalent of the spawnSync result plus a timedOut flag. */
export function runCliProcess({ args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...value,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutOverflow,
        stderrOverflow,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
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
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = 8 * 1024 * 1024 - stdoutBytes;
      if (remaining <= 0) {
        stdoutOverflow = true;
        return;
      }
      stdoutChunks.push(bytes.subarray(0, remaining));
      stdoutBytes += Math.min(bytes.byteLength, remaining);
      if (bytes.byteLength > remaining) stdoutOverflow = true;
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = 8 * 1024 * 1024 - stderrBytes;
      if (remaining <= 0) {
        stderrOverflow = true;
        return;
      }
      stderrChunks.push(bytes.subarray(0, remaining));
      stderrBytes += Math.min(bytes.byteLength, remaining);
      if (bytes.byteLength > remaining) stderrOverflow = true;
    });
    child.on("error", (error) => {
      if (timedOut) return;
      settle({ status: null, signal: null, error });
    });
    child.on("close", (code, signal) => {
      settle({ status: code, signal });
    });
  });
}

/** Catastrophic-failure wrapper: an unexpected throw inside runTask must still produce a
 *  per-task record instead of rejecting the batch (which would abort the whole CI job). */
async function runTaskSafe(task, timeoutMs, evaluationContext) {
  const started = performance.now();
  try {
    return await runTask(task, timeoutMs, evaluationContext);
  } catch (error) {
    const artifactDir = resolve(evaluationContext.taskArtifactDir, sanitize(task.instance_id));
    const receiptPath = resolve(artifactDir, "receipt.json");
    if (existsSync(receiptPath)) {
      return {
        ...JSON.parse(readFileSync(receiptPath, "utf8")),
        taskReceiptPath: relative(repoRoot, receiptPath),
      };
    }
    const result = taskResult(task, started, {
      disposition: "generation-inconclusive",
      failureStage: "harness",
      error: `Harness failure: ${error instanceof Error ? error.message : String(error)}`,
      benchmarkInconclusive: true,
    });
    if (existsSync(artifactDir)) {
      writeJsonExclusive(receiptPath, {
        schemaVersion: 1,
        ...result,
        receiptPath: relative(repoRoot, receiptPath),
      });
      return { ...result, taskReceiptPath: relative(repoRoot, receiptPath) };
    }
    return result;
  }
}

function runGitCommand({ args, cwd }) {
  return spawnSync(
    "git",
    ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );
}

export function isolateFrozenGitCommit(repoDir) {
  const script = [
    "set -eu",
    "git config gc.auto 0",
    "git config maintenance.auto false",
    "git remote remove origin",
    "git for-each-ref --format='%(refname)' refs/heads refs/remotes refs/tags | while IFS= read -r ref; do git update-ref -d \"$ref\"; done",
    "if git symbolic-ref -q refs/remotes/origin/HEAD >/dev/null; then git symbolic-ref -d refs/remotes/origin/HEAD; fi",
    "git reflog expire --expire=now --all",
    "git gc --prune=now",
    'test -z "$(git remote)"',
    "test -z \"$(git for-each-ref --format='%(refname)' refs/heads refs/remotes refs/tags)\"",
    'test -z "$(git fsck --unreachable --no-reflogs 2>&1)"',
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

function writeJsonExclusive(path, value) {
  writeJsonTextDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonTextDurable(path, text) {
  const descriptor = openSync(path, "wx");
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function artifactReference(path) {
  return {
    path: relative(repoRoot, path),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function inspectAttemptEvidence(path) {
  if (!existsSync(path)) return { prefixValid: false, complete: false, reason: "missing" };
  const bytes = readFileSync(path);
  if (bytes.byteLength > 1024 * 1024 * 1024) {
    return { prefixValid: false, complete: false, reason: "oversized" };
  }
  const parts = bytes.toString("utf8").split("\n");
  const partialTail = parts.pop();
  const records = [];
  try {
    for (const line of parts) {
      if (line.length === 0) continue;
      records.push(JSON.parse(line));
    }
  } catch {
    return { prefixValid: false, complete: false, reason: "malformed-record" };
  }
  for (let sequence = 0; sequence < records.length; sequence += 1) {
    if (records[sequence]?.sequence !== sequence) {
      return { prefixValid: false, complete: false, reason: "sequence-gap" };
    }
  }
  if (records.length === 0) {
    return { prefixValid: false, complete: false, reason: "empty-prefix" };
  }
  if (
    !exactKeys(records[0], ["maxBytes", "rootRunId", "schemaVersion", "sequence", "type"]) ||
    records[0].type !== "header" ||
    records[0].schemaVersion !== 1 ||
    records[0].maxBytes !== 1024 * 1024 * 1024 ||
    typeof records[0].rootRunId !== "string"
  ) {
    return { prefixValid: false, complete: false, reason: "invalid-header" };
  }
  const requests = new Map();
  const requestOrder = [];
  const closures = new Set();
  const terminals = new Set();
  const resources = new Set();
  let rootStatus;
  const counts = { modelRequest: 0, modelOutcome: 0, modelFailure: 0, terminalSnapshot: 0 };
  const footer = records.at(-1)?.type === "footer" ? records.at(-1) : undefined;
  const body = footer === undefined ? records.slice(1) : records.slice(1, -1);
  for (const record of body) {
    if (record.type === "model-request") {
      if (
        !exactKeys(record, [
          "invocationId",
          "request",
          "resourceId",
          "runId",
          "sequence",
          "type",
        ]) ||
        typeof record.invocationId !== "string" ||
        requests.has(record.invocationId) ||
        record.resourceId !== record.runId ||
        !validModelRequest(record.request, record.resourceId)
      ) {
        return { prefixValid: false, complete: false, reason: "invalid-model-request" };
      }
      requests.set(record.invocationId, record.resourceId);
      requestOrder.push(record.invocationId);
      resources.add(record.resourceId);
      counts.modelRequest += 1;
    } else if (record.type === "model-outcome" || record.type === "model-failure") {
      const valueKey = record.type === "model-outcome" ? "outcome" : "failure";
      if (
        !exactKeys(record, ["invocationId", valueKey, "resourceId", "runId", "sequence", "type"]) ||
        closures.has(record.invocationId) ||
        record.resourceId !== record.runId ||
        requests.get(record.invocationId) !== record.resourceId ||
        !validModelClosure(record[valueKey], record.type)
      ) {
        return { prefixValid: false, complete: false, reason: "invalid-model-closure" };
      }
      closures.add(record.invocationId);
      counts[record.type === "model-outcome" ? "modelOutcome" : "modelFailure"] += 1;
    } else if (record.type === "terminal-snapshot") {
      if (
        !exactKeys(record, ["resourceId", "runId", "sequence", "snapshot", "type"]) ||
        terminals.has(record.resourceId) ||
        record.resourceId !== record.runId ||
        !validTerminalSnapshot(record.snapshot, record.resourceId)
      ) {
        return { prefixValid: false, complete: false, reason: "invalid-terminal-snapshot" };
      }
      terminals.add(record.resourceId);
      resources.add(record.resourceId);
      if (record.resourceId === records[0].rootRunId) rootStatus = record.snapshot.status;
      counts.terminalSnapshot += 1;
    } else {
      return { prefixValid: false, complete: false, reason: "unknown-record" };
    }
  }
  if (footer === undefined) {
    return {
      prefixValid: true,
      complete: false,
      reason: partialTail.length === 0 ? "missing-footer" : "partial-tail",
    };
  }
  const footerKeys = [
    "complete",
    "expectedCounts",
    "invocationIds",
    "prefixSha256",
    "resourceIds",
    "rootRunId",
    "sequence",
    "type",
    "writtenCounts",
    ...(footer.failureReason === undefined ? [] : ["failureReason"]),
  ];
  if (!exactKeys(footer, footerKeys)) {
    return { prefixValid: false, complete: false, reason: "invalid-footer" };
  }
  const prefix = `${parts.slice(0, -1).join("\n")}\n`;
  if (createHash("sha256").update(prefix).digest("hex") !== footer.prefixSha256) {
    return { prefixValid: false, complete: false, reason: "prefix-hash-mismatch" };
  }
  const paired =
    requests.size === closures.size &&
    [...requests.keys()].every((invocationId) => closures.has(invocationId));
  const countMatch =
    JSON.stringify(counts) === JSON.stringify(footer.expectedCounts) &&
    JSON.stringify(counts) === JSON.stringify(footer.writtenCounts);
  const complete =
    footer.complete === true &&
    partialTail.length === 0 &&
    requests.size > 0 &&
    paired &&
    countMatch &&
    footer.rootRunId === records[0].rootRunId &&
    JSON.stringify(footer.invocationIds) === JSON.stringify(requestOrder) &&
    JSON.stringify(footer.resourceIds) === JSON.stringify([...resources]) &&
    terminals.size === resources.size &&
    rootStatus !== undefined;
  return {
    prefixValid: true,
    complete,
    reason: complete ? "complete" : "incomplete-footer",
    ...(rootStatus === undefined ? {} : { rootStatus }),
  };
}

function validModelRequest(request, resourceId) {
  if (
    !exactKeys(request, ["externalContext", "instructions", "messages", "tools"]) ||
    !Array.isArray(request.externalContext) ||
    !Array.isArray(request.instructions) ||
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    !Array.isArray(request.tools)
  ) {
    return false;
  }
  return runKeyId(request.messages.at(-1)?.runKey) === resourceId;
}

function validModelClosure(value, recordType) {
  if (recordType === "model-failure") {
    return (
      exactKeys(value, ["kind", "reason"]) &&
      value.kind === "failure" &&
      ["provider", "transport", "throw", "malformed"].includes(value.reason)
    );
  }
  if (
    !exactKeys(value, ["candidate", "kind"]) ||
    value.kind !== "response" ||
    !validAssistantMessage(value.candidate)
  ) {
    return false;
  }
  return true;
}

function validAssistantMessage(value) {
  const keys = ["content", "toolCalls", ...(value?.reasoning === undefined ? [] : ["reasoning"])];
  return (
    exactKeys(value, keys) &&
    typeof value.content === "string" &&
    (value.reasoning === undefined || typeof value.reasoning === "string") &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(
      (call) =>
        exactKeys(call, ["callId", "input", "name"]) &&
        typeof call.callId === "string" &&
        typeof call.name === "string",
    )
  );
}

function validTerminalSnapshot(snapshot, resourceId) {
  return (
    exactKeys(snapshot, [
      "cycle",
      "deadlineAt",
      "key",
      "status",
      "stopFlag",
      "terminalCause",
      "transcript",
    ]) &&
    ["cancelled", "completed", "failed"].includes(snapshot.status) &&
    typeof snapshot.terminalCause === "string" &&
    [
      "completed",
      "context-unavailable",
      "request-too-large",
      "model-failure",
      "invalid-model-response",
      "model-output-too-large",
      "max-accepted-tool-calls",
      "max-model-cycles",
      "tool-unknown",
      "run-deadline",
      "stopped",
      "session-closed",
      "agent-closed",
    ].includes(snapshot.terminalCause) &&
    (snapshot.status !== "completed" || snapshot.terminalCause === "completed") &&
    typeof snapshot.stopFlag === "boolean" &&
    Number.isSafeInteger(snapshot.cycle) &&
    snapshot.cycle >= 0 &&
    Number.isFinite(snapshot.deadlineAt) &&
    Array.isArray(snapshot.transcript) &&
    snapshot.transcript.length > 0 &&
    snapshot.transcript.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        ["assistant", "tool", "user"].includes(entry.kind) &&
        runKeyId(entry.runKey) === resourceId,
    ) &&
    runKeyId(snapshot.key) === resourceId
  );
}

function runKeyId(key) {
  if (
    !exactKeys(key, ["kind", "sequence", "sessionKey"]) ||
    key.kind !== "run" ||
    !exactKeys(key.sessionKey, ["agentIdentity", "kind", "sequence"]) ||
    key.sessionKey.kind !== "session" ||
    typeof key.sessionKey.agentIdentity !== "string" ||
    !Number.isSafeInteger(key.sessionKey.sequence) ||
    !Number.isSafeInteger(key.sequence)
  ) {
    return undefined;
  }
  return JSON.stringify([key.sessionKey.agentIdentity, key.sessionKey.sequence, key.sequence]);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function taskResult(task, startMs, extra = {}) {
  return {
    instance_id: task.instance_id,
    repo: task.repo,
    base_commit: task.base_commit,
    problem_statement: task.problem_statement,
    wallMs: Number((performance.now() - startMs).toFixed(1)),
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
