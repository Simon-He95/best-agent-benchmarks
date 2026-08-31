#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectAttemptEvidence } from "./swe-bench-harness.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TRANSPORT_FAILURE =
  /^v3 run model-failure: transport: (?:Cannot connect to API: (?:read ECONNRESET|Headers Timeout Error|Connect Timeout Error \(attempted address: [^)]+\))|.*(?:busy|overloaded|rate.?limit|channel not found|get_channel_failed))/imu;

export function parseRecoveryPlanArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--results") parsed.resultsDir = resolve(argv[++index]);
    else if (argv[index] === "--plan") parsed.planPath = resolve(argv[++index]);
    else if (argv[index] === "--corpus") parsed.corpusPath = resolve(argv[++index]);
    else if (argv[index] === "--output") parsed.outputPath = resolve(argv[++index]);
    else throw new Error(`Unknown recovery-plan argument: ${argv[index]}`);
  }
  for (const field of ["resultsDir", "planPath", "corpusPath", "outputPath"]) {
    if (parsed[field] === undefined) throw new Error(`Missing recovery-plan ${field}.`);
  }
  return parsed;
}

export function buildFormalRecovery(inspection, options) {
  const plan = readJson(options.planPath);
  const githubJobsPath = resolve(options.resultsDir, "github-jobs.json");
  const githubJobs = existsSync(githubJobsPath) ? readJson(githubJobsPath).jobs : [];
  if (!Array.isArray(githubJobs)) throw new Error("GitHub jobs are malformed.");
  const expectedRunId = Number(String(inspection.formalRunId).replace(/^formal-/u, ""));
  const plannerExecutions = githubJobs.filter(
    (job) => job.name === "Build benchmark recovery plan",
  );
  if (
    plannerExecutions.length !== 1 ||
    plannerExecutions[0].run_id !== expectedRunId ||
    plannerExecutions[0].run_attempt !== 1 ||
    (options.requireNoRecoveryJobs === true &&
      githubJobs.some((job) => /^macOS recovery \(.+\)$/u.test(job.name)))
  ) {
    throw new Error("Recovery planning requires one attempt-1 planner and no prior recovery jobs.");
  }
  for (const batch of plan.batches) {
    const name = `macOS generation (${batch.id})`;
    const executions = githubJobs.filter((job) => job.name === name);
    if (
      executions.length !== 1 ||
      executions[0].run_id !== expectedRunId ||
      executions[0].run_attempt !== 1
    ) {
      throw new Error(`Source generation job must have exactly one attempt-1 execution: ${name}`);
    }
  }

  const taskById = new Map(inspection.tasks.map((task) => [task.instanceId, task]));
  const recoveryById = new Map();
  for (const reason of inspection.reasons) {
    if (typeof reason.instanceId !== "string") continue;
    const task = taskById.get(reason.instanceId);
    if (task === undefined || task.prediction !== undefined) continue;
    const receiptPath = resolveReference(task.receipt, options.resultsDir);
    const receipt = readJson(receiptPath);
    if (
      receipt.instance_id !== reason.instanceId ||
      reason.stage !== receipt.failureStage ||
      reason.reason !== (receipt.error ?? "generation infrastructure inconclusive")
    ) {
      continue;
    }
    const eligibility = classifyTaskRecovery(receipt, options.resultsDir, dirname(receiptPath));
    if (eligibility === undefined) continue;
    const sourceShard = sourceShardFor(plan, reason.instanceId);
    recoveryById.set(reason.instanceId, {
      instanceId: reason.instanceId,
      sourceShard,
      eligibility,
      sourceReceipt: reference(receiptPath),
    });
  }

  for (const reason of inspection.reasons) {
    if (
      reason.stage !== "fragment" ||
      reason.reason !== "expected shard artifact is missing" ||
      !Number.isInteger(reason.shard)
    ) {
      continue;
    }
    const batch = plan.batches[reason.shard];
    if (batch === undefined) throw new Error(`Missing formal batch for shard ${reason.shard}.`);
    const job = githubJobs.find((entry) => entry.name === `macOS generation (${batch.id})`);
    const eligibility = classifyMissingShardRecovery(job);
    if (eligibility === undefined) continue;
    for (const instanceId of batch.tasks) {
      recoveryById.set(instanceId, {
        instanceId,
        sourceShard: reason.shard,
        eligibility,
      });
    }
  }

  const tasks = plan.batches.flatMap((batch, sourceShard) =>
    batch.tasks.flatMap((instanceId) => {
      const recovery = recoveryById.get(instanceId);
      return recovery === undefined ? [] : [{ ...recovery, sourceShard }];
    }),
  );
  const batches = plan.batches.flatMap((batch, sourceShard) => {
    const instanceIds = batch.tasks.filter((instanceId) => recoveryById.has(instanceId));
    return instanceIds.length === 0
      ? []
      : [
          {
            id: `recovery-${String(sourceShard + 1).padStart(3, "0")}`,
            sourceShard,
            tasks: instanceIds,
          },
        ];
  });
  return {
    schemaVersion: 1,
    formalRunId: inspection.formalRunId,
    candidate: inspection.candidate,
    corpus: inspection.corpus,
    plan: inspection.plan,
    sourceInspection: {
      accepted: inspection.accepted,
      scriptHashes: inspection.scriptHashes,
      reasonsSha256: createHash("sha256")
        .update(JSON.stringify(inspection.reasons))
        .digest("hex"),
    },
    maxRecoveryAttempts: 1,
    maxBatchSize: 5,
    tasks,
    batches,
  };
}

