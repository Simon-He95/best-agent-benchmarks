#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectAttemptEvidence } from "./swe-bench-harness.mjs";
import { readFrozenPrediction } from "./swe-bench-official-evaluator.mjs";
import { buildFormalRecovery } from "./plan-recovery.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidatePath = resolve(repoRoot, "config/best-agent-candidate.json");
const CONTROL_CLOSURE_PATHS = [
  "package.json",
  "package-lock.json",
  "config/swe-bench-full-batches.json",
  "config/swe-bench-verified.json",
  "scripts/benchmark-history.mjs",
  "scripts/benchmark-provider.mjs",
  "scripts/isolation-smoke.mjs",
  "scripts/materialize-ci-provider.mjs",
  "scripts/plan-recovery.mjs",
  "scripts/prepare-swe-bench.mjs",
  "scripts/sandbox-network-smoke.mjs",
  "scripts/smoke.mjs",
];

export function parseAdmissionArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--results") parsed.resultsDir = resolve(argv[++index]);
    else if (argv[index] === "--plan") parsed.planPath = resolve(argv[++index]);
    else if (argv[index] === "--corpus") parsed.corpusPath = resolve(argv[++index]);
    else if (argv[index] === "--recovery-manifest")
      parsed.recoveryManifestPath = resolve(argv[++index]);
    else if (argv[index] === "--output") parsed.outputPath = resolve(argv[++index]);
    else throw new Error(`Unknown admission argument: ${argv[index]}`);
  }
  for (const field of ["resultsDir", "planPath", "corpusPath", "outputPath"]) {
    if (parsed[field] === undefined) throw new Error(`Missing admission ${field}.`);
  }
  return parsed;
}

