#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectFormalGeneration } from "./admit-generation.mjs";
import * as evaluator from "./swe-bench-official-evaluator.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseEvaluationArgs(argv) {
  if (argv[0] === "--verify-report") {
    if (argv.length !== 2) throw new Error("--verify-report must be the only evaluation mode.");
    return { verifyReportPath: resolve(argv[1]) };
  }
  const parsed = { concurrency: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--admission-receipt") {
      parsed.admissionReceiptPath = resolve(argv[++index]);
    } else if (argv[index] === "--manifest") parsed.manifestPath = resolve(argv[++index]);
    else if (argv[index] === "--output") parsed.outputPath = resolve(argv[++index]);
    else if (argv[index] === "--concurrency") parsed.concurrency = Number(argv[++index]);
    else throw new Error(`Unknown evaluation argument: ${argv[index]}`);
  }
  for (const key of ["admissionReceiptPath", "manifestPath", "outputPath"]) {
    if (!parsed[key]) throw new Error(`Missing required evaluation ${key}.`);
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return parsed;
}

export async function evaluateAdmittedGeneration(options) {
  if (existsSync(options.outputPath)) throw new Error("Refusing to overwrite evaluation output.");
  const admitted = verifyAdmissionReceipt(options.admissionReceiptPath);
  const candidate = readJson(resolveReference(admitted.receipt.candidate));
  admitEvaluationManifest(options.manifestPath, admitted.receipt);
  const outputDir = resolve(
    repoRoot,
    "results",
    "official-evaluation",
    admitted.receipt.compositeSha256,
  );
  if (existsSync(outputDir)) {
    throw new Error("This admitted generation has already claimed an official evaluation.");
  }
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir, { recursive: false });
  const batchClaimPath = resolve(outputDir, "batch-claim.json");
  writeDurableJson(batchClaimPath, {
    schemaVersion: 1,
    compositeSha256: admitted.receipt.compositeSha256,
    formalRunId: admitted.receipt.formalRunId,
    admissionReceipt: fileReference(options.admissionReceiptPath),
    manifest: fileReference(options.manifestPath),
  });

  const predictionTasks = admitted.receipt.tasks.filter((task) => task.prediction !== undefined);
  const predictionPaths = predictionTasks.map((task) => resolveReference(task.prediction));
  const imageManifestPath = resolve(outputDir, "image-manifest.json");
  let imageManifestError;
  if (predictionPaths.length > 0) {
    try {
      await evaluator.freezeOfficialImageManifest({
        manifestPath: options.manifestPath,
        predictionPaths,
        outputPath: imageManifestPath,
      });
    } catch (error) {
      imageManifestError = error instanceof Error ? error.message : String(error);
    }
  }

  const tasks = [];
  if (imageManifestError !== undefined) {
    for (const task of admitted.receipt.tasks) {
      tasks.push(
        task.prediction === undefined
          ? { instance_id: task.instanceId, disposition: task.disposition }
          : await inconclusiveTask(
              task,
              admitted.predictions.get(task.instanceId),
              "evaluator-error",
              `evaluator-error: ${imageManifestError}`,
            ),
      );
    }
  } else {
    for (let index = 0; index < admitted.receipt.tasks.length; index += options.concurrency) {
      const batch = admitted.receipt.tasks.slice(index, index + options.concurrency);
      const evaluated = await Promise.all(
        batch.map((task) =>
          evaluateTask(task, admitted.predictions.get(task.instanceId), {
            admissionReceiptPath: options.admissionReceiptPath,
            manifestPath: options.manifestPath,
            imageManifestPath,
            outputDir,
          }),
        ),
      );
      tasks.push(...evaluated);
    }
  }

  const summary = evaluator.summarizeOfficialEvaluations(tasks);
  const report = {
    benchmark: "swe-bench-verified",
    candidateId: `cli-${candidate.cliVersion}-${candidate.sourceCommit}`,
    evaluatedAt: new Date().toISOString(),
    evaluation: {
      schemaVersion: 1,
      method: "official-swe-bench-docker",
      batchClaim: fileReference(batchClaimPath),
      admissionReceipt: fileReference(options.admissionReceiptPath),
      manifest: fileReference(options.manifestPath),
      imageManifest:
        predictionPaths.length === 0 || imageManifestError !== undefined
          ? null
          : fileReference(imageManifestPath),
      ...(imageManifestError === undefined ? {} : { imageManifestError }),
    },
    summary,
    tasks,
  };
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeDurableJson(options.outputPath, report);
  const markdownPath = options.outputPath.replace(/\.json$/u, ".md");
  writeFileSync(markdownPath, renderMarkdown(report), { flag: "wx" });
  return { outputPath: options.outputPath, markdownPath, summary };
}

