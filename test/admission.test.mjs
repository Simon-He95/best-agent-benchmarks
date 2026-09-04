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
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { admitFormalGeneration } from "../scripts/admit-generation.mjs";
import {
  buildFormalRecovery,
  classifyMissingShardRecovery,
  classifyTaskRecovery,
} from "../scripts/plan-recovery.mjs";
import {
  verifyAdmissionReceipt,
  verifyOfficialEvaluationReport,
} from "../scripts/evaluate-official.mjs";
import {
  inspectAttemptEvidence,
  runCliProcess,
  taskResult,
} from "../scripts/swe-bench-harness.mjs";
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
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timeoutClosure, "forced");
});

test("the CLI watchdog admits a graceful Application shutdown only after owned process cleanup", async () => {
  mkdirSync(resolve(repoRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, ".tmp", "watchdog-graceful-fixture-"));
  const pidPath = resolve(root, "child.pid");
  try {
    const source = [
      'const {spawn}=require("node:child_process");',
      'const {writeFileSync}=require("node:fs");',
      `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});`,
      `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'process.on("SIGTERM",()=>{process.kill(-child.pid,"SIGTERM");child.once("close",()=>process.exit(1));});',
      "setInterval(()=>{},1000);",
    ].join("");
    const result = await runCliProcess({
      args: [process.execPath, "-e", source],
      cwd: repoRoot,
      timeoutMs: 50,
      env: process.env,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.timeoutClosure, "graceful");
    const childPid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI watchdog force-closes a surviving member before returning", async () => {
  mkdirSync(resolve(repoRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, ".tmp", "watchdog-survivor-fixture-"));
  const pidPath = resolve(root, "child.pid");
  let childPid;
  try {
    const childSource = [
      'const {writeFileSync}=require("node:fs");',
      'process.on("SIGTERM",()=>{});',
      `writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const source = [
      'const {spawn}=require("node:child_process");',
      `spawn(process.execPath,["-e",${JSON.stringify(childSource)}],{stdio:"ignore"});`,
      'process.on("SIGTERM",()=>process.exit(1));',
      "setInterval(()=>{},1000);",
    ].join("");
    const result = await runCliProcess({
      args: [process.execPath, "-e", source],
      cwd: repoRoot,
      timeoutMs: 300,
      env: process.env,
    });
    childPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.timeoutClosure, "forced");
    assert.throws(() => process.kill(childPid, 0), /ESRCH/u);
  } finally {
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
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

test("formal recovery admits only unscored environment and provider transport failures", () => {
  mkdirSync(resolve(repoRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, ".tmp", "formal-recovery-fixture-"));
  try {
    const stderrPath = resolve(root, "stderr.txt");
    const stdoutPath = resolve(root, "stdout.txt");
    const processReceiptPath = resolve(root, "process-receipt.json");
    const evidencePath = resolve(root, "attempt-evidence.jsonl");
    writeFileSync(stdoutPath, "");
    writeFileSync(
      stderrPath,
      "v3 run model-failure: transport: Cannot connect to API: read ECONNRESET\n",
    );
    writeJson(processReceiptPath, {
      status: 1,
      signal: null,
      timedOut: false,
      timeoutClosure: "not-applicable",
      stdoutOverflow: false,
      stderrOverflow: false,
      stdout: reference(stdoutPath),
      stderr: reference(stderrPath),
    });
    writeCompleteEvidence(evidencePath, "transport");
    const transport = {
      disposition: "generation-inconclusive",
      failureStage: "process",
      stdout: reference(stdoutPath),
      stderr: reference(stderrPath),
      processReceipt: reference(processReceiptPath),
      evidence: reference(evidencePath),
    };
    assert.deepEqual(classifyTaskRecovery(transport, root), {
      kind: "provider-transport",
      stderr: reference(stderrPath),
    });
    const otherRoot = resolve(root, "other-task");
    mkdirSync(otherRoot);
    for (const name of ["stdout.txt", "stderr.txt", "attempt-evidence.jsonl"]) {
      writeFileSync(resolve(otherRoot, name), readFileSync(resolve(root, name)));
    }
    writeJson(resolve(otherRoot, "process-receipt.json"), {
      ...JSON.parse(readFileSync(processReceiptPath, "utf8")),
      stdout: reference(resolve(otherRoot, "stdout.txt")),
      stderr: reference(resolve(otherRoot, "stderr.txt")),
    });
    assert.equal(
      classifyTaskRecovery(
        {
          ...transport,
          stdout: reference(resolve(otherRoot, "stdout.txt")),
          stderr: reference(resolve(otherRoot, "stderr.txt")),
          processReceipt: reference(resolve(otherRoot, "process-receipt.json")),
          evidence: reference(resolve(otherRoot, "attempt-evidence.jsonl")),
        },
        root,
        root,
      ),
      undefined,
    );
    assert.deepEqual(
      classifyTaskRecovery(
        { disposition: "generation-inconclusive", failureStage: "isolation" },
        root,
      ),
      { kind: "task-environment-before-model", failureStage: "isolation" },
    );
    writeFileSync(stderrPath, "v3 run failed: tool-unknown\n");
    transport.stderr = reference(stderrPath);
    writeJson(processReceiptPath, {
      ...JSON.parse(readFileSync(processReceiptPath, "utf8")),
      stderr: transport.stderr,
    });
    transport.processReceipt = reference(processReceiptPath);
    assert.equal(classifyTaskRecovery(transport, root), undefined);
    writeFileSync(
      stderrPath,
      "v3 run model-failure: transport: Cannot connect to API: read ECONNRESET\nv3 run failed: tool-unknown\n",
    );
    transport.stderr = reference(stderrPath);
    writeJson(processReceiptPath, {
      ...JSON.parse(readFileSync(processReceiptPath, "utf8")),
      stderr: transport.stderr,
    });
    transport.processReceipt = reference(processReceiptPath);
    writeCompleteEvidence(evidencePath, undefined, "tool-unknown");
    transport.evidence = reference(evidencePath);
    assert.equal(classifyTaskRecovery(transport, root), undefined);
    assert.equal(
      classifyTaskRecovery({ ...transport, prediction: reference(stderrPath) }, root),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing shard is recoverable only before generation starts", () => {
  const failedBeforeGeneration = {
    id: 42,
    name: "macOS generation (verified-full-024)",
    conclusion: "failure",
    steps: [
      { name: "Install benchmark dependencies and the exact CLI candidate", conclusion: "failure" },
      { name: "Generate and freeze predictions", status: "pending", conclusion: null },
    ],
  };
  assert.deepEqual(classifyMissingShardRecovery(failedBeforeGeneration), {
    kind: "generation-job-failure-before-model",
    job: {
      id: 42,
      name: "macOS generation (verified-full-024)",
      conclusion: "failure",
    },
  });
  assert.equal(
    classifyMissingShardRecovery({
      ...failedBeforeGeneration,
      steps: [
        { name: "Generate and freeze predictions", status: "completed", conclusion: "failure" },
      ],
    }),
    undefined,
  );
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
    writeJson(resolve(resultsDir, "gates/sandbox-network-smoke.json"), {
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
        ...Array.from({ length: 100 }, (_, shard) =>
          successfulJob(
            `macOS generation (verified-full-${String(shard + 1).padStart(3, "0")})`,
          ),
        ),
        successfulJob("Build benchmark recovery plan"),
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
          timeoutClosure: "not-applicable",
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
          processIsolation: "workspace-sandbox",
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
    const sandboxGatePath = resolve(resultsDir, "gates/sandbox-network-smoke.json");
    const sandboxGateBytes = readFileSync(sandboxGatePath);
    rmSync(sandboxGatePath);
    const missingSandboxGate = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "missing-sandbox-gate.json"),
    });
    assert.equal(missingSandboxGate.accepted, false);
    assert.ok(missingSandboxGate.reasons.some((reason) => reason.reason.includes("receipt missing")));
    writeFileSync(sandboxGatePath, sandboxGateBytes);
    writeJson(sandboxGatePath, { ok: true, host: { platform: "linux", arch: "arm64" } });
    const wrongSandboxHost = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "wrong-sandbox-host.json"),
    });
    assert.equal(wrongSandboxHost.accepted, false);
    assert.ok(wrongSandboxHost.reasons.some((reason) => reason.reason.includes("host is not")));
    writeFileSync(sandboxGatePath, sandboxGateBytes);
    const firstFragmentPath = resolve(resultsDir, "swe-bench-results.shard-0.json");
    const firstFragment = JSON.parse(readFileSync(firstFragmentPath, "utf8"));
    writeJson(firstFragmentPath, {
      ...firstFragment,
      composition: { ...firstFragment.composition, processIsolation: "host" },
    });
    const hostProcessAdmission = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "host-process-isolation.json"),
    });
    assert.equal(hostProcessAdmission.accepted, false);
    assert.ok(
      hostProcessAdmission.reasons.some(
        (reason) => reason.stage === "configuration" && reason.shard === 0,
      ),
    );
    const compositionWithoutProcessIsolation = { ...firstFragment.composition };
    delete compositionWithoutProcessIsolation.processIsolation;
    writeJson(firstFragmentPath, {
      ...firstFragment,
      composition: compositionWithoutProcessIsolation,
    });
    const missingProcessAdmission = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "missing-process-isolation.json"),
    });
    assert.equal(missingProcessAdmission.accepted, false);
    assert.ok(
      missingProcessAdmission.reasons.some(
        (reason) => reason.stage === "configuration" && reason.shard === 0,
      ),
    );
    writeJson(firstFragmentPath, firstFragment);
    const verified = verifyAdmissionReceipt(accepted.receiptPath);
    assert.equal(verified.predictions.size, 1);
    writeFileSync(sandboxGatePath, `${sandboxGateBytes.toString("utf8")} `);
    assert.throws(() => verifyAdmissionReceipt(accepted.receiptPath), /no longer reproduces|changed/u);
    writeFileSync(sandboxGatePath, sandboxGateBytes);
    const githubJobsPath = resolve(resultsDir, "github-jobs.json");
    const githubJobsBytes = readFileSync(githubJobsPath);
    const duplicateExecutionJobs = JSON.parse(githubJobsBytes);
    const sourceJobName = "macOS generation (verified-full-001)";
    const sourceJob = duplicateExecutionJobs.jobs.find((job) => job.name === sourceJobName);
    sourceJob.conclusion = "failure";
    sourceJob.steps = [
      {
        name: "Generate and freeze predictions",
        status: "completed",
        conclusion: "failure",
      },
    ];
    duplicateExecutionJobs.jobs.push({
      ...successfulJob(sourceJobName),
      run_attempt: 2,
    });
    writeJson(githubJobsPath, duplicateExecutionJobs);
    const duplicateExecution = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "duplicate-execution.json"),
    });
    assert.equal(duplicateExecution.accepted, false);
    assert.ok(duplicateExecution.reasons.some((reason) => reason.stage === "ci-jobs"));
    assert.throws(
      () =>
        buildFormalRecovery(duplicateExecution, {
          resultsDir,
          planPath,
          corpusPath,
          requireNoRecoveryJobs: true,
        }),
      /exactly one attempt-1 execution/u,
    );
    writeFileSync(githubJobsPath, githubJobsBytes);

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

    const recoveryInstanceId = instanceIds[1];
    const sourceTaskDir = resolve(
      resultsDir,
      "swe-bench-results.shard-0.tasks",
      recoveryInstanceId,
    );
    const sourceReceiptPath = resolve(sourceTaskDir, "receipt.json");
    const sourceReceiptBytes = readFileSync(sourceReceiptPath);
    const sourceReceipt = JSON.parse(sourceReceiptBytes);
    const sourceStderrPath = resolve(sourceTaskDir, "stderr.txt");
    const sourceStderrBytes = readFileSync(sourceStderrPath);
    const sourceProcessPath = resolve(sourceTaskDir, "process-receipt.json");
    const sourceProcessBytes = readFileSync(sourceProcessPath);
    const sourceEvidencePath = resolve(sourceTaskDir, "attempt-evidence.jsonl");
    const sourceEvidenceBytes = readFileSync(sourceEvidencePath);
    writeFileSync(
      sourceStderrPath,
      "v3 run model-failure: transport: Cannot connect to API: read ECONNRESET\n",
    );
    writeJson(sourceProcessPath, {
      ...JSON.parse(sourceProcessBytes),
      status: 1,
      stderr: reference(sourceStderrPath),
    });
    writeCompleteEvidence(sourceEvidencePath, "transport");
    writeJson(sourceReceiptPath, {
      schemaVersion: 1,
      instance_id: sourceReceipt.instance_id,
      repo: sourceReceipt.repo,
      base_commit: sourceReceipt.base_commit,
      problem_statement: sourceReceipt.problem_statement,
      disposition: "generation-inconclusive",
      failureStage: "process",
      error: "CLI did not complete normally",
      benchmarkInconclusive: true,
      wallMs: sourceReceipt.wallMs,
      claim: sourceReceipt.claim,
      processReceipt: reference(sourceProcessPath),
      evidence: reference(sourceEvidencePath),
      stdout: sourceReceipt.stdout,
      stderr: reference(sourceStderrPath),
      receiptPath: sourceReceipt.receiptPath,
    });
    const sourceInspection = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "source-with-transport-failure.json"),
    });
    assert.equal(sourceInspection.accepted, false);
    const recoveryManifest = buildFormalRecovery(sourceInspection, {
      resultsDir,
      planPath,
      corpusPath,
    });
    assert.deepEqual(recoveryManifest.tasks.map((task) => task.instanceId), [recoveryInstanceId]);
    const jobs = JSON.parse(readFileSync(githubJobsPath, "utf8"));
    jobs.jobs.push(successfulJob("macOS recovery (recovery-001)"));
    writeJson(githubJobsPath, jobs);
    const recoveryManifestPath = resolve(resultsDir, "recovery-plan/recovery-plan.json");
    writeJson(recoveryManifestPath, recoveryManifest);
    const recoveryTaskDir = resolve(
      resultsDir,
      "recovery/swe-bench-recovery.shard-0.tasks",
      recoveryInstanceId,
    );
    mkdirSync(recoveryTaskDir, { recursive: true });
    for (const name of ["claim.json", "process-receipt.json", "stdout.txt", "stderr.txt", "attempt-evidence.jsonl"]) {
      writeFileSync(resolve(recoveryTaskDir, name), readFileSync(resolve(sourceTaskDir, name)));
    }
    writeFileSync(resolve(recoveryTaskDir, "stderr.txt"), sourceStderrBytes);
    writeJson(resolve(recoveryTaskDir, "process-receipt.json"), {
      ...JSON.parse(sourceProcessBytes),
      stdout: reference(resolve(recoveryTaskDir, "stdout.txt")),
      stderr: reference(resolve(recoveryTaskDir, "stderr.txt")),
    });
    writeFileSync(resolve(recoveryTaskDir, "attempt-evidence.jsonl"), sourceEvidenceBytes);
    const recoveryReceiptPath = resolve(recoveryTaskDir, "receipt.json");
    writeJson(recoveryReceiptPath, {
      ...sourceReceipt,
      claim: reference(resolve(recoveryTaskDir, "claim.json")),
      processReceipt: reference(resolve(recoveryTaskDir, "process-receipt.json")),
      evidence: reference(resolve(recoveryTaskDir, "attempt-evidence.jsonl")),
      stdout: reference(resolve(recoveryTaskDir, "stdout.txt")),
      stderr: reference(resolve(recoveryTaskDir, "stderr.txt")),
      receiptPath: relative(repoRoot, recoveryReceiptPath),
    });
    writeJson(resolve(resultsDir, "recovery/swe-bench-recovery.shard-0.json"), {
      candidateId: `cli-${candidate.cliVersion}-${candidate.sourceCommit}`,
      provider: candidate.provider,
      composition: {
        shard: 0,
        shardTotal: 100,
        formalRunId: "formal-123",
        fullAccess: true,
        permissionMode: "full",
        interactionTools: false,
        workspaceBackend: "sandbox",
        processIsolation: "workspace-sandbox",
        execNetworkIsolation: true,
        networkToolSchemas: false,
        taskTimeoutMs: candidate.taskTimeoutMs,
        recoveryManifestSha256: sha256(recoveryManifestPath),
      },
      evaluation: {
        method: "official-swe-bench-docker-deferred",
        evaluationBatchId: "formal-123",
      },
      tasks: [
        {
          instance_id: recoveryInstanceId,
          taskReceiptPath: relative(repoRoot, recoveryReceiptPath),
        },
      ],
    });
    const recovered = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      recoveryManifestPath,
      outputPath: resolve(resultsDir, "recovered.json"),
    });
    assert.equal(recovered.accepted, true, JSON.stringify(recovered.reasons));
    assert.equal(
      recovered.tasks.find((task) => task.instanceId === recoveryInstanceId).receipt.path,
      relative(repoRoot, recoveryReceiptPath),
    );
    assert.equal(verifyAdmissionReceipt(recovered.receiptPath).receipt.accepted, true);
    const recoveryFragmentPath = resolve(
      resultsDir,
      "recovery/swe-bench-recovery.shard-0.json",
    );
    const recoveryFragment = JSON.parse(readFileSync(recoveryFragmentPath, "utf8"));
    writeJson(recoveryFragmentPath, {
      ...recoveryFragment,
      composition: { ...recoveryFragment.composition, processIsolation: "host" },
    });
    const hostRecovery = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      recoveryManifestPath,
      outputPath: resolve(root, "host-recovery-process-isolation.json"),
    });
    assert.equal(hostRecovery.accepted, false);
    assert.ok(
      hostRecovery.reasons.some((reason) => reason.stage === "recovery-fragment"),
    );
    writeJson(recoveryFragmentPath, recoveryFragment);
    const tamperedManifestPath = resolve(resultsDir, "recovery-plan/tampered.json");
    writeJson(tamperedManifestPath, { ...recoveryManifest, maxRecoveryAttempts: 2 });
    const tampered = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      recoveryManifestPath: tamperedManifestPath,
      outputPath: resolve(resultsDir, "tampered-admission.json"),
    });
    assert.equal(tampered.accepted, false);
    assert.ok(tampered.reasons.some((reason) => reason.stage === "recovery"));
    writeFileSync(sourceReceiptPath, sourceReceiptBytes);
    writeFileSync(sourceStderrPath, sourceStderrBytes);
    writeFileSync(sourceProcessPath, sourceProcessBytes);
    writeFileSync(sourceEvidencePath, sourceEvidenceBytes);

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
    writeJson(firstProcessPath, {
      ...firstProcess,
      status: 1,
      timedOut: true,
      timeoutClosure: "forced",
    });
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

    writeJson(firstProcessPath, {
      ...firstProcess,
      status: "1",
      signal: null,
      timedOut: true,
      timeoutClosure: "graceful",
    });
    writeJson(firstReceiptPath, {
      ...invalidTimeoutReceipt,
      processReceipt: reference(firstProcessPath),
      evidence: reference(firstEvidencePath),
    });
    const nonNumericTimeoutStatus = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "non-numeric-timeout-status.json"),
    });
    assert.equal(nonNumericTimeoutStatus.accepted, false);
    assert.ok(
      nonNumericTimeoutStatus.reasons.some((reason) =>
        reason.reason.includes("model-timeout closure"),
      ),
    );

    writeJson(firstProcessPath, {
      ...firstProcess,
      status: 1,
      signal: null,
      timedOut: true,
      timeoutClosure: "graceful",
    });
    const originalEvidenceRecords = sourceEvidenceBytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const evidenceWithoutFooter = originalEvidenceRecords.slice(0, -1);
    writeFileSync(
      firstEvidencePath,
      `${evidenceWithoutFooter.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    writeJson(firstReceiptPath, {
      ...invalidTimeoutReceipt,
      processReceipt: reference(firstProcessPath),
      evidence: reference(firstEvidencePath),
    });
    const missingFooterTimeout = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "missing-footer-timeout.json"),
    });
    assert.equal(missingFooterTimeout.accepted, false);
    assert.ok(
      missingFooterTimeout.reasons.some((reason) =>
        reason.reason.includes("model-timeout closure"),
      ),
    );

    writeFileSync(
      firstEvidencePath,
      `${originalEvidenceRecords
        .map((record, index) =>
          JSON.stringify(
            index === originalEvidenceRecords.length - 1
              ? { ...record, complete: false }
              : record,
          ),
        )
        .join("\n")}\n`,
    );
    writeJson(firstReceiptPath, {
      ...invalidTimeoutReceipt,
      processReceipt: reference(firstProcessPath),
      evidence: reference(firstEvidencePath),
    });
    const incompleteFooterTimeout = admitFormalGeneration({
      resultsDir,
      planPath,
      corpusPath,
      outputPath: resolve(root, "incomplete-footer-timeout.json"),
    });
    assert.equal(incompleteFooterTimeout.accepted, false);
    assert.ok(
      incompleteFooterTimeout.reasons.some((reason) =>
        reason.reason.includes("model-timeout closure"),
      ),
    );

    writeFileSync(firstEvidencePath, sourceEvidenceBytes);
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
  return {
    name,
    run_id: 123,
    run_attempt: 1,
    conclusion: "success",
    steps: [{ name: "fixture", conclusion: "success" }],
  };
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

test("attempt evidence admits only the one-shot root resource", () => {
  const root = mkdtempSync(resolve(tmpdir(), "attempt-evidence-root-"));
  try {
    const evidencePath = resolve(root, "evidence.jsonl");
    writeCompleteEvidence(evidencePath);
    const records = readFileSync(evidencePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const footer = records.pop();
    const childRunKey = {
      kind: "run",
      sessionKey: { kind: "session", agentIdentity: "agent", sequence: 1 },
      sequence: 2,
    };
    const childResourceId = JSON.stringify(["agent", 1, 2]);
    const childInvocationId = JSON.stringify(["model", childResourceId, 1]);
    const childRequest = structuredClone(records[1]);
    childRequest.resourceId = childResourceId;
    childRequest.runId = childResourceId;
    childRequest.invocationId = childInvocationId;
    childRequest.request.messages[0].runKey = childRunKey;
    const childOutcome = structuredClone(records[2]);
    childOutcome.resourceId = childResourceId;
    childOutcome.runId = childResourceId;
    childOutcome.invocationId = childInvocationId;
    const childTerminal = structuredClone(records[3]);
    childTerminal.resourceId = childResourceId;
    childTerminal.runId = childResourceId;
    childTerminal.snapshot.key = childRunKey;
    childTerminal.snapshot.transcript[0].runKey = childRunKey;
    records.push(childRequest, childOutcome, childTerminal);
    records.forEach((record, sequence) => {
      record.sequence = sequence;
    });
    const prefix = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const counts = {
      modelRequest: 2,
      modelOutcome: 2,
      modelFailure: 0,
      terminalSnapshot: 2,
    };
    footer.sequence = records.length;
    footer.resourceIds = [footer.rootRunId, childResourceId];
    footer.invocationIds = [records[1].invocationId, childInvocationId];
    footer.expectedCounts = counts;
    footer.writtenCounts = counts;
    footer.prefixSha256 = createHash("sha256").update(prefix).digest("hex");
    writeFileSync(evidencePath, `${prefix}${JSON.stringify(footer)}\n`);
    assert.deepEqual(inspectAttemptEvidence(evidencePath), {
      prefixValid: true,
      complete: false,
      reason: "incomplete-footer",
      rootStatus: "completed",
      rootTerminalCause: "completed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeCompleteEvidence(
  path,
  failureReason,
  terminalCause = failureReason === undefined ? "completed" : "model-failure",
) {
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
    type: failureReason === undefined ? "model-outcome" : "model-failure",
    resourceId,
    runId: resourceId,
    invocationId,
    ...(failureReason === undefined
      ? { outcome: { kind: "response", candidate: { content: "done", toolCalls: [] } } }
      : { failure: { kind: "failure", reason: failureReason } }),
    sequence: 2,
  });
  const terminal = JSON.stringify({
    type: "terminal-snapshot",
    resourceId,
    runId: resourceId,
    snapshot: {
      key: runKey,
      status: terminalCause === "completed" ? "completed" : "failed",
      stopFlag: false,
      deadlineAt: 123,
      cycle: 1,
      terminalCause,
      transcript: [{ kind: "user", runKey, message: { content: "fixture" } }],
    },
    sequence: 3,
  });
  const prefix = `${header}\n${request}\n${outcome}\n${terminal}\n`;
  const counts = {
    modelRequest: 1,
    modelOutcome: failureReason === undefined ? 1 : 0,
    modelFailure: failureReason === undefined ? 0 : 1,
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
