#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const OFFICIAL_EVALUATOR_VERSION = "4.1.0";
export const OFFICIAL_EVALUATOR_COMMIT = "726c5461e2ef52d83cf1ea2107870a8bb3328d57";
export const OFFICIAL_IMAGE_PULL_RETRY_ATTEMPTS = 3;
export const OFFICIAL_PLATFORM = "linux/amd64";
export const OFFICIAL_EVALUATION_TIMEOUT_SECONDS = 1_800;
export const OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS = 900;
export const OFFICIAL_DATASET_NAME = "princeton-nlp/SWE-bench_Verified";
export const OFFICIAL_DATASET_SPLIT = "test";
export const OFFICIAL_DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";

const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_RAW_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const encoder = new TextEncoder();
export const OFFICIAL_REASONS = new Set([
  "official-resolved",
  "official-unresolved",
  "invalid-prediction",
  "missing-exact-patch",
  "config-mismatch",
  "digest-mismatch",
  "evaluator-error",
  "evaluator-timeout",
  "report-missing",
  "report-malformed",
  "report-mismatch",
  "uncertain-external-effect",
]);

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createFrozenPrediction(input) {
  const prediction = exactRecord(
    input,
    [
      "schemaVersion",
      "evaluationBatchId",
      "attemptId",
      "instanceId",
      "modelNameOrPath",
      "modelPatch",
    ],
    "FrozenPrediction input",
  );
  if (prediction.schemaVersion !== 1) throw new Error("FrozenPrediction schemaVersion must be 1.");
  for (const key of ["evaluationBatchId", "attemptId", "instanceId", "modelNameOrPath"]) {
    assertIdentifier(prediction[key], `FrozenPrediction.${key}`);
  }
  if (typeof prediction.modelPatch !== "string" || prediction.modelPatch.length === 0) {
    throw new Error("FrozenPrediction.modelPatch must be a non-empty string.");
  }
  if (encoder.encode(prediction.modelPatch).byteLength > MAX_PATCH_BYTES) {
    throw new Error(`FrozenPrediction.modelPatch exceeds ${MAX_PATCH_BYTES} bytes.`);
  }
  return Object.freeze({
    ...prediction,
    modelPatchSha256: sha256Text(prediction.modelPatch),
  });
}

export function writeFrozenPrediction(path, prediction) {
  const admitted = createFrozenPrediction({
    schemaVersion: prediction.schemaVersion,
    evaluationBatchId: prediction.evaluationBatchId,
    attemptId: prediction.attemptId,
    instanceId: prediction.instanceId,
    modelNameOrPath: prediction.modelNameOrPath,
    modelPatch: prediction.modelPatch,
  });
  if (
    prediction.modelPatchSha256 !== undefined &&
    prediction.modelPatchSha256 !== admitted.modelPatchSha256
  ) {
    throw new Error("FrozenPrediction.modelPatchSha256 does not match modelPatch.");
  }
  writeJsonAtomic(path, admitted);
  return admitted;
}

export function readFrozenPrediction(path) {
  const value = readJson(path, MAX_PATCH_BYTES + 64 * 1024, "FrozenPrediction");
  const admitted = createFrozenPrediction({
    schemaVersion: value.schemaVersion,
    evaluationBatchId: value.evaluationBatchId,
    attemptId: value.attemptId,
    instanceId: value.instanceId,
    modelNameOrPath: value.modelNameOrPath,
    modelPatch: value.modelPatch,
  });
  if (value.modelPatchSha256 !== admitted.modelPatchSha256) {
    throw new Error("FrozenPrediction.modelPatchSha256 does not match modelPatch.");
  }
  return admitted;
}

export function freezePredictionFromResult(input) {
  const result = readJson(input.resultPath, 128 * 1024 * 1024, "benchmark result");
  if (!Array.isArray(result.tasks)) throw new Error("Benchmark result.tasks must be an array.");
  const matches = result.tasks.filter((task) => task?.instance_id === input.instanceId);
  if (matches.length !== 1) {
    throw new Error("Benchmark result must contain exactly one matching instance.");
  }
  const task = matches[0];
  if (
    typeof task.agentPatch !== "string" ||
    task.agentPatch.length === 0 ||
    task.agentPatch.includes("... (truncated)") ||
    !Number.isInteger(task.patchLines) ||
    task.patchLines !== task.agentPatch.split("\n").length
  ) {
    throw new Error("The selected attempt does not contain an exact full patch.");
  }
  if (!result.provider || typeof result.provider !== "object") {
    throw new Error("Benchmark result.provider is required.");
  }
  assertIdentifier(result.provider.kind, "benchmark provider kind");
  assertIdentifier(result.provider.model, "benchmark provider model");
  const prediction = createFrozenPrediction({
    schemaVersion: 1,
    evaluationBatchId: input.evaluationBatchId,
    attemptId: input.attemptId,
    instanceId: input.instanceId,
    modelNameOrPath: `${result.provider.kind}/${result.provider.model}`,
    modelPatch: task.agentPatch,
  });
  writeFrozenPrediction(input.outputPath, prediction);
  return Object.freeze({
    prediction,
    source: Object.freeze({
      resultPath: input.resultPath,
      resultSha256: sha256File(input.resultPath),
      generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : "",
      candidateId: typeof result.candidateId === "string" ? result.candidateId : "",
    }),
  });
}

