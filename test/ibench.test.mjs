import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aggregateReports, frozenTaskIds, renderAggregateMarkdown } from "../scripts/ibench-aggregate.mjs";
import {
  computeReport,
  materializeProvider,
  parseArgs,
  pickScorer,
  renderReportMarkdown,
  selectTasks,
  verifyFileSha256,
} from "../scripts/ibench-run.mjs";

const RELEASE = {
  repository: "https://github.com/eval-sys/ibench",
  commit: "24b0613a5b79b5e70b5c902c4d64c77e58ec0102",
  releaseManifestSha256: "e7c351ff85a097aeb9068ca9c8c80157e1f51244e842fc1c16f3a7ad01f9073e",
  taskCount: 3,
  instructionProfile: "intent",
};
const PROFILE = {
  release: RELEASE,
  solver: { harness: "best-agent-cli", label: "best-agent-cli / deepseek-v4-flash / high", config: "solver.json" },
  scorer: {
    official: { harness: "codex", label: "codex / deepseek-flash / high", config: "scorer-official.json", requires: ["DEEPSEEK_API_KEY"] },
    fallback: { harness: "best-agent-cli", label: "best-agent-cli / deepseek-v4-flash / high", config: "scorer.json" },
  },
  provider: {
    kind: "openai",
    model: "deepseek-v4-flash",
    baseURL: "https://dimagent.cn/v1",
    compatibilityMode: "compatible",
    reasoningEffort: "high",
    transportProfile: "dim-oauth",
  },
  baseline: { harness: "DSH", model: "DeepSeek Flash", modelId: "deepseek-flash", baseURL: "https://api.deepseek.com", effort: "high", passed: 7, total: 44, passRate: 7 / 44, source: "ibench" },
};
const TASKS = [
  { id: "task-a", name: "alpha" },
  { id: "task-b", name: "beta" },
  { id: "task-c", name: "gamma" },
];

function signedJwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

test("selectTasks predeclares every released task by default", () => {
  assert.deepEqual(selectTasks(TASKS, {}).map((task) => task.id), ["task-a", "task-b", "task-c"]);
});

test("selectTasks resolves names and rejects unknown or duplicated selections", () => {
  assert.deepEqual(selectTasks(TASKS, { taskIds: "beta" }).map((task) => task.id), ["task-b"]);
  assert.deepEqual(selectTasks(TASKS, { taskIds: "task-c,alpha" }).map((task) => task.id), ["task-c", "task-a"]);
  assert.throws(() => selectTasks(TASKS, { taskIds: "beta,task-b" }), /twice/u);
  assert.throws(() => selectTasks(TASKS, { taskIds: "nope" }), /unknown/u);
});

test("selectTasks applies offset, shard and limit over release order", () => {
  assert.deepEqual(selectTasks(TASKS, { offset: 1 }).map((task) => task.id), ["task-b", "task-c"]);
  assert.deepEqual(selectTasks(TASKS, { shard: 1, shardTotal: 2 }).map((task) => task.id), ["task-b"]);
  assert.deepEqual(selectTasks(TASKS, { limit: 2 }).map((task) => task.id), ["task-a", "task-b"]);
  assert.throws(() => selectTasks(TASKS, { limit: 0 }), /positive/u);
});

test("parseArgs keeps re-grading separate from solving", () => {
  const parsed = parseArgs(["--score-only", "--output", "results/ibench/b01", "--score-config", "scorer.json"]);
  assert.equal(parsed.scoreOnly, true);
  assert.equal(parsed.solverOnly, false);
  assert.match(parsed.output, /results\/ibench\/b01$/u);
  // A run cannot be solved and re-graded by the same invocation.
  assert.throws(() => parseArgs(["--score-only", "--solver-only"]), /opposite ends/u);
  assert.throws(() => parseArgs(["--score-only", "--dry-run"]), /no plan to print/u);
});

test("pickScorer never silently replaces the published judge", () => {
  assert.throws(() => pickScorer(PROFILE, undefined, { environment: {} }), /requires DEEPSEEK_API_KEY/u);
  assert.equal(pickScorer(PROFILE, undefined, { environment: {}, solverOnly: true }).official, true);
  assert.equal(pickScorer(PROFILE, undefined, { environment: {}, dryRun: true }).official, true);
  assert.equal(pickScorer(PROFILE, undefined, { environment: { DEEPSEEK_API_KEY: "synthetic" } }).official, true);
  assert.equal(pickScorer(PROFILE, "diagnostic.json", { environment: {} }).official, false);
});

