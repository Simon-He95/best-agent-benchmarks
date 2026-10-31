#!/usr/bin/env node
/**
 * Aggregate independent IBench batch reports into one predeclared result.
 *
 * Every batch is a separate Harbor job; this script only re-reads the batch
 * reports IBench produced. It refuses a partial or mixed composition: the union
 * of batch tasks must exact-cover the frozen batch plan, and every batch must
 * come from the same release, solver, scorer and provider.
 *
 * Usage:
 *   node scripts/ibench-aggregate.mjs [--input <dir>] [--config <path>]
 *                                     [--batches <path>] [--output <path>]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function frozenTaskIds(batches) {
  if (
    !Number.isInteger(batches.maxBatchSize) ||
    batches.maxBatchSize < 1 ||
    batches.batches.some((batch) => batch.tasks.length < 1 || batch.tasks.length > batches.maxBatchSize)
  ) {
    throw new Error("The frozen batch plan is inconsistent with its own maximum batch size.");
  }
  const ids = batches.batches.flatMap((batch) => batch.tasks);
  if (ids.length !== batches.taskCount || new Set(ids).size !== ids.length) {
    throw new Error("The frozen batch plan must cover every task exactly once.");
  }
  return ids;
}

/**
 * Merge batch reports. `reports` are the parsed `ibench-report.json` files.
 * Returns the aggregate report or throws on any composition violation.
 */
export function aggregateReports({ reports, batches, profile, runId, allowPartial = false }) {
  if (reports.length === 0) throw new Error("No batch reports to aggregate.");
  const expected = frozenTaskIds(batches);
  const expectedSet = new Set(expected);
  const seen = new Map();
  const identity = (report) =>
    JSON.stringify([
      report.release.commit,
      report.release.manifestSha256,
      report.candidate.harness,
      report.candidate.label,
      report.candidate.scorerHarness,
      report.candidate.scorerLabel,
      report.provider.model,
      report.provider.reasoningEffort,
      report.provider.baseURL,
      report.instructionProfile,
      report.solverOnly,
    ]);
  const reference = identity(reports[0]);
  for (const report of reports) {
    if (identity(report) !== reference) {
      throw new Error(`batch ${report.runId} was not produced by the same frozen composition.`);
    }
    for (const row of report.tasks) {
      if (!expectedSet.has(row.id)) throw new Error(`batch ${report.runId} contains an unfrozen task: ${row.id}`);
      if (seen.has(row.id)) throw new Error(`task ${row.id} appears in more than one batch.`);
      seen.set(row.id, row);
    }
  }
  if (seen.size !== expected.length && !allowPartial) {
    const missing = expected.filter((id) => !seen.has(id));
    throw new Error(`batches do not cover the frozen plan; missing ${missing.length}: ${missing.slice(0, 5).join(", ")}`);
  }
  const rows = expected.filter((id) => seen.has(id)).map((id) => seen.get(id));
  const passed = rows.filter((row) => row.passed).length;
  const total = rows.length;
  const first = reports[0];
  const partial = total !== profile.release.taskCount;
  return {
    schemaVersion: 1,
    benchmark: "ibench",
    generatedAt: new Date().toISOString(),
    runId,
    release: first.release,
    candidate: first.candidate,
    provider: first.provider,
    instructionProfile: first.instructionProfile,
    solverOnly: first.solverOnly,
    batchCount: reports.length,
    partial,
    passRate: first.solverOnly || total === 0 ? null : passed / total,
    passed,
    total,
    comparableToPublishedLeaderboard:
      !partial && !first.solverOnly && first.candidate.scorerIsOfficial,
    baseline: profile.baseline,
    tasks: rows,
  };
}

export function renderAggregateMarkdown(report) {
  return [
    `# IBench aggregate ${report.runId}`,
    "",
    `- Release: \`${report.release.commit}\` (${report.release.taskCount} frozen tasks)`,
    `- Solver: ${report.candidate.label}`,
    `- Scorer: ${report.candidate.scorerLabel}${report.candidate.scorerIsOfficial ? "" : " (non-official scorer)"}`,
    `- Batches: ${report.batchCount}`,
    report.partial ? `- Partial run: ${report.total} of ${report.release.taskCount} frozen tasks` : "",
    report.passRate === null
      ? `- Pass rate: deferred (${report.passed}/${report.total} seen)`
      : `- Pass rate: **${report.passed}/${report.total}** = ${(report.passRate * 100).toFixed(1)}%`,
    `- Published DSH reference: ${report.baseline.passed}/${report.baseline.total} = ${(report.baseline.passRate * 100).toFixed(1)}% (${report.baseline.harness} / ${report.baseline.model})`,
    `- Comparable to the published leaderboard: ${report.comparableToPublishedLeaderboard ? "yes" : "no"}`,
    "",
    "| Task | Status | Reward |",
    "| --- | --- | --- |",
    ...report.tasks.map((task) => `| \`${task.id}\` | ${task.status} | ${task.reward === null ? "-" : task.reward} |`),
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    input: join(repoRoot, "results/ibench"),
    configPath: join(repoRoot, "config/ibench.json"),
    batchesPath: join(repoRoot, "config/ibench-batches.json"),
    output: undefined,
    allowPartial: false,
  };
  const valueOf = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--input": options.input = resolve(valueOf(index, "--input")); index += 1; break;
      case "--config": options.configPath = resolve(valueOf(index, "--config")); index += 1; break;
      case "--batches": options.batchesPath = resolve(valueOf(index, "--batches")); index += 1; break;
      case "--output": options.output = resolve(valueOf(index, "--output")); index += 1; break;
      case "--allow-partial": options.allowPartial = true; break;
      default: throw new Error(`unknown option: ${argv[index]}`);
    }
  }
  return options;
}

export function collectBatchReports(input) {
  if (!existsSync(input)) throw new Error(`aggregate input does not exist: ${input}`);
  return readdirSync(input, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(input, entry.name, "ibench-report.json"))
    .filter((path) => existsSync(path))
    .sort()
    .map(readJson);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = readJson(options.configPath);
  const batches = readJson(options.batchesPath);
  const reports = collectBatchReports(options.input);
  const runId = process.env.IBENCH_RUN_ID ?? `aggregate-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const report = aggregateReports({ reports, batches, profile, runId, allowPartial: options.allowPartial });
  const output = options.output ?? join(options.input, "ibench-aggregate.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(output.replace(/\.json$/u, ".md"), renderAggregateMarkdown(report));
  const rate = report.passRate === null ? "deferred" : `${(report.passRate * 100).toFixed(1)}%`;
  console.log(
    `ibench> aggregate ${report.passed}/${report.total} = ${rate} ` +
      `across ${report.batchCount} batches; report: ${output}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ibench-aggregate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