export function loadOfficialEvaluatorManifest(path) {
  const value = readJson(path, 256 * 1024, "official evaluator manifest");
  exactRecord(
    value,
    [
      "schemaVersion",
      "profileId",
      "evaluatorPython",
      "evaluatorSourceDir",
      "gitExecutable",
      "dockerExecutable",
      "evaluatorVersion",
      "evaluatorCommit",
      "dataset",
      "platform",
      "evaluationTimeoutSeconds",
      "imagePullTimeoutSeconds",
    ],
    "official evaluator manifest",
  );
  if (value.schemaVersion !== 1) throw new Error("Official evaluator schemaVersion must be 1.");
  assertIdentifier(value.profileId, "official evaluator profileId");
  assertAbsolutePath(value.evaluatorPython, "official evaluator evaluatorPython");
  assertAbsolutePath(value.evaluatorSourceDir, "official evaluator evaluatorSourceDir");
  assertAbsolutePath(value.gitExecutable, "official evaluator gitExecutable");
  assertAbsolutePath(value.dockerExecutable, "official evaluator dockerExecutable");
  if (value.evaluatorVersion !== OFFICIAL_EVALUATOR_VERSION) {
    throw new Error(`Official evaluator version must be ${OFFICIAL_EVALUATOR_VERSION}.`);
  }
  if (value.evaluatorCommit !== OFFICIAL_EVALUATOR_COMMIT) {
    throw new Error(`Official evaluator commit must be ${OFFICIAL_EVALUATOR_COMMIT}.`);
  }
  if (value.platform !== OFFICIAL_PLATFORM) {
    throw new Error(`Official evaluator platform must be ${OFFICIAL_PLATFORM}.`);
  }
  if (value.evaluationTimeoutSeconds !== OFFICIAL_EVALUATION_TIMEOUT_SECONDS) {
    throw new Error(
      `Official evaluator timeout must be ${OFFICIAL_EVALUATION_TIMEOUT_SECONDS} seconds.`,
    );
  }
  if (value.imagePullTimeoutSeconds !== OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS) {
    throw new Error(
      `Official image pull timeout must be ${OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS} seconds.`,
    );
  }
  const dataset = exactRecord(
    value.dataset,
    [
      "schemaVersion",
      "profileId",
      "sourceDatasetName",
      "split",
      "sourceRevision",
      "localDatasetJsonlPath",
      "localDatasetJsonlSha256",
      "localDatasetJsonlBytes",
      "selectedInstanceIds",
    ],
    "official dataset manifest",
  );
  if (dataset.schemaVersion !== 1) throw new Error("Dataset schemaVersion must be 1.");
  for (const key of ["profileId", "sourceDatasetName", "split", "sourceRevision"]) {
    assertIdentifier(dataset[key], `official dataset ${key}`);
  }
  if (
    dataset.sourceDatasetName !== OFFICIAL_DATASET_NAME ||
    dataset.split !== OFFICIAL_DATASET_SPLIT ||
    dataset.sourceRevision !== OFFICIAL_DATASET_REVISION
  ) {
    throw new Error(
      "Official dataset source, split, or revision does not match the pinned profile.",
    );
  }
  assertAbsolutePath(dataset.localDatasetJsonlPath, "official dataset localDatasetJsonlPath");
  assertSha256(dataset.localDatasetJsonlSha256, "official dataset localDatasetJsonlSha256");
  if (
    !Number.isSafeInteger(dataset.localDatasetJsonlBytes) ||
    dataset.localDatasetJsonlBytes <= 0
  ) {
    throw new Error("Official dataset localDatasetJsonlBytes must be a positive safe integer.");
  }
  assertSelectedInstanceIds(dataset.selectedInstanceIds);
  return Object.freeze({
    ...value,
    dataset: Object.freeze({
      ...dataset,
      selectedInstanceIds: Object.freeze([...dataset.selectedInstanceIds]),
    }),
    manifestPath: path,
  });
}