export function classifyMissingShardRecovery(job) {
  if (job?.conclusion !== "failure" || !Array.isArray(job.steps)) return undefined;
  const generation = job.steps.find((step) => step.name === "Generate and freeze predictions");
  if (
    generation === undefined ||
    (!["pending", "queued"].includes(generation.status) && generation.conclusion !== "skipped")
  ) {
    return undefined;
  }
  return {
    kind: "generation-job-failure-before-model",
    job: {
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
    },
  };
}

export function classifyTaskRecovery(receipt, resultsDir, artifactRoot = resultsDir) {
  if (
    receipt?.disposition !== "generation-inconclusive" ||
    receipt.prediction !== undefined
  ) {
    return undefined;
  }
  if (["clone", "fetch", "checkout", "isolation", "cli-spawn"].includes(receipt.failureStage)) {
    return { kind: "task-environment-before-model", failureStage: receipt.failureStage };
  }
  if (receipt.failureStage !== "process" || receipt.stderr === undefined) return undefined;
  const stderrPath = resolveReference(receipt.stderr, resultsDir);
  const stdoutPath = resolveReference(receipt.stdout, resultsDir);
  const processReceiptPath = resolveReference(receipt.processReceipt, resultsDir);
  const evidencePath = resolveReference(receipt.evidence, resultsDir);
  if (
    stderrPath !== resolve(artifactRoot, "stderr.txt") ||
    stdoutPath !== resolve(artifactRoot, "stdout.txt") ||
    processReceiptPath !== resolve(artifactRoot, "process-receipt.json") ||
    evidencePath !== resolve(artifactRoot, "attempt-evidence.jsonl")
  ) {
    return undefined;
  }
  const processReceipt = readJson(processReceiptPath);
  const evidence = inspectAttemptEvidence(evidencePath);
  if (
    JSON.stringify(processReceipt.stdout) !== JSON.stringify(receipt.stdout) ||
    JSON.stringify(processReceipt.stderr) !== JSON.stringify(receipt.stderr) ||
    !Number.isInteger(processReceipt.status) ||
    processReceipt.status === 0 ||
    processReceipt.timedOut !== false ||
    processReceipt.signal !== null ||
    processReceipt.stdoutOverflow !== false ||
    processReceipt.stderrOverflow !== false ||
    evidence.complete !== true ||
    evidence.rootStatus !== "failed" ||
    evidence.rootTerminalCause !== "model-failure" ||
    evidence.rootModelFailureReason !== "transport"
  ) {
    return undefined;
  }
  const stderr = readFileSync(stderrPath, "utf8");
  if (!TRANSPORT_FAILURE.test(stderr)) return undefined;
  return { kind: "provider-transport", stderr: reference(stderrPath) };
}

function sourceShardFor(plan, instanceId) {
  const sourceShard = plan.batches.findIndex((batch) => batch.tasks.includes(instanceId));
  if (sourceShard === -1) throw new Error(`Task is outside the formal plan: ${instanceId}`);
  return sourceShard;
}

function resolveReference(value, resultsDir) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.path !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.sha256 !== "string"
  ) {
    throw new Error("Artifact reference is malformed.");
  }
  const path = resolve(repoRoot, value.path);
  const resultsRoot = `${resolve(resultsDir)}/`;
  if (!path.startsWith(resultsRoot) || !existsSync(path)) {
    throw new Error("Artifact reference escapes or is missing from the results directory.");
  }
  if (statSync(path).size !== value.bytes || sha256File(path) !== value.sha256) {
    throw new Error("Artifact reference bytes/hash mismatch.");
  }
  return path;
}

function reference(path) {
  return {
    path: relative(repoRoot, path),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonDurable(path, value) {
  const descriptor = openSync(path, "wx");
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseRecoveryPlanArgs(process.argv.slice(2));
    const { inspectFormalGeneration } = await import("./admit-generation.mjs");
    const recovery = buildFormalRecovery(inspectFormalGeneration(options), {
      ...options,
      requireNoRecoveryJobs: true,
    });
    writeJsonDurable(options.outputPath, recovery);
    process.stdout.write(
      `${JSON.stringify({ tasks: recovery.tasks.length, batches: recovery.batches.length })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
