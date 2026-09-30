import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "frontier-harness-comparison.mjs");

const PRICING = {
  name: "test-table",
  freshInputUsdPerMillion: 1,
  cacheWriteUsdPerMillion: 1,
  cacheReadUsdPerMillion: 0.1,
  outputUsdPerMillion: 10,
};

const OFFICIAL = {
  source: { resultsFile: "https://example.invalid/eval-data.json", resultsGeneratedAt: "2026-08-22T00:00:00Z", modelLabel: "Test Model", runtime: "test runtime" },
  priceTable: { name: "test-official-table", freshInputUsdPerMillion: 2, cacheWriteUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 20 },
  comparability: { repoRule: "diagnostic only" },
  harnesses: [
    { key: "a", label: "A", color: "#ffffff", shape: "circle", successful: 2, passRate: 2 / 3, costPerPass: 4, medianSuccessfulSeconds: 300, medianCostPerSuccessfulTask: 0.5, cacheHitRateTypical: 0.9 },
  ],
};

function cell(task, disposition, durationMs, usage) {
  return { task, disposition, durationMs, usage, evidenceSha256: `sha-${task}-${disposition}` };
}

function writeFixture(directory, { record, recovery, pricing }) {
  const paths = {
    record: path.join(directory, "record.json"),
    pricing: path.join(directory, "pricing.json"),
    official: path.join(directory, "official.json"),
    out: path.join(directory, "comparison.json"),
  };
  fs.writeFileSync(paths.record, JSON.stringify(record));
  fs.writeFileSync(paths.pricing, JSON.stringify(pricing ?? PRICING));
  fs.writeFileSync(paths.official, JSON.stringify(OFFICIAL));
  if (recovery !== undefined) {
    paths.recovery = path.join(directory, "recovery.json");
    fs.writeFileSync(paths.recovery, JSON.stringify(recovery));
  }
  return paths;
}

function run(directory, paths, extra = []) {
  const args = [
    SCRIPT,
    "--record", paths.record,
    "--pricing", paths.pricing,
    "--official", paths.official,
    "--out", paths.out,
    "--readingBasis", "test reading",
    ...extra,
  ];
  return execFileSync(process.execPath, args, { cwd: directory, encoding: "utf8" });
}

test("the comparison builder prices cells from raw token facts and reports the three official columns", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fh-comparison-"));
  // 1000 fresh input + 10000 cache reads + 1000 output at 1/0.1/10 USD per million.
  const priced = { noCacheInputTokens: 1000, cacheReadTokens: 10000, cacheWriteTokens: 0, completionTokens: 1000 };
  const record = {
    formalRunId: "test-run",
    cli: { sourceCommit: "deadbeef" },
    perTask: [
      cell("t/one", "passed", 300000, priced),
      cell("t/two", "passed", 600000, priced),
      cell("t/three", "failed", 900000, priced),
      cell("t/four", "error", 6000, null),
    ],
  };
  const paths = writeFixture(directory, { record });
  const stdout = run(directory, paths);
  const dataset = JSON.parse(fs.readFileSync(paths.out, "utf8"));
  const expectedCellCost = (1000 * 1 + 10000 * 0.1 + 1000 * 10) / 1_000_000; // 0.012

  assert.equal(dataset.point.cells, 30);
  assert.equal(dataset.point.passes, 2);
  assert.equal(dataset.point.passRate, 2 / 30);
  assert.equal(dataset.point.costPerPass, (expectedCellCost * 3) / 2);
  assert.equal(dataset.point.medianSuccessfulSeconds, 450);
  assert.equal(dataset.point.costCoverage, 3 / 4);
  // The same tokens priced on the official frozen table (2 / 0.2 / 2 / 20 per million).
  const officialCellCost = (1000 * 2 + 10000 * 0.2 + 1000 * 20) / 1_000_000; // 0.024
  assert.equal(dataset.point.officialPriceRepricing.costPerPass, (officialCellCost * 3) / 2);
  assert.equal(dataset.point.officialPriceRepricing.priceTableName, "test-official-table");
  assert.equal(dataset.tokens.inputTokens, 11000 * 3);
  assert.equal(dataset.tokens.outputTokens, 1000 * 3);
  assert.deepEqual(dataset.reading.stillWithoutVerdict, ["t/four"]);
  assert.deepEqual(dataset.reading.refilledFromRecovery, []);
  assert.equal(dataset.reading.rawPrimaryRun.passRateOverValidCells, 2 / 3);
  assert.equal(dataset.officialHarnesses.length, 1);
  assert.match(stdout, /"passes": 2/);
});

test("the comparison builder refills only no-verdict cells and never replaces a graded one", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fh-comparison-"));
  const priced = { noCacheInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 1_000_000 };
  const record = {
    perTask: [
      cell("t/one", "passed", 100000, priced),
      cell("t/two", "failed", 100000, priced),
      cell("t/three", "error", 6000, null),
    ],
  };
  const recovery = {
    perTask: [
      cell("t/three", "passed", 200000, priced),
      cell("t/two", "passed", 1000, priced), // must be ignored: t/two already carries a verdict
    ],
  };
  const paths = writeFixture(directory, { record, recovery });
  run(directory, paths, ["--recovery", paths.recovery]);
  const dataset = JSON.parse(fs.readFileSync(paths.out, "utf8"));
  const byTask = new Map(dataset.reading.cells.map((entry) => [entry.task, entry]));

  assert.deepEqual(dataset.reading.refilledFromRecovery, ["t/three"]);
  assert.deepEqual(dataset.reading.stillWithoutVerdict, []);
  assert.equal(byTask.get("t/three").disposition, "passed");
  assert.equal(byTask.get("t/two").disposition, "failed");
  assert.equal(dataset.point.passes, 2);
  assert.equal(dataset.reading.rawPrimaryRun.passes, 1);
});

test("a recovery record that died again fills nothing and a later one can still fill the cell", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fh-comparison-"));
  const priced = { noCacheInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 1_000_000 };
  const record = { perTask: [cell("t/one", "passed", 100000, priced), cell("t/three", "error", 6000, null)] };
  const first = { perTask: [cell("t/three", "error", 5000, null)] };
  const second = { perTask: [cell("t/three", "failed", 300000, priced)] };
  const paths = writeFixture(directory, { record, recovery: first });
  const secondPath = path.join(directory, "recovery-second.json");
  fs.writeFileSync(secondPath, JSON.stringify(second));
  run(directory, paths, ["--recovery", `${paths.recovery},${secondPath}`]);
  const dataset = JSON.parse(fs.readFileSync(paths.out, "utf8"));

  assert.deepEqual(dataset.reading.refilledFromRecovery, ["t/three"]);
  assert.deepEqual(dataset.reading.stillWithoutVerdict, []);
  assert.equal(dataset.reading.cells.find((entry) => entry.task === "t/three").disposition, "failed");
  assert.equal(dataset.point.passes, 1);
});

test("the comparison builder refuses an unpriced or empty record instead of guessing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fh-comparison-"));
  const record = { perTask: [cell("t/one", "passed", 1000, { noCacheInputTokens: 1, cacheReadTokens: 1, completionTokens: 1 })] };
  const paths = writeFixture(directory, { record, pricing: { name: "incomplete", freshInputUsdPerMillion: 1 } });
  assert.throws(
    () => run(directory, paths),
    (error) => /price table is missing a required USD-per-million rate/.test(String(error.stderr)),
  );

  const emptyPaths = writeFixture(directory, { record: { perTask: [] } });
  assert.throws(
    () => run(directory, emptyPaths),
    (error) => /record carries no perTask array/.test(String(error.stderr)),
  );
});
