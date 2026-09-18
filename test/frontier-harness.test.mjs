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

test("frontier-harness freezes the glm-5.3 max-effort provider profile", () => {
  assert.equal(config.provider.kind, "openai");
  assert.equal(config.provider.model, "glm-5.3");
  assert.equal(config.provider.compatibilityMode, "compatible");
  assert.equal(config.provider.reasoningEffort, "max");
  assert.equal(config.provider.transportProfile, "dim-oauth");
  assert.equal(config.provider.baseURL, "https://dimagent.cn/v1");
});

test("frontier-harness composition is headless, full-permission, and excludes unusable tools", () => {
  assert.deepEqual(config.generation.executionProfile, {
    source: "explicit-custom",
    workspaceBackend: "plain",
    workspaceAuthorization: "unrestricted",
    processIsolation: "host",
    commandPolicy: "path",
    workspaceGrants: ["read", "write", "exec"],
  });
  assert.deepEqual(config.generation.toolExclude, ["network"]);
  assert.equal(config.generation.defaultAgentTimeoutMultiplier, 1);
  assert.equal(config.workspace, "/app");
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
        reasoningEffort: "max",
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
