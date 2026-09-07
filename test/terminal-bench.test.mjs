import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(new URL("../config/terminal-bench.json", import.meta.url), "utf8"),
);
const plan = JSON.parse(
  readFileSync(new URL("../config/terminal-bench-batches.json", import.meta.url), "utf8"),
);

test("terminal-bench config pins a real dataset record", () => {
  assert.equal(config.profileId, "terminal-bench-4.0-v4.0.0");
  assert.equal(config.dataset.name, "terminal-bench/terminal-bench");
  assert.equal(config.dataset.version, "4.0.0");
  assert.match(config.dataset.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.match(config.dataset.datasetTomlSha256, /^[0-9a-f]{64}$/u);
  assert.equal(config.dataset.taskCount, 66);
  assert.equal(config.generation.maxBatchTasks, 10);
  assert.ok(config.generation.maxBatchTasks <= 10);
  assert.equal(config.generation.maxModelCycles, Math.floor(Number.MAX_SAFE_INTEGER / 4));
  assert.ok(Number.isSafeInteger(config.generation.maxModelCycles * 4));
});

test("candidate preparation passes the frozen maximum budget and unrestricted profile to CLI", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "tb-budget-"));
  const environment = { ...process.env };
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  try {
    writeFileSync(join(dir, "best-agent-cli.tgz"), "fixture");
    writeFileSync(join(dir, "build-report.json"), "{}");
    writeFileSync(join(dir, "provider.json"), "{}");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "candidate.json"), JSON.stringify({
      schemaVersion: 1,
      packageName: config.cli.packageName,
      cliVersion: config.cli.cliVersion,
      sourceRepository: config.cli.sourceRepository,
      sourceCommit: config.cli.sourceCommit,
      target: config.cli.target,
      tarballSha256: hash("fixture"),
      buildReportSha256: hash("{}"),
      binarySha256: "1".repeat(64),
      lockfileSha256: "2".repeat(64),
      runtimeLockSha256: "3".repeat(64),
      nodeBinarySha256: "4".repeat(64),
      nodeVersion: "v24.15.0",
      runtimeDependencies: {},
    }));
    process.env.BEST_AGENT_CLI_CANDIDATE_DIR = dir;
    process.env.BEST_AGENT_PROVIDER_CONFIG = join(dir, "provider.json");
    process.env.DIMCODE_HOME = dir;
    process.env.BEST_AGENT_PROVIDER_MODEL = config.provider.model;
    const { verifyFrozenIdentity } = await import("../scripts/terminal-bench-harness.mjs");
    verifyFrozenIdentity();
    const args = JSON.parse(process.env.BEST_AGENT_CLI_EXECUTION_ARGS_JSON);
    assert.equal(args.filter((arg) => arg === "--max-model-cycles").length, 1);
    assert.equal(args[args.indexOf("--max-model-cycles") + 1], String(config.generation.maxModelCycles));
    for (const [option, value] of [["--workspace-backend", "plain"], ["--workspace-authorization", "unrestricted"], ["--process-isolation", "host"], ["--command-policy", "path"]]) {
      assert.equal(args[args.indexOf(option) + 1], value);
    }
    assert.deepEqual(args.flatMap((arg, index) => arg === "--workspace-grant" ? [args[index + 1]] : []), ["read", "write", "exec"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal-bench pins a current Linux x64 source candidate", () => {
  assert.equal(config.cli.packageName, "@best-agent/cli-linux-x64-gnu");
  assert.match(config.cli.cliVersion, /^\d+\.\d+\.\d+[\w.-]*$/u);
  assert.equal(config.cli.sourceRepository, "Simon-He95/best-agent");
  assert.match(config.cli.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(config.cli.target, "linux-x64-gnu");
  assert.deepEqual(config.generation.executionProfile, {
    source: "explicit-custom",
    workspaceBackend: "plain",
    workspaceAuthorization: "unrestricted",
    processIsolation: "host",
    commandPolicy: "path",
    workspaceGrants: ["read", "write", "exec"],
  });
  assert.equal(config.provider.model, "deepseek-v4-flash");
  assert.equal(config.provider.transportProfile, "dim-oauth");
});

test("terminal-bench GPU classification is frozen and disjoint from the plan", () => {
  assert.deepEqual(config.gpuTasks, [
    "terminal-bench/fp8-rmsnorm-gemm",
    "terminal-bench/jax-speedrun-gpu",
    "terminal-bench/math-eval-grader",
  ]);
  const planned = new Set(plan.batches.flatMap((batch) => batch.tasks));
  for (const gpuTask of config.gpuTasks) {
    assert.ok(!planned.has(gpuTask), `${gpuTask} must not enter the Docker plan`);
  }
  assert.ok(config.resourceExceededTasks.length > 0);
});

test("terminal-bench batch plan exact-covers the Docker-eligible corpus in order", () => {
  assert.equal(plan.profileId, config.profileId);
  assert.equal(plan.datasetCommit, config.dataset.sourceCommit);
  assert.equal(plan.cliVersion, config.cli.cliVersion);
  const tasks = plan.batches.flatMap((batch) => batch.tasks);
  assert.equal(tasks.length, plan.taskCount);
  assert.equal(plan.taskCount, config.dataset.taskCount - config.gpuTasks.length);
  assert.equal(new Set(tasks).size, tasks.length, "task ids must be unique");
  for (const batch of plan.batches) {
    assert.ok(batch.tasks.length >= 1 && batch.tasks.length <= plan.maxBatchSize);
    assert.match(batch.id, /^[a-zA-Z0-9._-]+$/u);
  }
  assert.equal(plan.maxBatchSize, 10);
  for (const task of tasks) {
    assert.match(task, /^terminal-bench\/[a-z0-9-]+$/u);
  }
});

test("harness rejects unknown arguments", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/terminal-bench-harness.mjs"), "--bogus-flag"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument/u);
});