export function verifyOfficialEvaluationReport(path) {
  const report = readJson(path);
  exactKeys(
    report,
    ["benchmark", "candidateId", "evaluatedAt", "evaluation", "summary", "tasks"],
    "official evaluation report",
  );
  if (
    report.benchmark !== "swe-bench-verified" ||
    typeof report.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(report.evaluatedAt)) ||
    !Array.isArray(report.tasks) ||
    report.tasks.length !== 500
  ) {
    throw new Error("Official evaluation report does not describe one 500-task evaluation.");
  }
  exactKeys(
    report.evaluation,
    [
      "schemaVersion",
      "method",
      "batchClaim",
      "admissionReceipt",
      "manifest",
      "imageManifest",
      ...(report.evaluation.imageManifestError === undefined ? [] : ["imageManifestError"]),
    ],
    "official evaluation metadata",
  );
  if (
    report.evaluation.schemaVersion !== 1 ||
    report.evaluation.method !== "official-swe-bench-docker" ||
    (report.evaluation.imageManifestError !== undefined &&
      (typeof report.evaluation.imageManifestError !== "string" ||
        report.evaluation.imageManifestError.length === 0))
  ) {
    throw new Error("Official evaluation method is not admitted.");
  }
  const admissionReceiptPath = verifyReference(report.evaluation.admissionReceipt);
  const admitted = verifyAdmissionReceipt(admissionReceiptPath);
  const candidate = readJson(resolveReference(admitted.receipt.candidate));
  if (report.candidateId !== `cli-${candidate.cliVersion}-${candidate.sourceCommit}`) {
    throw new Error("Official evaluation candidate does not match its admission receipt.");
  }
  const manifestPath = verifyReference(report.evaluation.manifest);
  const evaluatorManifest = admitEvaluationManifest(manifestPath, admitted.receipt);
  const batchClaimPath = verifyReference(report.evaluation.batchClaim);
  const batchClaim = readJson(batchClaimPath);
  exactKeys(
    batchClaim,
    ["schemaVersion", "compositeSha256", "formalRunId", "admissionReceipt", "manifest"],
    "official evaluation batch claim",
  );
  if (
    batchClaim.schemaVersion !== 1 ||
    batchClaim.compositeSha256 !== admitted.receipt.compositeSha256 ||
    batchClaim.formalRunId !== admitted.receipt.formalRunId ||
    canonicalJson(batchClaim.admissionReceipt) !==
      canonicalJson(report.evaluation.admissionReceipt) ||
    canonicalJson(batchClaim.manifest) !== canonicalJson(report.evaluation.manifest)
  ) {
    throw new Error("Official evaluation batch claim does not match the admitted generation.");
  }
  let imageEntries = new Map();
  if (report.evaluation.imageManifest === null) {
    if (report.evaluation.imageManifestError === undefined && admitted.predictions.size !== 0) {
      throw new Error("Official evaluation omitted its image manifest without a recorded error.");
    }
  } else {
    if (report.evaluation.imageManifestError !== undefined) {
      throw new Error("Official evaluation cannot contain both an image manifest and its error.");
    }
    const imageManifest = evaluator.loadOfficialImageManifest(
      verifyReference(report.evaluation.imageManifest),
    );
    const expectedIds = [...admitted.predictions.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      imageManifest.evaluationBatchId !== admitted.receipt.formalRunId ||
      imageManifest.platform !== evaluatorManifest.platform ||
      canonicalJson(imageManifest.entries.map((entry) => entry.instanceId)) !==
        canonicalJson(expectedIds)
    ) {
      throw new Error("Official image manifest does not exact-cover admitted predictions.");
    }
    imageEntries = new Map(imageManifest.entries.map((entry) => [entry.instanceId, entry]));
  }

  for (let index = 0; index < admitted.receipt.tasks.length; index += 1) {
    verifyOfficialTask(
      report.tasks[index],
      admitted.receipt.tasks[index],
      admitted.predictions,
      report.evaluation,
      evaluatorManifest,
      imageEntries,
    );
  }
  const summary = evaluator.summarizeOfficialEvaluations(report.tasks);
  if (canonicalJson(report.summary) !== canonicalJson(summary)) {
    throw new Error("Official evaluation summary does not reproduce its task records.");
  }
  return {
    accepted: true,
    compositeSha256: admitted.receipt.compositeSha256,
    summary,
  };
}