export async function acquireOfficialDataset(options) {
  assertAbsolutePath(options.pythonPath, "dataset acquisition pythonPath");
  assertAbsolutePath(options.outputPath, "dataset acquisition outputPath");
  assertAbsolutePath(options.manifestOutputPath, "dataset acquisition manifestOutputPath");
  assertIdentifier(options.profileId, "dataset acquisition profileId");
  if (!existsSync(options.pythonPath)) throw new Error("Dataset acquisition Python is missing.");
  if (existsSync(options.outputPath) || existsSync(options.manifestOutputPath)) {
    throw new Error("Refusing to overwrite an existing dataset artifact.");
  }
  mkdirSync(dirname(options.outputPath), { recursive: true });
  const temporaryPath = `${options.outputPath}.tmp-${process.pid}`;
  const script = [
    "import json,sys",
    "from datasets import load_dataset",
    "name,split,revision,output=sys.argv[1:]",
    "rows=load_dataset(name, split=split, revision=revision)",
    "with open(output, 'x', encoding='utf-8') as handle:",
    "    for row in rows:",
    "        handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True, separators=(',', ':'))+'\\n')",
  ].join("\n");
  const runner = options.commandRunner ?? runBoundedCommand;
  const result = await runner({
    executable: options.pythonPath,
    args: [
      "-c",
      script,
      OFFICIAL_DATASET_NAME,
      OFFICIAL_DATASET_SPLIT,
      OFFICIAL_DATASET_REVISION,
      temporaryPath,
    ],
    env: { ...process.env, PYTHONNOUSERSITE: "1" },
    timeoutMs: 1_800_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.timedOut || result.status !== 0 || !existsSync(temporaryPath)) {
    rmSync(temporaryPath, { force: true });
    throw new Error("Pinned dataset acquisition failed.");
  }
  const bytes = readFileSync(temporaryPath);
  let rows;
  try {
    rows = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    rmSync(temporaryPath, { force: true });
    throw new Error("Pinned dataset acquisition produced invalid JSONL.");
  }
  const selectedInstanceIds = rows
    .map((row) => row?.instance_id)
    .sort((left, right) =>
      typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : 0,
    );
  try {
    assertSelectedInstanceIds(selectedInstanceIds);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  const datasetManifest = Object.freeze({
    schemaVersion: 1,
    profileId: options.profileId,
    sourceDatasetName: OFFICIAL_DATASET_NAME,
    split: OFFICIAL_DATASET_SPLIT,
    sourceRevision: OFFICIAL_DATASET_REVISION,
    localDatasetJsonlPath: options.outputPath,
    localDatasetJsonlSha256: createHash("sha256").update(bytes).digest("hex"),
    localDatasetJsonlBytes: bytes.byteLength,
    selectedInstanceIds: Object.freeze(selectedInstanceIds),
  });
  renameSync(temporaryPath, options.outputPath);
  writeJsonAtomic(options.manifestOutputPath, datasetManifest);
  return datasetManifest;
}

export async function freezeOfficialImageManifest(options) {
  const manifest =
    typeof options.manifestPath === "string"
      ? loadOfficialEvaluatorManifest(options.manifestPath)
      : options.manifest;
  if (!manifest) throw new Error("Official evaluator manifest is required.");
  if (!Array.isArray(options.predictionPaths) || options.predictionPaths.length === 0) {
    throw new Error("At least one frozen prediction is required.");
  }
  const predictions = options.predictionPaths
    .map((path) => readFrozenPrediction(path))
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (
    new Set(predictions.map((prediction) => prediction.instanceId)).size !== predictions.length ||
    new Set(predictions.map((prediction) => prediction.evaluationBatchId)).size !== 1
  ) {
    throw new Error("Image manifest predictions must have unique instances in one batch.");
  }
  const runner = options.commandRunner ?? runBoundedCommand;
  await preflightEvaluator(manifest, runner);
  verifyFrozenDataset(manifest);
  const entries = [];
  for (const prediction of predictions) {
    assertPredictionInDataset(manifest, prediction);
    const imageRef = await resolveOfficialImageRef({
      manifest,
      prediction,
      namespace: "swebench",
      instanceImageTag: "latest",
      runner,
    });
    let pull;
    for (let attempt = 1; attempt <= OFFICIAL_IMAGE_PULL_RETRY_ATTEMPTS; attempt += 1) {
      pull = await runner({
        executable: manifest.dockerExecutable,
        args: ["pull", "--platform", manifest.platform, imageRef],
        timeoutMs: manifest.imagePullTimeoutSeconds * 1_000,
        maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      });
      if (!pull.timedOut && pull.status === 0) break;
      if (attempt < OFFICIAL_IMAGE_PULL_RETRY_ATTEMPTS) {
        await (options.retryDelay ?? delay)(attempt * 1_000);
      }
    }
    if (pull.timedOut || pull.status !== 0) {
      throw new Error(
        `Official image pull failed for ${prediction.instanceId} (status=${pull.status}, timedOut=${pull.timedOut}): ${pull.stderr.trim().slice(-500)}`,
      );
    }
    const repository = stripTag(imageRef);
    const repoDigests = parseJsonStringArray(
      await dockerInspect(imageRef, "{{json .RepoDigests}}", manifest, runner),
      "docker RepoDigests",
    );
    const matches = repoDigests.filter((value) => value.startsWith(`${repository}@sha256:`));
    if (matches.length !== 1) throw new Error("Official image digest is missing or ambiguous.");
    const imageDigest = matches[0].slice(matches[0].indexOf("@") + 1);
    assertDigest(imageDigest);
    entries.push(Object.freeze({ instanceId: prediction.instanceId, imageRef, imageDigest }));
  }
  const imageManifest = Object.freeze({
    schemaVersion: 1,
    evaluationBatchId: predictions[0].evaluationBatchId,
    platform: manifest.platform,
    entries: Object.freeze(entries),
  });
  writeJsonAtomic(options.outputPath, imageManifest);
  return imageManifest;
}

export function verifyOfficialDatasetManifest(manifest) {
  verifyFrozenDataset(manifest);
  return true;
}

export function projectOfficialRunReport(input) {
  const { report, prediction, provenance } = input;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return officialRecord(prediction, provenance, "inconclusive", "report-malformed", null);
  }
  if (report.schema_version !== 2) {
    return officialRecord(prediction, provenance, "inconclusive", "report-malformed", null);
  }
  const names = ["submitted_ids", "completed_ids", "resolved_ids", "unresolved_ids", "error_ids"];
  const sets = {};
  for (const name of names) {
    const values = report[name];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      return officialRecord(prediction, provenance, "inconclusive", "report-malformed", null);
    }
    const set = new Set(values);
    if (set.size !== values.length) {
      return officialRecord(prediction, provenance, "inconclusive", "report-malformed", null);
    }
    sets[name] = set;
  }
  const id = prediction.instanceId;
  if (sets.submitted_ids.size !== 1 || !sets.submitted_ids.has(id)) {
    return officialRecord(prediction, provenance, "inconclusive", "report-mismatch", null);
  }
  if (sets.error_ids.has(id)) {
    return officialRecord(prediction, provenance, "inconclusive", "evaluator-error", null);
  }
  const completed = sets.completed_ids.has(id);
  const resolved = sets.resolved_ids.has(id);
  const unresolved = sets.unresolved_ids.has(id);
  if (completed && resolved && !unresolved) {
    return officialRecord(prediction, provenance, "resolved", "official-resolved", true);
  }
  if (completed && unresolved && !resolved) {
    return officialRecord(prediction, provenance, "test-failed", "official-unresolved", false);
  }
  return officialRecord(prediction, provenance, "inconclusive", "report-mismatch", null);
}

