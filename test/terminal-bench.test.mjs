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
});

test("terminal-bench pins a Linux x64 CLI package", () => {
  assert.equal(config.cli.packageName, "@best-agent/cli-linux-x64-gnu");
  assert.match(config.cli.cliVersion, /^\d+\.\d+\.\d+[\w.-]*$/u);
  assert.match(config.cli.packageIntegrity, /^sha512-[A-Za-z0-9+/=]+$/u);
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

test("workflow pins harbor and never touches the SWE-bench workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/terminal-bench.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /harbor==0\.14\.0/u);
  assert.match(workflow, /terminal-bench-harness\.mjs/u);
  assert.match(workflow, /expected_list/u);
  const harness = readFileSync(
    new URL("../scripts/terminal-bench-harness.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    harness,
    /--agent-import-path",\s*"terminal_bench_best_agent:BestAgentCli"/u,
  );
  assert.match(harness, /"--cpus",\s*"ignore"/u);
  assert.match(harness, /"--memory",\s*"ignore"/u);
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
  assert.match(markdown, /verifier-failed/u);
  assert.match(markdown, /FAILED test_final_output/u);
});