function verifyOfficialTask(
  task,
  admittedTask,
  predictions,
  evaluation,
  evaluatorManifest,
  imageEntries,
) {
  if (
    task.instance_id !== admittedTask.instanceId ||
    task.disposition !== admittedTask.disposition
  ) {
    throw new Error("Official task identity or disposition does not match admission.");
  }
  if (admittedTask.prediction === undefined) {
    exactKeys(task, ["instance_id", "disposition"], "not-evaluated official task");
    return;
  }
  exactKeys(
    task,
    [
      "instance_id",
      "disposition",
      "officialEvaluation",
      ...(task.evaluationError === undefined ? [] : ["evaluationError"]),
      ...(task.claim === undefined ? [] : ["claim"]),
      ...(task.terminalReceipt === undefined ? [] : ["terminalReceipt"]),
    ],
    "evaluated official task",
  );
  const prediction = predictions.get(task.instance_id);
  const official = evaluator.admitOfficialEvaluationRecord(task.officialEvaluation);
  const hasEvaluationError =
    typeof task.evaluationError === "string" && task.evaluationError.length > 0;
  if (task.evaluationError !== undefined && !hasEvaluationError) {
    throw new Error("Official task evaluationError must be a non-empty string.");
  }
  if (
    official.instanceId !== prediction.instanceId ||
    official.attemptId !== prediction.attemptId ||
    official.evaluationBatchId !== prediction.evaluationBatchId ||
    official.patchSha256 !== prediction.modelPatchSha256
  ) {
    throw new Error("Official task result does not match its frozen prediction.");
  }
  if (task.terminalReceipt === undefined) {
    if (official.verdict !== "inconclusive" || !hasEvaluationError) {
      throw new Error("An official task without a terminal receipt must remain inconclusive.");
    }
    if (task.claim !== undefined) verifyReference(task.claim);
    return;
  }
  if (task.claim === undefined) {
    throw new Error("An official terminal receipt requires its invocation claim.");
  }
  if ((official.verdict === "inconclusive") !== hasEvaluationError) {
    throw new Error("Official terminal task error marker does not match its verdict.");
  }
  if (
    official.evaluatorVersion !== evaluatorManifest.evaluatorVersion ||
    official.evaluatorCommit !== evaluatorManifest.evaluatorCommit ||
    official.datasetRevision !== evaluatorManifest.dataset.sourceRevision ||
    official.platform !== evaluatorManifest.platform ||
    official.officialRunId !== evaluator.officialRunIdFor(prediction)
  ) {
    throw new Error("Official terminal task provenance does not match its evaluator manifest.");
  }
  const imageEntry = imageEntries.get(task.instance_id);
  if (
    imageEntry === undefined ||
    ((official.imageRef !== "" || official.verdict !== "inconclusive") &&
      (official.imageRef !== imageEntry.imageRef ||
        official.imageDigest !== imageEntry.imageDigest))
  ) {
    throw new Error("Official terminal task provenance does not match its pinned image.");
  }
  const claimPath = verifyReference(task.claim);
  const claim = readJson(claimPath);
  exactKeys(
    claim,
    ["schemaVersion", "instanceId", "admissionReceipt", "prediction", "manifest", "imageManifest"],
    "official task invocation claim",
  );
  if (
    claim.schemaVersion !== 1 ||
    claim.instanceId !== admittedTask.instanceId ||
    canonicalJson(claim.admissionReceipt) !== canonicalJson(evaluation.admissionReceipt) ||
    canonicalJson(claim.prediction) !== canonicalJson(admittedTask.prediction) ||
    canonicalJson(claim.manifest) !== canonicalJson(evaluation.manifest) ||
    canonicalJson(claim.imageManifest) !== canonicalJson(evaluation.imageManifest)
  ) {
    throw new Error("Official task invocation claim does not match admission.");
  }
  verifyReference(claim.admissionReceipt);
  verifyReference(claim.prediction);
  verifyReference(claim.manifest);
  verifyReference(claim.imageManifest);
  const terminalPath = verifyReference(task.terminalReceipt);
  const terminal = readJson(terminalPath);
  exactKeys(
    terminal,
    ["schemaVersion", "instanceId", "claim", "officialEvaluation"],
    "official task terminal receipt",
  );
  if (
    terminal.schemaVersion !== 1 ||
    terminal.instanceId !== admittedTask.instanceId ||
    canonicalJson(terminal.claim) !== canonicalJson(task.claim) ||
    canonicalJson(terminal.officialEvaluation) !== canonicalJson(task.officialEvaluation)
  ) {
    throw new Error("Official task terminal receipt does not match its report and claim.");
  }
}