test("harness fails closed when the current candidate identity mismatches", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const candidateDir = mkdtempSync(join(tmpdir(), "tb-candidate-"));
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
      runtimeLockSha256: "0".repeat(64),
      runtimeDependencies: {},
    }),
  );
  const previous = process.env.BEST_AGENT_CLI_CANDIDATE_DIR;
  process.env.BEST_AGENT_CLI_CANDIDATE_DIR = candidateDir;
  try {
    const { verifyFrozenIdentity } = await import(
      `../scripts/terminal-bench-harness.mjs?candidate=${Date.now()}`
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

test("report rejects a missing expected list", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      "/nonexistent",
      "--corpus",
      "/nonexistent",
      "--expected-tasks",
      "/nonexistent",
      "--output",
      "/nonexistent",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected-tasks list is empty|Cannot read|ENOENT/u);
});

test("diagnostic pass rate keeps missing expected tasks in the denominator", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "tb-report-"));
  const results = join(root, "results");
  mkdirSync(results);
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: config.dataset,
      gpuTasks: [],
      tasks: [
        { name: "terminal-bench/one" },
        { name: "terminal-bench/two" },
      ],
    }),
  );
  writeFileSync(
    join(root, "expected.txt"),
    "terminal-bench/one\nterminal-bench/two\n",
  );
  writeFileSync(
    join(results, "terminal-bench-results.one.json"),
    JSON.stringify({
      task: { name: "terminal-bench/one" },
      result: { disposition: "passed" },
      evidenceAdmission: { prefixValid: true, complete: true, reason: "complete" },
      artifacts: {},
    }),
  );
  const output = join(root, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      results,
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      join(root, "expected.txt"),
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.coverage.present, 1);
  assert.equal(report.coverage.missing.length, 1);
  assert.equal(report.passRate, 0.5);
  assert.equal(report.passAt1, null);

  writeFileSync(join(root, "expected.txt"), "terminal-bench/one\n");
  const subsetOutput = join(root, "formal-subset.json");
  const subset = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      results,
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      join(root, "expected.txt"),
      "--output",
      subsetOutput,
      "--formal",
    ],
    { encoding: "utf8" },
  );
  assert.equal(subset.status, 0, subset.stderr);
  const subsetReport = JSON.parse(readFileSync(subsetOutput, "utf8"));
  assert.equal(subsetReport.coverage.fullExpected, false);
  assert.equal(subsetReport.passAt1, null);
});

