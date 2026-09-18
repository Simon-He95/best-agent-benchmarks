#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 per-task generation harness.
 *
 * Runs exactly one frozen task attempt through Pier's Docker environment with
 * the pinned best-agent CLI (installed-agent plugin), then freezes the trial
 * outcome and the complete inference-time artifacts. The task's own verifier
 * (inside the frozen task image) is the only grader; this script only
 * transcribes Pier's canonical trial record and never re-parses test output.
 *
 * Composition fairness: one headless `best-agent run` per task (no TUI, no
 * interaction tools), full workspace permissions, tools that cannot work in
 * the air-gapped task environment (network) are excluded up front, one frozen
 * candidate, one predeclared attempt, and no evaluator output ever re-enters
 * the model attempt.
 *
 * Usage:
 *   node scripts/frontier-harness-harness.mjs [options]
 *
 * Options:
 *   --task <id>                       suite-prefixed task id (terminal-bench/<dir> | datacurve/<dir>)
 *   --corpus <path>                   frozen manifest from prepare-frontier-harness.mjs
 *   --source <path>                   frontier-harness-eval checkout (pinned commit)
 *   --output <path>                   frozen per-task result JSON
 *   --jobs-dir <path>                 pier -o jobs dir for this task
 *   --job-name <name>                 pier job name
 *   --model <id>                      provider model
 *   --agent-timeout-multiplier <f>    multiplier over task agent timeout
 *   --candidate-id <id>               candidate identity (cli-<ver>-<commit>)
 *   --batch-id <id>                   batch label
 *   --formal-run-id <id>              formal/diagnostic run id
 *   --timeout-ms <ms>                 provider/CLI per-task timeout
 *
 * Environment:
 *   BEST_AGENT_PROVIDER_CONFIG / DIMCODE_HOME / BEST_AGENT_PROVIDER_BASE_URL
 *                                     frozen provider identity files and gateway
 *   BEST_AGENT_PROVIDER_MODEL         credential context
 *   BEST_AGENT_CLI_CANDIDATE_DIR      pre-attempt assembled cjs candidate artifact
 *   FH_PIER_BIN                       pier binary (default: pier)
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

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "frontier-harness.json"), "utf8"),
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
    !/^[0-9a-f]{64}$/u.test(candidate.nodeBinarySha256) ||
    !/^v\d+\.\d+\.\d+$/u.test(candidate.nodeVersion) ||
    typeof candidate.runtimeDependencies !== "object" ||
    candidate.runtimeDependencies === null
  ) {
    throw new Error("Current Linux candidate identity does not match config/frontier-harness.json.");
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
  if (!process.env.BEST_AGENT_PROVIDER_BASE_URL) {
    throw new Error("BEST_AGENT_PROVIDER_BASE_URL is required for the agent egress allowlist.");
  }
  process.env.BEST_AGENT_CLI_TARBALL = tarballPath;
  process.env.BEST_AGENT_CLI_TARBALL_SHA256 = candidate.tarballSha256;
  process.env.BEST_AGENT_CLI_BINARY_SHA256 = candidate.binarySha256;
  process.env.BEST_AGENT_CLI_NODE_SHA256 = candidate.nodeBinarySha256;
  process.env.BEST_AGENT_CLI_NODE_VERSION = candidate.nodeVersion;
  process.env.BEST_AGENT_CLI_RUNTIME_LOCK_SHA256 = candidate.runtimeLockSha256;
  process.env.BEST_AGENT_CLI_WORKSPACE = config.workspace;
  const execution = config.generation.executionProfile;
  process.env.BEST_AGENT_CLI_EXECUTION_ARGS_JSON = JSON.stringify([
    "--no-base-instructions",
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
    ...(config.generation.toolExclude ?? []).flatMap((tool) => ["--tool-exclude", tool]),
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

function runPier(pierBin, args, env, stdioBase) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pierBin, args, {
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
  const unpinnedAllowed = process.env.FH_ALLOW_UNPINNED_SOURCE === "1";
  if (head.status !== 0 || head.stdout.trim() !== frozen.dataset.sourceCommit) {
    if (!unpinnedAllowed) {
      throw new Error(
        `frontier-harness-eval checkout HEAD mismatch: expected ${frozen.dataset.sourceCommit}.`,
      );
    }
    process.stderr.write(
      "WARNING: FH_ALLOW_UNPINNED_SOURCE=1 skips the pinned-commit verification " +
        "(local development only; CI never sets this).\n",
    );
  }
  const taskDir = join(args.source, "tasks", args.task.split("/").pop());
  if (!existsSync(join(taskDir, "task.toml"))) {
    throw new Error(`task.toml missing under ${taskDir}.`);
  }

  const candidate = verifyFrozenIdentity();
  const { cliVersion, model } = candidate;

  if (existsSync(args.output)) {
    throw new Error(`Refusing to overwrite ${args.output}.`);
  }
  mkdirSync(args.jobsDir, { recursive: true });

  const effectiveAgentTimeoutSec = task.agentTimeoutSec * args.agentTimeoutMultiplier;
  const providerTimeoutMs =
    args.timeoutMs ??
    Math.max(60_000, Math.round((effectiveAgentTimeoutSec - 60) * 1000));
  // Keep the in-container CLI timeout identical to the harness-derived value so
  // the agent fails cleanly before Pier kills the trial.
  process.env.BEST_AGENT_TIMEOUT_MS = String(providerTimeoutMs);

  const pierBin = process.env.FH_PIER_BIN ?? "pier";
  const pierArgs = [
    "run",
    "-p",
    taskDir,
    "--agent-import-path",
    "frontier_harness_best_agent:BestAgentCli",
    "-m",
    model,
    "-e",
    config.pier.environment,
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
    "--environment-build-timeout-multiplier",
    String(config.generation.environmentBuildTimeoutMultiplier),
    "--cpus",
    "ignore",
    "--memory",
    "ignore",
    "-y",
  ];

  const startMs = Date.now();
  const result = await runPier(pierBin, pierArgs, process.env, args.output);
  const durationMs = Date.now() - startMs;

  const trialDir = findResultJson(args.jobsDir, args.jobName);
  let disposition;
  let rewardValues;
  let exception;
  if (!trialDir) {
    disposition = "not-evaluated";
  } else {
    const trialResult = JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8"));
    const verifier = trialResult.verifier_result;
    if (verifier && verifier.rewards && Object.keys(verifier.rewards).length > 0) {
      rewardValues = verifier.rewards;
      disposition = Object.values(verifier.rewards).some((value) => Number(value) >= 1)
        ? "passed"
        : "failed";
    } else if (trialResult.exception_info) {
      exception = {
        type: String(
          trialResult.exception_info.exception_type ??
            trialResult.exception_info.type ??
            "error",
        ),
        message: String(
          trialResult.exception_info.exception_message ??
            trialResult.exception_info.message ??
            "",
        ).slice(0, 2000),
      };
      disposition = "error";
    } else {
      disposition = "inconclusive";
    }
  }

  const evidencePath = trialDir ? join(trialDir, "agent", "best-agent-evidence.jsonl") : undefined;
  const stdoutPath = trialDir ? join(trialDir, "agent", "best-agent-stdout.txt") : undefined;
  const stderrPath = trialDir ? join(trialDir, "agent", "best-agent-stderr.txt") : undefined;
  const processReceiptPath = trialDir
    ? join(trialDir, "agent", "best-agent-process-receipt.json")
    : undefined;
  const pierResultPath = trialDir ? join(trialDir, "result.json") : undefined;
  const pierStdoutPath = `${args.output}.stdout.txt`;
  const pierStderrPath = `${args.output}.stderr.txt`;
  const evidenceSha256 = evidencePath ? sha256File(evidencePath) : undefined;
  const record = {
    schemaVersion: 1,
    task: {
      name: task.name,
      suite: task.suite,
      instructionSha256: task.instructionSha256,
      datasetOrder: task.datasetOrder,
      dockerImage: task.dockerImage,
    },
    candidateId: args.candidateId,
    cliPackage: candidate.packageName,
    cliVersion,
    cliTarget: candidate.target,
    cliBinarySha256: candidate.binarySha256,
    candidateManifestSha256: candidate.candidateManifestSha256,
    model,
    batchId: args.batchId,
    formalRunId: args.formalRunId,
    pierVersion: config.pier.version,
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
      ...(pierResultPath && existsSync(pierResultPath)
        ? {
            pierResult: relative(repoRoot, pierResultPath),
            pierResultSha256: sha256File(pierResultPath),
          }
        : {}),
      candidate: relative(repoRoot, candidate.candidatePath),
    },
    durationMs,
    pierExitCode: result.code,
    pierSignal: result.signal,
    pierStdout: relative(repoRoot, pierStdoutPath),
    pierStdoutSha256: sha256File(pierStdoutPath),
    pierStderr: relative(repoRoot, pierStderrPath),
    pierStderrSha256: sha256File(pierStderrPath),
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
    process.stderr.write(`frontier-harness-harness: ${error.stack ?? error}\n`);
    process.exit(1);
  });
}