test("the CI matrix enforces the frozen batch size before dispatch", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ibench.yml", import.meta.url), "utf8");
  const script = workflow.split('node <<\'NODE\' >> "$GITHUB_OUTPUT"\n')[1].split("          NODE")[0];
  const batches = JSON.parse(readFileSync(new URL("../config/ibench-batches.json", import.meta.url), "utf8"));
  const run = (tasks, concurrency = "2") => spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TASKS: tasks, BATCHES: "0", CONCURRENCY: concurrency },
    encoding: "utf8",
  });
  const full = run("");
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /complete=true/u);
  const custom = run(batches.batches[4].tasks.join(","));
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /complete=false/u);
  assert.match(run(batches.batches.flatMap((batch) => batch.tasks).slice(0, 5).join(",")).stderr, /exceeds the frozen/u);
  for (const value of ["0", "-1", "NaN", "5", "1.5"]) {
    const invalid = run("", value);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /ibench_concurrency/u);
  }
});

test("verifyFileSha256 accepts exact bytes and rejects a different manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "ibench-hash-"));
  try {
    const path = join(directory, "release.json");
    writeFileSync(path, '{"tasks":[]}\n');
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(verifyFileSha256(path, digest), digest);
    assert.throws(() => verifyFileSha256(path, "0".repeat(64)), /hash mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("computeReport counts only reward 1 as a pass and keeps every declared task", () => {
  const tasks = TASKS;
  const report = computeReport({
    profile: { ...PROFILE, release: { ...RELEASE, taskCount: 44 } },
    release: { ...RELEASE, taskCount: 44 },
    tasks,
    trials: [
      { task_id: "task-a", status: "scored", rewards: { reward: 1 }, verdicts: [{ path: "x" }] },
      { task_id: "task-b", status: "scored", rewards: { reward: 0 }, verdicts: [{ path: "y" }] },
      { task_id: "task-c", status: "failed", error: "solver produced an empty patch" },
    ],
    run: { solverOnly: false },
    context: { runId: "run-1", scorer: { ...PROFILE.scorer.official, official: true } },
  });
  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.passRate, 1 / 3);
  assert.equal(report.tasks.find((row) => row.id === "task-c").status, "failed");
  assert.equal(report.tasks.find((row) => row.id === "task-c").reward, null);
  assert.equal(report.comparableToPublishedLeaderboard, false, "3 of 44 tasks is a subset");
});

test("computeReport is leaderboard-comparable only for the full official composition", () => {
  const fullTasks = Array.from({ length: 44 }, (_, index) => ({ id: `task-${index}`, name: `name-${index}` }));
  const trials = fullTasks.map((task) => ({ task_id: task.id, status: "scored", rewards: { reward: 0 } }));
  const base = {
    profile: PROFILE,
    release: { ...RELEASE, taskCount: 44 },
    tasks: fullTasks,
    trials,
    run: { solverOnly: false },
  };
  const nonOfficial = computeReport({
    ...base,
    context: { runId: "run-2", scorer: { ...PROFILE.scorer.fallback, official: false } },
  });
  assert.equal(nonOfficial.comparableToPublishedLeaderboard, false);
  const official = computeReport({
    ...base,
    context: { runId: "run-3", scorer: { ...PROFILE.scorer.official, official: true } },
  });
  assert.equal(official.comparableToPublishedLeaderboard, false, "gateway model aliases are not verified as equivalent");
  const matched = computeReport({
    ...base,
    profile: { ...PROFILE, provider: { ...PROFILE.provider, model: PROFILE.baseline.modelId, baseURL: PROFILE.baseline.baseURL } },
    context: { runId: "run-matched", scorer: { ...PROFILE.scorer.official, official: true } },
  });
  assert.equal(matched.comparableToPublishedLeaderboard, true);
  const solverOnly = computeReport({
    ...base,
    run: { solverOnly: true },
    context: { runId: "run-4", scorer: { ...PROFILE.scorer.official, official: true } },
  });
  assert.equal(solverOnly.comparableToPublishedLeaderboard, false);
  assert.equal(solverOnly.passRate, null, "a solver-only run has no verdict to rate yet");
  assert.match(renderReportMarkdown(solverOnly), /deferred/u);
  assert.match(renderReportMarkdown(official), /0\.0%/u);
});

test("materializeProvider writes the CLI identity files and rejects an expired token", () => {
  const directory = mkdtempSync(join(tmpdir(), "ibench-provider-"));
  try {
    const token = signedJwt(Math.floor(Date.now() / 1000) + 3600);
    const materialized = materializeProvider({
      profile: PROFILE.provider,
      directory,
      token,
      credentialRef: "benchmark-ci-dim-oauth",
    });
    const provider = JSON.parse(readFileSync(materialized.providerConfig, "utf8"));
    assert.equal(provider.model, "deepseek-v4-flash");
    assert.equal(provider.reasoningEffort, "high");
    assert.equal(provider.transportProfile, "dim-oauth");
    assert.equal(provider.credentialRef, "benchmark-ci-dim-oauth");
    const auth = JSON.parse(readFileSync(join(materialized.dimcodeHome, "dimcode", "auth.json"), "utf8"));
    assert.equal(auth.nextApiOauth.access, token);
    assert.equal(statSync(materialized.providerConfig).mode & 0o777, 0o600);
    assert.throws(
      () =>
        materializeProvider({
          profile: PROFILE.provider,
          directory: join(directory, "expired"),
          token: signedJwt(Math.floor(Date.now() / 1000) - 60),
        }),
      /expired/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function batchReport({ runId, rows, scorerIsOfficial = false, solverOnly = false }) {
  return {
    schemaVersion: 1,
    benchmark: "ibench",
    runId,
    release: {
      repository: RELEASE.repository,
      commit: RELEASE.commit,
      manifestSha256: RELEASE.releaseManifestSha256,
      taskCount: RELEASE.taskCount,
    },
    candidate: {
      harness: PROFILE.solver.harness,
      label: PROFILE.solver.label,
      solverConfig: PROFILE.solver.config,
      scorerHarness: "best-agent-cli",
      scorerLabel: "scorer",
      scorerConfig: "scorer.json",
      scorerIsOfficial,
    },
    provider: { model: PROFILE.provider.model, reasoningEffort: "high", baseURL: PROFILE.provider.baseURL },
    instructionProfile: "intent",
    solverOnly,
    tasks: rows,
  };
}

test("aggregateReports merges disjoint batches into one frozen reading", () => {
  const batches = { taskCount: 3, maxBatchSize: 2, batches: [{ id: "b1", tasks: ["task-a", "task-b"] }, { id: "b2", tasks: ["task-c"] }] };
  assert.deepEqual(frozenTaskIds(batches), ["task-a", "task-b", "task-c"]);
  const report = aggregateReports({
    reports: [
      batchReport({ runId: "b1", rows: [
        { id: "task-a", status: "scored", passed: true, reward: 1 },
        { id: "task-b", status: "scored", passed: false, reward: 0 },
      ] }),
      batchReport({ runId: "b2", rows: [{ id: "task-c", status: "scored", passed: true, reward: 1 }] }),
    ],
    batches,
    profile: { ...PROFILE, release: { ...RELEASE, taskCount: 3 } },
    runId: "aggregate",
  });
  assert.equal(report.passed, 2);
  assert.equal(report.total, 3);
  assert.equal(report.partial, false);
  assert.equal(report.comparableToPublishedLeaderboard, false, "non-official scorer");
});

test("aggregateReports refuses duplicates, foreign tasks and incomplete coverage", () => {
  const batches = { taskCount: 2, maxBatchSize: 1, batches: [{ id: "b1", tasks: ["task-a"] }, { id: "b2", tasks: ["task-b"] }] };
  const a = batchReport({ runId: "b1", rows: [{ id: "task-a", status: "scored", passed: true, reward: 1 }] });
  const b = batchReport({ runId: "b2", rows: [{ id: "task-b", status: "scored", passed: false, reward: 0 }] });
  assert.throws(
    () => aggregateReports({ reports: [a, { ...b, tasks: [{ id: "task-a", status: "scored", passed: true, reward: 1 }] }], batches, profile: PROFILE, runId: "x" }),
    /more than one batch/u,
  );
  assert.throws(
    () => aggregateReports({ reports: [a, { ...b, tasks: [{ id: "task-z", status: "scored", passed: true, reward: 1 }] }], batches, profile: PROFILE, runId: "x" }),
    /unfrozen task/u,
  );
  assert.throws(
    () => aggregateReports({ reports: [a], batches, profile: PROFILE, runId: "x" }),
    /do not cover/u,
  );
  const partial = aggregateReports({ reports: [a], batches, profile: PROFILE, runId: "x", allowPartial: true });
  assert.equal(partial.partial, true);
  assert.equal(partial.total, 1);
});

test("aggregateReports rejects a batch produced by a different composition", () => {
  const batches = { taskCount: 2, maxBatchSize: 1, batches: [{ id: "b1", tasks: ["task-a"] }, { id: "b2", tasks: ["task-b"] }] };
  const a = batchReport({ runId: "b1", rows: [{ id: "task-a", status: "scored", passed: true, reward: 1 }] });
  const b = batchReport({ runId: "b2", rows: [{ id: "task-b", status: "scored", passed: false, reward: 0 }] });
  const changed = { ...b, provider: { ...b.provider, reasoningEffort: "max" } };
  assert.throws(() => aggregateReports({ reports: [a, changed], batches, profile: PROFILE, runId: "x" }), /same frozen composition/u);
  const foreignRelease = [a, b].map((report) => ({ ...report, release: { ...report.release, commit: "foreign" } }));
  assert.throws(() => aggregateReports({ reports: foreignRelease, batches, profile: PROFILE, runId: "x" }), /pinned release/u);
  assert.throws(() => aggregateReports({ reports: [a, { ...b, candidate: { ...b.candidate, scorerIsOfficial: true } }], batches, profile: PROFILE, runId: "x" }), /same frozen composition/u);
});

test("aggregateReports requires the baseline model endpoint and effort even with the official judge", () => {
  const batches = { taskCount: 2, maxBatchSize: 1, batches: [{ id: "b1", tasks: ["task-a"] }, { id: "b2", tasks: ["task-b"] }] };
  const profile = { ...PROFILE, release: { ...RELEASE, taskCount: 2 } };
  const reports = ["task-a", "task-b"].map((id) => batchReport({ runId: id, scorerIsOfficial: true, rows: [{ id, status: "scored", passed: false, reward: 0 }] }));
  assert.equal(aggregateReports({ reports, batches, profile, runId: "gateway" }).comparableToPublishedLeaderboard, false);
  for (const report of reports) {
    report.provider = { ...report.provider, model: PROFILE.baseline.modelId, baseURL: PROFILE.baseline.baseURL };
  }
  assert.equal(aggregateReports({ reports, batches, profile, runId: "official" }).comparableToPublishedLeaderboard, true);
  for (const report of reports) report.provider.reasoningEffort = "low";
  assert.equal(aggregateReports({ reports, batches, profile, runId: "effort" }).comparableToPublishedLeaderboard, false);
});

test("aggregateReports reports a deferred rate for solver-only batches", () => {
  const batches = { taskCount: 2, maxBatchSize: 1, batches: [{ id: "b1", tasks: ["task-a"] }, { id: "b2", tasks: ["task-b"] }] };
  const reports = [
    batchReport({ runId: "b1", solverOnly: true, rows: [{ id: "task-a", status: "solved", passed: false, reward: null }] }),
    batchReport({ runId: "b2", solverOnly: true, rows: [{ id: "task-b", status: "solved", passed: false, reward: null }] }),
  ];
  const report = aggregateReports({ reports, batches, profile: { ...PROFILE, release: { ...RELEASE, taskCount: 2 } }, runId: "solver-only" });
  assert.equal(report.passRate, null);
  assert.equal(report.comparableToPublishedLeaderboard, false);
  const markdown = renderAggregateMarkdown(report);
  assert.match(markdown, /deferred \(0\/2 seen\)/u);
  assert.doesNotMatch(markdown, /NaN/u);
});

test("score-only preserves source evidence and identity without solver credentials or calls", () => {
  for (const scoreExit of [0, 7]) {
    const directory = mkdtempSync(join(tmpdir(), "ibench-score-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "run");
      const bin = join(directory, "bin");
      mkdirSync(join(source, "tasks"), { recursive: true });
      mkdirSync(join(output, "jobs/score"), { recursive: true });
      mkdirSync(join(output, "jobs/solve"), { recursive: true });
      mkdirSync(bin);
      const manifest = JSON.stringify({ tasks: TASKS });
      writeFileSync(join(source, "tasks/release.json"), manifest);
      for (const args of [
        ["init", source],
        ["-C", source, "add", "."],
        ["-C", source, "-c", "user.name=test", "-c", "user.email=test@invalid", "commit", "-m", "fixture"],
        ["-C", source, "remote", "add", "origin", source],
      ]) {
        const result = spawnSync("git", args, { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const commit = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const profile = {
        ...PROFILE,
        schemaVersion: 1,
        benchmark: "ibench",
        release: { ...RELEASE, commit, releaseManifest: "tasks/release.json", releaseManifestSha256: createHash("sha256").update(manifest).digest("hex") },
        limits: { nConcurrent: 1 },
      };
      const config = join(directory, "profile.json");
      writeFileSync(config, JSON.stringify(profile));
      const previous = batchReport({ runId: "original-run", rows: TASKS.map((task) => ({ ...task, passed: false, reward: null })) });
      previous.release.commit = commit;
      previous.release.manifestSha256 = profile.release.releaseManifestSha256;
      previous.candidate.label = "original-cli-version";
      previous.provider.model = "original-model";
      previous.instructionProfile = "intent-actions";
      const originalReport = JSON.stringify(previous);
      const originalResults = JSON.stringify({ error: "source-scorer-fault", trials: [] });
      writeFileSync(join(output, "run.json"), '{"original":"run"}');
      writeFileSync(join(output, "ibench-report.json"), originalReport);
      writeFileSync(join(output, "results.json"), originalResults);
      writeFileSync(join(output, "jobs/score/source-error.txt"), "source-scorer-fault");
      writeFileSync(join(output, "jobs/solve/candidate.patch"), "frozen patch");
      writeFileSync(join(bin, "uv"), `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.UV_CALL_LOG, JSON.stringify(args) + "\\n");
if (args.slice(0, 4).join(" ") !== "run --no-sync ibench score") process.exit(99);
const output = args[4];
writeFileSync(join(output, "results.json"), JSON.stringify({
  success: ${scoreExit === 0}, phase: "completed", error: ${scoreExit === 0 ? "null" : '"controlled score source failure"'},
  trials: ${JSON.stringify(TASKS.map((task) => ({ task_id: task.id, status: "scored", rewards: { reward: 1 } })))},
}));
if (${scoreExit} !== 0) console.error("controlled score source failure");
process.exit(${scoreExit});
`, { mode: 0o755 });
      const args = [
        new URL("../scripts/ibench-run.mjs", import.meta.url).pathname,
        "--score-only", "--config", config, "--ibench-source", source,
        "--output", output, "--skip-uv-sync", "--skip-base-image",
      ];
      const env = {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: directory,
        BENCHMARK_PROVIDER_API_KEY: "", DEEPSEEK_API_KEY: "", UV_CALL_LOG: join(directory, "calls.jsonl"),
      };
      const denied = spawnSync(process.execPath, args, { env, encoding: "utf8" });
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /requires DEEPSEEK_API_KEY/u);
      assert.equal(readdirSync(output).includes("prior-scores"), false);
      const result = spawnSync(process.execPath, args, { env: { ...env, DEEPSEEK_API_KEY: "synthetic" }, encoding: "utf8" });
      assert.equal(result.status, scoreExit, result.stderr);
      const calls = readFileSync(env.UV_CALL_LOG, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, 1, "no solver, plugin install, or extra scorer invocation");
      assert.equal(calls[0][3], "score");
      const report = JSON.parse(readFileSync(join(output, "ibench-report.json"), "utf8"));
      assert.equal(report.runId, "original-run");
      assert.equal(report.candidate.label, previous.candidate.label);
      assert.deepEqual(report.provider, previous.provider);
      assert.equal(report.instructionProfile, "intent-actions");
      assert.equal(report.candidate.scorerIsOfficial, true);
      assert.equal(report.ibench.exitCode, scoreExit);
      assert.equal(readFileSync(join(output, report.ibench.priorEvidence, "ibench-report.json"), "utf8"), originalReport);
      assert.equal(readFileSync(join(output, report.ibench.priorEvidence, "results.json"), "utf8"), originalResults);
      assert.equal(readFileSync(join(output, report.ibench.priorEvidence, "jobs/score/source-error.txt"), "utf8"), "source-scorer-fault");
      assert.equal(readFileSync(join(output, "jobs/solve/candidate.patch"), "utf8"), "frozen patch");
      if (scoreExit !== 0) assert.match(result.stderr, /controlled score source failure/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