test("formal report keeps passAt1 null when all expected results are missing", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "tb-empty-report-"));
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: config.dataset,
      gpuTasks: [],
      tasks: [
        { name: "terminal-bench/one" },
        { name: "terminal-bench/two" },
      ],
    }),
  );
  writeFileSync(join(root, "expected.txt"), "terminal-bench/one\nterminal-bench/two\n");
  const output = join(root, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      join(root, "missing-results"),
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      join(root, "expected.txt"),
      "--output",
      output,
      "--formal",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.coverage.present, 0);
  assert.equal(report.coverage.missing.length, 2);
  assert.equal(report.passRate, 0);
  assert.equal(report.passAt1, null);
});

test("formal report keeps passAt1 null when a present task has an error", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "tb-error-report-"));
  const results = join(root, "results");
  mkdirSync(results);
  writeFileSync(
    join(root, "corpus.json"),
    JSON.stringify({
      profileId: config.profileId,
      dataset: config.dataset,
      gpuTasks: [],
      tasks: [{ name: "terminal-bench/one" }],
    }),
  );
  writeFileSync(join(root, "expected.txt"), "terminal-bench/one\n");
  writeFileSync(
    join(results, "terminal-bench-results.one.json"),
    JSON.stringify({
      task: { name: "terminal-bench/one" },
      result: {
        disposition: "error",
        rewards: { reward: 0 },
        exception: { type: "AgentTimeoutError", message: "timed out" },
      },
      evidenceAdmission: { prefixValid: true, complete: true, reason: "complete" },
      artifacts: {},
    }),
  );
  const output = join(root, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      results,
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      join(root, "expected.txt"),
      "--output",
      output,
      "--formal",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.coverage.present, 1);
  assert.equal(report.results.error, 1);
  assert.equal(report.passAt1, null);

  writeFileSync(
    join(results, "terminal-bench-results.one.json"),
    JSON.stringify({
      task: { name: "terminal-bench/one" },
      result: { disposition: "passed", rewards: { reward: 1 } },
      evidenceAdmission: {
        prefixValid: true,
        complete: false,
        reason: "incomplete-footer",
      },
      artifacts: {},
    }),
  );
  const incompleteOutput = join(root, "incomplete-report.json");
  const incomplete = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-report.mjs"),
      "--results",
      results,
      "--corpus",
      join(root, "corpus.json"),
      "--expected-tasks",
      join(root, "expected.txt"),
      "--output",
      incompleteOutput,
      "--formal",
    ],
    { encoding: "utf8" },
  );
  assert.equal(incomplete.status, 0, incomplete.stderr);
  const incompleteReport = JSON.parse(readFileSync(incompleteOutput, "utf8"));
  assert.equal(incompleteReport.passRate, 1);
  assert.equal(incompleteReport.passAt1, null);
  assert.deepEqual(incompleteReport.coverage.incompleteEvidence, ["terminal-bench/one"]);
});

