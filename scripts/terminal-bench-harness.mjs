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
 *   BEST_AGENT_CLI_PACKAGE / BEST_AGENT_CLI_VERSION / BEST_AGENT_CLI_INTEGRITY
 *                                          pinned CLI identity (must match config)
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

function verifyFrozenIdentity() {
  const cli = config.cli;
  const packageName = process.env.BEST_AGENT_CLI_PACKAGE ?? cli.packageName;
  const cliVersion = process.env.BEST_AGENT_CLI_VERSION ?? cli.cliVersion;
  const integrity = process.env.BEST_AGENT_CLI_INTEGRITY ?? cli.packageIntegrity;
  if (
    packageName !== cli.packageName ||
    cliVersion !== cli.cliVersion ||
    integrity !== cli.packageIntegrity
  ) {
    throw new Error(
      "CLI identity environment does not match config/terminal-bench.json.",
    );
  }
  const provider = config.provider;
  const providerOverride = process.env.BEST_AGENT_PROVIDER_CONFIG;
  const model = process.env.BEST_AGENT_PROVIDER_MODEL ?? provider.model;
  if (model !== provider.model) {
    throw new Error(
      `BEST_AGENT_PROVIDER_MODEL ${model} does not match the frozen provider model ${provider.model}.`,
    );
  }
  if (!providerOverride || !existsSync(providerOverride)) {
    throw new Error("BEST_AGENT_PROVIDER_CONFIG must point to the frozen provider.json.");
  }
  const dimcodeHome = process.env.DIMCODE_HOME;
  if (!dimcodeHome || !existsSync(join(dimcodeHome, "config.json"))) {
    throw new Error("DIMCODE_HOME must point to the frozen dimcode home.");
  }
  return { packageName, cliVersion, integrity, model };
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

  const { packageName, cliVersion, integrity, model } = verifyFrozenIdentity();

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
  const result = await runHarbor(harborBin, harborArgs, process.env, args.output);
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
  const evidenceSha256 = evidencePath ? sha256File(evidencePath) : undefined;
  const record = {
    schemaVersion: 1,
    task: {
      name: task.name,
      digest: task.digest,
      instructionSha256: task.instructionSha256,
      datasetOrder: task.datasetOrder,
    },
    candidateId: args.candidateId,
    cliPackage: packageName,
    cliVersion,
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
    artifacts: {
      ...(evidencePath && existsSync(evidencePath)
        ? { evidence: relative(repoRoot, evidencePath), evidenceSha256 }
        : {}),
      ...(stdoutPath && existsSync(stdoutPath)
        ? { stdout: relative(repoRoot, stdoutPath) }
        : {}),
    },
    durationMs,
    harborExitCode: result.code,
    harborSignal: result.signal,
    harborStdout: relative(repoRoot, `${args.output}.stdout.txt`),
    harborStderr: relative(repoRoot, `${args.output}.stderr.txt`),
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

main().catch((error) => {
  process.stderr.write(`terminal-bench-harness: ${error.stack ?? error}\n`);
  process.exit(1);
});