export function verifyAdmissionReceipt(path) {
  const receipt = readJson(path);
  const reportKeys = [
    "accepted",
    "candidate",
    "corpus",
    "formalRunId",
    "gates",
    "githubJobs",
    "plan",
    "recovery",
    "reasons",
    "schemaVersion",
    "scriptHashes",
    "shards",
    "tasks",
  ];
  exactKeys(receipt, [...reportKeys, "admissionReport", "compositeSha256"], "receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.accepted !== true ||
    receipt.reasons.length !== 0 ||
    typeof receipt.formalRunId !== "string" ||
    !/^formal-[0-9]+$/u.test(receipt.formalRunId) ||
    !Array.isArray(receipt.tasks) ||
    receipt.tasks.length !== 500 ||
    new Set(receipt.tasks.map((task) => task.instanceId)).size !== 500
  ) {
    throw new Error("Input must be one accepted formal 500-task admission receipt.");
  }
  const admissionReportPath = verifyReference(receipt.admissionReport);
  const frozenReport = readJson(admissionReportPath);
  exactKeys(frozenReport, reportKeys, "admission report");
  const receiptReport = Object.fromEntries(reportKeys.map((key) => [key, receipt[key]]));
  if (canonicalJson(receiptReport) !== canonicalJson(frozenReport)) {
    throw new Error("Admission receipt does not exactly embed its admission report.");
  }
  const recomputed = inspectFormalGeneration({
    resultsDir: dirname(admissionReportPath),
    planPath: verifyReference(receipt.plan),
    corpusPath: verifyReference(receipt.corpus),
    ...(receipt.recovery === null
      ? {}
      : { recoveryManifestPath: verifyReference(receipt.recovery.manifest) }),
  });
  if (canonicalJson(recomputed) !== canonicalJson(frozenReport)) {
    throw new Error("Admission evidence no longer reproduces the accepted report.");
  }
  const compositeSha256 = createHash("sha256").update(JSON.stringify(frozenReport)).digest("hex");
  if (receipt.compositeSha256 !== compositeSha256) {
    throw new Error("Admission receipt composite hash does not match its report.");
  }
  verifyReference(receipt.githubJobs);
  for (const reference of Object.values(receipt.gates)) verifyReference(reference);
  if (!Array.isArray(receipt.shards)) throw new Error("Admission shard references are malformed.");
  for (const reference of receipt.shards) verifyReference(reference);
  if (receipt.recovery !== null) {
    exactKeys(receipt.recovery, ["manifest", "shards"], "admission recovery");
    if (!Array.isArray(receipt.recovery.shards)) {
      throw new Error("Admission recovery shard references are malformed.");
    }
    for (const reference of receipt.recovery.shards) verifyReference(reference);
  }
  const predictions = new Map();
  for (const task of receipt.tasks) {
    verifyReference(task.receipt);
    if (task.prediction !== undefined) {
      const predictionPath = verifyReference(task.prediction);
      const prediction = evaluator.readFrozenPrediction(predictionPath);
      if (prediction.instanceId !== task.instanceId) {
        throw new Error("Admission prediction identity does not match its task.");
      }
      predictions.set(task.instanceId, prediction);
    }
  }
  return { receipt, predictions };
}

function admitEvaluationManifest(path, receipt) {
  const manifest = evaluator.loadOfficialEvaluatorManifest(path);
  const plan = readJson(resolveReference(receipt.plan));
  const profile = readJson(resolve(repoRoot, "config/swe-bench-verified.json"));
  const corpusPath = resolveReference(receipt.corpus);
  const selected = receipt.tasks
    .map((task) => task.instanceId)
    .sort((left, right) => left.localeCompare(right));
  const dataset = manifest.dataset;
  if (
    resolve(dataset.localDatasetJsonlPath) !== corpusPath ||
    dataset.localDatasetJsonlSha256 !== receipt.corpus.sha256 ||
    dataset.localDatasetJsonlBytes !== receipt.corpus.bytes ||
    dataset.profileId !== plan.profileId ||
    dataset.profileId !== profile.profileId ||
    dataset.sourceDatasetName !== profile.sourceDatasetName ||
    dataset.split !== profile.split ||
    dataset.sourceRevision !== profile.sourceRevision ||
    JSON.stringify(dataset.selectedInstanceIds) !== JSON.stringify(selected)
  ) {
    throw new Error("Official evaluator dataset does not match the admitted generation corpus.");
  }
  return manifest;
}