test("trial projection preserves exception and verifier rewards without scoring the error", async () => {
  const { projectTrialResult } = await import(
    `../scripts/terminal-bench-harness.mjs?projection=${Date.now()}`
  );
  assert.deepEqual(
    projectTrialResult({
      exception_info: {
        exception_type: "AgentTimeoutError",
        exception_message: "agent timed out after 5400 seconds",
      },
      verifier_result: { rewards: { reward: 0 } },
    }),
    {
      disposition: "error",
      rewardValues: { reward: 0 },
      exception: {
        type: "AgentTimeoutError",
        message: "agent timed out after 5400 seconds",
      },
    },
  );
  assert.deepEqual(
    projectTrialResult({ verifier_result: { rewards: { reward: 1, detail: 0 } } }),
    {
      disposition: "passed",
      rewardValues: { reward: 1, detail: 0 },
      exception: undefined,
    },
  );
  assert.deepEqual(
    projectTrialResult({ verifier_result: { rewards: { reward: 0, detail: 1 } } }),
    {
      disposition: "failed",
      rewardValues: { reward: 0, detail: 1 },
      exception: undefined,
    },
  );
  assert.deepEqual(
    projectTrialResult({ verifier_result: { rewards: { reward: "1" } } }),
    {
      disposition: "inconclusive",
      rewardValues: { reward: "1" },
      exception: undefined,
    },
  );
});

