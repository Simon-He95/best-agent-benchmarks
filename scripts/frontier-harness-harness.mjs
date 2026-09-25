#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 per-task generation harness.
 *
 * Runs exactly one frozen task attempt through Pier's Docker environment with
 * the pinned best-agent CLI (installed-agent plugin), then freezes the trial
 * outcome and the complete inference-time artifacts. The task's own verifier
 * (the per-suite source task definition staged below) is the only grader; this
 * script only transcribes Pier's canonical trial record and never re-parses
 * test output.
 *
 * Staging: the eval repo's tasks/ directory carries public metadata only (no
 * tests/). The Pier task directory is therefore staged from the authoritative
 * per-suite sources frozen in the corpus (terminal-bench -> terminal-bench-2,
 * datacurve -> deep-swe): the complete task directory (task.toml,
 * instruction.md, environment/, tests/, solution/) is copied verbatim, and the
 * only edit is network normalization — the best-agent CLI has no HTTP-proxy
 * support, so an air-gapped agent phase would cut off the model provider.
 * [agent] network_mode="no-network" is rewritten to "public" and
 * [environment] allow_internet=false to true, with a provenance comment left
 * in the staged task.toml. Verifier-side network policy is never touched.
 * Task environments are therefore internet-connected (matching the original
 * benchmark's egress-allowlisted runtime and this repo's Terminal-Bench 4.0
 * diagnostic composition); the CLI's network tool stays excluded and no
 * closed-book claim is made.
 *
 * Composition fairness: one headless `best-agent run` per task (no TUI, no
 * interaction tools), full workspace permissions, one frozen candidate, one
 * predeclared attempt, and no evaluator output ever re-enters the model
 * attempt.
 *
 * Usage:
 *   node scripts/frontier-harness-harness.mjs [options]
 *
 * Options:
 *   --task <id>                       suite-prefixed task id (terminal-bench/<dir> | datacurve/<dir>)
 *   --corpus <path>                   frozen manifest from prepare-frontier-harness.mjs
 *   --source <path>                   frontier-harness-eval checkout (pinned commit; dataset validation)
 *   --terminal-bench-source <path>    terminal-bench-2 checkout (pinned commit; task staging)
 *   --deep-swe-source <path>          deep-swe checkout (pinned commit; task staging)
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

