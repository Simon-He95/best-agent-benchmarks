#!/usr/bin/env node
/**
 * Build the leaderboard-comparison dataset for a frozen frontier-harness record.
 *
 * The official FrontierHarness v1.0 leaderboard publishes three aggregate columns
 * that this harness can reproduce from its own frozen per-task records:
 *
 *   pass rate                 = passes / expected cells
 *   cost per pass             = sum of known per-cell costs / passes
 *   median time per successful task = median wall-clock seconds over successful cells
 *
 * The official numbers are computed on a frozen price table, not on live bills, so a
 * self-run can only be placed next to them if it is priced the same way: this script
 * takes an explicit price table (USD per million tokens) and refuses to run without
 * one, because the repo has no frozen table for the deepseek-v4.1-flash provider and
 * an unstated price would silently make the cost column incomparable.
 *
 * Usage:
 *   node scripts/frontier-harness-comparison.mjs \
 *     --record docs/benchmarks/history/frontier-harness/20260930T115155Z--36711152110.json \
 *     --recovery <frozen recovery record.json> \
 *     --pricing docs/benchmarks/history/frontier-harness/leaderboard-pricing-deepseek-v4.1-flash.json \
 *     --official docs/benchmarks/history/frontier-harness/leaderboard-official-v1.0-k3.json \
 *     --out docs/benchmarks/history/frontier-harness/leaderboard-comparison-deepseek-v4.1-flash.json
 */

import fs from "node:fs";

const EXPECTED_CELLS = 30;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Price one cell from the CLI's token facts: fresh input, cache read, cache write, output. */
function cellCostUsd(usage, pricing) {
  if (usage === undefined || usage === null) return null;
  const fresh = usage.noCacheInputTokens;
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const output = usage.completionTokens;
  if ([fresh, cacheRead, cacheWrite, output].some((value) => typeof value !== "number")) return null;
  return (
    (fresh * pricing.freshInputUsdPerMillion +
      cacheRead * pricing.cacheReadUsdPerMillion +
      cacheWrite * pricing.cacheWriteUsdPerMillion +
      output * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

function summarizeRecord(record, pricing) {
  const perTask = record.perTask;
  if (!Array.isArray(perTask) || perTask.length === 0) {
    throw new Error("record carries no perTask array");
  }
  const cells = perTask.map((entry) => {
    const cost = cellCostUsd(entry.usage, pricing);
    return {
      task: entry.task,
      disposition: entry.disposition,
      durationSeconds: typeof entry.durationMs === "number" ? entry.durationMs / 1000 : null,
      costUsd: cost,
      usage: entry.usage ?? null,
      evidenceSha256: entry.evidenceSha256 ?? null,
    };
  });
  return {
    runId: record.formalRunId ?? null,
    candidateId: record.cli?.sourceCommit ?? null,
    provider: record.provider ?? null,
    cells,
  };
}

function build(dataset) {
  const official = readJson(dataset.official);
  const pricing = readJson(dataset.pricing);
  if (typeof pricing.freshInputUsdPerMillion !== "number" ||
      typeof pricing.cacheReadUsdPerMillion !== "number" ||
      typeof pricing.outputUsdPerMillion !== "number") {
    throw new Error("price table is missing a required USD-per-million rate");
  }

  const primary = summarizeRecord(readJson(dataset.record), pricing);
  const recovery = dataset.recovery === undefined ? null : summarizeRecord(readJson(dataset.recovery), pricing);

  // The reading this comparison is drawn under: the primary run's cells, with the
  // no-verdict cells refilled by the same-candidate recovery batch. Every other
  // verdict is the primary run's own and is never replaced.
  const refilled = new Map();
  for (const cell of [...primary.cells].reverse()) {
    if (cell.disposition === "error" && recovery) {
      const replacement = recovery.cells.find((candidate) => candidate.task === cell.task);
      if (replacement) refilled.set(cell.task, replacement);
    }
  }
  const reading = primary.cells.map((cell) => refilled.get(cell.task) ?? cell);
  const stillUnverdicted = reading.filter((cell) => cell.disposition === "error" || cell.disposition === "not-evaluated");

  const passes = reading.filter((cell) => cell.disposition === "passed");
  const successfulSeconds = passes.map((cell) => cell.durationSeconds).filter((value) => typeof value === "number");
  const knownCosts = reading.map((cell) => cell.costUsd).filter((value) => typeof value === "number");
  const totalCost = knownCosts.reduce((sum, value) => sum + value, 0);

  const rawPasses = primary.cells.filter((cell) => cell.disposition === "passed").length;
  const rawValid = primary.cells.filter((cell) => cell.disposition === "passed" || cell.disposition === "failed").length;

  return {
    schemaVersion: 1,
    label: "best-agent (this repository's frontier-harness composition) on deepseek-v4.1-flash",
    generatedAt: new Date().toISOString(),
    point: {
      key: "best-agent-deepseek-v4.1-flash",
      label: "best-agent",
      sublabel: "deepseek-v4.1-flash max effort",
      color: "#ff6418",
      shape: "star",
      cells: EXPECTED_CELLS,
      passes: passes.length,
      passRate: passes.length / EXPECTED_CELLS,
      costPerPass: passes.length === 0 ? null : totalCost / passes.length,
      medianSuccessfulSeconds: median(successfulSeconds),
      costCoverage: knownCosts.length / reading.length,
      successfulCells: passes.length,
    },
    reading: {
      basis: dataset.readingBasis,
      cells: reading.map((cell) => ({
        task: cell.task,
        disposition: cell.disposition,
        durationSeconds: cell.durationSeconds,
        costUsd: cell.costUsd,
      })),
      refilledFromRecovery: [...refilled.keys()],
      stillWithoutVerdict: stillUnverdicted.map((cell) => cell.task),
      rawPrimaryRun: {
        passes: rawPasses,
        validCells: rawValid,
        passRateOverExpected: rawPasses / EXPECTED_CELLS,
        passRateOverValidCells: rawValid === 0 ? null : rawPasses / rawValid,
      },
    },
    usage: {
      totalCostUsd: totalCost,
      knownCostCells: knownCosts.length,
      priceTable: pricing,
    },
    provenance: {
      primaryRecord: dataset.record,
      recoveryRecord: dataset.recovery ?? null,
      officialSnapshot: dataset.official,
      officialSource: official.source,
      officialPriceTable: official.priceTable,
    },
    officialHarnesses: official.harnesses,
    comparability: official.comparability,
  };
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["record", "pricing", "official", "out", "readingBasis"]) {
  if (args[required] === undefined) throw new Error(`missing --${required}`);
}
const result = build(args);
fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);

const { point, reading } = result;
console.log(JSON.stringify({
  out: args.out,
  passes: point.passes,
  cells: point.cells,
  passRate: point.passRate,
  costPerPass: point.costPerPass,
  medianSuccessfulSeconds: point.medianSuccessfulSeconds,
  costCoverage: point.costCoverage,
  refilled: reading.refilledFromRecovery,
  stillWithoutVerdict: reading.stillWithoutVerdict,
  rawPrimaryRun: reading.rawPrimaryRun,
}, null, 2));