test("workflow pins harbor and never touches the SWE-bench workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/terminal-bench.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /harbor==0\.14\.0/u);
  assert.match(workflow, /terminal-bench-harness\.mjs/u);
  assert.match(workflow, /expected_list/u);
  assert.match(workflow, /Freeze current Linux candidate/u);
  assert.match(workflow, /terminal-bench-candidate-/u);
  assert.match(workflow, /secrets\.BEST_AGENT_SOURCE_TOKEN/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /eligible\.slice\(offset, offset \+ count\)/u);
  assert.match(workflow, /binarySha256/u);
  assert.match(workflow, /runtimeLockSha256/u);
  assert.match(workflow, /npm install --prefix \.tmp\/npm\/release-stage\/linux-x64-gnu/u);
  assert.match(
    workflow,
    /Validate Terminal-Bench contracts[\s\S]+node --test test\/terminal-bench\.test\.mjs/u,
  );
  assert.doesNotMatch(workflow, /tb_model|MODEL_OVERRIDE|Resolve effective model/u);
  assert.match(
    workflow,
    /materialize-ci-provider\.mjs[^\n]+config\/terminal-bench\.json/u,
  );
  const harness = readFileSync(
    new URL("../scripts/terminal-bench-harness.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    harness,
    /"--agent-import-path",\s*"terminal_bench_best_agent:BestAgentCli"/u,
  );
  assert.doesNotMatch(harness, /host_agent|host-darwin|agentMode/u);
  assert.match(harness, /BEST_AGENT_CLI_CANDIDATE_DIR is required/u);
  assert.match(harness, /stderrSha256/u);
  assert.match(harness, /delete harborEnv\.BENCHMARK_PROVIDER_API_KEY/u);
  const agent = readFileSync(
    new URL(
      "../tools/terminal-bench-agent/terminal_bench_best_agent/__init__.py",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(harness, /BEST_AGENT_CLI_EXECUTION_ARGS_JSON/u);
  assert.match(harness, /inspectAttemptEvidence\(evidencePath\)/u);
  assert.match(harness, /BEST_AGENT_CLI_WORKSPACE = config\.workspace/u);
  assert.match(agent, /BEST_AGENT_CLI_EXECUTION_ARGS_JSON/u);
  assert.match(agent, /BEST_AGENT_CLI_WORKSPACE/u);
  assert.doesNotMatch(agent, /--workspace-backend|--workspace-authorization|--process-isolation/u);
  assert.doesNotMatch(agent, /cd \/app/u);
  assert.doesNotMatch(agent, /apt-get[^\n]+\|\| true/u);
  assert.doesNotMatch(agent, /get_version_command|2>\/dev\/null|\|\| true/u);
  const setupStrict = agent.indexOf('"set -e"');
  const providerSetup = agent.indexOf(
    'await self._prepare_provider(environment)',
  );
  const attemptRelaxed = agent.indexOf('"set +e"');
  const cliAttempt = agent.indexOf("best-agent\" run");
  const receiptStrict = agent.indexOf('"set -e"', setupStrict + 1);
  assert.ok(
    providerSetup >= 0 &&
      providerSetup < setupStrict &&
      setupStrict < attemptRelaxed &&
      attemptRelaxed < cliAttempt &&
      cliAttempt < receiptStrict,
    "setup must fail closed; only the single CLI attempt may return non-zero before its receipt",
  );
  const failureAnalysis = readFileSync(
    new URL("../scripts/terminal-bench-failures.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(failureAnalysis, /skip unparsable|catch \{\s*\/\/ skip/u);
  assert.doesNotMatch(agent, /ua-proxy|CLIENT_SYSTEM_PROMPT|docker cp/u);
  assert.doesNotMatch(agent, /base64|BEST_AGENT_PROVIDER_API_KEY/u);
  assert.match(agent, /upload_file\(str\(source\), target\)/u);
  assert.match(agent, /chmod 600/u);
  assert.match(agent, /CLI_NODE_SHA256/u);
  assert.match(agent, /best-agent-stdout\.txt/iu);
  assert.match(agent, /best-agent-stderr\.txt/iu);
  assert.match(harness, /"--cpus",\s*"ignore"/u);
  assert.match(harness, /"--memory",\s*"ignore"/u);
  const installer = readFileSync(
    new URL(
      "../tools/terminal-bench-agent/terminal_bench_best_agent/install-cli.sh",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(installer, /CLI_RUNTIME_LOCK_SHA256/u);
  assert.doesNotMatch(installer, /npm install|nvm install|curl -fsSL/u);
  const bench = readFileSync(
    new URL("../.github/workflows/bench.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/terminal-bench|harbor/u.test(bench),
    "the SWE-bench workflow must remain untouched",
  );
});

test("batch plan math is consistent", () => {
  assert.equal(plan.batchCount, Math.ceil(plan.taskCount / plan.maxBatchSize));
  const last = plan.batches[plan.batches.length - 1];
  assert.ok(last.tasks.length === plan.taskCount % plan.maxBatchSize || plan.taskCount % plan.maxBatchSize === 0);
});

test("failure analysis classifies stages and emits per-task details", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "tb-fail-"));
  const resultsDir = join(base, "results");
  const jobsDir = join(base, "jobs", "foo", "job-1", "foo__abc", "verifier");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(join(base, "jobs", "foo", "job-1", "foo__abc", "agent"), { recursive: true });
  writeFileSync(
    join(resultsDir, "terminal-bench-results.foo.json"),
    JSON.stringify({
      task: { name: "terminal-bench/foo" },
      jobName: "job-1",
      result: { disposition: "failed", rewards: { reward: 0 } },
      effectiveAgentTimeoutSec: 5400,
      durationMs: 1000,
    }),
  );
  writeFileSync(
    join(base, "jobs", "foo", "job-1", "foo__abc", "verifier", "test-stdout.txt"),
    "FAILED test_final_output",
  );
  writeFileSync(
    join(base, "jobs", "foo", "job-1", "foo__abc", "result.json"),
    "{}",
  );
  writeFileSync(
    join(base, "jobs", "foo", "job-1", "foo__abc", "agent", "best-agent-evidence.jsonl"),
    JSON.stringify({
      type: "terminal-snapshot",
      sequence: 3,
      snapshot: { terminalCause: "completed", transcript: [] },
    }) + "\n",
  );
  const output = join(base, "failures.md");
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-failures.mjs"),
      "--results",
      resultsDir,
      "--jobs",
      join(base, "jobs"),
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const markdown = readFileSync(output, "utf8");
  assert.match(markdown, /— model/u);
  assert.match(markdown, /FAILED test_final_output/u);

  writeFileSync(
    join(base, "jobs", "foo", "job-1", "foo__abc", "agent", "best-agent-evidence.jsonl"),
    "{not-json}\n",
  );
  const corrupt = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/terminal-bench-failures.mjs"),
      "--results",
      resultsDir,
      "--jobs",
      join(base, "jobs"),
      "--output",
      join(base, "corrupt.md"),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /SyntaxError|JSON/u);
});
