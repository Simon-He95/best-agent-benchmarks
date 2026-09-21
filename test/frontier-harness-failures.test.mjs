import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyVerifierDelivery } from "../scripts/frontier-harness-failures.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "frontier-harness-failures.mjs");

/**
 * Verbatim excerpts of the 2026-09-20 high-effort run's verifier output
 * (run 35479874603): the frozen `reward.json` byte for byte, and the captured
 * `verifier/test-stdout.txt` lines that carry the delivery signature.
 */
const fixtures = join(repoRoot, "test", "fixtures", "frontier-harness-verifier");
const anko = {
  reward: JSON.parse(readFileSync(join(fixtures, "anko-typed-variable-bindings", "reward.json"), "utf8")),
  log: readFileSync(join(fixtures, "anko-typed-variable-bindings", "log-excerpt.txt"), "utf8"),
};
const httpx = {
  reward: JSON.parse(
    readFileSync(join(fixtures, "httpx-multipart-response-parsing", "reward.json"), "utf8"),
  ),
  log: readFileSync(join(fixtures, "httpx-multipart-response-parsing", "log-excerpt.txt"), "utf8"),
};
const config = JSON.parse(
  readFileSync(new URL("../config/frontier-harness.json", import.meta.url), "utf8"),
);

test("the declared specification gaps are real corpus tasks and stay instruction-free", () => {
  const gaps = config.specificationGaps.tasks;
  assert.equal(gaps.length, 3);
  for (const entry of gaps) {
    // A gap is a declaration about the corpus, so it must name a real task and
    // must not carry replacement instruction text: the pinned bytes stay frozen.
    assert.ok(config.source.taskIds.includes(entry.task), entry.task);
    assert.deepEqual(Object.keys(entry).sort(), ["observed", "omission", "task"]);
    assert.ok(entry.omission.length > 40, entry.task);
    assert.ok(entry.observed.length > 40, entry.task);
    assert.ok(!("clarification" in entry), entry.task);
    assert.ok(!("text" in entry), entry.task);
  }
  assert.match(config.specificationGaps.note, /canonical verdict stands unchanged/u);
});

test("a delivery that never compiled is derived as a build failure, not N test failures", () => {
  const result = classifyVerifierDelivery({ rewards: anko.reward, log: anko.log });
  assert.equal(result.delivery, "build-failed");
  assert.equal(result.missingFromReport, 8);
  assert.deepEqual(result.f2p, { passed: 1, total: 9, partial: 0.9223300970873787 });
  assert.deepEqual(result.signals, [
    "go-build-failed",
    "reporter-failed-build-event",
    "scored-report-missing",
  ]);
});

test("a scored suite that ran is derived as a functional result with its fail-to-pass distance", () => {
  const result = classifyVerifierDelivery({ rewards: httpx.reward, log: httpx.log });
  assert.equal(result.delivery, "ran");
  assert.equal(result.missingFromReport, 0);
  assert.deepEqual(result.f2p, { passed: 121, total: 122, partial: 0.9992826398852224 });
  assert.deepEqual(result.signals, []);
});

