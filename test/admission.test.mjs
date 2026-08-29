import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { admitFormalGeneration } from "../scripts/admit-generation.mjs";
import {
  verifyAdmissionReceipt,
  verifyOfficialEvaluationReport,
} from "../scripts/evaluate-official.mjs";
import { runCliProcess, taskResult } from "../scripts/swe-bench-harness.mjs";
import {
  OFFICIAL_DATASET_NAME,
  OFFICIAL_DATASET_REVISION,
  OFFICIAL_DATASET_SPLIT,
  OFFICIAL_EVALUATION_TIMEOUT_SECONDS,
  OFFICIAL_EVALUATOR_COMMIT,
  OFFICIAL_EVALUATOR_VERSION,
  OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS,
  OFFICIAL_PLATFORM,
  officialRunIdFor,
  runBoundedCommand,
  summarizeOfficialEvaluations,
} from "../scripts/swe-bench-official-evaluator.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

test("the CLI watchdog returns only after the killed process closes", async () => {
  const result = await runCliProcess({
    args: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    cwd: repoRoot,
    timeoutMs: 50,
    env: process.env,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
});

test("the official evaluator watchdog returns the killed process closure", async () => {
  const result = await runBoundedCommand({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repoRoot,
    timeoutMs: 50,
    maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
});

test("formal admission exact-covers 500 task receipts and rejects a mutated artifact", () => {
  mkdirSync(resolve(repoRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, ".tmp", "formal-admission-fixture-"));
  try {
    const resultsDir = resolve(root, "results");
    mkdirSync(resultsDir);
    writeJson(resolve(resultsDir, "gates/headless-smoke.json"), {
      ok: true,
      host: { platform: "darwin", arch: "arm64" },
    });
    writeJson(resolve(resultsDir, "gates/repository-isolation.json"), {
      ok: true,
      host: { platform: "darwin", arch: "arm64" },
    });
    writeJson(resolve(resultsDir, "github-jobs.json"), {
      jobs: [
        ...[
          "Freeze task batches",
          "macOS headless smoke",
          "Freeze SWE-bench corpus",
          "Verify frozen repository isolation",
        ].map(successfulJob),
        ...Array.from({ length: 100 }, (_, shard) => successfulJob(`macOS generation (${shard})`)),
      ],
    });
    const corpusPath = resolve(repoRoot, "results/corpora/swe-bench-verified.jsonl");
    const planPath = resolve(repoRoot, "config/swe-bench-full-batches.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const instanceIds = plan.batches.flatMap((batch) => batch.tasks);
    const corpusTasks = new Map(
      readFileSync(corpusPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map((task) => [task.instance_id, task]),
    );
    const candidate = JSON.parse(
      readFileSync(resolve(repoRoot, "config/best-agent-candidate.json"), "utf8"),
    );
    let firstEvidencePath;
    for (let shard = 0; shard < 100; shard += 1) {
      const tasks = [];
      for (const instanceId of instanceIds.slice(shard * 5, shard * 5 + 5)) {
        const corpusTask = corpusTasks.get(instanceId);
        const taskDir = resolve(resultsDir, `swe-bench-results.shard-${shard}.tasks`, instanceId);
        mkdirSync(taskDir, { recursive: true });
        const claimPath = resolve(taskDir, "claim.json");
        const processReceiptPath = resolve(taskDir, "process-receipt.json");
        const stdoutPath = resolve(taskDir, "stdout.txt");
        const stderrPath = resolve(taskDir, "stderr.txt");
        const evidencePath = resolve(taskDir, "attempt-evidence.jsonl");
        const receiptPath = resolve(taskDir, "receipt.json");
        const predictionPath = resolve(
          resultsDir,
          `swe-bench-results.shard-${shard}.predictions`,
          `${instanceId}.json`,
        );
        writeJson(claimPath, {
          schemaVersion: 1,
          instanceId,
          repo: corpusTask.repo,
          baseCommit: corpusTask.base_commit,
          candidateId: `cli-${candidate.cliVersion}-${candidate.sourceCommit}`,
          evaluationBatchId: "formal-123",
          formalRunId: "formal-123",
          timeoutMs: candidate.taskTimeoutMs,
        });
        writeFileSync(stdoutPath, "complete\n");
        writeFileSync(stderrPath, "");
        writeJson(processReceiptPath, {
          schemaVersion: 1,
          status: 0,
          signal: null,
          timedOut: false,
          stdoutOverflow: false,
          stderrOverflow: false,
          stdout: reference(stdoutPath),
          stderr: reference(stderrPath),
        });
        writeCompleteEvidence(evidencePath);
        firstEvidencePath ??= evidencePath;
        const modelPatch = "diff --git a/value.py b/value.py\n";
        const frozen = instanceId === instanceIds[0];
        if (frozen) {
          mkdirSync(dirname(predictionPath), { recursive: true });
          writeJson(predictionPath, {
            schemaVersion: 1,
            evaluationBatchId: "formal-123",
            attemptId: `formal-123-${instanceId}`,
            instanceId,
            modelNameOrPath: `${candidate.provider.kind}/${candidate.provider.model}`,
            modelPatch,
            modelPatchSha256: createHash("sha256").update(modelPatch).digest("hex"),
          });
        }
        const producedResult = taskResult(corpusTask, performance.now(), {
          disposition: frozen ? "frozen-prediction" : "no-diff",
          claim: reference(claimPath),
          processReceipt: reference(processReceiptPath),
          evidence: reference(evidencePath),
          stdout: reference(stdoutPath),
          stderr: reference(stderrPath),
          ...(frozen
            ? {
                patchLines: 1,
                prediction: reference(predictionPath),
                patchSha256: createHash("sha256").update(modelPatch).digest("hex"),
                agentPatch: modelPatch,
              }
            : {
                error: "Agent produced no diff",
                cliExitCode: 0,
                cliError: "",
              }),
        });
        writeJson(receiptPath, {
          schemaVersion: 1,
          ...producedResult,
          receiptPath: relative(repoRoot, receiptPath),
        });
        tasks.push({
          instance_id: instanceId,
          taskReceiptPath: relative(repoRoot, receiptPath),
        });
      }
      writeJson(resolve(resultsDir, `swe-bench-results.shard-${shard}.json`), {
        candidateId: `cli-${candidate.cliVersion}-${candidate.sourceCommit}`,
        provider: candidate.provider,
        composition: {
          shard,
          formalRunId: "formal-123",
          fullAccess: true,
          permissionMode: "full",
          interactionTools: false,
          workspaceBackend: "sandbox",
          execNetworkIsolation: true,
          networkToolSchemas: false,
          taskTimeoutMs: candidate.taskTimeoutMs,
        },
        evaluation: {
          method: "official-swe-bench-docker-deferred",
          evaluationBatchId: "formal-123",
        },
        tasks,
      });
    }
    const acceptedPath = resolve(resultsDir, "accepted.json");
    const accepted = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: acceptedPath,
    });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted.reasons));
    assert.equal(existsSync(accepted.receiptPath), true);
    const verified = verifyAdmissionReceipt(accepted.receiptPath);
    assert.equal(verified.predictions.size, 1);

    const profile = JSON.parse(
      readFileSync(resolve(repoRoot, "config/swe-bench-verified.json"), "utf8"),
    );
    const manifestPath = resolve(root, "official-evaluator-manifest.json");
    writeJson(manifestPath, {
      schemaVersion: 1,
      profileId: profile.profileId,
      evaluatorPython: resolve(root, "python"),
      evaluatorSourceDir: resolve(root, "swe-bench"),
      gitExecutable: resolve(root, "git"),
      dockerExecutable: resolve(root, "docker"),
      evaluatorVersion: OFFICIAL_EVALUATOR_VERSION,
      evaluatorCommit: OFFICIAL_EVALUATOR_COMMIT,
      dataset: {
        schemaVersion: 1,
        profileId: profile.profileId,
        sourceDatasetName: OFFICIAL_DATASET_NAME,
        split: OFFICIAL_DATASET_SPLIT,
        sourceRevision: OFFICIAL_DATASET_REVISION,
        localDatasetJsonlPath: corpusPath,
        localDatasetJsonlSha256: sha256(corpusPath),
        localDatasetJsonlBytes: statSync(corpusPath).size,
        selectedInstanceIds: [...instanceIds].sort((left, right) => left.localeCompare(right)),
      },
      platform: OFFICIAL_PLATFORM,
      evaluationTimeoutSeconds: OFFICIAL_EVALUATION_TIMEOUT_SECONDS,
      imagePullTimeoutSeconds: OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS,
    });
    const batchClaimPath = resolve(root, "batch-claim.json");
    writeJson(batchClaimPath, {
      schemaVersion: 1,
      compositeSha256: verified.receipt.compositeSha256,
      formalRunId: verified.receipt.formalRunId,
      admissionReceipt: reference(accepted.receiptPath),
      manifest: reference(manifestPath),
    });
    const prediction = verified.predictions.get(instanceIds[0]);
    const imageManifestPath = resolve(root, "image-manifest.json");
    const imageRef = "swebench/sweb.eval.fixture:latest";
    const imageDigest = `sha256:${"a".repeat(64)}`;
    writeJson(imageManifestPath, {
      schemaVersion: 1,
      evaluationBatchId: prediction.evaluationBatchId,
      platform: OFFICIAL_PLATFORM,
      entries: [{ instanceId: prediction.instanceId, imageRef, imageDigest }],
    });
    const invocationClaimPath = resolve(root, "invocation-claim.json");
    writeJson(invocationClaimPath, {
      schemaVersion: 1,
      instanceId: prediction.instanceId,
      admissionReceipt: reference(accepted.receiptPath),
      prediction: verified.receipt.tasks.find((task) => task.instanceId === prediction.instanceId)
        .prediction,
      manifest: reference(manifestPath),
      imageManifest: reference(imageManifestPath),
    });
    const officialEvaluation = {
      schemaVersion: 1,
      evaluationBatchId: prediction.evaluationBatchId,
      attemptId: prediction.attemptId,
      instanceId: prediction.instanceId,
      patchSha256: prediction.modelPatchSha256,
      verdict: "resolved",
      reason: "official-resolved",
      officialResolved: true,
      evaluatorVersion: OFFICIAL_EVALUATOR_VERSION,
      evaluatorCommit: OFFICIAL_EVALUATOR_COMMIT,
      datasetRevision: OFFICIAL_DATASET_REVISION,
      imageRef,
      imageDigest,
      platform: OFFICIAL_PLATFORM,
      officialRunId: officialRunIdFor(prediction),
      wallMs: 0,
    };
    const terminalReceiptPath = resolve(root, "terminal-receipt.json");
    writeJson(terminalReceiptPath, {
      schemaVersion: 1,
      instanceId: prediction.instanceId,
      claim: reference(invocationClaimPath),
      officialEvaluation,
    });
    const officialTasks = verified.receipt.tasks.map((task) =>
      task.prediction === undefined
        ? { instance_id: task.instanceId, disposition: task.disposition }
        : {
            instance_id: task.instanceId,
            disposition: task.disposition,
            officialEvaluation,
            claim: reference(invocationClaimPath),
            terminalReceipt: reference(terminalReceiptPath),
          },
    );
    const reportPath = resolve(root, "official-report.json");
    const report = {
      benchmark: "swe-bench-verified",
      candidateId: `cli-${candidate.cliVersion}-${candidate.sourceCommit}`,
      evaluatedAt: new Date().toISOString(),
      evaluation: {
        schemaVersion: 1,
        method: "official-swe-bench-docker",
        batchClaim: reference(batchClaimPath),
        admissionReceipt: reference(accepted.receiptPath),
        manifest: reference(manifestPath),
        imageManifest: reference(imageManifestPath),
      },
      summary: summarizeOfficialEvaluations(officialTasks),
      tasks: officialTasks,
    };
    writeJson(reportPath, report);
    assert.equal(verifyOfficialEvaluationReport(reportPath).accepted, true);
    const forgedEvaluation = { ...officialEvaluation, evaluatorCommit: "b".repeat(40) };
    writeJson(terminalReceiptPath, {
      schemaVersion: 1,
      instanceId: prediction.instanceId,
      claim: reference(invocationClaimPath),
      officialEvaluation: forgedEvaluation,
    });
    const forgedTasks = officialTasks.map((task) =>
      task.instance_id === prediction.instanceId
        ? {
            ...task,
            officialEvaluation: forgedEvaluation,
            terminalReceipt: reference(terminalReceiptPath),
          }
        : task,
    );
    writeJson(reportPath, { ...report, tasks: forgedTasks });
    assert.throws(() => verifyOfficialEvaluationReport(reportPath), /provenance/u);
    writeJson(terminalReceiptPath, {
      schemaVersion: 1,
      instanceId: prediction.instanceId,
      claim: reference(invocationClaimPath),
      officialEvaluation,
    });
    writeJson(reportPath, { ...report, summary: { ...report.summary, passAt1: 1 } });
    assert.throws(() => verifyOfficialEvaluationReport(reportPath), /summary/u);
    writeJson(reportPath, report);

    const firstPredictionPath = resolve(
      resultsDir,
      "swe-bench-results.shard-0.predictions",
      `${instanceIds[0]}.json`,
    );
    const predictionBytes = readFileSync(firstPredictionPath);
    writeFileSync(firstPredictionPath, `${predictionBytes.toString("utf8")} `);
    assert.throws(
      () => verifyAdmissionReceipt(accepted.receiptPath),
      /no longer reproduces|changed/u,
    );
    writeFileSync(firstPredictionPath, predictionBytes);

    const firstReceiptPath = resolve(
      resultsDir,
      "swe-bench-results.shard-0.tasks",
      instanceIds[0],
      "receipt.json",
    );
    const firstReceipt = JSON.parse(readFileSync(firstReceiptPath, "utf8"));
    firstReceipt.evidence = reference(
      resolve(
        resultsDir,
        "swe-bench-results.shard-0.tasks",
        instanceIds[1],
        "attempt-evidence.jsonl",
      ),
    );
    writeFileSync(firstReceiptPath, `${JSON.stringify(firstReceipt, null, 2)}\n`);
    const crossSwapped = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "cross-swapped.json"),
    });
    assert.equal(crossSwapped.accepted, false);
    assert.ok(crossSwapped.reasons.some((reason) => reason.reason.includes("evidence reference")));
    writeJson(firstReceiptPath, {
      ...firstReceipt,
      evidence: reference(firstEvidencePath),
    });

    const firstProcessPath = resolve(
      resultsDir,
      "swe-bench-results.shard-0.tasks",
      instanceIds[0],
      "process-receipt.json",
    );
    const firstProcess = JSON.parse(readFileSync(firstProcessPath, "utf8"));
    writeJson(firstProcessPath, { ...firstProcess, timedOut: true });
    const invalidTimeoutReceipt = JSON.parse(readFileSync(firstReceiptPath, "utf8"));
    invalidTimeoutReceipt.disposition = "model-timeout";
    invalidTimeoutReceipt.timedOut = true;
    delete invalidTimeoutReceipt.agentPatch;
    delete invalidTimeoutReceipt.patchLines;
    delete invalidTimeoutReceipt.patchSha256;
    delete invalidTimeoutReceipt.prediction;
    invalidTimeoutReceipt.processReceipt = reference(firstProcessPath);
    writeJson(firstReceiptPath, invalidTimeoutReceipt);
    const invalidTimeout = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "invalid-timeout.json"),
    });
    assert.equal(invalidTimeout.accepted, false);
    assert.ok(
      invalidTimeout.reasons.some((reason) => reason.reason.includes("model-timeout closure")),
    );
    writeJson(firstProcessPath, firstProcess);
    writeJson(firstReceiptPath, {
      ...firstReceipt,
      evidence: reference(firstEvidencePath),
      processReceipt: reference(firstProcessPath),
    });

    writeFileSync(firstEvidencePath, "mutated\n", { flag: "a" });
    const rejected = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "rejected.json"),
    });
    assert.equal(rejected.accepted, false);
    assert.ok(
      rejected.reasons.some((reason) => reason.reason.includes("evidence reference is missing")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function successfulJob(name) {
  return { name, conclusion: "success", steps: [{ name: "fixture", conclusion: "success" }] };
}

test("admission command preserves its own fatal reason as a rejected report", () => {
  mkdirSync(resolve(repoRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, ".tmp", "formal-admission-failure-"));
  try {
    const outputPath = resolve(root, "rejected.json");
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/admit-generation.mjs"),
        "--results",
        resolve(root, "missing-results"),
        "--plan",
        resolve(root, "missing-plan.json"),
        "--corpus",
        resolve(root, "missing-corpus.jsonl"),
        "--output",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.accepted, false);
    assert.equal(report.reasons[0].stage, "admission");
    assert.match(report.reasons[0].reason, /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeCompleteEvidence(path) {
  const runKey = {
    kind: "run",
    sessionKey: { kind: "session", agentIdentity: "agent", sequence: 1 },
    sequence: 1,
  };
  const resourceId = JSON.stringify(["agent", 1, 1]);
  const invocationId = JSON.stringify(["model", resourceId, 1]);
  const header = JSON.stringify({
    type: "header",
    schemaVersion: 1,
    sequence: 0,
    rootRunId: resourceId,
    maxBytes: 1024 * 1024 * 1024,
  });
  const request = JSON.stringify({
    type: "model-request",
    resourceId,
    runId: resourceId,
    invocationId,
    request: {
      instructions: [],
      messages: [{ kind: "user", runKey, message: { content: "fixture" } }],
      externalContext: [],
      tools: [],
    },
    sequence: 1,
  });
  const outcome = JSON.stringify({
    type: "model-outcome",
    resourceId,
    runId: resourceId,
    invocationId,
    outcome: { kind: "response", candidate: { content: "done", toolCalls: [] } },
    sequence: 2,
  });
  const terminal = JSON.stringify({
    type: "terminal-snapshot",
    resourceId,
    runId: resourceId,
    snapshot: {
      key: runKey,
      status: "completed",
      stopFlag: false,
      deadlineAt: 123,
      cycle: 1,
      terminalCause: "completed",
      transcript: [{ kind: "user", runKey, message: { content: "fixture" } }],
    },
    sequence: 3,
  });
  const prefix = `${header}\n${request}\n${outcome}\n${terminal}\n`;
  const counts = {
    modelRequest: 1,
    modelOutcome: 1,
    modelFailure: 0,
    terminalSnapshot: 1,
  };
  const footer = JSON.stringify({
    type: "footer",
    sequence: 4,
    complete: true,
    rootRunId: resourceId,
    resourceIds: [resourceId],
    invocationIds: [invocationId],
    expectedCounts: counts,
    writtenCounts: counts,
    prefixSha256: createHash("sha256").update(prefix).digest("hex"),
  });
  writeFileSync(path, `${prefix}${footer}\n`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function reference(path) {
  return { path: relative(repoRoot, path), bytes: statSync(path).size, sha256: sha256(path) };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