async function evaluateTask(task, prediction, context) {
  if (task.prediction === undefined) {
    return { instance_id: task.instanceId, disposition: task.disposition };
  }
  const taskDir = resolve(context.outputDir, safeId(task.instanceId));
  mkdirSync(taskDir, { recursive: false });
  const claimPath = resolve(taskDir, "invocation-claim.json");
  const terminalReceiptPath = resolve(taskDir, "terminal-receipt.json");
  const claim = {
    schemaVersion: 1,
    instanceId: task.instanceId,
    admissionReceipt: fileReference(context.admissionReceiptPath),
    prediction: task.prediction,
    manifest: fileReference(context.manifestPath),
    imageManifest: fileReference(context.imageManifestPath),
  };
  try {
    writeDurableJson(claimPath, claim);
  } catch (error) {
    return inconclusiveTask(
      task,
      prediction,
      "uncertain-external-effect",
      `uncertain-external-effect: ${error instanceof Error ? error.message : String(error)}`,
      existsSync(claimPath) ? claimPath : undefined,
    );
  }
  try {
    const officialEvaluation = await evaluator.evaluateFrozenPrediction({
      manifestPath: context.manifestPath,
      prediction,
      imageManifestPath: context.imageManifestPath,
      outputDir: resolve(taskDir, "official"),
    });
    writeDurableJson(terminalReceiptPath, {
      schemaVersion: 1,
      instanceId: task.instanceId,
      claim: fileReference(claimPath),
      officialEvaluation,
    });
    return {
      instance_id: task.instanceId,
      disposition: task.disposition,
      officialEvaluation,
      claim: fileReference(claimPath),
      terminalReceipt: fileReference(terminalReceiptPath),
      ...(officialEvaluation.verdict === "inconclusive"
        ? { evaluationError: officialEvaluation.reason }
        : {}),
    };
  } catch (error) {
    return inconclusiveTask(
      task,
      prediction,
      "uncertain-external-effect",
      `uncertain-external-effect: ${error instanceof Error ? error.message : String(error)}`,
      claimPath,
    );
  }
}

async function inconclusiveTask(task, prediction, reason, evaluationError, claimPath) {
  const fallback = await evaluator.evaluateFrozenPrediction({ prediction });
  return {
    instance_id: task.instanceId,
    disposition: task.disposition,
    officialEvaluation: evaluator.admitOfficialEvaluationRecord({ ...fallback, reason }),
    evaluationError,
    ...(claimPath === undefined ? {} : { claim: fileReference(claimPath) }),
  };
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} fields do not match the admitted schema.`);
  }
}

function verifyReference(reference) {
  exactKeys(reference, ["bytes", "path", "sha256"], "artifact reference");
  const path = resolveReference(reference);
  const actual = fileReference(path);
  if (actual.bytes !== reference.bytes || actual.sha256 !== reference.sha256) {
    throw new Error(`Referenced artifact changed: ${reference.path}`);
  }
  return path;
}

function resolveReference(reference) {
  const path = resolve(repoRoot, reference.path);
  if (path !== repoRoot && !path.startsWith(`${repoRoot}/`)) {
    throw new Error("Artifact reference escapes the benchmark repository.");
  }
  return path;
}

function writeDurableJson(path, value) {
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

function fileReference(path) {
  const bytes = readFileSync(path);
  return {
    path: path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
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

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function renderMarkdown(report) {
  const lines = [
    "# Official SWE-bench evaluation",
    "",
    `- Candidate: ${report.candidateId}`,
    `- Official pass@1: ${report.summary.passAt1 ?? "inconclusive"}`,
    `- Coverage: ${report.summary.officialCoverage}`,
    "",
    "| Instance | Verdict | Reason |",
    "|---|---|---|",
  ];
  for (const task of report.tasks) {
    lines.push(
      `| ${task.instance_id} | ${evaluator.projectBenchmarkTaskDisposition(task)} | ${task.officialEvaluation?.reason ?? "not-evaluated"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseEvaluationArgs(process.argv.slice(2));
  const operation = options.verifyReportPath
    ? Promise.resolve(verifyOfficialEvaluationReport(options.verifyReportPath))
    : evaluateAdmittedGeneration(options);
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