test("a typecheck failure in the captured output is derived as its own delivery failure", () => {
  const result = classifyVerifierDelivery({
    rewards: { reward: 0, f2p_total: 3, f2p_passed: 0, partial: 0 },
    log: "src/index.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  });
  assert.equal(result.delivery, "typecheck-failed");
  assert.equal(result.typecheckError, "error TS2322");
});

test("missing fail-to-pass rows without a build signal are an incomplete report, not a scored run", () => {
  const result = classifyVerifierDelivery({
    rewards: { reward: 0, f2p_total: 2, f2p_passed: 0, partial: 0 },
    log: "✗ [f2p] some.test\n    missing from report (test did not run or produced no result — see raw output)",
  });
  assert.equal(result.delivery, "incomplete-report");
  assert.equal(result.missingFromReport, 1);
});

test("a task with no verifier evidence at all reports no distance", () => {
  const result = classifyVerifierDelivery({});
  assert.equal(result.delivery, "unknown");
  assert.equal(result.f2p, null);
  assert.equal(result.missingFromReport, 0);
});

/** A frozen record plus the trial directory the analysis reads evidence from. */
function writeTask({ resultsDir, jobsDir, task, reward, log, terminalCause = "completed" }) {
  const short = task.split("/").pop();
  const jobName = `fh-test-${short}`;
  const trial = join(jobsDir, short, jobName, "pier-task__TEST");
  mkdirSync(join(trial, "verifier"), { recursive: true });
  mkdirSync(join(trial, "agent"), { recursive: true });
  writeFileSync(join(trial, "result.json"), "{}\n");
  writeFileSync(join(trial, "verifier", "reward.json"), `${JSON.stringify(reward)}\n`);
  writeFileSync(join(trial, "verifier", "test-stdout.txt"), log);
  writeFileSync(
    join(trial, "agent", "best-agent-evidence.jsonl"),
    [
      JSON.stringify({ type: "model-outcome", sequence: 1 }),
      JSON.stringify({
        type: "terminal-snapshot",
        sequence: 2,
        snapshot: { terminalCause, transcript: [] },
      }),
      JSON.stringify({ type: "footer", sequence: 3, complete: true }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(resultsDir, `frontier-harness-results.${short}.json`),
    `${JSON.stringify(
      {
        task: { name: task },
        result: { disposition: "failed", rewards: reward },
        durationMs: 1_330_000,
        effectiveAgentTimeoutSec: 5400,
        jobName,
        artifacts: { evidenceSha256: "0".repeat(64) },
      },
      null,
      2,
    )}\n`,
  );
}

test("the failure analysis names a build-broken delivery as its own stage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fh-failures-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultsDir = join(root, "results");
  const jobsDir = join(root, "jobs");
  mkdirSync(resultsDir, { recursive: true });
  writeTask({
    resultsDir,
    jobsDir,
    task: "datacurve/anko-typed-variable-bindings",
    reward: anko.reward,
    log: anko.log,
  });
  writeTask({
    resultsDir,
    jobsDir,
    task: "terminal-bench/build-cython-ext",
    reward: httpx.reward,
    log: httpx.log,
  });
  const output = join(root, "failures.md");
  const json = join(root, "failures.json");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--results", resultsDir, "--jobs", jobsDir, "--output", output, "--json", json],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const markdown = readFileSync(output, "utf8");
  assert.match(markdown, /### anko-typed-variable-bindings — delivery/u);
  assert.match(markdown, /### build-cython-ext — model/u);
  assert.match(
    markdown,
    /\| delivery \| \*\*build-failed\*\* — 8 fail-to-pass rows never produced a result/u,
  );
  assert.match(markdown, /\| delivery \| ran — fail-to-pass 121\/122 \(partial 0\.9993\) \|/u);
  assert.match(
    markdown,
    /\| delivery \| 1 \| the delivered patch never built in the scored configuration \|/u,
  );

  const summary = JSON.parse(readFileSync(json, "utf8"));
  assert.deepEqual(summary.byStage, { delivery: 1, model: 1 });
  const ankoSummary = summary.tasks.find((entry) => entry.task.endsWith("anko-typed-variable-bindings"));
  assert.equal(ankoSummary.stage, "delivery");
  assert.equal(ankoSummary.disposition, "failed");
  assert.equal(ankoSummary.verifier.delivery, "build-failed");
  assert.equal(ankoSummary.verifier.missingFromReport, 8);
  const ranSummary = summary.tasks.find((entry) => entry.task.endsWith("build-cython-ext"));
  assert.equal(ranSummary.stage, "model");
  assert.equal(ranSummary.verifier.delivery, "ran");
  assert.equal(ranSummary.verifier.f2p.passed, 121);
  assert.equal("specificationGap" in ranSummary, false);
});

test("a declared specification gap is labelled and kept out of capability readings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fh-failures-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultsDir = join(root, "results");
  const jobsDir = join(root, "jobs");
  mkdirSync(resultsDir, { recursive: true });
  writeTask({
    resultsDir,
    jobsDir,
    task: "datacurve/httpx-multipart-response-parsing",
    reward: httpx.reward,
    log: httpx.log,
  });
  const output = join(root, "failures.md");
  const json = join(root, "failures.json");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--results", resultsDir, "--jobs", jobsDir, "--output", output, "--json", json],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const markdown = readFileSync(output, "utf8");
  assert.match(markdown, /### httpx-multipart-response-parsing — specification-gap/u);
  assert.match(markdown, /\| specification gap \| The instruction requires a continuation line/u);
  assert.match(markdown, /1 of the not-passed tasks are declared specification gaps/u);
  assert.match(
    markdown,
    /\| specification-gap \| 1 \| the pinned instruction omits a rule the hidden tests require/u,
  );
  const summary = JSON.parse(readFileSync(json, "utf8"));
  assert.deepEqual(summary.byStage, { "specification-gap": 1 });
  const entry = summary.tasks[0];
  // The canonical verdict is untouched: only the derived stage and the declared
  // gap are added.
  assert.equal(entry.disposition, "failed");
  assert.deepEqual(entry.rewards, httpx.reward);
  assert.equal(entry.stage, "specification-gap");
  assert.equal(entry.verifier.delivery, "ran");
  assert.match(entry.specificationGap.omission, /continuation line/u);
});

test("an agent timeout keeps its budget classification regardless of the verifier output", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fh-failures-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultsDir = join(root, "results");
  const jobsDir = join(root, "jobs");
  mkdirSync(resultsDir, { recursive: true });
  writeTask({
    resultsDir,
    jobsDir,
    task: "terminal-bench/chess-best-move",
    reward: { reward: 0 },
    log: "no test results",
    terminalCause: "?",
  });
  const record = join(resultsDir, "frontier-harness-results.chess-best-move.json");
  const frozen = JSON.parse(readFileSync(record, "utf8"));
  frozen.result = { disposition: "failed", rewards: { reward: 0 }, exception: { type: "AgentTimeoutError", message: "Agent execution timed out after 900.0 seconds" } };
  writeFileSync(record, `${JSON.stringify(frozen, null, 2)}\n`);
  const output = join(root, "failures.md");
  const json = join(root, "failures.json");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--results", resultsDir, "--jobs", jobsDir, "--output", output, "--json", json],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(summary.tasks[0].stage, "agent-timeout");
  assert.equal(summary.tasks[0].verifier.delivery, "unknown");
});

test("the fixture excerpts are the real verifier bytes they claim to be", () => {
  // Guard against a fixture being "fixed up" into something the run never wrote.
  assert.equal(anko.reward.f2p_passed, 1);
  assert.equal(anko.reward.f2p_total, 9);
  assert.match(anko.log, /FAIL\\tgithub\.com\/mattn\/anko\/vm \[build failed\]/u);
  assert.equal(httpx.reward.f2p_passed, 121);
  assert.match(httpx.log, /P2P 1272\/1272 pass 0 fail; F2P 121\/122 pass 1 fail/u);
  // The frozen reward.json bytes are pinned, so a fixture cannot drift silently.
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(
    sha256(join(fixtures, "anko-typed-variable-bindings", "reward.json")).slice(0, 16),
    "6b127cfd99128da8",
  );
  assert.equal(
    sha256(join(fixtures, "httpx-multipart-response-parsing", "reward.json")).slice(0, 16),
    "b11a136c5040f5e6",
  );
});
