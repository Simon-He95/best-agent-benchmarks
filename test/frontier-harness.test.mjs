import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(new URL("../config/frontier-harness.json", import.meta.url), "utf8"),
);
const plan = JSON.parse(
  readFileSync(new URL("../config/frontier-harness-batches.json", import.meta.url), "utf8"),
);

/**
 * Write the delivery gate's record for a candidate directory. The harness requires
 * this fact, so every synthetic candidate here must carry one; the negative cases
 * in the candidate-delivery suite prove the gate itself fails closed.
 */
function writeDeliveryVerification(candidateDir, { verified = true, bind } = {}) {
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const receiptPath = join(candidateDir, "candidate.json");
  writeFileSync(
    join(candidateDir, "delivery-verification.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        candidateManifestSha256: bind ?? sha256(receiptPath),
        verified,
        runner: { node: process.version, platform: process.platform, arch: process.arch },
        checks: [{ id: "packaging.files", status: "passed", detail: "synthetic" }],
      },
      null,
      2,
    )}\n`,
  );
}

test("frontier-harness config pins the frozen benchmark record", () => {
  assert.equal(config.profileId, "frontier-harness-v1.0-e837a70b");
  assert.equal(config.source.name, "frontier-harness-eval/eval");
  assert.match(config.source.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(config.source.taskCount, 30);
  assert.equal(config.source.terminalBenchTaskCount, 21);
  assert.equal(config.source.deepSweTaskCount, 9);
  const ids = config.source.taskIds;
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, ids.length, "task ids must be unique");
  assert.equal(
    ids.filter((id) => id.startsWith("terminal-bench/")).length,
    config.source.terminalBenchTaskCount,
  );
  assert.equal(
    ids.filter((id) => id.startsWith("datacurve/")).length,
    config.source.deepSweTaskCount,
  );
  for (const id of ids) {
    assert.match(id, /^(terminal-bench|datacurve)\/[a-z0-9-]+$/u, id);
  }
  assert.ok(config.source.taskIds.includes(config.smokeTask));
  assert.deepEqual(config.gpuTasks, []);
  assert.deepEqual(config.resourceExceededTasks, []);
  assert.equal(config.generation.maxBatchTasks, 10);
});

test("frontier-harness pins the runner and a current Linux x64 source candidate", () => {
  assert.equal(config.pier.version, "0.3.1");
  assert.equal(config.pier.environment, "docker");
  assert.equal(config.pier.sourceRepository, "datacurve-ai/pier");
  assert.equal(config.pier.sourceTag, "v0.3.1");
  assert.match(config.pier.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(config.cli.packageName, "@best-agent/cli-linux-x64-gnu");
  assert.match(config.cli.cliVersion, /^\d+\.\d+\.\d+[\w.-]*$/u);
  assert.equal(config.cli.sourceRepository, "Simon-He95/best-agent");
  assert.match(config.cli.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(config.cli.target, "linux-x64-gnu");
});

test("frontier-harness freezes the deepseek-v4-flash max-effort provider profile", () => {
  assert.equal(config.provider.kind, "openai");
  assert.equal(config.provider.model, "deepseek-v4-flash");
  assert.equal(config.provider.compatibilityMode, "compatible");
  assert.equal(config.provider.reasoningEffort, "max");
  // The profile declares the efforts a run may select, and its default is one of
  // them: an attempt can never run at an effort the frozen record never named.
  // This model's sanctioned pair is max, so max is the only declared effort.
  assert.deepEqual(config.provider.reasoningEffortOptions, ["max"]);
  assert.ok(config.provider.reasoningEffortOptions.includes(config.provider.reasoningEffort));
  assert.equal(config.provider.transportProfile, "dim-oauth");
  assert.equal(config.provider.baseURL, "https://dimagent.cn/v1");
});

test("frontier-harness composition is headless, full-permission, and excludes unusable tools", () => {
  assert.deepEqual(config.generation.executionProfile, {
    source: "explicit-custom",
    workspaceBackend: "plain",
    workspaceAuthorization: "unrestricted",
    processIsolation: "host",
    processClosePolicy: "release",
    commandPolicy: "path",
    workspaceGrants: ["read", "write", "exec"],
  });
  assert.deepEqual(config.generation.toolExclude, ["network"]);
  assert.equal(config.generation.modelInvocationTimeoutMs, 1_800_000);
  assert.equal(config.generation.defaultAgentTimeoutMultiplier, 1);
  assert.equal(config.workspace, "/app");
  assert.doesNotMatch(
    readFileSync(join(repoRoot, ".github/workflows/frontier-harness.yml"), "utf8"),
    /fh_timeout_ms|--timeout-ms/u,
  );
});

test("frontier-harness batch plan exact-covers the frozen corpus in order", () => {
  assert.equal(plan.profileId, config.profileId);
  assert.equal(plan.datasetCommit, config.source.sourceCommit);
  const tasks = plan.batches.flatMap((batch) => batch.tasks);
  assert.equal(tasks.length, plan.taskCount);
  assert.equal(plan.taskCount, config.source.taskCount);
  assert.equal(new Set(tasks).size, tasks.length, "task ids must be unique");
  for (const batch of plan.batches) {
    assert.ok(batch.tasks.length >= 1 && batch.tasks.length <= plan.maxBatchSize);
    assert.match(batch.id, /^[a-zA-Z0-9._-]+$/u);
  }
  assert.equal(plan.maxBatchSize, 10);
  assert.deepEqual(
    tasks,
    config.source.taskIds,
    "the full plan must exact-cover the frozen corpus in corpus order",
  );
});

test("frontier-harness harness rejects unknown arguments", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/frontier-harness-harness.mjs"), "--bogus-flag"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument/u);
});

test("frontier-harness prepare rejects unknown arguments", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/prepare-frontier-harness.mjs"), "--bogus-flag"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument/u);
});

test("harness fails closed when the current candidate identity mismatches", async () => {
  const candidateDir = mkdtempSync(join(tmpdir(), "fh-candidate-"));
  writeFileSync(join(candidateDir, "best-agent-cli.tgz"), "candidate");
  writeFileSync(join(candidateDir, "build-report.json"), "{}\n");
  writeFileSync(
    join(candidateDir, "candidate.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: config.cli.packageName,
      cliVersion: config.cli.cliVersion,
      sourceRepository: config.cli.sourceRepository,
      sourceCommit: "0".repeat(40),
      target: config.cli.target,
      tarballSha256: "0".repeat(64),
      buildReportSha256: "0".repeat(64),
      binarySha256: "0".repeat(64),
      lockfileSha256: "0".repeat(64),
      runtimeDependencies: {},
    }),
  );
  writeDeliveryVerification(candidateDir);
  const previous = process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
  process.env.BEST_AGENT_CLI_CANDIDATE_DIR = candidateDir;
  try {
    const { verifyFrozenIdentity } = await import(
      `../scripts/frontier-harness-harness.mjs?candidate=${Date.now()}`
    );
    assert.throws(
      () => verifyFrozenIdentity(),
      /candidate identity does not match/u,
    );
  } finally {
    if (previous === undefined) delete process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
    else process.env.BEST_AGENT_CLI_CANDIDATE_DIR = previous;
  }
});

test("the harness refuses a candidate whose delivery was never verified, or verified other bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fh-delivery-gate-"));
  const candidateDir = join(root, "candidate");
  mkdirSync(candidateDir, { recursive: true });
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(join(candidateDir, "best-agent-cli.tgz"), "candidate");
  writeFileSync(join(candidateDir, "build-report.json"), "{}\n");
  writeFileSync(
    join(candidateDir, "candidate.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: config.cli.packageName,
      cliVersion: config.cli.cliVersion,
      sourceRepository: config.cli.sourceRepository,
      sourceCommit: config.cli.sourceCommit,
      target: config.cli.target,
      tarballSha256: sha256(join(candidateDir, "best-agent-cli.tgz")),
      buildReportSha256: sha256(join(candidateDir, "build-report.json")),
      binarySha256: "1".repeat(64),
      lockfileSha256: "2".repeat(64),
      runtimeLockSha256: "3".repeat(64),
      nodeBinarySha256: "4".repeat(64),
      nodeVersion: "v24.16.0",
      runtimeDependencies: {},
    }),
  );
  const previous = process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
  process.env.BEST_AGENT_CLI_CANDIDATE_DIR = candidateDir;
  try {
    const { verifyFrozenIdentity } = await import(
      `../scripts/frontier-harness-harness.mjs?delivery=${Date.now()}`
    );
    // A directory that merely looks like a candidate is not a verified delivery.
    assert.throws(() => verifyFrozenIdentity(), /has no delivery-verification\.json/u);
    // A record that failed the gate is not a pass.
    writeDeliveryVerification(candidateDir, { verified: false });
    assert.throws(() => verifyFrozenIdentity(), /is not a pass bound to this receipt/u);
    // A pass bound to other receipt bytes does not cover the bytes about to be used.
    writeDeliveryVerification(candidateDir, { bind: "0".repeat(64) });
    assert.throws(() => verifyFrozenIdentity(), /is not a pass bound to this receipt/u);
    // Only a pass bound to exactly these receipt bytes is admitted: control then
    // advances to the next frozen-identity requirement, not to a delivery refusal.
    writeDeliveryVerification(candidateDir);
    assert.throws(() => verifyFrozenIdentity(), /BEST_AGENT_PROVIDER_CONFIG/u);
  } finally {
    if (previous === undefined) delete process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
    else process.env.BEST_AGENT_CLI_CANDIDATE_DIR = previous;
  }
});

test("the harness freezes the materialized reasoning effort and refuses an undeclared one", async () => {
  const root = mkdtempSync(join(tmpdir(), "fh-effort-"));
  const candidateDir = join(root, "candidate");
  const dimcodeHome = join(root, "dimcode-home");
  mkdirSync(candidateDir, { recursive: true });
  mkdirSync(dimcodeHome, { recursive: true });
  writeFileSync(join(dimcodeHome, "config.json"), "{}\n");
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(join(candidateDir, "best-agent-cli.tgz"), "candidate");
  writeFileSync(join(candidateDir, "build-report.json"), "{}\n");
  writeFileSync(
    join(candidateDir, "candidate.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: config.cli.packageName,
      cliVersion: config.cli.cliVersion,
      sourceRepository: config.cli.sourceRepository,
      sourceCommit: config.cli.sourceCommit,
      target: config.cli.target,
      tarballSha256: sha256(join(candidateDir, "best-agent-cli.tgz")),
      buildReportSha256: sha256(join(candidateDir, "build-report.json")),
      binarySha256: "1".repeat(64),
      lockfileSha256: "2".repeat(64),
      runtimeLockSha256: "3".repeat(64),
      nodeBinarySha256: "4".repeat(64),
      nodeVersion: "v24.16.0",
      runtimeDependencies: {},
    }),
  );
  writeDeliveryVerification(candidateDir);
  const providerPath = join(root, "provider.json");
  const writeProvider = (reasoningEffort, timeoutMs) =>
    writeFileSync(
      providerPath,
      JSON.stringify({
        kind: config.provider.kind,
        model: config.provider.model,
        apiKey: "synthetic-key",
        baseURL: config.provider.baseURL,
        compatibilityMode: config.provider.compatibilityMode,
        reasoningEffort,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        credentialRef: "benchmark-ci-dim-oauth",
        transportProfile: config.provider.transportProfile,
      }),
    );

  const envKeys = [
    "BEST_AGENT_CLI_CANDIDATE_DIR",
    "BEST_AGENT_PROVIDER_CONFIG",
    "BEST_AGENT_PROVIDER_MODEL",
    "BEST_AGENT_PROVIDER_BASE_URL",
    "BEST_AGENT_PROVIDER_TIMEOUT_MS",
    "DIMCODE_HOME",
  ];
  const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.BEST_AGENT_CLI_CANDIDATE_DIR = candidateDir;
    process.env.BEST_AGENT_PROVIDER_CONFIG = providerPath;
    process.env.BEST_AGENT_PROVIDER_MODEL = config.provider.model;
    process.env.BEST_AGENT_PROVIDER_BASE_URL = config.provider.baseURL;
    process.env.DIMCODE_HOME = dimcodeHome;
    const { verifyFrozenIdentity } = await import(
      `../scripts/frontier-harness-harness.mjs?effort=${Date.now()}`
    );

    // The declared effort is carried into the frozen identity the record
    // transcribes.
    writeProvider(config.provider.reasoningEffort);
    assert.equal(
      verifyFrozenIdentity().reasoningEffort,
      config.provider.reasoningEffort,
    );
    writeProvider(config.provider.reasoningEffort, 900_000);
    assert.throws(() => verifyFrozenIdentity(), /does not match the frozen/u);
    writeProvider(config.provider.reasoningEffort);
    process.env.BEST_AGENT_PROVIDER_TIMEOUT_MS = "900000";
    assert.throws(() => verifyFrozenIdentity(), /does not match the frozen/u);
    delete process.env.BEST_AGENT_PROVIDER_TIMEOUT_MS;

    // An effort the frozen profile never declared fails closed instead of being
    // recorded as an attempt that ran at it — including the effort the previous
    // profile declared and this one does not.
    for (const undeclared of ["high", "low"]) {
      writeProvider(undeclared);
      assert.throws(
        () => verifyFrozenIdentity(),
        /provider identity does not match/u,
      );
    }
  } finally {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("frontier-harness pins the authoritative per-suite task sources", () => {
  const { terminalBench, deepSwe } = config.taskSources;
  assert.equal(terminalBench.repository, "laude-institute/terminal-bench-2");
  assert.match(terminalBench.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(terminalBench.taskPath, "<name>");
  assert.ok(terminalBench.provenance.includes("terminal-bench@2.0"));
  assert.equal(deepSwe.repository, "datacurve-ai/deep-swe");
  assert.match(deepSwe.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(deepSwe.taskPath, "tasks/<name>");
  assert.ok(deepSwe.provenance.length > 0);
});

test("normalizeTaskTomlNetwork only rewrites the agent phase", async () => {
  const { normalizeTaskTomlNetwork } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );

  const datacurveLike = [
    'schema_version = "1.3"',
    "artifacts = [\"/logs/artifacts/model.patch\"]",
    "[verifier]",
    'network_mode = "no-network"',
    'environment_mode = "separate"',
    "timeout_sec = 1800.0",
    "[verifier.environment]",
    "build_timeout_sec = 1800.0",
    "[[verifier.collect]]",
    'command = "cd /app && git diff HEAD > /logs/artifacts/model.patch"',
    "[agent]",
    'network_mode = "no-network"',
    "timeout_sec = 5400.0",
    "[environment]",
    'docker_image = "public.ecr.aws/example:pin"',
    "[environment.env]",
  ].join("\n");
  const normalized = normalizeTaskTomlNetwork(datacurveLike);
  assert.deepEqual(normalized.changes, [
    '[agent] network_mode = "no-network" -> network_mode = "public"',
  ]);
  assert.match(normalized.text, /^# Staged by frontier-harness-harness\.mjs/u);
  assert.doesNotMatch(normalized.text, /\[agent\][^\[]*network_mode = "no-network"/u);
  // The verifier's own network policy must survive verbatim.
  assert.match(normalized.text, /\[verifier\]\nnetwork_mode = "no-network"/u);
  assert.match(normalized.text, /environment_mode = "separate"/u);
  assert.match(normalized.text, /docker_image = "public\.ecr\.aws\/example:pin"/u);

  const terminalBenchLike = [
    'schema_version = "1.0"',
    "[verifier]",
    "timeout_sec = 900.0",
    "[agent]",
    "timeout_sec = 900.0",
    "[environment]",
    'docker_image = "alexgshaw/regex-log:20251031"',
    'memory = "2G"',
  ].join("\n");
  const untouched = normalizeTaskTomlNetwork(terminalBenchLike);
  assert.deepEqual(untouched.changes, []);
  assert.equal(untouched.text, terminalBenchLike);

  const alreadyPublic = '[agent]\nnetwork_mode = "public"\n';
  const noChange = normalizeTaskTomlNetwork(alreadyPublic);
  assert.deepEqual(noChange.changes, []);
  assert.equal(noChange.text, alreadyPublic);

  const restrictedEnv = "[environment]\nallow_internet = false\n";
  const opened = normalizeTaskTomlNetwork(restrictedEnv);
  assert.deepEqual(opened.changes, [
    "[environment] allow_internet = false -> allow_internet = true",
  ]);
  assert.match(opened.text, /allow_internet = true/u);
});

test("stagePierTask copies the source task verbatim with network normalization", async () => {
  const { stagePierTask } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );
  const sourceRoot = mkdtempSync(join(tmpdir(), "fh-stage-source-"));
  const pierTaskDir = mkdtempSync(join(tmpdir(), "fh-stage-dest-"));

  const instruction = "Write a regex that matches dates.\n";
  const instructionSha256 = createHash("sha256").update(instruction).digest("hex");
  const taskDir = join(sourceRoot, "tasks", "example-task");
  mkdirSync(join(taskDir, "environment"), { recursive: true });
  mkdirSync(join(taskDir, "tests"), { recursive: true });
  mkdirSync(join(taskDir, "solution"), { recursive: true });
  writeFileSync(
    join(taskDir, "task.toml"),
    [
      'schema_version = "1.3"',
      "[agent]",
      'network_mode = "no-network"',
      "timeout_sec = 5400.0",
      "[verifier]",
      'network_mode = "no-network"',
      'environment_mode = "separate"',
      "[environment]",
      'docker_image = "public.ecr.aws/example:pin"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(taskDir, "instruction.md"), instruction);
  writeFileSync(join(taskDir, "environment", "Dockerfile"), "FROM ubuntu:24.04\n");
  writeFileSync(join(taskDir, "tests", "test.sh"), "#!/bin/bash\necho 1 > /logs/verifier/reward.txt\n", { mode: 0o755 });
  writeFileSync(join(taskDir, "tests", "grader.py"), "print('grade')\n");
  writeFileSync(join(taskDir, "solution", "solve.sh"), "exit 0\n");

  const task = {
    name: "datacurve/example-task",
    suite: "datacurve",
    sourceTaskDir: "tasks/example-task",
    instructionSha256,
  };
  const staged = stagePierTask({ task, sourceRoot, pierTaskDir });
  assert.equal(staged.networkChanges.length, 1);

  const stagedToml = readFileSync(join(pierTaskDir, "task.toml"), "utf8");
  assert.match(stagedToml, /network_mode = "public"/u);
  assert.match(stagedToml, /\[verifier\]\nnetwork_mode = "no-network"/u);
  assert.equal(
    readFileSync(join(pierTaskDir, "instruction.md"), "utf8"),
    instruction,
  );
  assert.equal(
    statSync(join(pierTaskDir, "tests", "test.sh")).mode & 0o111,
    0o111,
    "test.sh must keep its executable bit",
  );
  assert.ok(existsSync(join(pierTaskDir, "solution", "solve.sh")));
  assert.ok(existsSync(join(pierTaskDir, "tests", "grader.py")));

  // Re-staging over an existing task.toml must fail closed.
  assert.throws(
    () => stagePierTask({ task, sourceRoot, pierTaskDir }),
    /Refusing to restage/u,
  );

  // A mutated instruction (hash mismatch) must fail closed.
  const freshDest = mkdtempSync(join(tmpdir(), "fh-stage-dest2-"));
  const tamperedTask = { ...task, instructionSha256: "0".repeat(64) };
  assert.throws(
    () => stagePierTask({ task: tamperedTask, sourceRoot, pierTaskDir: freshDest }),
    /does not match the frozen corpus hash/u,
  );
});

test("classifyTrialOutcome marks pre-model provider deaths as errors", async () => {
  const { classifyTrialOutcome, summarizeAttemptEvidence } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );

  // Evidence summaries: the footer's writtenCounts are authoritative.
  assert.deepEqual(summarizeAttemptEvidence(undefined), {
    present: false,
    modelOutcomes: null,
    terminalCause: null,
    modelFailureReasons: [],
  });
  const footerEvidence = [
    '{"type":"model-request","sequence":1}',
    '{"type":"model-failure","sequence":2,"reason":"transport"}',
    '{"type":"terminal-snapshot","sequence":3,"snapshot":{"terminalCause":"model-failure"}}',
    '{"type":"footer","sequence":4,"writtenCounts":{"modelRequest":1,"modelOutcome":0,"modelFailure":1,"terminalSnapshot":1}}',
    "",
  ].join("\n");
  assert.deepEqual(summarizeAttemptEvidence(footerEvidence), {
    present: true,
    modelOutcomes: 0,
    terminalCause: "model-failure",
    modelFailureReasons: ["transport"],
  });
  const countedEvidence = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-outcome","sequence":2}',
    '{"type":"terminal-snapshot","sequence":3,"snapshot":{"terminalCause":"completed"}}',
    "",
  ].join("\n");
  assert.deepEqual(summarizeAttemptEvidence(countedEvidence), {
    present: true,
    modelOutcomes: 2,
    terminalCause: "completed",
    modelFailureReasons: [],
  });

  const exception = {
    exception_type: "NonZeroAgentExitCodeError",
    exception_message: "Command failed (exit 1)",
  };

  // A real pass.
  assert.deepEqual(
    classifyTrialOutcome({ trialResult: { verifier_result: { rewards: { reward: 1 } } } }),
    { disposition: "passed", rewards: { reward: 1 } },
  );
  // The canonical key wins: `reward: 0` with a diagnostic `p2p: 1` (all
  // pass-to-pass tests still pass) is a task FAILURE — the fail-to-pass
  // suite proves the task was not solved.
  const multiKeyRewards = {
    reward: 0,
    f2p_total: 25,
    f2p_passed: 0,
    p2p_total: 1679,
    p2p_passed: 1679,
    f2p: 0,
    p2p: 1,
  };
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: { verifier_result: { rewards: multiKeyRewards } },
    }),
    { disposition: "failed", rewards: multiKeyRewards },
  );
  // Rewards without a canonical `reward` key fall back to the legacy
  // any-key>=1 rule (no such verifier exists in the frozen corpus; both real
  // verifiers write `reward`).
  assert.equal(
    classifyTrialOutcome({ trialResult: { verifier_result: { rewards: { f2p: 1 } } } }).disposition,
    "passed",
  );
  assert.equal(
    classifyTrialOutcome({ trialResult: { verifier_result: { rewards: { f2p: 0, p2p: 1 } } } }).disposition,
    "passed",
  );
  // A real task failure: the model responded (outcomes > 0) and the verifier graded 0.
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
      evidenceText: countedEvidence,
    }),
    {
      disposition: "failed",
      rewards: { reward: 0 },
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
      modelOutcomes: 2,
      terminalCause: "completed",
    },
  );
  // A pre-model provider death: the CLI errored before receiving any model
  // response, so the graded 0 is an environment/provider failure, not a task
  // failure.
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
      evidenceText: footerEvidence,
    }),
    {
      disposition: "error",
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
      preModelFailure: true,
      modelOutcomes: 0,
      terminalCause: "model-failure",
    },
  );
  // Missing evidence stays conservative: keep the verifier's verdict.
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
    }),
    {
      disposition: "failed",
      rewards: { reward: 0 },
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
    },
  );
  // No verifier result: the agent exception is the outcome.
  assert.deepEqual(
    classifyTrialOutcome({ trialResult: { exception_info: exception } }),
    {
      disposition: "error",
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
    },
  );
  // Neither rewards nor an exception.
  assert.deepEqual(classifyTrialOutcome({ trialResult: {} }), {
    disposition: "inconclusive",
  });
});

test("delivery Run evidence cannot replace the primary failure or its model count", async () => {
  const { summarizeAttemptEvidence, classifyTrialOutcome } = await import(
    `../scripts/frontier-harness-harness.mjs?delivery=${Date.now()}`
  );
  const evidence = [
    { type: "header", rootRunId: "primary" },
    { type: "terminal-snapshot", resourceId: "primary", snapshot: { terminalCause: "stopped" } },
    { type: "model-outcome", resourceId: "delivery" },
    { type: "terminal-snapshot", resourceId: "delivery", snapshot: { terminalCause: "completed" } },
    { type: "footer", writtenCounts: { modelOutcome: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  assert.deepEqual(summarizeAttemptEvidence(evidence), {
    present: true,
    modelOutcomes: 0,
    terminalCause: "stopped",
    deliveryTerminalCause: "completed",
    modelFailureReasons: [],
  });
  assert.deepEqual(
    classifyTrialOutcome({ trialResult: { exception_info: { exception_type: "killed" } }, evidenceText: evidence }),
    {
      disposition: "error",
      exception: { type: "killed", message: "" },
      preModelFailure: true,
      modelOutcomes: 0,
      terminalCause: "stopped",
      deliveryTerminalCause: "completed",
    },
  );
});

test("classifyTrialOutcome marks post-response provider deaths as errors", async () => {
  const { classifyTrialOutcome, summarizeAttemptEvidence } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );

  const exception = {
    exception_type: "NonZeroAgentExitCodeError",
    exception_message: "Command failed (exit 1)",
  };
  // A quota death after two model responses: the frozen CLI writes the nested
  // `failure.reason`, and the verifier's 0 was produced over an interrupted
  // workspace, so it is an infrastructure event rather than a task failure.
  const transportEvidence = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-outcome","sequence":2}',
    '{"type":"model-failure","sequence":3,"failure":{"kind":"failure","reason":"transport"}}',
    '{"type":"terminal-snapshot","sequence":4,"snapshot":{"terminalCause":"model-failure"}}',
    "",
  ].join("\n");
  assert.deepEqual(summarizeAttemptEvidence(transportEvidence), {
    present: true,
    modelOutcomes: 2,
    terminalCause: "model-failure",
    modelFailureReasons: ["transport"],
  });
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
      evidenceText: transportEvidence,
    }),
    {
      disposition: "error",
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
      infraFailure: true,
      modelOutcomes: 2,
      terminalCause: "model-failure",
    },
  );
  // The CLI's other provider-side reason: `connection` means the endpoint was
  // unreachable at the transport level (DNS/connect/reset), which the CLI's own
  // classifier documents and its tests pin. It is the same outage as `transport`
  // and must not be graded as a task failure either.
  const connectionEvidence = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-failure","sequence":2,"failure":{"kind":"failure","reason":"connection"}}',
    '{"type":"terminal-snapshot","sequence":3,"snapshot":{"terminalCause":"model-failure"}}',
    "",
  ].join("\n");
  assert.deepEqual(summarizeAttemptEvidence(connectionEvidence), {
    present: true,
    modelOutcomes: 1,
    terminalCause: "model-failure",
    modelFailureReasons: ["connection"],
  });
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
      evidenceText: connectionEvidence,
    }),
    {
      disposition: "error",
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
      infraFailure: true,
      modelOutcomes: 1,
      terminalCause: "model-failure",
    },
  );
  // The CLI's own model-invocation deadline is this harness's pinned policy,
  // not an infrastructure event: a timeout stays graded by the verifier.
  const timeoutEvidence = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-failure","sequence":2,"failure":{"kind":"failure","reason":"timeout"}}',
    '{"type":"terminal-snapshot","sequence":3,"snapshot":{"terminalCause":"model-failure"}}',
    "",
  ].join("\n");
  assert.deepEqual(
    classifyTrialOutcome({
      trialResult: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: exception,
      },
      evidenceText: timeoutEvidence,
    }),
    {
      disposition: "failed",
      rewards: { reward: 0 },
      exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
      modelOutcomes: 1,
      terminalCause: "model-failure",
    },
  );
  // A transport failure that did not end the run leaves the verdict alone.
  const recoveredEvidence = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-failure","sequence":2,"failure":{"kind":"failure","reason":"transport"}}',
    '{"type":"terminal-snapshot","sequence":3,"snapshot":{"terminalCause":"completed"}}',
    "",
  ].join("\n");
  assert.equal(
    classifyTrialOutcome({
      trialResult: { verifier_result: { rewards: { reward: 1 } } },
      evidenceText: recoveredEvidence,
    }).disposition,
    "passed",
  );
});

test("projectAgentUsage reads the plugin's usage facts and keeps missing ones missing", async () => {
  const { projectAgentUsage } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );

  // No usage metadata at all (a pre-change candidate, or a run with no model call).
  assert.equal(projectAgentUsage(undefined), undefined);
  assert.equal(projectAgentUsage({ n_input_tokens: 5 }), undefined);

  // The shape the plugin writes from the CLI's durable thread_metrics row.
  assert.deepEqual(
    projectAgentUsage({
      n_input_tokens: 161419,
      n_output_tokens: 7449,
      n_cache_tokens: 142080,
      cost_usd: null,
      metadata: {
        usage: {
          prompt_tokens: 161419,
          completion_tokens: 7449,
          total_tokens: 168868,
          cache_read_tokens: 142080,
          cache_write_tokens: 0,
          no_cache_input_tokens: 19339,
          model_call_count: 13,
          reported_call_count: 13,
          reported_input_tokens: 161419,
        },
      },
    }),
    {
      promptTokens: 161419,
      completionTokens: 7449,
      cacheReadTokens: 142080,
      costUsd: null,
      totalTokens: 168868,
      cacheWriteTokens: 0,
      noCacheInputTokens: 19339,
      modelCallCount: 13,
      reportedCallCount: 13,
      reportedInputTokens: 161419,
    },
  );
});

test("provider materialization rejects a non-frozen provider profile", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-provider-"));
  const wrongProfile = mkdtempSync(join(tmpdir(), "fh-provider-config-"));
  writeFileSync(
    join(wrongProfile, "config.json"),
    JSON.stringify({
      provider: {
        kind: "openai",
        model: "deepseek-v4-flash",
        baseURL: config.provider.baseURL,
        compatibilityMode: "compatible",
        reasoningEffort: "high",
        reasoningEffortOptions: ["high"],
        transportProfile: "dim-oauth",
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/materialize-frontier-provider.mjs"),
      root,
      join(root, "github.env"),
      join(wrongProfile, "config.json"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BENCHMARK_PROVIDER_API_KEY: "synthetic-key" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frozen frontier-harness provider profile is invalid/u);
});

test("provider materialization selects a declared effort and refuses an undeclared one", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-effort-materialize-"));
  const token =
    "fixture." +
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url") +
    ".fixture";
  const materialize = (effort) => {
    const label = effort === "" ? "default" : effort;
    const target = join(root, label);
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/materialize-frontier-provider.mjs"),
        target,
        join(root, `${label}.env`),
        resolve(repoRoot, "config/frontier-harness.json"),
        effort,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, BENCHMARK_PROVIDER_API_KEY: token },
      },
    );
    return { result, providerPath: join(target, "provider.json") };
  };

  // A declared effort is materialized verbatim, and the printed summary names it.
  const declared = materialize(config.provider.reasoningEffort);
  assert.equal(declared.result.status, 0, declared.result.stderr);
  assert.equal(
    JSON.parse(readFileSync(declared.providerPath, "utf8")).reasoningEffort,
    config.provider.reasoningEffort,
  );
  assert.equal(
    JSON.parse(declared.result.stdout).reasoningEffort,
    config.provider.reasoningEffort,
  );

  // An empty selection keeps the frozen profile's own default.
  const fallback = materialize("");
  assert.equal(fallback.result.status, 0, fallback.result.stderr);
  assert.equal(
    JSON.parse(readFileSync(fallback.providerPath, "utf8")).reasoningEffort,
    config.provider.reasoningEffort,
  );

  // An effort outside the declared options never reaches the credential files —
  // including the previous profile's own alternative, which this model never
  // declared and the harness's admitted list does not name for it.
  const refused = materialize("low");
  assert.notEqual(refused.result.status, 0);
  assert.match(refused.result.stderr, /is not a declared option/u);
  assert.ok(!existsSync(refused.providerPath));

  const refusedEffort = materialize("high");
  assert.notEqual(refusedEffort.result.status, 0);
  assert.match(refusedEffort.result.stderr, /is not a declared option/u);
  assert.ok(!existsSync(refusedEffort.providerPath));
});

test("classifyTrialOutcome grades a run whose fatal failure was its own budget", async () => {
  const { classifyTrialOutcome } = await import(
    `../scripts/frontier-harness-harness.mjs?unit=${Date.now()}`
  );

  const exception = {
    exception_type: "NonZeroAgentExitCodeError",
    exception_message: "Command failed (exit 1)",
  };
  const trialResult = {
    verifier_result: { rewards: { reward: 0 } },
    exception_info: exception,
  };
  const terminal = '{"type":"terminal-snapshot","sequence":9,"snapshot":{"terminalCause":"model-failure"}}';
  const failure = (sequence, reason) =>
    `{"type":"model-failure","sequence":${sequence},"failure":{"kind":"failure","reason":"${reason}"}}`;

  // A transport failure the run survived must not excuse the fatal budget
  // timeout that followed: only the failure that ended the run decides.
  const survivedTransport = [
    '{"type":"model-outcome","sequence":1}',
    failure(2, "transport"),
    '{"type":"model-outcome","sequence":3}',
    failure(4, "timeout"),
    terminal,
    "",
  ].join("\n");
  assert.deepEqual(classifyTrialOutcome({ trialResult, evidenceText: survivedTransport }), {
    disposition: "failed",
    rewards: { reward: 0 },
    exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
    modelOutcomes: 2,
    terminalCause: "model-failure",
  });

  // The mirror image: an earlier budget timeout does not stop the fatal
  // transport death from being infrastructure.
  const fatalTransport = [
    '{"type":"model-outcome","sequence":1}',
    failure(2, "timeout"),
    '{"type":"model-outcome","sequence":3}',
    failure(4, "transport"),
    terminal,
    "",
  ].join("\n");
  assert.deepEqual(classifyTrialOutcome({ trialResult, evidenceText: fatalTransport }), {
    disposition: "error",
    exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
    infraFailure: true,
    modelOutcomes: 2,
    terminalCause: "model-failure",
  });

  // The same rule holds for the other provider reason: a `connection` outage the
  // run survived does not excuse the fatal budget timeout that followed.
  const survivedConnection = [
    '{"type":"model-outcome","sequence":1}',
    failure(2, "connection"),
    '{"type":"model-outcome","sequence":3}',
    failure(4, "timeout"),
    terminal,
    "",
  ].join("\n");
  assert.deepEqual(classifyTrialOutcome({ trialResult, evidenceText: survivedConnection }), {
    disposition: "failed",
    rewards: { reward: 0 },
    exception: { type: "NonZeroAgentExitCodeError", message: "Command failed (exit 1)" },
    modelOutcomes: 2,
    terminalCause: "model-failure",
  });

  // A model-failure with no recorded reason stays graded: the classifier never
  // guesses an infrastructure death it cannot prove.
  const unlabelled = [
    '{"type":"model-outcome","sequence":1}',
    '{"type":"model-failure","sequence":2}',
    terminal,
    "",
  ].join("\n");
  assert.equal(
    classifyTrialOutcome({ trialResult, evidenceText: unlabelled }).disposition,
    "failed",
  );
});

test("formal frontier report never claims passAt1 while a verdict is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "fh-report-"));
  const results = join(root, "results");
  mkdirSync(results);
  const tasks = ["datacurve/one", "terminal-bench/two"];
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: {
        name: "frontier-harness-eval-v1",
        sourceCommit: config.source.sourceCommit,
        taskCount: 30,
      },
      gpuTasks: [],
      tasks: tasks.map((name) => ({ name, instructionSha256: `frozen-${name}` })),
    }),
  );
  const expectedPath = join(root, "expected.txt");
  writeFileSync(expectedPath, `${tasks.join("\n")}\n`);
  const writeRecord = (task, result) =>
    writeFileSync(
      join(results, `frontier-harness-results.${task.split("/").pop()}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: {
          name: task,
          suite: task.split("/")[0],
          instructionSha256: `frozen-${task}`,
        },
        candidateId: "cli-synthetic",
        cliVersion: config.cli.cliVersion,
        cliBinarySha256: "a".repeat(64),
        candidateManifestSha256: "b".repeat(64),
        model: config.provider.model,
        batchId: "synthetic",
        durationMs: 1000,
        reasoningEffort: config.provider.reasoningEffort,
        result,
        artifacts: {},
      }),
    );
  writeRecord(tasks[0], { disposition: "passed", rewards: { reward: 1 } });
  // An infrastructure death: the trial carries no verdict.
  writeRecord(tasks[1], {
    disposition: "error",
    infraFailure: true,
    exception: { type: "NonZeroAgentExitCodeError", message: "HTTP 402" },
  });

  const run = (expected, name) => {
    const output = join(root, `${name}.json`);
    const spawned = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/frontier-harness-report.mjs"),
        "--results",
        results,
        "--corpus",
        join(root, "corpus.json"),
        "--expected-tasks",
        expected,
        "--output",
        output,
        "--formal",
      ],
      { encoding: "utf8" },
    );
    assert.equal(spawned.status, 0, spawned.stderr);
    return JSON.parse(readFileSync(output, "utf8"));
  };

  // The raw rate is always reported, and it keeps the invalid cell in the
  // denominator: an outage can never be read as a capability regression.
  const withError = run(expectedPath, "with-error");
  assert.deepEqual(withError.results, { passed: 1, failed: 0, error: 1, notEvaluated: 0 });
  assert.equal(withError.passRate, 0.5);
  assert.equal(withError.coverage.fullExpected, true);
  // The secondary valid-cells view drops the cell, and says how many.
  assert.equal(withError.validCells, 1);
  assert.equal(withError.passRateValidCells, 1);
  // ...but the formal headline is refused, because a verdict is missing.
  assert.equal(withError.scoreable, false);
  assert.equal(withError.capabilityMeasurement, false);
  assert.equal(withError.passAt1, null);

  // Once every cell has a verdict the formal headline is claimed.
  writeRecord(tasks[1], { disposition: "failed", rewards: { reward: 0 } });
  const graded = run(expectedPath, "graded");
  assert.equal(graded.passRate, 0.5);
  assert.equal(graded.validCells, 2);
  assert.equal(graded.passRateValidCells, 0.5);
  assert.equal(graded.scoreable, true);
  // Every acceptance criterion is named, and a clean run passes all of them.
  assert.deepEqual(
    graded.acceptance.map((entry) => [entry.id, entry.status]),
    [
      ["coverage.full", "passed"],
      ["verdicts.complete", "passed"],
      ["candidate.single", "passed"],
      ["provider.single", "passed"],
      ["instructions.frozen", "passed"],
    ],
  );
  assert.equal(graded.capabilityMeasurement, true);
  assert.equal(graded.passAt1, 0.5);
  assert.match(
    readFileSync(join(root, "graded.json.md"), "utf8"),
    /\| capability measurement \| yes \|/u,
  );

  // A subset of the corpus is not a formal full-corpus claim.
  const subsetPath = join(root, "expected-subset.txt");
  writeFileSync(subsetPath, `${tasks[0]}\n`);
  const subset = run(subsetPath, "subset");
  assert.equal(subset.passRate, 1);
  assert.equal(subset.coverage.fullExpected, false);
  assert.equal(subset.scoreable, false);
  assert.equal(subset.capabilityMeasurement, false);
  assert.equal(subset.passAt1, null);

  // Each acceptance criterion is individually load-bearing: a run that is complete
  // but mixes candidates, providers or instruction versions cannot carry a headline.
  const writeAcceptanceProbe = (task, overrides) => {
    const path = join(results, `frontier-harness-results.${task.split("/").pop()}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, ...overrides }));
  };
  const rejected = (overrides, expectedId, detail) => {
    writeAcceptanceProbe(tasks[1], overrides);
    const probe = run(expectedPath, `probe-${expectedId}`);
    const entry = probe.acceptance.find((candidate) => candidate.id === expectedId);
    assert.equal(entry.status, "failed", expectedId);
    assert.match(entry.detail, detail);
    assert.equal(probe.capabilityMeasurement, false);
    assert.equal(probe.passAt1, null);
    // The raw rate stays visible; only the claim is refused.
    assert.equal(probe.passRate, 0.5);
    writeAcceptanceProbe(tasks[1], {
      candidateId: "cli-synthetic",
      cliVersion: config.cli.cliVersion,
      cliBinarySha256: "a".repeat(64),
      candidateManifestSha256: "b".repeat(64),
      model: config.provider.model,
      task: { name: tasks[1], suite: "terminal-bench", instructionSha256: `frozen-${tasks[1]}` },
    });
  };
  rejected({ cliBinarySha256: "c".repeat(64) }, "candidate.single", /2 distinct candidate identities/u);
  rejected({ model: "another-model" }, "provider.single", /another-model/u);
  rejected(
    { task: { name: tasks[1], suite: "terminal-bench", instructionSha256: "rewritten" } },
    "instructions.frozen",
    /do not match the frozen instruction hash/u,
  );

  // The provider effort is transcribed from the frozen records, not from the
  // config default, so a run is reported at the effort its attempts ran at.
  assert.equal(graded.provider.reasoningEffort, config.provider.reasoningEffort);
  assert.match(
    readFileSync(join(root, "graded.json.md"), "utf8"),
    new RegExp(`reasoning ${config.provider.reasoningEffort}`, "u"),
  );
});

test("frontier report refuses records whose reasoning effort is not declared", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-report-effort-"));
  const results = join(root, "results");
  mkdirSync(results);
  const tasks = ["datacurve/one", "terminal-bench/two"];
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: {
        name: "frontier-harness-eval-v1",
        sourceCommit: config.source.sourceCommit,
        taskCount: 30,
      },
      gpuTasks: [],
      tasks: tasks.map((name) => ({ name })),
    }),
  );
  const expectedPath = join(root, "expected.txt");
  writeFileSync(expectedPath, `${tasks.join("\n")}\n`);
  const writeRecord = (task, reasoningEffort) =>
    writeFileSync(
      join(results, `frontier-harness-results.${task.split("/").pop()}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: { name: task, suite: task.split("/")[0] },
        candidateId: "synthetic",
        batchId: "synthetic",
        durationMs: 1000,
        reasoningEffort,
        result: { disposition: "passed", rewards: { reward: 1 } },
        artifacts: {},
      }),
    );
  const report = () =>
    spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/frontier-harness-report.mjs"),
        "--results",
        results,
        "--corpus",
        join(root, "corpus.json"),
        "--expected-tasks",
        expectedPath,
        "--output",
        join(root, "report.json"),
        "--formal",
      ],
      { encoding: "utf8" },
    );

  // An effort the frozen profile never declared is refused, not reported: on a
  // single-effort profile every other effort is rejected here before any two
  // records could disagree among themselves.
  writeRecord(tasks[0], "max");
  for (const undeclared of ["high", "low"]) {
    writeRecord(tasks[1], undeclared);
    const refused = report();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /carries no declared reasoning effort/u);
  }

  // The same records under one declared effort report normally.
  writeRecord(tasks[1], "max");
  const agreed = report();
  assert.equal(agreed.status, 0, agreed.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(root, "report.json"), "utf8")).provider.reasoningEffort,
    "max",
  );
});

