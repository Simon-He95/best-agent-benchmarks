#!/usr/bin/env node
/**
 * FrontierHarness repaired reading.
 *
 * A run's frozen record keeps the verdicts it measured. This script publishes,
 * beside that record, a *repaired reading*: the same run with a declared,
 * bounded set of cells replaced by a re-measured verdict, each cell labelled with
 * the class it was admitted under and counted for the extra attempt it received.
 *
 * Usage:
 *   node scripts/frontier-harness-repaired-reading.mjs \
 *     --record <frozen record.json> --repairs <manifest.json> [<manifest.json> ...] \
 *     --output <out.json>
 *
 * Semantics:
 *   - The record file is read only. It is never rewritten: the verdicts a run
 *     measured stay exactly as they were, and a repair is always a companion.
 *   - A repair manifest is admitted only when it declares the frozen record it
 *     repairs by sha256, so a manifest written for another run (or for an edited
 *     record) is refused instead of being applied to the wrong numbers.
 *   - Every admitted cell must exist in the record, must carry a re-measured
 *     verdict, and may be repaired by exactly one manifest: one extra attempt
 *     per cell, never two, and never a second chance at a cell that the reading
 *     would count twice.
 *   - The reading publishes `passAt1: null` unconditionally. It is a repaired
 *     reading, not a pass@1: the counted attempts are not the run's own.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const VERDICTS = new Set(["passed", "failed", "error", "not-evaluated"]);
const KINDS = new Set(["recovery", "diagnostic-recheck", "recheck"]);

function fail(message) {
  console.error(`repaired-reading: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { record: undefined, repairs: [], output: undefined, official: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--record":
        parsed.record = resolve(argv[++i]);
        break;
      case "--repairs":
        parsed.repairs.push(resolve(argv[++i]));
        break;
      case "--output":
        parsed.output = resolve(argv[++i]);
        break;
      case "--official":
        parsed.official = true;
        break;
      default:
        fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!parsed.record || !parsed.output || parsed.repairs.length === 0) {
    fail("--record, at least one --repairs and --output are required");
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const recordBytes = readFileSync(args.record);
const recordSha256 = createHash("sha256").update(recordBytes).digest("hex");
const record = JSON.parse(recordBytes.toString("utf8"));
// The frozen aggregate record does not carry the run id inside itself; the file
// name does (`...--<runId>.json`), so a reader still sees which run is repaired.
const runId = record.formalRunId ?? Number(/(\d{6,})\.json$/u.exec(args.record)?.[1]);
const runIdLabel = Number.isFinite(runId) && runId !== null ? runId : "unknown";

const cells = new Map();
for (const entry of record.perTask ?? []) {
  cells.set(entry.task, entry.disposition);
}
if (cells.size === 0) fail("the record carries no per-task verdicts");
if (!record.results) fail("the record carries no result counts");

const repairs = [];
const seen = new Map();
for (const path of args.repairs) {
  if (!existsSync(path)) fail(`repair manifest does not exist: ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!KINDS.has(manifest.kind)) {
    fail(`${path}: kind must be one of ${[...KINDS].join(", ")}`);
  }
  if (manifest.sourceRun?.frozenRecordSha256 !== recordSha256) {
    fail(
      `${path}: sourceRun.frozenRecordSha256 does not match the record being read ` +
        `(declared ${manifest.sourceRun?.frozenRecordSha256 ?? "nothing"}, read ${recordSha256})`,
    );
  }
  const repairCells = manifest.outcome?.cells;
  if (!Array.isArray(repairCells) || repairCells.length === 0) {
    fail(`${path}: the manifest carries no re-measured verdict (outcome.cells)`);
  }
  const admitted = [];
  for (const cell of repairCells) {
    if (typeof cell.task !== "string" || !cells.has(cell.task)) {
      fail(`${path}: ${cell.task ?? "a cell"} is not a task of this record`);
    }
    if (!VERDICTS.has(cell.disposition)) {
      fail(`${path}: ${cell.task} carries no verdict (${cell.disposition ?? "nothing"})`);
    }
    if (seen.has(cell.task)) {
      fail(
        `${cell.task}: already repaired by ${seen.get(cell.task)}; ` +
          "a cell receives at most one extra attempt",
      );
    }
    if (typeof cell.class !== "string" || cell.class.length === 0) {
      fail(`${path}: ${cell.task} declares no admission class`);
    }
    seen.set(cell.task, manifest.batchLabel ?? path);
    admitted.push({
      task: cell.task,
      originalDisposition: cells.get(cell.task),
      remediatedDisposition: cell.disposition,
      changed: cells.get(cell.task) !== cell.disposition,
      class: cell.class,
      rewards: cell.rewards,
      durationMs: cell.durationMs,
    });
  }
  repairs.push({
    batchLabel: manifest.batchLabel ?? path,
    kind: manifest.kind,
    runId: manifest.runId,
    runUrl: manifest.runUrl,
    manifestPath: path.slice(resolve(".").length + 1),
    cells: admitted,
  });
}

// The repaired reading itself: the record's own counts, then one replacement per
// admitted cell. Nothing else moves.
const reading = {
  passed: record.results.passed,
  failed: record.results.failed,
  error: record.results.error,
  notEvaluated: record.results.notEvaluated ?? 0,
};
for (const repair of repairs) {
  for (const cell of repair.cells) {
    const from = cell.originalDisposition;
    const to = cell.remediatedDisposition;
    if (from === to) continue;
    if (from === "passed") reading.passed -= 1;
    else if (from === "failed") reading.failed -= 1;
    else if (from === "error") reading.error -= 1;
    else reading.notEvaluated -= 1;
    if (to === "passed") reading.passed += 1;
    else if (to === "failed") reading.failed += 1;
    else if (to === "error") reading.error += 1;
    else reading.notEvaluated += 1;
  }
}
const expected = record.coverage?.expectedEligible ?? record.coverage?.expected;
const validCells = reading.passed + reading.failed;
const repairedCells = repairs.flatMap((repair) => repair.cells);

const output = {
  schemaVersion: 1,
  profileId: record.profileId,
  recordKind: args.official ? "official-repaired-reading" : "repaired-reading",
  sourceRun: {
    runId: runIdLabel,
    frozenRecord: args.record.slice(resolve(".").length + 1),
    frozenRecordSha256: recordSha256,
    results: record.results,
    passAt1: record.passAt1 ?? null,
  },
  repairs,
  repairedReading: {
    passed: reading.passed,
    failed: reading.failed,
    error: reading.error,
    notEvaluated: reading.notEvaluated,
    expected,
    validCells,
    // Matches the frozen report's own arithmetic: the pass rate is over every
    // predeclared task, so a cell left without a verdict still counts against.
    passRate: expected ? reading.passed / expected : null,
    passRateValidCells: validCells ? reading.passed / validCells : null,
    passAt1: null,
    extraAttempts: repairedCells.length,
    cells: repairedCells.map((cell) => ({
      task: cell.task,
      originalDisposition: cell.originalDisposition,
      remediatedDisposition: cell.remediatedDisposition,
      changed: cell.changed,
      class: cell.class,
    })),
  },
  // The run's official result. It is the repaired pass rate, named for what it
  // measures: the run's own verdicts plus one re-measured attempt per repaired
  // cell. `passAt1` above stays null because that metric is defined over exactly
  // one attempt per cell, and this figure counts more attempts than the run did.
  official: args.official
    ? {
        metric: "repairedPassRate",
        value: expected ? reading.passed / expected : null,
        repairedCells: repairedCells.length,
        extraAttempts: repairedCells.length,
        ofExpected: expected,
        label:
          "FrontierHarness Eval v1.0, run " +
          `${runIdLabel} on candidate ` +
          `${record.cli?.sourceCommit ?? "the frozen candidate"}` +
          (repairedCells.length > 0
            ? `; ${repairedCells.length} cell(s) re-measured once each under a frozen, declared manifest`
            : "") +
          ". The strict one-attempt-per-task pass@1 of the raw run is null; this " +
          "official result counts the declared re-measurements and discloses them.",
      }
    : undefined,
  boundary:
    "A repaired reading is not a pass@1. Every repaired cell received one extra " +
    "attempt beyond the run's own predeclared attempts, so this figure counts more " +
    "attempts than the run did, it is published beside the run's frozen record and " +
    "never instead of it, and the run's own verdicts are unchanged. Across the whole " +
    "reading a cell carries exactly one additional attempt at most, and each repair is " +
    "labelled with the class it was admitted under so a reader can recompute the " +
    "reading from the frozen record plus the named manifests.",
};

writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
const lines = [
  `# FrontierHarness ${args.official ? "official repaired reading" : "repaired reading"}`,
  ``,
  `| field | value |`,
  `| --- | --- |`,
  `| source run | ${output.sourceRun.runId ?? "unknown"} (frozen record sha256 ${recordSha256.slice(0, 12)}…) |`,
  `| record verdicts | ${record.results.passed} passed / ${record.results.failed} failed / ${record.results.error} error / ${output.sourceRun.results.notEvaluated ?? 0} not-evaluated |`,
  `| repaired cells | ${repairedCells.length} (one extra attempt each) |`,
  `| repaired reading | **${reading.passed} passed / ${reading.failed} failed / ${reading.error} error / ${reading.notEvaluated} not-evaluated** |`,
  `| pass rate (repaired, diagnostic) | ${output.repairedReading.passRate === null ? "n/a" : `${(output.repairedReading.passRate * 100).toFixed(1)}%`} |`,  `| pass@1 (strict, one attempt per task) | null — the official result above is the repaired pass rate, and the raw record below is what that number was built from |`,
  ``,
  `| cell | in the record | re-measured | class | batch |`,
  `| --- | --- | --- | --- | --- |`,
  ...repairedCells.map(
    (cell) =>
      `| ${cell.task} | ${cell.originalDisposition} | ${cell.remediatedDisposition} | ${cell.class} | ${
        repairs.find((repair) => repair.cells.includes(cell))?.batchLabel ?? ""
      } |`,
  ),
  ``,
  `> ${output.boundary}`,
  ``,
];
if (args.official) {
  lines.splice(
    2,
    0,
    `**Official result: ${output.official.value === null ? "n/a" : `${(output.official.value * 100).toFixed(1)}%`} repaired pass rate** over ${output.official.ofExpected} predeclared tasks, counting ${output.official.repairedCells} declared re-measurement(s).`,
    ``,
  );
}
writeFileSync(`${args.output}.md`, lines.join("\n"));
console.log(`repaired reading written to ${args.output}`);
