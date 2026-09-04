#!/usr/bin/env node
/**
 * Terminal-Bench 4.0 per-task generation harness.
 *
 * Runs exactly one frozen task attempt through Harbor's Docker environment with
 * the pinned best-agent CLI (installed-agent plugin), then freezes the trial
 * outcome and the complete inference-time artifacts. The official terminal-bench
 * verifier (from the frozen task repo) is the only grader; this script only
 * transcribes Harbor's canonical trial record and never re-parses test output.
 *
 * Usage:
 *   node scripts/terminal-bench-harness.mjs [options]
 *
 * Options:
 *   --task <name>                     task name (terminal-bench/<dir>)
 *   --corpus <path>                   frozen manifest from prepare-terminal-bench.mjs
 *   --source <path>                   terminal-bench checkout (pinned commit)
 *   --output <path>                   frozen per-task result JSON
 *   --jobs-dir <path>                 harbor -o jobs dir for this task
 *   --job-name <name>                 harbor job name
 *   --model <id>                      provider model
 *   --agent-timeout-multiplier <f>    multiplier over task agent timeout
 *   --candidate-id <id>               candidate identity (cli-<ver>-<commit>)
 *   --batch-id <id>                   batch label
 *   --formal-run-id <id>              formal/diagnostic run id
 *   --timeout-ms <ms>                 provider/CLI per-task timeout
 *
 * Environment:
 *   BEST_AGENT_PROVIDER_CONFIG / DIMCODE_HOME  frozen provider identity files
 *   BEST_AGENT_PROVIDER_MODEL / BENCHMARK_PROVIDER_API_KEY  credential context
 *   BEST_AGENT_CLI_CANDIDATE_DIR            pre-attempt Linux candidate artifact
 *   TB_HARBOR_BIN                            harbor binary (default: harbor)
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectAttemptEvidence } from "./swe-bench-harness.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "terminal-bench.json"), "utf8"),
);

function sha256File(path) {
  if (!existsSync(path)) return undefined;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findResultJson(jobsDir, jobName) {
  const jobDir = resolve(jobsDir, jobName);
  if (!existsSync(jobDir)) return undefined;
  const candidates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) continue;
      if (existsSync(join(path, "result.json"))) candidates.push(path);
    }
  };
  walk(jobDir);
  return candidates.sort().pop(); // latest trial dir if several
}

function parseArgs(argv) {
  const parsed = {
    task: undefined,
    corpus: undefined,
    source: undefined,
    output: undefined,
    jobsDir: undefined,
    jobName: undefined,
    model: undefined,
    agentTimeoutMultiplier: config.generation.defaultAgentTimeoutMultiplier,
    candidateId: "unknown",
    batchId: "local",
    formalRunId: "diagnostic-local",
    timeoutMs: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--task":
        parsed.task = argv[++i];
        break;
      case "--corpus":
        parsed.corpus = resolve(argv[++i]);
        break;
      case "--source":
        parsed.source = resolve(argv[++i]);
        break;
      case "--output":
        parsed.output = resolve(argv[++i]);
        break;
      case "--jobs-dir":
        parsed.jobsDir = resolve(argv[++i]);
        break;
      case "--job-name":
        parsed.jobName = argv[++i];
        break;
      case "--model":
        parsed.model = argv[++i];
        break;
      case "--agent-timeout-multiplier":
        parsed.agentTimeoutMultiplier = Number(argv[++i]);
        break;
      case "--candidate-id":
        parsed.candidateId = argv[++i];
        break;
      case "--batch-id":
        parsed.batchId = argv[++i];
        break;
      case "--formal-run-id":
        parsed.formalRunId = argv[++i];
        break;
      case "--timeout-ms": {
        const raw = argv[++i];
        parsed.timeoutMs = raw === undefined || raw === "" ? undefined : Number(raw);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  for (const key of ["task", "corpus", "source", "output", "jobsDir", "jobName", "model"]) {
    if (!parsed[key]) throw new Error(`--${key} is required.`);
  }
  if (
    !Number.isFinite(parsed.agentTimeoutMultiplier) ||
    parsed.agentTimeoutMultiplier <= 0
  ) {
    throw new Error("--agent-timeout-multiplier must be a positive number.");
  }
  return parsed;
}

export function verifyFrozenIdentity() {
  const cli = config.cli;
  const candidateDir = process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
  if (!candidateDir) {
    throw new Error("BEST_AGENT_CLI_CANDIDATE_DIR is required.");
  }
  const candidatePath = join(candidateDir, "candidate.json");
  const tarballPath = join(candidateDir, "best-agent-cli.tgz");
  const buildReportPath = join(candidateDir, "build-report.json");
  if (!existsSync(candidatePath) || !existsSync(tarballPath) || !existsSync(buildReportPath)) {
    throw new Error("Current Linux candidate artifact is incomplete.");
  }
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  if (
    candidate.schemaVersion !== 1 ||
    candidate.packageName !== cli.packageName ||
    candidate.cliVersion !== cli.cliVersion ||
    candidate.sourceRepository !== cli.sourceRepository ||
    candidate.sourceCommit !== cli.sourceCommit ||
    candidate.target !== cli.target ||
    candidate.tarballSha256 !== sha256File(tarballPath) ||
    candidate.buildReportSha256 !== sha256File(buildReportPath) ||
    !/^[0-9a-f]{64}$/u.test(candidate.binarySha256) ||
    !/^[0-9a-f]{64}$/u.test(candidate.lockfileSha256) ||
    !/^[0-9a-f]{64}$/u.test(candidate.runtimeLockSha256) ||
    typeof candidate.runtimeDependencies !== "object" ||
    candidate.runtimeDependencies === null
  ) {
    throw new Error("Current Linux candidate identity does not match config/terminal-bench.json.");
  }
  const provider = config.provider;
  const model = process.env.BEST_AGENT_PROVIDER_MODEL ?? provider.model;
  if (model !== provider.model) {
    throw new Error(
      `BEST_AGENT_PROVIDER_MODEL ${model} does not match the frozen provider model ${provider.model}.`,
    );
  }
  const providerOverride = process.env.BEST_AGENT_PROVIDER_CONFIG;
  if (!providerOverride || !existsSync(providerOverride)) {
    throw new Error("BEST_AGENT_PROVIDER_CONFIG must point to the frozen provider.json.");
  }
  const dimcodeHome = process.env.DIMCODE_HOME;
  if (!dimcodeHome || !existsSync(join(dimcodeHome, "config.json"))) {
    throw new Error("DIMCODE_HOME must point to the frozen dimcode home.");
  }
  process.env.BEST_AGENT_CLI_TARBALL = tarballPath;
  process.env.BEST_AGENT_CLI_TARBALL_SHA256 = candidate.tarballSha256;
  process.env.BEST_AGENT_CLI_BINARY_SHA256 = candidate.binarySha256;
  process.env.BEST_AGENT_CLI_RUNTIME_LOCK_SHA256 = candidate.runtimeLockSha256;
  process.env.BEST_AGENT_CLI_VERSION = candidate.cliVersion;
  process.env.BEST_AGENT_CLI_WORKSPACE = config.workspace;
  const execution = config.generation.executionProfile;
  process.env.BEST_AGENT_CLI_EXECUTION_ARGS_JSON = JSON.stringify([
    "--workspace",
    config.workspace,
    "--workspace-backend",
    execution.workspaceBackend,
    "--workspace-authorization",
    execution.workspaceAuthorization,
    "--process-isolation",
    execution.processIsolation,
    "--command-policy",
    execution.commandPolicy,
    ...execution.workspaceGrants.flatMap((grant) => ["--workspace-grant", grant]),
    ...(config.generation.toolExcludeNetwork ? ["--tool-exclude", "network"] : []),
  ]);
  return {
    packageName: candidate.packageName,
    cliVersion: candidate.cliVersion,
    target: candidate.target,
    binarySha256: candidate.binarySha256,
    candidateManifestSha256: sha256File(candidatePath),
    candidatePath,
    model,
  };
}

export function projectTrialResult(trialResult) {
  const verifier = trialResult.verifier_result;
  const rewardValues =
    verifier?.rewards && Object.keys(verifier.rewards).length > 0
      ? verifier.rewards
      : undefined;
  const sourceException = trialResult.exception_info;
  const exception = sourceException
    ? {
        type: String(sourceException.exception_type ?? sourceException.type ?? "error"),
        message: String(sourceException.exception_message ?? sourceException.message ?? ""),
      }
    : undefined;
  if (exception) return { disposition: "error", rewardValues, exception };
  if (rewardValues) {
    if (rewardValues.reward !== 0 && rewardValues.reward !== 1) {
      return { disposition: "inconclusive", rewardValues, exception: undefined };
    }
    return {
      disposition: rewardValues.reward === 1 ? "passed" : "failed",
      rewardValues,
      exception: undefined,
    };
  }
  return { disposition: "inconclusive", rewardValues: undefined, exception: undefined };
}

function runHarbor(harborBin, args, env, stdioBase) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(harborBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutPath = `${stdioBase}.stdout.txt`;
    const stderrPath = `${stdioBase}.stderr.txt`;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      mkdirSync(dirname(stdoutPath), { recursive: true });
      writeFileSync(stdoutPath, stdout);
      writeFileSync(stderrPath, stderr);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const frozen = JSON.parse(readFileSync(args.corpus, "utf8"));
  if (frozen.profileId !== config.profileId) {
    throw new Error("Frozen corpus profile does not match config.");
  }
  const task = frozen.tasks.find((entry) => entry.name === args.task);
  if (!task) {
    throw new Error(`Task ${args.task} is not in the frozen corpus.`);
  }

  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: args.source,
    encoding: "utf8",
  });
  const unpinnedAllowed = process.env.TB_ALLOW_UNPINNED_SOURCE === "1";
  if (head.status !== 0 || head.stdout.trim() !== frozen.dataset.sourceCommit) {
    if (!unpinnedAllowed) {
      throw new Error(
        `terminal-bench checkout HEAD mismatch: expected ${frozen.dataset.sourceCommit}.`,
      );
    }
    process.stderr.write(
      "WARNING: TB_ALLOW_UNPINNED_SOURCE=1 skips the pinned-commit verification " +
        "(local development only; CI never sets this).\n",
    );
  }
  const taskDir = join(args.source, "tasks", args.task.split("/").pop());
  if (!existsSync(join(taskDir, "task.toml"))) {
    throw new Error(`task.toml missing under ${taskDir}.`);
  }

  const candidate = verifyFrozenIdentity();
  const { packageName, cliVersion, model } = candidate;

  if (existsSync(args.output)) {
    throw new Error(`Refusing to overwrite ${args.output}.`);
  }
  mkdirSync(args.jobsDir, { recursive: true });

  const effectiveAgentTimeoutSec = task.agentTimeoutSec * args.agentTimeoutMultiplier;
  const providerTimeoutMs =
    args.timeoutMs ??
    Math.max(60_000, Math.round((effectiveAgentTimeoutSec - 60) * 1000));
  // Keep the in-container CLI timeout identical to the harness-derived value so
  // the agent fails cleanly before Harbor kills the trial.
  process.env.BEST_AGENT_TIMEOUT_MS = String(providerTimeoutMs);

  const harborBin = process.env.TB_HARBOR_BIN ?? "harbor";
  const harborArgs = [
    "run",
    "-p",
    taskDir,
    "--agent-import-path",
    "terminal_bench_best_agent:BestAgentCli",
    "-m",
    model,
    "-e",
    "docker",
    "-o",
    args.jobsDir,
    "--job-name",
    args.jobName,
    "-k",
    "1",
    "--agent-timeout-multiplier",
    String(args.agentTimeoutMultiplier),
    "--agent-setup-timeout-multiplier",
    String(config.generation.agentSetupTimeoutMultiplier),
    "--cpus",
    "ignore",
    "--memory",
    "ignore",
  ];

  const startMs = Date.now();
  const harborEnv = { ...process.env };
  delete harborEnv.BENCHMARK_PROVIDER_API_KEY;
  const result = await runHarbor(harborBin, harborArgs, harborEnv, args.output);
  const durationMs = Date.now() - startMs;

  const trialDir = findResultJson(args.jobsDir, args.jobName);
  let projected = {
    disposition: "not-evaluated",
    rewardValues: undefined,
    exception: undefined,
  };
  if (!trialDir) {
    projected = { ...projected, disposition: "not-evaluated" };
  } else {
    const trialResult = JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8"));
    projected = projectTrialResult(trialResult);
  }
  const { disposition, rewardValues, exception } = projected;

  const evidencePath =
    trialDir && existsSync(join(trialDir, "agent", "best-agent-evidence.jsonl"))
      ? join(trialDir, "agent", "best-agent-evidence.jsonl")
      : undefined;
  const stdoutPath = trialDir ? join(trialDir, "agent", "best-agent-stdout.txt") : undefined;
  const stderrPath = trialDir ? join(trialDir, "agent", "best-agent-stderr.txt") : undefined;
  const processReceiptPath = trialDir
    ? join(trialDir, "agent", "best-agent-process-receipt.json")
    : undefined;
  const harborResultPath = trialDir ? join(trialDir, "result.json") : undefined;
  const harborStdoutPath = `${args.output}.stdout.txt`;
  const harborStderrPath = `${args.output}.stderr.txt`;
  const evidenceSha256 = evidencePath ? sha256File(evidencePath) : undefined;
  const evidenceAdmission = evidencePath
    ? inspectAttemptEvidence(evidencePath)
    : { prefixValid: false, complete: false, reason: "missing" };
  const record = {
    schemaVersion: 1,
    task: {
      name: task.name,
      digest: task.digest,
      instructionSha256: task.instructionSha256,
      datasetOrder: task.datasetOrder,
      resourceExceededOnHostedRunner: config.resourceExceededTasks.includes(task.name),
    },
    candidateId: args.candidateId,
    cliPackage: packageName,
    cliVersion,
    cliTarget: candidate.target,
    cliBinarySha256: candidate.binarySha256,
    candidateManifestSha256: candidate.candidateManifestSha256,
    model,
    batchId: args.batchId,
    formalRunId: args.formalRunId,
    harborVersion: config.harbor.version,
    agentTimeoutMultiplier: args.agentTimeoutMultiplier,
    effectiveAgentTimeoutSec,
    providerTimeoutMs,
    jobName: args.jobName,
    trialDir: trialDir ? relative(repoRoot, trialDir) : undefined,
    result: {
      disposition,
      ...(rewardValues === undefined ? {} : { rewards: rewardValues }),
      ...(exception === undefined ? {} : { exception }),
    },
    evidenceAdmission,
    artifacts: {
      ...(evidencePath && existsSync(evidencePath)
        ? { evidence: relative(repoRoot, evidencePath), evidenceSha256 }
        : {}),
      ...(stdoutPath && existsSync(stdoutPath)
        ? { stdout: relative(repoRoot, stdoutPath), stdoutSha256: sha256File(stdoutPath) }
        : {}),
      ...(stderrPath && existsSync(stderrPath)
        ? { stderr: relative(repoRoot, stderrPath), stderrSha256: sha256File(stderrPath) }
        : {}),
      ...(processReceiptPath && existsSync(processReceiptPath)
        ? {
            processReceipt: relative(repoRoot, processReceiptPath),
            processReceiptSha256: sha256File(processReceiptPath),
          }
        : {}),
      ...(harborResultPath && existsSync(harborResultPath)
        ? {
            harborResult: relative(repoRoot, harborResultPath),
            harborResultSha256: sha256File(harborResultPath),
          }
        : {}),
      candidate: relative(repoRoot, candidate.candidatePath),
    },
    durationMs,
    harborExitCode: result.code,
    harborSignal: result.signal,
    harborStdout: relative(repoRoot, harborStdoutPath),
    harborStdoutSha256: sha256File(harborStdoutPath),
    harborStderr: relative(repoRoot, harborStderrPath),
    harborStderrSha256: sha256File(harborStderrPath),
  };
  writeFileSync(args.output, `${JSON.stringify(record, null, 2)}\n`);

  const markdown = [
    `## ${task.name}`,
    "",
    `| field | value |`,
    `| --- | --- |`,
    `| disposition | ${disposition} |`,
    ...(rewardValues
      ? Object.entries(rewardValues).map(
          ([key, value]) => `| reward ${key} | ${value} |`,
        )
      : []),
    `| duration | ${Math.round(durationMs / 1000)}s |`,
    `| candidate | ${args.candidateId} |`,
    `| cli | ${cliVersion} |`,
    `| model | ${model} |`,
    ...(exception ? [`| exception | ${exception.type}: ${exception.message.slice(0, 300)} |`] : []),
    "",
  ].join("\n");
  writeFileSync(`${args.output}.md`, markdown);
  process.stdout.write(`${JSON.stringify(record.result)}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`terminal-bench-harness: ${error.stack ?? error}\n`);
    process.exit(1);
  });
}
