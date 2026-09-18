import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