import { VERIFICATION_FILE } from "./verify-frontier-harness-candidate.mjs";

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
    terminalBenchSource: undefined,
    deepSweSource: undefined,
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
      case "--terminal-bench-source":
        parsed.terminalBenchSource = resolve(argv[++i]);
        break;
      case "--deep-swe-source":
        parsed.deepSweSource = resolve(argv[++i]);
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
  for (const key of [
    "task",
    "corpus",
    "source",
    "terminalBenchSource",
    "deepSweSource",
    "output",
    "jobsDir",
    "jobName",
    "model",
  ]) {
    if (!parsed[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required.`);
  }
  if (
    !Number.isFinite(parsed.agentTimeoutMultiplier) ||
    parsed.agentTimeoutMultiplier <= 0
  ) {
    throw new Error("--agent-timeout-multiplier must be a positive number.");
  }
  return parsed;
}

/**
 * The one projection of an execution profile onto the CLI's one-shot argv. `processClosePolicy` is
 * opt-in per config: a released process outlives the agent phase, which is what every task whose
 * verifier runs after the agent needs, while a run pinned to a CLI that predates
 * `--process-close-policy` keeps its exact argv. An undeclared value fails closed instead of
 * silently running `terminate`.
 */
export function projectExecutionArgs(execution, { workspace, toolExclude }) {
  const closePolicy = execution.processClosePolicy;
  if (closePolicy !== undefined && closePolicy !== "terminate" && closePolicy !== "release") {
    throw new Error("executionProfile.processClosePolicy must be terminate or release.");
  }
  return [
    "--no-base-instructions",
    "--workspace",
    workspace,
    "--workspace-backend",
    execution.workspaceBackend,
    "--workspace-authorization",
    execution.workspaceAuthorization,
    "--process-isolation",
    execution.processIsolation,
    ...(closePolicy === undefined ? [] : ["--process-close-policy", closePolicy]),
    "--command-policy",
    execution.commandPolicy,
    ...execution.workspaceGrants.flatMap((grant) => ["--workspace-grant", grant]),
    ...toolExclude.flatMap((tool) => ["--tool-exclude", tool]),
  ];
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
  // The delivery gate owns exactly one fact: whether this candidate's packaging, its
  // source typecheck and its packed artifact were verified for the frozen target. The
  // harness requires that fact and never re-derives it, so a candidate directory that
  // was never verified — or whose record belongs to other receipt bytes — cannot
  // reach a task attempt.
  const deliveryPath = join(candidateDir, VERIFICATION_FILE);
  if (!existsSync(deliveryPath)) {
    throw new Error(
      `Current Linux candidate has no ${VERIFICATION_FILE}; run scripts/verify-frontier-harness-candidate.mjs on the target host before any task attempt.`,
    );
  }
  const delivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
  if (
    delivery.schemaVersion !== 1 ||
    delivery.verified !== true ||
    delivery.candidateManifestSha256 !== sha256File(candidatePath)
  ) {
    throw new Error(
      `Current Linux candidate delivery verification is not a pass bound to this receipt (${VERIFICATION_FILE}).`,
    );
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
  // The effort is read back from the materialized identity the CLI actually
  // consumes, so the frozen record states the effort this attempt ran at; an
  // effort outside the profile's declared options fails closed here instead of
  // being recorded as something the profile never named.
  const materialized = JSON.parse(readFileSync(providerOverride, "utf8"));
  const effortOptions = provider.reasoningEffortOptions;
  const reasoningEffort = materialized?.reasoningEffort;
  if (
    materialized?.model !== provider.model ||
    !Array.isArray(effortOptions) ||
    !effortOptions.includes(reasoningEffort)
  ) {
    throw new Error(
      "The materialized provider identity does not match the frozen frontier-harness provider profile.",
    );
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
  process.env.BEST_AGENT_CLI_EXECUTION_ARGS_JSON = JSON.stringify(
    projectExecutionArgs(execution, {
      workspace: config.workspace,
      toolExclude: config.generation.toolExclude ?? [],
    }),
  );
  return {
    packageName: candidate.packageName,
    cliVersion: candidate.cliVersion,
    target: candidate.target,
    binarySha256: candidate.binarySha256,
    candidateManifestSha256: sha256File(candidatePath),
    candidatePath,
    model,
    reasoningEffort,
  };
}

const NETWORK_PROVENANCE_COMMENT =
  "# Staged by frontier-harness-harness.mjs: the agent phase is network-enabled" +
  " because the best-agent CLI needs direct model-provider egress (no proxy" +
  " support). This deviates from the task's declared agent network_mode and is" +
  " recorded as a diagnostic composition difference. The verifier's own network" +
  " policy is untouched.";

/**
 * Line-scoped TOML normalization: rewrite agent-phase network restrictions so
 * the model provider stays reachable. Only the [agent] network_mode and
 * [environment] allow_internet lines are touched; [verifier] sections (and any
 * other field) pass through verbatim.
 *
 * @returns {{ text: string, changes: string[] }} the normalized TOML text and
 *   a list of human-readable change descriptions (empty when unrestricted).
 */
export function normalizeTaskTomlNetwork(tomlText) {
  const lines = tomlText.split("\n");
  const changes = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].trim().match(/^\[+([^\]]+)\]+$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section === "agent") {
      const match = lines[i].match(/^(\s*network_mode\s*=\s*)"[^"]*"(\s*(?:#.*)?)$/);
      if (match) {
        const before = lines[i].trim();
        lines[i] = `${match[1]}"public"${match[2]}`;
        if (before !== lines[i].trim()) {
          changes.push(`[agent] ${before} -> ${lines[i].trim()}`);
        }
      }
    }
    if (section === "environment") {
      const match = lines[i].match(/^(\s*allow_internet\s*=\s*)false(\s*(?:#.*)?)$/);
      if (match) {
        const before = lines[i].trim();
        lines[i] = `${match[1]}true${match[2]}`;
        changes.push(`[environment] ${before} -> ${lines[i].trim()}`);
      }
    }
  }
  return {
    text: changes.length
      ? `${NETWORK_PROVENANCE_COMMENT}\n${lines.join("\n")}`
      : lines.join("\n"),
    changes,
  };
}

/**
 * Stage the Pier task directory from the frozen per-suite source checkout:
 * copy the complete task directory verbatim (modes preserved so tests keep
 * their executable bits), then apply the network normalization above.
 */
export function stagePierTask({ task, sourceRoot, pierTaskDir }) {
  const sourceTaskDir = join(sourceRoot, ...task.sourceTaskDir.split("/"));
  if (!existsSync(join(sourceTaskDir, "task.toml"))) {
    throw new Error(`task.toml missing under ${sourceTaskDir}.`);
  }
  if (!existsSync(join(sourceTaskDir, "instruction.md"))) {
    throw new Error(`instruction.md missing under ${sourceTaskDir}.`);
  }
  if (!existsSync(join(sourceTaskDir, "tests", "test.sh"))) {
    throw new Error(`tests/test.sh missing under ${sourceTaskDir}.`);
  }
  if (
    !existsSync(join(sourceTaskDir, "environment", "Dockerfile")) &&
    !existsSync(join(sourceTaskDir, "environment", "docker-compose.yaml"))
  ) {
    throw new Error(
      `environment/Dockerfile or environment/docker-compose.yaml missing under ${sourceTaskDir}.`,
    );
  }
  mkdirSync(pierTaskDir, { recursive: true });
  if (existsSync(join(pierTaskDir, "task.toml"))) {
    throw new Error(`Refusing to restage over ${pierTaskDir}.`);
  }
  const copy = spawnSync("cp", ["-a", `${sourceTaskDir}/.`, `${pierTaskDir}/`]);
  if (copy.status !== 0) {
    throw new Error(`Failed to stage ${sourceTaskDir}: ${copy.stderr || "unknown error"}`);
  }
  const stagedTomlPath = join(pierTaskDir, "task.toml");
  const original = readFileSync(stagedTomlPath, "utf8");
  const normalized = normalizeTaskTomlNetwork(original);
  if (normalized.changes.length) {
    writeFileSync(stagedTomlPath, normalized.text);
  }
  const stagedInstruction = readFileSync(join(pierTaskDir, "instruction.md"));
  const instructionSha256 = createHash("sha256").update(stagedInstruction).digest("hex");
  if (instructionSha256 !== task.instructionSha256) {
    throw new Error(
      `Staged instruction for ${task.name} does not match the frozen corpus hash.`,
    );
  }
  return { pierTaskDir, networkChanges: normalized.changes };
}

/**
 * The task's own canonical pass verdict from its verifier rewards.
 *
 * `reward` is the canonical key when the verifier writes one (the deep-swe
 * grader: binary 1 iff |f2p| > 0, every fail-to-pass test passes and no
 * pass-to-pass test fails; terminal-bench test.sh writes reward.txt => {reward}).
 * Its companion keys (p2p=1, partial, ...) are diagnostics — `p2p: 1` alone
 * means "no regression", not "the task was solved". Only rewards without a
 * `reward` key fall back to any-key>=1.
 */
/**
 * Project the provider-reported usage of a Pier trial's `agent_result` (filled by
 * the agent plugin from the CLI's durable `thread_metrics` row). A trial without
 * usage metadata answers `undefined`, so a missing fact stays missing instead of
 * turning into a zero; the benchmark prices the raw tokens itself.
 *
 * @returns {{ promptTokens: number|null, completionTokens: number|null, cacheReadTokens: number|null, costUsd: number|null, totalTokens: number|null, cacheWriteTokens: number|null, noCacheInputTokens: number|null, modelCallCount: number|null, reportedCallCount: number|null, reportedInputTokens: number|null } | undefined}
 */
export function projectAgentUsage(agentResult) {
  const usage = agentResult?.metadata?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const reported = (value) => (Number.isFinite(value) ? Number(value) : null);
  return {
    promptTokens: reported(agentResult.n_input_tokens),
    completionTokens: reported(agentResult.n_output_tokens),
    cacheReadTokens: reported(agentResult.n_cache_tokens),
    costUsd: reported(agentResult.cost_usd),
    totalTokens: reported(usage.total_tokens),
    cacheWriteTokens: reported(usage.cache_write_tokens),
    noCacheInputTokens: reported(usage.no_cache_input_tokens),
    modelCallCount: reported(usage.model_call_count),
    reportedCallCount: reported(usage.reported_call_count),
    reportedInputTokens: reported(usage.reported_input_tokens),
  };
}

export function canonicalPassed(rewards) {
  if (rewards && typeof rewards === "object" && "reward" in rewards) {
    return Number(rewards.reward) >= 1;
  }
  return Object.values(rewards ?? {}).some((value) => Number(value) >= 1);
}

/**
 * The `reason` values of a best-agent `model-failure` evidence entry, as defined
 * by the CLI's own `classifyModelFailure` (packages/model-binding-ai-sdk): the
 * provider was unreachable at the transport level (DNS/connect/reset) or the
 * request was rejected provider-side (HTTP status, TLS, upstream). Neither is a
 * model outcome — the request never produced an answer — so a trial that ends on
 * one carries no gradeable attempt.
 *
 * `timeout` is deliberately absent: it means the invocation was aborted on the
 * deadline this harness itself pinned (agent budget minus the guard interval), so
 * a task that used that budget up is a budget outcome, not an outage.
 */
const PROVIDER_FAILURE_REASONS = new Set(["connection", "transport"]);

/**
 * Summarize a best-agent attempt-evidence JSONL file: how many model outcomes
 * were written, the run's terminal cause, and why each model failure failed.
 * The footer's writtenCounts are authoritative when present; otherwise
 * model-outcome entries are counted.
 *
 * @returns {{ present: boolean, modelOutcomes: number | null, terminalCause: string | null, modelFailureReasons: string[] }}
 */
export function summarizeAttemptEvidence(evidenceText) {
  if (typeof evidenceText !== "string" || evidenceText.trim() === "") {
    return {
      present: false,
      modelOutcomes: null,
      terminalCause: null,
      modelFailureReasons: [],
    };
  }
  let footerOutcomes = null;
  let countedOutcomes = 0;
  let terminalCause = null;
  const modelFailureReasons = [];
  for (const line of evidenceText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof entry?.type === "string" && /^model-?outcome$/iu.test(entry.type)) {
      countedOutcomes += 1;
    }
    if (entry?.type === "model-failure") {
      // The frozen CLI nests the fact as `failure.reason`; older artifacts
      // carry the same value as a flat `reason`.
      const reason = entry.failure?.reason ?? entry.reason;
      if (typeof reason === "string" && reason.trim() !== "") {
        modelFailureReasons.push(reason.trim());
      }
    }
    if (entry?.type === "footer" && entry.writtenCounts) {
      if (Number.isInteger(entry.writtenCounts.modelOutcome)) {
        footerOutcomes = entry.writtenCounts.modelOutcome;
      }
    }
    if (entry?.type === "terminal-snapshot" && entry.snapshot?.terminalCause) {
      terminalCause = String(entry.snapshot.terminalCause);
    }
  }
  return {
    present: true,
    modelOutcomes: footerOutcomes ?? countedOutcomes,
    terminalCause,
    modelFailureReasons,
  };
}

/**
 * Transcribe one Pier trial into the harness disposition vocabulary.
 *
 * The task's own verifier reward is the only grader, but a trial that never
 * received a model answer has no gradeable attempt: either the agent process
 * failed before its first model response (attempt evidence recorded zero model
 * outcomes), or the run ended on a provider transport failure (endpoint
 * unreachable, quota exhausted, gateway error). Both are environment/provider
 * deaths, recorded as `error` — never scored as a task failure — matching the
 * benchmark rule that infrastructure deaths are marked rather than graded.
 */
export function classifyTrialOutcome({ trialResult, evidenceText }) {
  const evidence = summarizeAttemptEvidence(evidenceText);
  const verifier = trialResult?.verifier_result;
  const hasRewards =
    verifier && verifier.rewards && Object.keys(verifier.rewards).length > 0;
  let exception;
  if (trialResult?.exception_info) {
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
  }
  const evidenceFields = {
    ...(evidence.present ? { modelOutcomes: evidence.modelOutcomes } : {}),
    ...(evidence.terminalCause ? { terminalCause: evidence.terminalCause } : {}),
  };
  // The agent process errored out without ever receiving a model response.
  const preModelFailure = Boolean(exception) && evidence.modelOutcomes === 0;
  if (preModelFailure) {
    return {
      disposition: "error",
      exception,
      preModelFailure: true,
      ...evidenceFields,
    };
  }
  // Only the failure that actually ended the run decides: the evidence is
  // append-ordered, so the last model-failure is the fatal one. A provider
  // outage that was survived must not excuse a later, fatal budget timeout.
  // A verifier run over a workspace whose provider connection died cannot be
  // attributed to the agent, so the verdict is withheld as an outage.
  const fatalFailureReason = evidence.modelFailureReasons.at(-1);
  const infraFailure =
    evidence.terminalCause === "model-failure" &&
    PROVIDER_FAILURE_REASONS.has(fatalFailureReason);
  if (infraFailure) {
    return {
      disposition: "error",
      ...(exception ? { exception } : {}),
      infraFailure: true,
      ...evidenceFields,
    };
  }
  if (hasRewards) {
    const rewards = verifier.rewards;
    return {
      disposition: canonicalPassed(rewards) ? "passed" : "failed",
      rewards,
      ...(exception ? { exception } : {}),
      ...evidenceFields,
    };
  }
  if (exception) {
    return { disposition: "error", exception, ...evidenceFields };
  }
  return { disposition: "inconclusive", ...evidenceFields };
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

  // Resolve the authoritative per-suite source checkout for this task and
  // verify it sits at the commit frozen in the corpus (and pinned in config).
  const isTerminalBench = task.suite === "terminal-bench";
  const sourceRoot = isTerminalBench ? args.terminalBenchSource : args.deepSweSource;
  const sourcePin = isTerminalBench
    ? config.taskSources.terminalBench
    : config.taskSources.deepSwe;
  if (task.sourceRepository !== sourcePin.repository) {
    throw new Error(
      `Frozen corpus sources ${task.name} from ${task.sourceRepository}, but config pins ${sourcePin.repository}.`,
    );
  }
  if (task.sourceCommit !== sourcePin.sourceCommit) {
    throw new Error(
      `Frozen corpus pins ${task.name} at ${task.sourceCommit}, but config pins ${sourcePin.sourceCommit}.`,
    );
  }
  const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  if (sourceHead.status !== 0 || sourceHead.stdout.trim() !== task.sourceCommit) {
    throw new Error(
      `${sourcePin.repository} checkout HEAD mismatch: expected ${task.sourceCommit}.`,
    );
  }

  // Stage the complete task directory from the authoritative source; the only
  // edit is the agent-phase network normalization documented in stagePierTask.
  const pierTaskDir = join(args.jobsDir, "pier-task");
  const staged = stagePierTask({ task, sourceRoot, pierTaskDir });
  if (staged.networkChanges.length) {
    process.stderr.write(
      `Staging note (${task.name}): ${staged.networkChanges.join("; ")}\n`,
    );
  }

  const candidate = verifyFrozenIdentity();
  const { cliVersion, model, reasoningEffort } = candidate;

  if (existsSync(args.output)) {
    throw new Error(`Refusing to overwrite ${args.output}.`);
  }
  mkdirSync(args.jobsDir, { recursive: true });

  const effectiveAgentTimeoutSec = task.agentTimeoutSec * args.agentTimeoutMultiplier;
  // One model invocation ceiling for this attempt, derived from the task's own agent budget. It is
  // published under its own name and reaches the CLI as the explicit `--model-timeout-ms` flag, so
  // no attempt wall clock is ever handed to the CLI as a provider timeout. The ceiling bounds one
  // model call; it is not an attempt deadline and the harness does not claim one.
  const modelTimeoutMs =
    args.timeoutMs ??
    Math.max(60_000, Math.round((effectiveAgentTimeoutSec - 60) * 1000));
  process.env.BEST_AGENT_MODEL_TIMEOUT_MS = String(modelTimeoutMs);

  const pierBin = process.env.FH_PIER_BIN ?? "pier";
  const pierArgs = [
    "run",
    "-p",
    pierTaskDir,
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
  const evidencePath = trialDir
    ? join(trialDir, "agent", "best-agent-evidence.jsonl")
    : undefined;
  const trialResult = trialDir
    ? JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8"))
    : undefined;
  const outcome = trialResult
    ? classifyTrialOutcome({
        trialResult,
        evidenceText: evidencePath && existsSync(evidencePath)
          ? readFileSync(evidencePath, "utf8")
          : undefined,
      })
    : { disposition: "not-evaluated" };
  const { disposition, rewards: rewardValues, exception } = outcome;
  const usage = projectAgentUsage(trialResult?.agent_result);

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
    reasoningEffort,
    batchId: args.batchId,
    formalRunId: args.formalRunId,
    pierVersion: config.pier.version,
    agentTimeoutMultiplier: args.agentTimeoutMultiplier,
    effectiveAgentTimeoutSec,
    modelTimeoutMs,
    jobName: args.jobName,
    trialDir: trialDir ? relative(repoRoot, trialDir) : undefined,
    result: {
      disposition,
      ...(rewardValues === undefined ? {} : { rewards: rewardValues }),
      ...(exception === undefined ? {} : { exception }),
      ...(outcome.preModelFailure ? { preModelFailure: true } : {}),
      ...(outcome.modelOutcomes === undefined ? {} : { modelOutcomes: outcome.modelOutcomes }),
      ...(outcome.terminalCause ? { terminalCause: outcome.terminalCause } : {}),
    },
    ...(usage === undefined ? {} : { usage }),
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
    ...(outcome.preModelFailure
      ? [
          "| note | agent never received a model response; recorded as an environment/provider error, not scored as a task failure |",
        ]
      : []),
    ...(rewardValues
      ? Object.entries(rewardValues).map(
          ([key, value]) => `| reward ${key} | ${value} |`,
        )
      : []),
    `| duration | ${Math.round(durationMs / 1000)}s |`,
    `| candidate | ${args.candidateId} |`,
    `| cli | ${cliVersion} |`,
    `| model | ${model} |`,
    `| reasoning effort | ${reasoningEffort} |`,
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