export function projectBenchmarkTaskDisposition(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Benchmark task result must be an object.");
  }
  if (task.officialEvaluation !== undefined) {
    return admitOfficialEvaluationRecord(task.officialEvaluation).verdict;
  }
  return task.benchmarkInconclusive === true ? "inconclusive" : "not-evaluated";
}

export function summarizeOfficialEvaluations(tasks, options = {}) {
  const total = tasks.length;
  const dispositions = tasks.map(projectBenchmarkTaskDisposition);
  const officialResolved = dispositions.filter((state) => state === "resolved").length;
  const officialTestFailed = dispositions.filter((state) => state === "test-failed").length;
  const officialInconclusive = dispositions.filter((state) => state === "inconclusive").length;
  const notEvaluated = dispositions.filter((state) => state === "not-evaluated").length;
  if (officialResolved + officialTestFailed + officialInconclusive + notEvaluated !== total) {
    throw new Error("Benchmark task dispositions must exactly cover the task population.");
  }
  const unadmittedFragments = options.unadmittedFragments ?? 0;
  return Object.freeze({
    officialResolved,
    officialTestFailed,
    officialInconclusive,
    notEvaluated,
    unadmittedFragments,
    officialCoverage: ratio(officialResolved + officialTestFailed, total),
    adjudicatedResolveRate: ratio(officialResolved, officialResolved + officialTestFailed),
    passAt1Denominator: total,
    passAt1:
      officialInconclusive === 0 && unadmittedFragments === 0
        ? ratio(officialResolved, total)
        : null,
  });
}

export function createInfrastructureInconclusive(options) {
  const prediction = readFrozenPrediction(options.predictionPath);
  let provenance = fallbackProvenance(options, performance.now());
  if (options.manifestPath) {
    try {
      const manifest = loadOfficialEvaluatorManifest(options.manifestPath);
      provenance = {
        evaluatorVersion: manifest.evaluatorVersion,
        evaluatorCommit: manifest.evaluatorCommit,
        datasetRevision: manifest.dataset.sourceRevision,
        imageRef: "",
        imageDigest: "",
        platform: manifest.platform,
        officialRunId: officialRunIdFor(prediction),
        wallMs: 0,
      };
    } catch {
      // The canonical inconclusive record intentionally preserves empty unresolved provenance.
    }
  }
  return officialRecord(prediction, provenance, "inconclusive", "uncertain-external-effect", null);
}