test("the report discloses a task that exhausted its budget, including one that passed", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-report-budget-"));
  const results = join(root, "results");
  mkdirSync(results);
  const tasks = ["terminal-bench/passed-at-budget-edge", "terminal-bench/real-failure"];
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: {
        name: "frontier-harness-eval-v1",
        sourceCommit: config.source.sourceCommit,
        taskCount: 30,
      },
      gpuTasks: [],
      tasks: tasks.map((name) => ({ name, instructionSha256: `frozen-${name}` })),
    }),
  );
  const expectedPath = join(root, "expected.txt");
  writeFileSync(expectedPath, `${tasks.join("\n")}\n`);
  const writeRecord = (task, result) =>
    writeFileSync(
      join(results, `frontier-harness-results.${task.split("/").pop()}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: { name: task, suite: task.split("/")[0], instructionSha256: `frozen-${task}` },
        candidateId: "cli-synthetic",
        cliVersion: config.cli.cliVersion,
        cliBinarySha256: "a".repeat(64),
        candidateManifestSha256: "b".repeat(64),
        model: config.provider.model,
        batchId: "synthetic",
        durationMs: 941_000,
        reasoningEffort: config.provider.reasoningEffort,
        result,
        artifacts: {},
      }),
    );
  // The agent used its whole budget and the task still passed: the verifier grades the
  // delivered artifacts, so this is a passed verdict carrying a budget outcome.
  writeRecord(tasks[0], {
    disposition: "passed",
    rewards: { reward: 1 },
    exception: { type: "AgentTimeoutError", message: "Agent execution timed out after 900.0 seconds" },
  });
  // A genuine task failure that never came near its budget.
  writeRecord(tasks[1], { disposition: "failed", rewards: { reward: 0 } });

  const output = join(root, "report.json");
  const spawned = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/frontier-harness-report.mjs"),
      "--results",
      results,
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      expectedPath,
      "--output",
      output,
      "--formal",
    ],
    { encoding: "utf8" },
  );
  assert.equal(spawned.status, 0, spawned.stderr);

  const report = JSON.parse(readFileSync(output, "utf8"));
  // The verdict is untouched: the passed cell stays passed.
  assert.deepEqual(report.results, { passed: 1, failed: 1, error: 0, notEvaluated: 0 });
  // The budget outcome is named for every disposition, not only for failures.
  assert.deepEqual(report.budgetExhausted, {
    attempts: 1,
    passed: 1,
    tasks: [tasks[0]],
    passedTasks: [tasks[0]],
  });
  assert.equal(
    report.perTask.find((entry) => entry.task === tasks[0]).budgetExhausted,
    true,
  );
  assert.equal(
    report.perTask.find((entry) => entry.task === tasks[1]).budgetExhausted,
    false,
  );
  // A reader of the markdown sees both the per-task mark and the aggregate note.
  const markdown = readFileSync(`${output}.md`, "utf8");
  assert.match(markdown, /budget-exhausted attempts \| 1 \(1 still passed\)/u);
  assert.match(markdown, /\u23f1 budget-exhausted/u);
  assert.match(markdown, /can exhaust its budget and still pass/u);
});

test("a repaired reading replaces nothing in the record and counts every extra attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-repaired-"));
  const tasks = ["datacurve/one", "terminal-bench/two", "terminal-bench/three"];
  const recordPath = join(root, "record.json");
  writeFileSync(
    recordPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profileId: config.profileId,
        formalRunId: "formal-synthetic",
        coverage: { expected: 3, expectedEligible: 3, present: 3, missing: [] },
        results: { passed: 1, failed: 2, error: 0, notEvaluated: 0 },
        validCells: 3,
        passAt1: null,
        perTask: tasks.map((task, index) => ({
          task,
          disposition: index === 0 ? "passed" : "failed",
          rewards: index === 0 ? { reward: 1 } : { reward: 0 },
        })),
      },
      null,
      2,
    )}\n`,
  );
  const recordBytes = readFileSync(recordPath);
  const sha256 = createHash("sha256").update(recordBytes).digest("hex");
  const writeManifest = (name, body) => {
    const path = join(root, name);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "recheck",
          batchLabel: name.replace(".json", ""),
          sourceRun: { runId: "formal-synthetic", frozenRecordSha256: sha256 },
          ...body,
        },
        null,
        2,
      )}\n`,
    );
    return path;
  };
  const environmentRepair = writeManifest("recheck-environment.json", {
    kind: "recovery",
    outcome: {
      cells: [
        {
          task: tasks[1],
          disposition: "passed",
          rewards: { reward: 1 },
          durationMs: 1000,
          class: "pre-model-environment-failure",
        },
      ],
    },
  });
  const varianceRepair = writeManifest("recheck-variance.json", {
    outcome: {
      cells: [
        { task: tasks[2], disposition: "failed", class: "variance-check" },
      ],
    },
  });

  const output = join(root, "repaired.json");
  const run = (repairs, target = output) => {
    const spawned = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/frontier-harness-repaired-reading.mjs"),
        "--record",
        recordPath,
        ...repairs.flatMap((path) => ["--repairs", path]),
        "--output",
        target,
      ],
      { encoding: "utf8" },
    );
    return spawned;
  };

  const spawned = run([environmentRepair, varianceRepair]);
  assert.equal(spawned.status, 0, spawned.stderr);
  const reading = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(reading.recordKind, "repaired-reading");
  assert.equal(reading.official, undefined);
  // The record's own verdicts are restated, and only the admitted cells move.
  assert.deepEqual(reading.sourceRun.results, {
    passed: 1,
    failed: 2,
    error: 0,
    notEvaluated: 0,
  });
  assert.deepEqual(
    {
      passed: reading.repairedReading.passed,
      failed: reading.repairedReading.failed,
    },
    { passed: 2, failed: 1 },
  );
  assert.equal(reading.repairedReading.extraAttempts, 2);
  assert.equal(reading.repairedReading.passAt1, null, "a repaired reading is never a pass@1");
  // Both verdicts of a repaired cell are visible, so a reader can recompute the
  // reading from the record plus the named manifests.
  assert.deepEqual(
    reading.repairedReading.cells.map((cell) => [
      cell.task,
      cell.originalDisposition,
      cell.remediatedDisposition,
      cell.class,
    ]),
    [
      [tasks[1], "failed", "passed", "pre-model-environment-failure"],
      [tasks[2], "failed", "failed", "variance-check"],
    ],
  );
  // The record itself is untouched, byte for byte.
  assert.ok(readFileSync(recordPath).equals(recordBytes));

  // A manifest frozen for other numbers is refused instead of applied.
  const stale = writeManifest("recheck-stale.json", {
    sourceRun: { runId: "formal-synthetic", frozenRecordSha256: "0".repeat(64) },
    outcome: { cells: [{ task: tasks[1], disposition: "passed", class: "recovery" }] },
  });
  const refused = run([stale], join(root, "refused.json"));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not match the record/u);
  assert.equal(existsSync(join(root, "refused.json")), false);

  // A manifest without a re-measured verdict, a cell outside the record, and two
  // manifests claiming one cell are all refused.
  const empty = writeManifest("recheck-empty.json", { outcome: { cells: [] } });
  assert.notEqual(run([empty], join(root, "empty.json")).status, 0);
  const unknown = writeManifest("recheck-unknown.json", {
    outcome: { cells: [{ task: "datacurve/absent", disposition: "passed", class: "recovery" }] },
  });
  assert.notEqual(run([unknown], join(root, "unknown.json")).status, 0);
  const duplicate = writeManifest("recheck-duplicate.json", {
    outcome: { cells: [{ task: tasks[1], disposition: "passed", class: "recovery" }] },
  });
  const doubled = run([environmentRepair, duplicate], join(root, "doubled.json"));
  assert.notEqual(doubled.status, 0);
  assert.match(doubled.stderr, /at most one extra attempt/u);

  // The official mode publishes the run's official result beside the raw counts:
  // the repaired pass rate is the headline, the strict one-attempt pass@1 stays
  // null, and the same run can be read either way.
  const officialOutput = join(root, "official.json");
  const official = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/frontier-harness-repaired-reading.mjs"),
      "--record",
      recordPath,
      "--repairs",
      environmentRepair,
      "--repairs",
      varianceRepair,
      "--official",
      "--output",
      officialOutput,
    ],
    { encoding: "utf8" },
  );
  assert.equal(official.status, 0, official.stderr);
  const officialReading = JSON.parse(readFileSync(officialOutput, "utf8"));
  assert.equal(officialReading.recordKind, "official-repaired-reading");
  assert.equal(officialReading.official.metric, "repairedPassRate");
  assert.equal(officialReading.official.value, 2 / 3);
  assert.equal(officialReading.official.repairedCells, 2);
  assert.equal(officialReading.repairedReading.passAt1, null);
  assert.match(officialReading.official.label, /re-measured once each/u);
  const officialMarkdown = readFileSync(`${officialOutput}.md`, "utf8");
  assert.match(officialMarkdown, /official repaired reading/u);
  assert.match(officialMarkdown, /Official result: 66\.7% repaired pass rate/u);
});

test("an attempt's evidence is summarized from bytes, so a huge file cannot cost the record", async () => {
  const { summarizeAttemptEvidence, classifyTrialOutcomeOrDegrade } = await import(
    `../scripts/frontier-harness-harness.mjs?evidence-bytes=${Date.now()}`
  );
  const lines = [
    '{"type":"header","rootRunId":"[\\"run\\",1,1]","sequence":0}',
    '{"type":"model-outcome","resourceId":"[\\"run\\",1,1]","sequence":1}',
    '{"type":"model-failure","resourceId":"[\\"run\\",1,1]","failure":{"reason":"transport"},"sequence":2}',
    '{"type":"terminal-snapshot","resourceId":"[\\"run\\",1,1]","snapshot":{"terminalCause":"model-failure"},"sequence":3}',
  ];
  // An attempt's evidence file can outgrow the longest string V8 can hold (a 536 MiB
  // file did exactly that on 2026-10-02), so the record path hands the summarizer
  // bytes. Bytes and text are the same computation; only one of them can be too big.
  const byText = summarizeAttemptEvidence(lines.join("\n"));
  assert.deepEqual(summarizeAttemptEvidence(Buffer.from(lines.join("\n"), "utf8")), byText);
  assert.deepEqual(byText, {
    present: true,
    modelOutcomes: 1,
    terminalCause: "model-failure",
    modelFailureReasons: ["transport"],
  });
  // A classification that cannot read its evidence still produces a record: the
  // verdict degrades to inconclusive (kept out of the numerator) and names the error.
  const degraded = classifyTrialOutcomeOrDegrade({
    trialResult: {
      get verifier_result() {
        throw new Error("Cannot create a string longer than 0x1fffffe8 characters");
      },
    },
    evidenceText: Buffer.from("{}\n", "utf8"),
  });
  assert.equal(degraded.disposition, "inconclusive");
  assert.match(degraded.evidenceSummaryError, /Cannot create a string/u);
  const harnessSource = readFileSync(
    resolve(repoRoot, "scripts/frontier-harness-harness.mjs"),
    "utf8",
  );
  assert.match(harnessSource, /readFileSync\(evidencePath\)/u);
  assert.doesNotMatch(harnessSource, /readFileSync\(evidencePath, "utf8"\)/u);
});

test("a task environment's git identity comes from this host and is never empty", async () => {
  const { resolveGitIdentity } = await import(
    `../scripts/frontier-harness-harness.mjs?git-identity=${Date.now()}`
  );
  const keys = ["BEST_AGENT_GIT_IDENTITY_NAME", "BEST_AGENT_GIT_IDENTITY_EMAIL"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    // An explicit override is honoured, so a run can pin the identity it declares.
    process.env.BEST_AGENT_GIT_IDENTITY_NAME = "Override Agent";
    process.env.BEST_AGENT_GIT_IDENTITY_EMAIL = "override@example.invalid";
    assert.deepEqual(resolveGitIdentity(), {
      name: "Override Agent",
      email: "override@example.invalid",
    });
    // With no override it still resolves from this host, and never empty: a container that
    // ships no identity refuses a commit outright ("unable to auto-detect email address"),
    // which cost a real attempt a turn.
    delete process.env.BEST_AGENT_GIT_IDENTITY_NAME;
    delete process.env.BEST_AGENT_GIT_IDENTITY_EMAIL;
    const resolved = resolveGitIdentity();
    assert.ok(resolved.name.length > 0, "a name is always resolved");
    assert.ok(resolved.email.includes("@"), "an address is always resolved");
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