export function benchmarkControlClosureSha256() {
  const hash = createHash("sha256");
  for (const path of CONTROL_CLOSURE_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(repoRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function inspectFormalGeneration(options) {
  const plan = readJson(options.planPath);
  const candidate = readJson(candidatePath);
  const corpusTasks = new Map(
    readFileSync(options.corpusPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .map((task) => [task.instance_id, task]),
  );
  const expectedIds = plan.batches.flatMap((batch) => batch.tasks);
  const reasons = [];
  if (
    plan.taskCount !== 500 ||
    plan.batches.length !== 100 ||
    expectedIds.length !== 500 ||
    new Set(expectedIds).size !== 500 ||
    plan.batches.some((batch) => batch.tasks.length !== 5)
  ) {
    reasons.push({ stage: "plan", reason: "formal plan is not exact 500/100x5" });
  }
  if (sha256File(options.corpusPath) !== plan.corpusSha256) {
    reasons.push({ stage: "corpus", reason: "corpus hash does not match formal plan" });
  }
  if (
    sha256File(options.planPath) !==
    sha256File(resolve(repoRoot, "config/swe-bench-full-batches.json"))
  ) {
    reasons.push({ stage: "plan", reason: "plan does not match the frozen full plan" });
  }
  const gates = {
    headlessSmoke: admitGate(resolve(options.resultsDir, "gates/headless-smoke.json"), "ok"),
    repositoryIsolation: admitGate(
      resolve(options.resultsDir, "gates/repository-isolation.json"),
      "ok",
    ),
  };
  for (const [name, gate] of Object.entries(gates)) {
    if (gate.accepted !== true) {
      reasons.push({ stage: "gate", reason: `${name}: ${gate.reason}` });
    }
  }
  const reportsByShard = new Map();
  for (let shard = 0; shard < plan.batches.length; shard += 1) {
    const fragmentPath = resolve(options.resultsDir, `swe-bench-results.shard-${shard}.json`);
    if (!existsSync(fragmentPath)) {
      reasons.push({ stage: "fragment", shard, reason: "expected shard artifact is missing" });
      continue;
    }
    const report = readJson(fragmentPath);
    if (report.composition?.shard !== shard) {
      reasons.push({
        stage: "fragment",
        shard,
        reason: "fragment shard identity mismatch",
      });
      continue;
    }
    reportsByShard.set(shard, { report, fragmentPath });
  }
  const formalRunIds = new Set(
    [...reportsByShard.values()].map(({ report }) => report.composition?.formalRunId),
  );
  const formalRunId = formalRunIds.size === 1 ? [...formalRunIds][0] : undefined;
  if (typeof formalRunId !== "string" || !/^formal-[0-9]+$/u.test(formalRunId)) {
    reasons.push({ stage: "configuration", reason: "fragments do not share one formal run ID" });
  }
  const githubJobs = admitGithubJobs(
    resolve(options.resultsDir, "github-jobs.json"),
    undefined,
    plan,
    formalRunId,
  );
  if (githubJobs.accepted !== true) {
    reasons.push({ stage: "ci-jobs", reason: githubJobs.reason });
  }
  if (reportsByShard.size !== 100) {
    reasons.push({
      stage: "fragment",
      reason: `expected 100 shards, received ${reportsByShard.size}`,
    });
  }
  const taskRecords = [];
  for (let shard = 0; shard < plan.batches.length; shard += 1) {
    const entry = reportsByShard.get(shard);
    if (entry === undefined) continue;
    const expected = plan.batches[shard].tasks;
    const actual = entry.report.tasks?.map((task) => task.instance_id) ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      reasons.push({ stage: "fragment", shard, reason: "task order does not match frozen plan" });
      continue;
    }
    if (
      entry.report.candidateId !== `cli-${candidate.cliVersion}-${candidate.sourceCommit}` ||
      canonicalJson(entry.report.provider) !== canonicalJson(candidate.provider) ||
      entry.report.composition?.formalRunId !== formalRunId ||
      entry.report.composition?.fullAccess !== true ||
      entry.report.composition?.permissionMode !== "full" ||
      entry.report.composition?.interactionTools !== false ||
      entry.report.composition?.workspaceBackend !== "sandbox" ||
      entry.report.composition?.execNetworkIsolation !== true ||
      entry.report.composition?.networkToolSchemas !== false ||
      entry.report.composition?.taskTimeoutMs !== candidate.taskTimeoutMs ||
      entry.report.evaluation?.method !== "official-swe-bench-docker-deferred" ||
      entry.report.evaluation?.evaluationBatchId !== formalRunId
    ) {
      reasons.push({ stage: "configuration", shard, reason: "fragment configuration mismatch" });
      continue;
    }
    for (const task of entry.report.tasks) {
      const taskArtifactDir = resolve(
        options.resultsDir,
        `swe-bench-results.shard-${shard}.tasks`,
        safeId(task.instance_id),
      );
      const expectedReceiptPath = resolve(taskArtifactDir, "receipt.json");
      if (typeof task.taskReceiptPath !== "string") {
        reasons.push({
          stage: "task-receipt",
          instanceId: task.instance_id,
          reason: "missing task receipt path",
        });
        continue;
      }
      const receiptPath = resolve(repoRoot, task.taskReceiptPath);
      if (
        receiptPath !== expectedReceiptPath ||
        task.taskReceiptPath !== relative(repoRoot, expectedReceiptPath) ||
        !existsSync(receiptPath)
      ) {
        reasons.push({
          stage: "task-receipt",
          instanceId: task.instance_id,
          reason: "missing task receipt",
        });
        continue;
      }
      const receipt = readJson(receiptPath);
      const taskReason = admitTaskReceipt(receipt, {
        expectedTask: corpusTasks.get(task.instance_id),
        candidate,
        formalRunId,
        artifactRoot: taskArtifactDir,
        expectedPredictionPath: resolve(
          options.resultsDir,
          `swe-bench-results.shard-${shard}.predictions`,
          `${safeId(task.instance_id)}.json`,
        ),
      });
      if (taskReason !== undefined) {
        reasons.push({
          stage: receipt.failureStage ?? "task",
          instanceId: task.instance_id,
          reason: taskReason,
        });
      }
      taskRecords.push({
        instanceId: task.instance_id,
        disposition: receipt.disposition,
        receipt: reference(receiptPath),
        ...(receipt.prediction === undefined ? {} : { prediction: receipt.prediction }),
      });
    }
  }
  if (
    taskRecords.length !== 500 ||
    new Set(taskRecords.map((task) => task.instanceId)).size !== 500
  ) {
    reasons.push({
      stage: "population",
      reason: "task receipts do not exact-cover 500 unique instances",
    });
  }
  const scriptHashes = {
    harnessSha256: sha256File(resolve(repoRoot, "scripts/swe-bench-harness.mjs")),
    admissionSha256: sha256File(resolve(repoRoot, "scripts/admit-generation.mjs")),
    evaluatorEntrySha256: sha256File(resolve(repoRoot, "scripts/evaluate-official.mjs")),
    officialEvaluatorSha256: sha256File(
      resolve(repoRoot, "scripts/swe-bench-official-evaluator.mjs"),
    ),
    workflowSha256: sha256File(resolve(repoRoot, ".github/workflows/bench.yml")),
    controlClosureSha256: benchmarkControlClosureSha256(),
  };
  for (const [field, value] of Object.entries(scriptHashes)) {
    if (candidate[field] !== value)
      reasons.push({ stage: "candidate", reason: `${field} mismatch` });
  }
  let report = {
    schemaVersion: 1,
    accepted: reasons.length === 0,
    formalRunId: formalRunId ?? null,
    plan: reference(options.planPath),
    candidate: reference(candidatePath),
    corpus: reference(options.corpusPath),
    scriptHashes,
    gates: Object.fromEntries(
      Object.entries(gates).map(([name, gate]) => [name, gate.reference ?? null]),
    ),
    githubJobs: githubJobs.reference ?? null,
    recovery: null,
    shards: [...reportsByShard.values()]
      .sort((left, right) => left.report.composition.shard - right.report.composition.shard)
      .map(({ fragmentPath }) => reference(fragmentPath)),
    tasks: taskRecords,
    reasons,
  };
  if (options.recoveryManifestPath !== undefined) {
    report = applyFormalRecovery(report, options, { candidate, corpusTasks, plan });
  }
  return report;
}

function applyFormalRecovery(sourceReport, options, context) {
  if (!existsSync(options.recoveryManifestPath)) {
    return {
      ...sourceReport,
      accepted: false,
      reasons: [
        ...sourceReport.reasons,
        { stage: "recovery", reason: "recovery manifest is missing" },
      ],
    };
  }
  const manifest = readJson(options.recoveryManifestPath);
  const expectedManifest = buildFormalRecovery(sourceReport, options);
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    return {
      ...sourceReport,
      accepted: false,
      reasons: [
        ...sourceReport.reasons,
        { stage: "recovery", reason: "recovery manifest does not reproduce source evidence" },
      ],
    };
  }
  const manifestReference = reference(options.recoveryManifestPath);
  const recovered = new Map();
  const recoveryShards = [];
  const recoveryReasons = [];
  for (const batch of manifest.batches) {
    const fragmentPath = resolve(
      options.resultsDir,
      "recovery",
      `swe-bench-recovery.shard-${batch.sourceShard}.json`,
    );
    if (!existsSync(fragmentPath)) {
      recoveryReasons.push({
        stage: "recovery-fragment",
        shard: batch.sourceShard,
        reason: "expected recovery artifact is missing",
      });
      continue;
    }
    const fragment = readJson(fragmentPath);
    const actualTasks = fragment.tasks?.map((task) => task.instance_id) ?? [];
    if (
      fragment.composition?.shard !== batch.sourceShard ||
      fragment.composition?.shardTotal !== 100 ||
      fragment.composition?.recoveryManifestSha256 !== manifestReference.sha256 ||
      JSON.stringify(actualTasks) !== JSON.stringify(batch.tasks) ||
      fragment.candidateId !==
        `cli-${context.candidate.cliVersion}-${context.candidate.sourceCommit}` ||
      canonicalJson(fragment.provider) !== canonicalJson(context.candidate.provider) ||
      fragment.composition?.formalRunId !== sourceReport.formalRunId ||
      fragment.composition?.fullAccess !== true ||
      fragment.composition?.permissionMode !== "full" ||
      fragment.composition?.interactionTools !== false ||
      fragment.composition?.workspaceBackend !== "sandbox" ||
      fragment.composition?.execNetworkIsolation !== true ||
      fragment.composition?.networkToolSchemas !== false ||
      fragment.composition?.taskTimeoutMs !== context.candidate.taskTimeoutMs ||
      fragment.evaluation?.method !== "official-swe-bench-docker-deferred" ||
      fragment.evaluation?.evaluationBatchId !== sourceReport.formalRunId
    ) {
      recoveryReasons.push({
        stage: "recovery-fragment",
        shard: batch.sourceShard,
        reason: "recovery fragment configuration or task identity mismatch",
      });
      continue;
    }
    recoveryShards.push(reference(fragmentPath));
    for (const task of fragment.tasks) {
      const taskArtifactDir = resolve(
        options.resultsDir,
        "recovery",
        `swe-bench-recovery.shard-${batch.sourceShard}.tasks`,
        safeId(task.instance_id),
      );
      const receiptPath = resolve(taskArtifactDir, "receipt.json");
      if (
        task.taskReceiptPath !== relative(repoRoot, receiptPath) ||
        !existsSync(receiptPath)
      ) {
        recoveryReasons.push({
          stage: "recovery-task-receipt",
          instanceId: task.instance_id,
          reason: "missing recovery task receipt",
        });
        continue;
      }
      const receipt = readJson(receiptPath);
      const taskReason = admitTaskReceipt(receipt, {
        expectedTask: context.corpusTasks.get(task.instance_id),
        candidate: context.candidate,
        formalRunId: sourceReport.formalRunId,
        artifactRoot: taskArtifactDir,
        expectedPredictionPath: resolve(
          options.resultsDir,
          "recovery",
          `swe-bench-recovery.shard-${batch.sourceShard}.predictions`,
          `${safeId(task.instance_id)}.json`,
        ),
      });
      if (taskReason !== undefined) {
        recoveryReasons.push({
          stage: receipt.failureStage ?? "recovery-task",
          instanceId: task.instance_id,
          reason: taskReason,
        });
        continue;
      }
      recovered.set(task.instance_id, {
        instanceId: task.instance_id,
        disposition: receipt.disposition,
        receipt: reference(receiptPath),
        ...(receipt.prediction === undefined ? {} : { prediction: receipt.prediction }),
      });
    }
  }
  for (const task of manifest.tasks) {
    if (!recovered.has(task.instanceId)) {
      recoveryReasons.push({
        stage: "recovery-population",
        instanceId: task.instanceId,
        reason: "eligible task has no accepted recovery receipt",
      });
    }
  }
  const recoveredShards = new Set(
    context.plan.batches.flatMap((batch, shard) =>
      batch.tasks.every((instanceId) => recovered.has(instanceId)) ? [shard] : [],
    ),
  );
  const missingSourceShards = new Set(
    sourceReport.reasons.flatMap((reason) =>
      reason.stage === "fragment" &&
      reason.reason === "expected shard artifact is missing" &&
      Number.isInteger(reason.shard)
        ? [reason.shard]
        : [],
    ),
  );
  const sourceTasks = new Map(sourceReport.tasks.map((task) => [task.instanceId, task]));
  const tasks = context.plan.batches.flatMap((batch) =>
    batch.tasks.flatMap((instanceId) => {
      const task = recovered.get(instanceId) ?? sourceTasks.get(instanceId);
      return task === undefined ? [] : [task];
    }),
  );
  const reasons = sourceReport.reasons.filter((reason) => {
    if (typeof reason.instanceId === "string" && recovered.has(reason.instanceId)) return false;
    if (
      reason.stage === "fragment" &&
      reason.reason === "expected shard artifact is missing" &&
      recoveredShards.has(reason.shard)
    ) {
      return false;
    }
    if (
      reason.stage === "fragment" &&
      /^expected 100 shards, received /u.test(reason.reason) &&
      sourceReport.shards.length +
        [...missingSourceShards].filter((shard) => recoveredShards.has(shard)).length ===
        100
    ) {
      return false;
    }
    if (
      reason.stage === "population" &&
      tasks.length === 500 &&
      new Set(tasks.map((task) => task.instanceId)).size === 500
    ) {
      return false;
    }
    return reason.stage !== "ci-jobs";
  });
  const githubJobs = admitGithubJobs(
    resolve(options.resultsDir, "github-jobs.json"),
    manifest,
    context.plan,
    sourceReport.formalRunId,
  );
  if (!githubJobs.accepted) reasons.push({ stage: "ci-jobs", reason: githubJobs.reason });
  reasons.push(...recoveryReasons);
  return {
    ...sourceReport,
    accepted: reasons.length === 0,
    githubJobs: githubJobs.reference ?? sourceReport.githubJobs,
    recovery: {
      manifest: manifestReference,
      shards: recoveryShards,
    },
    tasks,
    reasons,
  };
}

export function admitFormalGeneration(options) {
  if (existsSync(options.outputPath)) throw new Error("Refusing to overwrite admission output.");
  const report = inspectFormalGeneration(options);
  writeJsonDurable(options.outputPath, report);
  if (!report.accepted) return report;
  const receiptPath = options.outputPath.replace(/\.json$/u, ".receipt.json");
  const receipt = {
    ...report,
    admissionReport: reference(options.outputPath),
    compositeSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
  };
  writeJsonDurable(receiptPath, receipt);
  return { ...report, receiptPath };
}

function admitGate(path, acceptedField) {
  if (!existsSync(path)) return { accepted: false, reason: "receipt missing" };
  const receipt = readJson(path);
  if (receipt[acceptedField] !== true) return { accepted: false, reason: "gate did not pass" };
  if (receipt.host?.platform !== "darwin" || receipt.host?.arch !== "arm64") {
    return { accepted: false, reason: "host is not darwin/arm64" };
  }
  return { accepted: true, reference: reference(path) };
}

function admitGithubJobs(path, recoveryManifest, plan, formalRunId) {
  if (!existsSync(path)) return { accepted: false, reason: "GitHub job/step receipt missing" };
  const jobs = readJson(path).jobs;
  if (!Array.isArray(jobs)) return { accepted: false, reason: "GitHub jobs are malformed" };
  const requiredNames = [
    "Freeze task batches",
    "macOS headless smoke",
    "Freeze SWE-bench corpus",
    "Verify frozen repository isolation",
  ];
  const expectedGenerationNames = plan.batches.map((batch) => `macOS generation (${batch.id})`);
  const generationJobs = jobs.filter((job) => expectedGenerationNames.includes(job.name));
  const requiredJobs = requiredNames.map((name) => jobs.filter((job) => job.name === name));
  const duplicateGeneration = expectedGenerationNames.filter(
    (name) => generationJobs.filter((job) => job.name === name).length !== 1,
  );
  if (generationJobs.length !== 100 || duplicateGeneration.length > 0) {
    return {
      accepted: false,
      reason: `source generation jobs must each have one execution; received ${generationJobs.length}, invalid=${duplicateGeneration.join(",")}`,
    };
  }
  const invalidRequired = requiredNames.filter((_, index) => requiredJobs[index].length !== 1);
  if (invalidRequired.length > 0) {
    return { accepted: false, reason: `jobs must have one execution: ${invalidRequired.join(", ")}` };
  }
  const expectedRunId = Number(String(formalRunId).replace(/^formal-/u, ""));
  const identityJobs = [...generationJobs, ...requiredJobs.flat()];
  if (
    !Number.isSafeInteger(expectedRunId) ||
    identityJobs.some((job) => job.run_id !== expectedRunId || job.run_attempt !== 1)
  ) {
    return { accepted: false, reason: "job run identity or attempt mismatch" };
  }
  const recoveredGenerationNames = new Set(
    recoveryManifest === undefined
      ? []
      : recoveryManifest.batches
          .filter((batch) => plan.batches[batch.sourceShard].tasks.length === batch.tasks.length)
          .map((batch) => `macOS generation (${plan.batches[batch.sourceShard].id})`),
  );
  const failed = [...generationJobs, ...requiredJobs.flat()].flatMap((job) => {
    if (job.conclusion === "failure" && recoveredGenerationNames.has(job.name)) return [];
    if (job.conclusion !== "success") return [`${job.name}: job=${job.conclusion}`];
    if (!Array.isArray(job.steps)) return [`${job.name}: steps malformed`];
    return job.steps
      .filter((step) => step.conclusion !== "success")
      .map((step) => `${job.name}/${step.name}: step=${step.conclusion}`);
  });
  if (recoveryManifest !== undefined) {
    const planJobs = jobs.filter((job) => job.name === "Build benchmark recovery plan");
    if (
      planJobs.length !== 1 ||
      planJobs[0].run_id !== expectedRunId ||
      planJobs[0].run_attempt !== 1 ||
      planJobs[0].conclusion !== "success"
    ) {
      failed.push("Build benchmark recovery plan must have one successful attempt-1 execution");
    }
    for (const batch of recoveryManifest.batches) {
      const name = `macOS recovery (${batch.id})`;
      const executions = jobs.filter((job) => job.name === name);
      if (
        executions.length !== 1 ||
        executions[0].run_id !== expectedRunId ||
        executions[0].run_attempt !== 1 ||
        executions[0].conclusion !== "success"
      ) {
        failed.push(`${name}: expected one successful attempt-1 execution`);
      }
    }
  }
  if (failed.length > 0) return { accepted: false, reason: failed.join("; ") };
  return { accepted: true, reference: reference(path) };
}

function admitTaskReceipt(receipt, context) {
  const instanceId = context.expectedTask?.instance_id;
  if (receipt.schemaVersion !== 1 || receipt.instance_id !== instanceId)
    return "task receipt identity mismatch";
  const claimPath = resolve(context.artifactRoot, "claim.json");
  const claim = matchesExactReference(receipt.claim, claimPath)
    ? readJson(resolve(repoRoot, receipt.claim.path))
    : undefined;
  if (
    !exactKeys(claim, [
      "baseCommit",
      "candidateId",
      "evaluationBatchId",
      "formalRunId",
      "instanceId",
      "repo",
      "schemaVersion",
      "timeoutMs",
    ]) ||
    claim.schemaVersion !== 1 ||
    claim?.instanceId !== instanceId ||
    claim.repo !== context.expectedTask.repo ||
    claim.baseCommit !== context.expectedTask.base_commit ||
    claim.candidateId !== `cli-${context.candidate.cliVersion}-${context.candidate.sourceCommit}` ||
    claim.evaluationBatchId !== context.formalRunId ||
    claim.formalRunId !== context.formalRunId ||
    claim.timeoutMs !== context.candidate.taskTimeoutMs
  ) {
    return "task claim identity mismatch";
  }
  if (receipt.disposition === "generation-inconclusive")
    return receipt.error ?? "generation infrastructure inconclusive";
  if (!validAcceptedTaskReceiptShape(receipt, context)) {
    return "task receipt schema or identity mismatch";
  }
  if (
    !matchesExactReference(
      receipt.processReceipt,
      resolve(context.artifactRoot, "process-receipt.json"),
    ) ||
    !matchesExactReference(
      receipt.evidence,
      resolve(context.artifactRoot, "attempt-evidence.jsonl"),
    ) ||
    !matchesExactReference(receipt.stdout, resolve(context.artifactRoot, "stdout.txt")) ||
    !matchesExactReference(receipt.stderr, resolve(context.artifactRoot, "stderr.txt")) ||
    (receipt.diagnosticPatch !== undefined &&
      !matchesExactReference(
        receipt.diagnosticPatch,
        resolve(context.artifactRoot, "diagnostic.patch"),
      ))
  ) {
    return "task evidence reference is missing or does not match bytes/hash";
  }
  const processReceipt = readJson(resolve(repoRoot, receipt.processReceipt.path));
  const evidence = inspectAttemptEvidence(resolve(repoRoot, receipt.evidence.path));
  if (
    !exactKeys(processReceipt, [
      "schemaVersion",
      "signal",
      "status",
      "stderr",
      "stderrOverflow",
      "stdout",
      "stdoutOverflow",
      "timedOut",
    ]) ||
    processReceipt.schemaVersion !== 1 ||
    !matchesExactReference(processReceipt.stdout, resolve(context.artifactRoot, "stdout.txt")) ||
    !matchesExactReference(processReceipt.stderr, resolve(context.artifactRoot, "stderr.txt"))
  ) {
    return "process stdout/stderr evidence is missing or mutated";
  }
  if (receipt.disposition === "model-timeout") {
    if (
      processReceipt.timedOut !== true ||
      processReceipt.status !== null ||
      processReceipt.signal !== "SIGKILL" ||
      processReceipt.stdoutOverflow !== false ||
      processReceipt.stderrOverflow !== false ||
      receipt.prediction !== undefined ||
      !evidence.prefixValid
    ) {
      return "model-timeout closure is invalid";
    }
    return undefined;
  }
  if (
    !evidence.complete ||
    evidence.rootStatus !== "completed" ||
    processReceipt.timedOut !== false ||
    processReceipt.status !== 0 ||
    processReceipt.signal !== null ||
    processReceipt.stdoutOverflow !== false ||
    processReceipt.stderrOverflow !== false
  )
    return "normal completion evidence is incomplete";
  if (receipt.disposition === "no-diff") {
    return receipt.prediction === undefined ? undefined : "no-diff task contains a prediction";
  }
  if (receipt.disposition === "frozen-prediction") {
    if (!matchesExactReference(receipt.prediction, context.expectedPredictionPath)) {
      return "frozen prediction is missing or mutated";
    }
    try {
      const prediction = readFrozenPrediction(resolve(repoRoot, receipt.prediction.path));
      if (
        prediction.instanceId !== instanceId ||
        prediction.evaluationBatchId !== context.formalRunId ||
        prediction.attemptId !== safeId(`${context.formalRunId}-${instanceId}`) ||
        prediction.modelNameOrPath !==
          `${context.candidate.provider.kind}/${context.candidate.provider.model}` ||
        prediction.modelPatchSha256 !== receipt.patchSha256
      ) {
        return "frozen prediction identity mismatch";
      }
    } catch (error) {
      return `frozen prediction is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
    return undefined;
  }
  return "unknown generation disposition";
}

function validAcceptedTaskReceiptShape(receipt, context) {
  const common = [
    "base_commit",
    "claim",
    "disposition",
    "evidence",
    "instance_id",
    "problem_statement",
    "processReceipt",
    "receiptPath",
    "repo",
    "schemaVersion",
    "stderr",
    "stdout",
    "wallMs",
  ];
  let variant;
  if (receipt.disposition === "frozen-prediction") {
    variant = ["agentPatch", "patchLines", "patchSha256", "prediction"];
  } else if (receipt.disposition === "no-diff") {
    variant = [
      "cliError",
      "cliExitCode",
      "error",
      ...(receipt.finalAnswer === undefined ? [] : ["finalAnswer"]),
    ];
  } else if (receipt.disposition === "model-timeout") {
    variant = [
      "timedOut",
      ...(receipt.diagnosticError === undefined ? [] : ["diagnosticError"]),
      ...(receipt.diagnosticPatch === undefined ? [] : ["diagnosticPatch"]),
    ];
  } else {
    return false;
  }
  return (
    exactKeys(receipt, [...common, ...variant]) &&
    receipt.instance_id === context.expectedTask.instance_id &&
    receipt.repo === context.expectedTask.repo &&
    receipt.base_commit === context.expectedTask.base_commit &&
    receipt.problem_statement === context.expectedTask.problem_statement &&
    Number.isFinite(receipt.wallMs) &&
    receipt.wallMs >= 0 &&
    receipt.receiptPath === relative(repoRoot, resolve(context.artifactRoot, "receipt.json"))
  );
}

function matchesExactReference(value, expectedPath) {
  if (!exactKeys(value, ["bytes", "path", "sha256"]) || typeof value.path !== "string") {
    return false;
  }
  const path = resolve(repoRoot, value.path);
  return (
    path === expectedPath &&
    existsSync(path) &&
    statSync(path).size === value.bytes &&
    sha256File(path) === value.sha256
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function reference(path) {
  return {
    path: path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path,
    bytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  const argv = process.argv.slice(2);
  try {
    const report = admitFormalGeneration(parseAdmissionArgs(argv));
    process.stdout.write(
      `${JSON.stringify({ accepted: report.accepted, reasons: report.reasons }, null, 2)}\n`,
    );
    if (!report.accepted) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputIndex = argv.indexOf("--output");
    const outputPath = outputIndex === -1 ? undefined : argv[outputIndex + 1];
    if (outputPath !== undefined && !existsSync(resolve(outputPath))) {
      mkdirSync(dirname(resolve(outputPath)), { recursive: true });
      writeJsonDurable(resolve(outputPath), {
        schemaVersion: 1,
        accepted: false,
        reasons: [{ stage: "admission", reason: message }],
      });
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