export async function evaluateFrozenPrediction(options) {
  const startMs = performance.now();
  let prediction;
  try {
    prediction =
      typeof options.predictionPath === "string"
        ? readFrozenPrediction(options.predictionPath)
        : createFrozenPrediction(options.prediction);
  } catch {
    const fallback = fallbackPrediction(options);
    return officialRecord(
      fallback,
      fallbackProvenance(options, startMs),
      "inconclusive",
      "invalid-prediction",
      null,
    );
  }

  let manifest;
  try {
    manifest =
      typeof options.manifestPath === "string"
        ? loadOfficialEvaluatorManifest(options.manifestPath)
        : options.manifest;
    if (!manifest) throw new Error("Official evaluator manifest is required.");
  } catch {
    return officialRecord(
      prediction,
      fallbackProvenance(options, startMs),
      "inconclusive",
      "config-mismatch",
      null,
    );
  }

  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const runner = options.commandRunner ?? runBoundedCommand;
  const baseProvenance = {
    evaluatorVersion: manifest.evaluatorVersion,
    evaluatorCommit: manifest.evaluatorCommit,
    datasetRevision: manifest.dataset.sourceRevision,
    imageRef: "",
    imageDigest: "",
    platform: manifest.platform,
    officialRunId: officialRunIdFor(prediction),
    wallMs: 0,
  };

  try {
    await preflightEvaluator(manifest, runner);
    verifyFrozenDataset(manifest);
    assertPredictionInDataset(manifest, prediction);

    const officialImageRef = await resolveOfficialImageRef({
      manifest,
      prediction,
      namespace: "swebench",
      instanceImageTag: "latest",
      runner,
    });
    if (!options.imageManifestPath) throw new EvaluationAdmissionError("digest-mismatch");
    const expectedImageManifest = loadImageManifest(options.imageManifestPath, prediction);
    const image = await preparePinnedImage({
      manifest,
      prediction,
      officialImageRef,
      expectedImageManifest,
      outputDir,
      runner,
    });
    const provenance = { ...baseProvenance, ...image.provenance };
    const predictionJsonlPath = resolve(outputDir, "prediction.jsonl");
    writeFileSync(
      predictionJsonlPath,
      `${JSON.stringify({
        instance_id: prediction.instanceId,
        model_name_or_path: prediction.modelNameOrPath,
        model_patch: prediction.modelPatch,
      })}\n`,
    );
    const aggregateReportPath = resolve(
      outputDir,
      `${prediction.modelNameOrPath.replaceAll("/", "__")}.${provenance.officialRunId}.json`,
    );
    const evaluation = await runner({
      executable: manifest.evaluatorPython,
      args: [
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        manifest.dataset.localDatasetJsonlPath,
        "--split",
        manifest.dataset.split,
        "--instance_ids",
        prediction.instanceId,
        "--predictions_path",
        predictionJsonlPath,
        "--max_workers",
        "1",
        "--cache_level",
        "instance",
        "--clean",
        "false",
        "--force_rebuild",
        "false",
        "--namespace",
        image.aliasNamespace,
        "--instance_image_tag",
        image.aliasTag,
        "--timeout",
        String(manifest.evaluationTimeoutSeconds),
        "--run_id",
        provenance.officialRunId,
      ],
      cwd: outputDir,
      env: evaluatorEnvironment(manifest),
      timeoutMs: (manifest.evaluationTimeoutSeconds + 60) * 1_000,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    writeProcessReceipt(outputDir, "official-evaluator", evaluation);
    if (evaluation.timedOut) {
      await cleanupEvaluationContainersBestEffort(provenance.officialRunId, manifest, runner);
      return withWallMs(
        officialRecord(prediction, provenance, "inconclusive", "evaluator-timeout", null),
        startMs,
      );
    }
    if (evaluation.status !== 0) {
      await cleanupEvaluationContainersBestEffort(provenance.officialRunId, manifest, runner);
      return withWallMs(
        officialRecord(prediction, provenance, "inconclusive", "evaluator-error", null),
        startMs,
      );
    }
    if (!existsSync(aggregateReportPath)) {
      return withWallMs(
        officialRecord(prediction, provenance, "inconclusive", "report-missing", null),
        startMs,
      );
    }
    let report;
    try {
      report = readJson(aggregateReportPath, MAX_RAW_REPORT_BYTES, "official run report");
    } catch {
      return withWallMs(
        officialRecord(prediction, provenance, "inconclusive", "report-malformed", null),
        startMs,
      );
    }
    return withWallMs(projectOfficialRunReport({ report, prediction, provenance }), startMs);
  } catch (error) {
    if (!(error instanceof EvaluationAdmissionError)) throw error;
    return withWallMs(
      officialRecord(prediction, baseProvenance, "inconclusive", error.reason, null),
      startMs,
    );
  }
}

async function preflightEvaluator(manifest, runner) {
  if (!existsSync(manifest.evaluatorPython) || !existsSync(manifest.evaluatorSourceDir)) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  const git = await runner({
    executable: manifest.gitExecutable,
    args: ["-C", manifest.evaluatorSourceDir, "rev-parse", "HEAD"],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  if (git.status !== 0 || git.stdout.trim() !== manifest.evaluatorCommit) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  const dirty = await runner({
    executable: manifest.gitExecutable,
    args: ["-C", manifest.evaluatorSourceDir, "status", "--porcelain"],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  if (dirty.status !== 0 || dirty.stdout.trim().length !== 0) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  const version = await runner({
    executable: manifest.evaluatorPython,
    args: ["-c", "import swebench; print(swebench.__version__)"],
    env: evaluatorEnvironment(manifest),
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.evaluatorVersion) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
}

function verifyFrozenDataset(manifest) {
  const path = manifest.dataset.localDatasetJsonlPath;
  if (!existsSync(path)) throw new EvaluationAdmissionError("config-mismatch");
  const bytes = readFileSync(path);
  if (
    bytes.byteLength !== manifest.dataset.localDatasetJsonlBytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.dataset.localDatasetJsonlSha256
  ) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  let rows;
  try {
    rows = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  const ids = rows.map((row) => row?.instance_id);
  if (ids.some((id) => typeof id !== "string")) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
  ids.sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(ids) !== JSON.stringify(manifest.dataset.selectedInstanceIds)) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
}

async function resolveOfficialImageRef({
  manifest,
  prediction,
  namespace,
  instanceImageTag,
  runner,
}) {
  const script = [
    "import json,sys",
    "from swebench.harness.utils import load_swebench_dataset",
    "from swebench.harness.test_spec.test_spec import make_test_spec",
    "dataset=load_swebench_dataset(sys.argv[1], sys.argv[2], [sys.argv[3]])",
    "assert len(dataset)==1",
    "spec=make_test_spec(dataset[0], namespace=sys.argv[4], instance_image_tag=sys.argv[5])",
    "print(json.dumps({'imageRef': spec.instance_image_key}))",
  ].join(";");
  const result = await runner({
    executable: manifest.evaluatorPython,
    args: [
      "-c",
      script,
      manifest.dataset.localDatasetJsonlPath,
      manifest.dataset.split,
      prediction.instanceId,
      namespace,
      instanceImageTag,
    ],
    env: evaluatorEnvironment(manifest),
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.status !== 0) throw new EvaluationAdmissionError("config-mismatch");
  try {
    const parsed = JSON.parse(result.stdout.trim());
    assertIdentifier(parsed.imageRef, "official image reference", 1_024);
    return parsed.imageRef;
  } catch {
    throw new EvaluationAdmissionError("config-mismatch");
  }
}

async function preparePinnedImage({
  manifest,
  prediction,
  officialImageRef,
  expectedImageManifest,
  outputDir,
  runner,
}) {
  const selectedEntry = expectedImageManifest.entries.find(
    (entry) => entry.instanceId === prediction.instanceId,
  );
  if (selectedEntry.imageRef !== officialImageRef) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }
  const digest = selectedEntry.imageDigest;
  const pullRef = `${stripTag(officialImageRef)}@${digest}`;
  const pull = await runner({
    executable: manifest.dockerExecutable,
    args: ["pull", "--platform", manifest.platform, pullRef],
    timeoutMs: manifest.imagePullTimeoutSeconds * 1_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  writeProcessReceipt(outputDir, "docker-pull", pull);
  if (pull.timedOut || pull.status !== 0) throw new EvaluationAdmissionError("evaluator-error");

  const inspectRef = `${stripTag(officialImageRef)}@${digest}`;
  const inspectDigests = await dockerInspect(inspectRef, "{{json .RepoDigests}}", manifest, runner);
  const repoDigests = parseJsonStringArray(inspectDigests, "docker RepoDigests");
  const repository = stripTag(officialImageRef);
  assertDigest(digest);
  if (!repoDigests.includes(`${repository}@${digest}`)) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }

  const aliasNamespace = `best-agent-pinned-${sha256Text(prediction.evaluationBatchId).slice(0, 12)}`;
  const aliasTag = `sha-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const aliasRef = await resolveOfficialImageRef({
    manifest,
    prediction,
    namespace: aliasNamespace,
    instanceImageTag: aliasTag,
    runner,
  });
  const tag = await runner({
    executable: manifest.dockerExecutable,
    args: ["tag", `${repository}@${digest}`, aliasRef],
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
  });
  if (tag.status !== 0) throw new EvaluationAdmissionError("digest-mismatch");
  const sourceId = (
    await dockerInspect(`${repository}@${digest}`, "{{.Id}}", manifest, runner)
  ).trim();
  const aliasId = (await dockerInspect(aliasRef, "{{.Id}}", manifest, runner)).trim();
  if (!sourceId || sourceId !== aliasId) throw new EvaluationAdmissionError("digest-mismatch");

  return {
    aliasNamespace,
    aliasTag,
    provenance: { imageRef: officialImageRef, imageDigest: digest },
  };
}

export function loadOfficialImageManifest(path) {
  const value = readJson(path, 256 * 1024, "official image manifest");
  exactRecord(
    value,
    ["schemaVersion", "evaluationBatchId", "platform", "entries"],
    "official image manifest",
  );
  assertIdentifier(value.evaluationBatchId, "official image manifest evaluationBatchId");
  if (
    value.schemaVersion !== 1 ||
    value.platform !== OFFICIAL_PLATFORM ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }
  const entries = value.entries.map((value) => {
    const entry = exactRecord(
      value,
      ["instanceId", "imageRef", "imageDigest"],
      "official image manifest entry",
    );
    assertIdentifier(entry.instanceId, "official image manifest instanceId");
    assertIdentifier(entry.imageRef, "official image manifest imageRef", 1_024);
    assertDigest(entry.imageDigest);
    return Object.freeze({ ...entry });
  });
  const ids = entries.map((entry) => entry.instanceId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)
  ) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }
  return Object.freeze({ ...value, entries: Object.freeze(entries) });
}

function loadImageManifest(path, prediction) {
  const value = loadOfficialImageManifest(path);
  if (
    value.evaluationBatchId !== prediction.evaluationBatchId ||
    !value.entries.some((entry) => entry.instanceId === prediction.instanceId)
  ) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }
  return value;
}

async function dockerInspect(ref, format, manifest, runner) {
  const result = await runner({
    executable: manifest.dockerExecutable,
    args: ["image", "inspect", ref, "--format", format],
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
  });
  if (result.status !== 0) throw new EvaluationAdmissionError("digest-mismatch");
  return result.stdout.trim();
}

async function cleanupEvaluationContainers(runId, manifest, runner) {
  const list = await runner({
    executable: manifest.dockerExecutable,
    args: ["ps", "-aq", "--filter", `name=${runId}`],
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  const ids = list.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (list.status === 0 && ids.length > 0) {
    await runner({
      executable: manifest.dockerExecutable,
      args: ["rm", "-f", ...ids],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    });
  }
}

async function cleanupEvaluationContainersBestEffort(runId, manifest, runner) {
  try {
    await cleanupEvaluationContainers(runId, manifest, runner);
  } catch {
    // Cleanup failure cannot replace the canonical evaluator timeout/error reason.
  }
}

export function runBoundedCommand({ executable, args, cwd, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const limit = maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
    const append = (current, chunk) => {
      if (current.byteLength >= limit) return current;
      const remaining = limit - current.byteLength;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ...value,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already closed
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (timedOut) return;
      settle({ status: null, signal: null, timedOut: false, error: error.message });
    });
    child.on("close", (status, signal) => {
      settle({ status, signal, timedOut });
    });
  });
}

function officialRecord(prediction, provenance, verdict, reason, officialResolved) {
  if (!OFFICIAL_REASONS.has(reason)) throw new Error(`Unknown official reason: ${reason}`);
  return admitOfficialEvaluationRecord({
    schemaVersion: 1,
    evaluationBatchId: prediction.evaluationBatchId,
    attemptId: prediction.attemptId,
    instanceId: prediction.instanceId,
    patchSha256: prediction.modelPatchSha256,
    verdict,
    reason,
    officialResolved,
    evaluatorVersion: provenance.evaluatorVersion,
    evaluatorCommit: provenance.evaluatorCommit,
    datasetRevision: provenance.datasetRevision,
    imageRef: provenance.imageRef,
    imageDigest: provenance.imageDigest,
    platform: provenance.platform,
    officialRunId: provenance.officialRunId,
    wallMs: provenance.wallMs,
  });
}

export function admitOfficialEvaluationRecord(input) {
  const record = exactRecord(
    input,
    [
      "schemaVersion",
      "evaluationBatchId",
      "attemptId",
      "instanceId",
      "patchSha256",
      "verdict",
      "reason",
      "officialResolved",
      "evaluatorVersion",
      "evaluatorCommit",
      "datasetRevision",
      "imageRef",
      "imageDigest",
      "platform",
      "officialRunId",
      "wallMs",
    ],
    "OfficialEvaluationRecord",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("OfficialEvaluationRecord schemaVersion must be 1.");
  }
  for (const key of ["evaluationBatchId", "attemptId", "instanceId", "platform"]) {
    assertIdentifier(record[key], `OfficialEvaluationRecord.${key}`);
  }
  for (const key of [
    "evaluatorVersion",
    "evaluatorCommit",
    "datasetRevision",
    "imageRef",
    "imageDigest",
    "officialRunId",
  ]) {
    if (typeof record[key] !== "string") {
      throw new Error(`OfficialEvaluationRecord.${key} must be a string.`);
    }
  }
  for (const key of ["evaluatorVersion", "officialRunId"]) {
    if (record[key] !== "") {
      assertIdentifier(record[key], `OfficialEvaluationRecord.${key}`);
    }
  }
  for (const key of ["evaluatorCommit", "datasetRevision"]) {
    if (record[key] !== "" && !/^[a-f0-9]{40}$/u.test(record[key])) {
      throw new Error(`OfficialEvaluationRecord.${key} must be a lowercase 40-character hash.`);
    }
  }
  if (record.imageRef !== "") {
    assertIdentifier(record.imageRef, "OfficialEvaluationRecord.imageRef", 1_024);
  }
  if (record.patchSha256 === "") {
    if (record.reason !== "invalid-prediction") {
      throw new Error("Only invalid-prediction may omit OfficialEvaluationRecord.patchSha256.");
    }
  } else {
    assertSha256(record.patchSha256, "OfficialEvaluationRecord.patchSha256");
  }
  if (!OFFICIAL_REASONS.has(record.reason)) {
    throw new Error(`Unknown official reason: ${record.reason}`);
  }
  const tupleIsValid =
    (record.verdict === "resolved" &&
      record.reason === "official-resolved" &&
      record.officialResolved === true) ||
    (record.verdict === "test-failed" &&
      record.reason === "official-unresolved" &&
      record.officialResolved === false) ||
    (record.verdict === "inconclusive" &&
      !["official-resolved", "official-unresolved"].includes(record.reason) &&
      record.officialResolved === null);
  if (!tupleIsValid) {
    throw new Error("OfficialEvaluationRecord verdict/reason/officialResolved tuple is invalid.");
  }
  if ((record.imageRef === "") !== (record.imageDigest === "")) {
    throw new Error("OfficialEvaluationRecord imageRef and imageDigest must both be set or empty.");
  }
  if (record.imageDigest !== "") assertDigest(record.imageDigest);
  if (!Number.isFinite(record.wallMs) || record.wallMs < 0) {
    throw new Error("OfficialEvaluationRecord.wallMs must be a finite non-negative number.");
  }
  return Object.freeze({ ...record });
}

function withWallMs(record, startMs) {
  return Object.freeze({ ...record, wallMs: Number((performance.now() - startMs).toFixed(1)) });
}

function fallbackPrediction(options) {
  const value = options.prediction ?? {};
  const instanceId = boundedFallback(
    value.instanceId,
    basename(options.predictionPath ?? "unknown"),
  );
  return {
    evaluationBatchId: boundedFallback(value.evaluationBatchId, "invalid-batch"),
    attemptId: boundedFallback(value.attemptId, "invalid-attempt"),
    instanceId,
    modelNameOrPath: boundedFallback(value.modelNameOrPath, "invalid-model"),
    modelPatchSha256: "",
  };
}

function fallbackProvenance(options, startMs) {
  return {
    evaluatorVersion: "",
    evaluatorCommit: "",
    datasetRevision: "",
    imageRef: "",
    imageDigest: "",
    platform: OFFICIAL_PLATFORM,
    officialRunId: "",
    wallMs: Number((performance.now() - startMs).toFixed(1)),
  };
}

function boundedFallback(value, fallback) {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= 256
    ? value
    : fallback;
}

function evaluatorEnvironment(manifest) {
  return {
    ...process.env,
    PYTHONPATH: manifest.evaluatorSourceDir,
    PYTHONNOUSERSITE: "1",
  };
}

export function officialRunIdFor(prediction) {
  return sanitize(`${prediction.evaluationBatchId}-${prediction.instanceId}`).slice(0, 80);
}

function stripTag(ref) {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(0, colon) : ref;
}

function parseJsonStringArray(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new EvaluationAdmissionError(
      label.includes("Digest") ? "digest-mismatch" : "config-mismatch",
    );
  }
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid keys.`);
  }
  return value;
}

function assertIdentifier(value, label, maxBytes = MAX_IDENTIFIER_BYTES) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) {
    throw new Error(`${label} must be 1..${maxBytes} UTF-8 bytes.`);
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertDigest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new EvaluationAdmissionError("digest-mismatch");
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertSelectedInstanceIds(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 500 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length ||
    value.some((entry, index) => index > 0 && value[index - 1].localeCompare(entry) >= 0)
  ) {
    throw new Error(
      "Official dataset selectedInstanceIds must be 1..500 unique instance IDs in ascending order.",
    );
  }
}

function assertPredictionInDataset(manifest, prediction) {
  if (!manifest.dataset.selectedInstanceIds.includes(prediction.instanceId)) {
    throw new EvaluationAdmissionError("config-mismatch");
  }
}

function readJson(path, maxBytes, label) {
  const bytes = readFileSync(path);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return JSON.parse(bytes.toString("utf8"));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing artifact: ${path}`);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function writeProcessReceipt(outputDir, name, result) {
  writeJsonAtomic(resolve(outputDir, `${name}.json`), {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  });
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function ratio(value, total) {
  if (!total) return 0;
  return Number((value / total).toFixed(3));
}

class EvaluationAdmissionError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function parseCliArgs(argv) {
  const parsed = { predictionPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--acquire-dataset") parsed.acquireDataset = true;
    else if (key === "--freeze-result") parsed.resultPath = resolve(argv[++index]);
    else if (key === "--freeze-images") parsed.freezeImages = true;
    else if (key === "--instance") parsed.instanceId = argv[++index];
    else if (key === "--evaluation-batch") parsed.evaluationBatchId = argv[++index];
    else if (key === "--attempt") parsed.attemptId = argv[++index];
    else if (key === "--manifest") parsed.manifestPath = resolve(argv[++index]);
    else if (key === "--python") parsed.pythonPath = resolve(argv[++index]);
    else if (key === "--dataset-manifest-output") {
      parsed.manifestOutputPath = resolve(argv[++index]);
    } else if (key === "--profile-id") parsed.profileId = argv[++index];
    else if (key === "--prediction") parsed.predictionPaths.push(resolve(argv[++index]));
    else if (key === "--output") parsed.outputDir = resolve(argv[++index]);
    else if (key === "--image-manifest") parsed.imageManifestPath = resolve(argv[++index]);
    else throw new Error(`Unknown official evaluator argument: ${key}`);
  }
  if (parsed.acquireDataset) {
    if (
      !parsed.pythonPath ||
      !parsed.outputDir ||
      !parsed.manifestOutputPath ||
      !parsed.profileId
    ) {
      throw new Error(
        "Dataset usage: --acquire-dataset --python <absolute> --profile-id <id> --output <dataset.jsonl> --dataset-manifest-output <json>",
      );
    }
    return { mode: "acquire-dataset", ...parsed, outputPath: parsed.outputDir };
  }
  if (parsed.resultPath) {
    if (!parsed.instanceId || !parsed.evaluationBatchId || !parsed.attemptId || !parsed.outputDir) {
      throw new Error(
        "Freeze usage: --freeze-result <json> --instance <id> --evaluation-batch <id> --attempt <id> --output <prediction.json>",
      );
    }
    return { mode: "freeze", ...parsed, outputPath: parsed.outputDir };
  }
  if (parsed.freezeImages) {
    if (!parsed.manifestPath || parsed.predictionPaths.length === 0 || !parsed.outputDir) {
      throw new Error(
        "Image freeze usage: --freeze-images --manifest <json> --prediction <json>... --output <image-manifest.json>",
      );
    }
    return {
      mode: "freeze-images",
      ...parsed,
      outputPath: parsed.outputDir,
    };
  }
  throw new Error(
    "Direct Docker evaluation is unavailable; use evaluate-official.mjs --admission-receipt.",
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.mode === "acquire-dataset") {
      const dataset = await acquireOfficialDataset(args);
      process.stdout.write(`${JSON.stringify(dataset, null, 2)}\n`);
    } else if (args.mode === "freeze") {
      const frozen = freezePredictionFromResult(args);
      process.stdout.write(
        `${JSON.stringify(
          {
            outputPath: args.outputPath,
            instanceId: frozen.prediction.instanceId,
            attemptId: frozen.prediction.attemptId,
            patchSha256: frozen.prediction.modelPatchSha256,
            patchBytes: encoder.encode(frozen.prediction.modelPatch).byteLength,
            source: frozen.source,
          },
          null,
          2,
        )}\n`,
      );
    } else if (args.mode === "freeze-images") {
      const manifest = await freezeOfficialImageManifest(args);
      process.stdout.write(
        `${JSON.stringify(
          {
            outputPath: args.outputPath,
            manifestSha256: sha256File(args.outputPath),
            evaluationBatchId: manifest.evaluationBatchId,
            selectedInstances: manifest.entries.length,
          },
          null,
          2,
        )}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
