import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveCliEntrypoint } from "../scripts/swe-bench-harness.mjs";
import { parseEvaluationArgs } from "../scripts/evaluate-official.mjs";
import { parsePrepareArgs } from "../scripts/prepare-swe-bench.mjs";

test("public benchmark artifacts match the pinned candidate record", () => {
  const candidate = JSON.parse(
    readFileSync(new URL("../config/best-agent-candidate.json", import.meta.url), "utf8"),
  );
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(
    sha256(new URL("../scripts/swe-bench-harness.mjs", import.meta.url)),
    candidate.harnessSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/swe-bench-official-evaluator.mjs", import.meta.url)),
    candidate.officialEvaluatorSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/benchmark-history.mjs", import.meta.url)),
    candidate.benchmarkHistorySha256,
  );
  assert.equal(
    sha256(new URL("../scripts/benchmark-provider.mjs", import.meta.url)),
    candidate.benchmarkProviderSha256,
  );
});

test("configuration paths are explicit and bounded at the process boundary", () => {
  assert.throws(() => resolveCliEntrypoint({ BEST_AGENT_CLI_PATH: "relative" }), /absolute/u);
  assert.deepEqual(
    parsePrepareArgs([
      "--corpus",
      "/tmp/corpus.jsonl",
      "--manifest",
      "/tmp/manifest.json",
      "--evaluator-source",
      "/tmp/swe-bench",
    ]),
    {
      corpusPath: "/tmp/corpus.jsonl",
      manifestPath: "/tmp/manifest.json",
      evaluatorSourceDir: "/tmp/swe-bench",
    },
  );
  assert.equal(
    parseEvaluationArgs([
      "--report",
      "/tmp/report.json",
      "--predictions",
      "/tmp/predictions",
      "--manifest",
      "/tmp/manifest.json",
      "--output",
      "/tmp/output.json",
    ]).concurrency,
    1,
  );
});

test("repository contains no second SWE-bench grader", () => {
  const runner = readFileSync(new URL("../scripts/swe-bench-harness.mjs", import.meta.url), "utf8");
  const evaluator = readFileSync(new URL("../scripts/evaluate-official.mjs", import.meta.url), "utf8");
  for (const source of [runner, evaluator]) {
    assert.doesNotMatch(source, /FAIL_TO_PASS/u);
    assert.doesNotMatch(source, /test_patch/u);
    assert.doesNotMatch(source, /-m["']?,\s*["']pytest/u);
  }
  assert.match(evaluator, /summarizeOfficialEvaluations/u);
  assert.match(evaluator, /projectBenchmarkTaskDisposition/u);
});

test("hosted generation uses the public package and caps each batch at ten tasks", () => {
  const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /repository:\s*Simon-He95\/best-agent(?:\s|$)/u);
  assert.match(workflow, /@best-agent\/cli@\$\{\{ steps\.candidate\.outputs\.version \}\}/u);
  assert.match(workflow, /count > 10/u);
  assert.match(workflow, /name: swe-bench-corpus-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /needs: \[plan, smoke, corpus\]/u);
  assert.match(workflow, /brew install ripgrep/u);
});

test("beta.9 diagnostic plan is the frozen ledger's complete non-resolved population", () => {
  const ledgerPath = new URL("../results/benchmark-progress.json", import.meta.url);
  const ledgerBytes = readFileSync(ledgerPath);
  const ledger = JSON.parse(ledgerBytes);
  const manifest = JSON.parse(
    readFileSync(new URL("../config/beta9-failure-rerun-batches.json", import.meta.url), "utf8"),
  );
  const plannedIds = manifest.batches.flatMap((batch) => batch.tasks);
  const expectedIds = ledger.tasks
    .filter((task) => task.state !== "resolved")
    .map((task) => task.instance_id);

  assert.equal(createHash("sha256").update(ledgerBytes).digest("hex"), manifest.ledgerSha256);
  assert.deepEqual(plannedIds, expectedIds);
  assert.equal(manifest.taskCount, plannedIds.length);
  assert.equal(new Set(plannedIds).size, plannedIds.length);
  assert.ok(manifest.batches.every((batch) => batch.tasks.length <= 10));
});
