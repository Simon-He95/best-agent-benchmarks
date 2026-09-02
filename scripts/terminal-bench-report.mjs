#!/usr/bin/env node
/**
 * Terminal-Bench 4.0 aggregate report.
 *
 * Merges frozen per-task harness records into one report. The report only
 * transcribes Harbor's canonical trial verdicts (passed/failed/error) and
 * computes the solved fraction; it never re-grades tasks.
 *
 * Usage:
 *   node scripts/terminal-bench-report.mjs \
 *     --results <dir> --corpus <manifest> --expected-tasks <list> \
 *     --output <report.json> [--formal]
 *
 * Semantics:
 *   - GPU tasks are excluded from the Docker-environment expected set and listed
 *     separately (no GPU on hosted runners).
 *   - passAt1 stays null for diagnostic/subset runs and becomes the solved
 *     fraction only for a --formal run with complete expected coverage.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "terminal-bench.json"), "utf8"),
);

function parseArgs(argv) {
  const parsed = {
    results: undefined,
    corpus: undefined,
    expectedTasks: undefined,
    output: undefined,
    formal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--results":
        parsed.results = resolve(argv[++i]);
        break;
      case "--corpus":
        parsed.corpus = resolve(argv[++i]);
        break;
      case "--expected-tasks":
        parsed.expectedTasks = resolve(argv[++i]);
        break;
      case "--output":
        parsed.output = resolve(argv[++i]);
        break;
      case "--formal":
        parsed.formal = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!parsed.results || !parsed.corpus || !parsed.expectedTasks || !parsed.output) {
    throw new Error(
      "--results, --corpus, --expected-tasks and --output are required.",
    );
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const frozen = JSON.parse(readFileSync(args.corpus, "utf8"));
  const expectedSet = new Set(
    readFileSync(args.expectedTasks, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (expectedSet.size === 0) throw new Error("--expected-tasks list is empty.");

  const gpuTasks = new Set(frozen.gpuTasks ?? []);
  const expectedEligible = [...expectedSet].filter((name) => !gpuTasks.has(name));
  if (expectedEligible.length === 0) throw new Error("Expected set has no eligible tasks.");

  const records = [];
  for (const file of readdirSync(args.results)) {
    if (!/^terminal-bench-results\./u.test(file)) continue;
    if (!file.endsWith(".json")) continue;
    records.push(JSON.parse(readFileSync(join(args.results, file), "utf8")));
  }
  const byTask = new Map(records.map((record) => [record.task.name, record]));
  const present = [...expectedEligible].filter((name) => byTask.has(name));
  const missing = [...expectedEligible].filter((name) => !byTask.has(name));

  const counted = present.map((name) => byTask.get(name));
  const passed = counted.filter((r) => r.result.disposition === "passed").length;
  const failed = counted.filter((r) => r.result.disposition === "failed").length;
  const errors = counted.filter((r) => r.result.disposition === "error").length;
  const notEvaluated = counted.filter((r) =>
    ["not-evaluated", "inconclusive"].includes(r.result.disposition),
  ).length;

  const complete = missing.length === 0;
  const passRate = present.length > 0 ? passed / present.length : 0;

  const report = {
    schemaVersion: 1,
    profileId: frozen.profileId,
    dataset: frozen.dataset,
    harbor: config.harbor,
    cli: config.cli,
    provider: config.provider,
    formal: args.formal,
    gpuExcludedTasks: [...gpuTasks].filter((name) => expectedSet.has(name)),
    coverage: {
      expected: expectedSet.size,
      expectedEligible: expectedEligible.length,
      present: present.length,
      missing,
    },
    results: {
      passed,
      failed,
      error: errors,
      notEvaluated,
    },
    passRate,
    passAt1: args.formal && complete ? passRate : null,
    perTask: expectedEligible.map((name) => {
      const record = byTask.get(name);
      if (!record) {
        return { task: name, disposition: "not-evaluated", missing: true };
      }
      return {
        task: name,
        disposition: record.result.disposition,
        rewards: record.result.rewards ?? undefined,
        exception: record.result.exception ?? undefined,
        durationMs: record.durationMs,
        evidenceSha256: record.artifacts.evidenceSha256 ?? undefined,
        batchId: record.batchId,
      };
    }),
  };
  writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);

  const rows = report.perTask
    .map((entry) => {
      const icon =
        entry.disposition === "passed"
          ? "✅"
          : entry.disposition === "failed"
            ? "❌"
            : entry.disposition === "error"
              ? "⚠️"
              : "➖";
      const rewards = entry.rewards
        ? Object.entries(entry.rewards)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")
        : "";
      return `| ${icon} ${entry.task} | ${entry.disposition} | ${rewards} |`;
    })
    .join("\n");
  const markdown = [
    `# Terminal-Bench 4.0 report (${args.formal ? "formal" : "diagnostic"})`,
    "",
    `| metric | value |`,
    `| --- | --- |`,
    `| dataset | ${frozen.dataset.name}@${frozen.dataset.version} (${frozen.dataset.sourceCommit.slice(0, 7)}) |`,
    `| cli | ${config.cli.packageName}@${config.cli.cliVersion} |`,
    `| model | ${config.provider.model} |`,
    `| expected tasks | ${report.coverage.expected} (${report.coverage.expectedEligible} eligible in Docker, ${report.gpuExcludedTasks.length} GPU-excluded) |`,
    `| present | ${report.coverage.present} |`,
    `| missing | ${report.coverage.missing.length} |`,
    `| passed | ${passed} |`,
    `| failed | ${failed} |`,
    `| error | ${errors} |`,
    `| not-evaluated | ${notEvaluated} |`,
    `| **pass rate** | **${(passRate * 100).toFixed(1)}%** |`,
    `| pass@1 | ${report.passAt1 === null ? "null (diagnostic)" : `${(report.passAt1 * 100).toFixed(1)}%`} |`,
    "",
    "## Per-task verdicts",
    "",
    "| task | disposition | rewards |",
    "| --- | --- | --- |",
    rows,
    "",
  ].join("\n");
  writeFileSync(`${args.output}.md`, markdown);
  process.stdout.write(
    `${JSON.stringify(
      {
        coverage: report.coverage,
        results: report.results,
        passRate,
        passAt1: report.passAt1,
      },
      null,
      2,
    )}\n`,
  );
}

main();