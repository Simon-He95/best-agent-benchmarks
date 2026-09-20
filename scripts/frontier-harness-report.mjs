#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 aggregate report.
 *
 * Merges frozen per-task harness records into one report. The report only
 * transcribes Pier's canonical trial verdicts (passed/failed/error) and
 * computes the solved fraction; it never re-grades tasks.
 *
 * Usage:
 *   node scripts/frontier-harness-report.mjs \
 *     --results <dir> --corpus <manifest> --expected-tasks <list> \
 *     --output <report.json> [--formal]
 *
 * Semantics:
 *   - This is a self-run diagnostic reproduction of the published FrontierHarness
 *     task set on GitHub-hosted runners; it is not comparable to the
 *     frontierharness.org leaderboard (different runtime, isolation, and network
 *     policy), so passAt1 stays null unless --formal declares a complete,
 *     predeclared single-attempt run over the full expected set.
 *   - GPU tasks are excluded from the Docker-environment expected set and listed
 *     separately (no GPU on hosted runners).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "frontier-harness.json"), "utf8"),
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
  // The corpus' own Docker-eligible population, independent of the expected
  // list this run declared: `fullExpected` compares the two, so a run that
  // declares only a subset of the corpus can never be a formal full-corpus claim.
  const corpusEligible = (frozen.tasks ?? [])
    .map((task) => task.name)
    .filter((name) => !gpuTasks.has(name));
  const expectedEligible = [...expectedSet].filter((name) => !gpuTasks.has(name));
  if (expectedEligible.length === 0) throw new Error("Expected set has no eligible tasks.");

  const records = [];
  for (const file of readdirSync(args.results)) {
    if (!/^frontier-harness-results\./u.test(file)) continue;
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
  // `fullExpected` mirrors the terminal-bench report: the predeclared expected
  // list must be the whole Docker-eligible corpus, not a subset.
  const fullExpected =
    corpusEligible.length > 0 &&
    expectedSet.size === corpusEligible.length &&
    corpusEligible.every((name) => expectedSet.has(name));
  const passRate = passed / expectedEligible.length;
  // passAt1 is the formal headline and only a clean run may claim it: any trial
  // without a verdict (infrastructure death) or an interrupted subset leaves it
  // null. This is the same gate the terminal-bench report applies, so a run
  // containing an outage can never be published as a formal pass@1 — the raw
  // rate below stays visible either way.
  const scoreable =
    fullExpected &&
    complete &&
    errors === 0 &&
    notEvaluated === 0;
  // The published FrontierHarness convention scores passes over *valid cells*: a
  // trial whose agent died on infrastructure carries no verdict, so it leaves the
  // denominator instead of being graded as a task failure. It is a secondary
  // view: it only holds if the invalid cells are unrelated to task difficulty,
  // so `passRate` (raw, never inflated) stays the primary number and the
  // coverage block always reports how many cells were dropped.
  const validCells = passed + failed;
  const passRateValidCells = validCells === 0 ? null : passed / validCells;

  // Provider-reported usage is summed over the tasks that reported it; a task
  // without a usage record is absent, never a zero, and cost stays null until the
  // benchmark has a frozen price table (the CLI reports raw tokens only).
  const usageRecords = counted.filter((record) => record.usage !== undefined);
  const usageSum = (key) =>
    usageRecords.reduce((total, record) => total + (record.usage[key] ?? 0), 0);
  const usage =
    usageRecords.length === 0
      ? null
      : {
          tasks: usageRecords.length,
          promptTokens: usageSum("promptTokens"),
          completionTokens: usageSum("completionTokens"),
          cacheReadTokens: usageSum("cacheReadTokens"),
          totalTokens: usageSum("totalTokens"),
          modelCallCount: usageSum("modelCallCount"),
          costUsd: usageRecords.every((record) => record.usage.costUsd === null)
            ? null
            : usageSum("costUsd"),
        };

  const report = {
    schemaVersion: 1,
    profileId: frozen.profileId,
    dataset: frozen.dataset,
    pier: config.pier,
    cli: config.cli,
    provider: config.provider,
    formal: args.formal,
    comparability: "diagnostic self-run on GitHub-hosted runners; not comparable to the published frontierharness.org leaderboard",
    gpuExcludedTasks: [...gpuTasks].filter((name) => expectedSet.has(name)),
    coverage: {
      expected: expectedSet.size,
      expectedEligible: expectedEligible.length,
      present: present.length,
      missing,
      fullExpected,
    },
    results: {
      passed,
      failed,
      error: errors,
      notEvaluated,
    },
    passRate,
    validCells,
    passRateValidCells,
    scoreable,
    passAt1: args.formal && scoreable ? passRate : null,
    usage,
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
        usage: record.usage ?? undefined,
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
      const tokens = entry.usage
        ? `in ${entry.usage.promptTokens ?? "-"} / cache ${entry.usage.cacheReadTokens ?? "-"} / out ${entry.usage.completionTokens ?? "-"}`
        : "-";
      return `| ${icon} ${entry.task} | ${entry.disposition} | ${rewards} | ${tokens} |`;
    })
    .join("\n");
  const markdown = [
    `# FrontierHarness Eval v1.0 report (${args.formal ? "formal" : "diagnostic"})`,
    "",
    `| metric | value |`,
    `| --- | --- |`,
    `| dataset | ${frozen.dataset.name}@${frozen.dataset.sourceCommit.slice(0, 7)} (${frozen.dataset.taskCount} tasks) |`,
    `| runner | pier ${config.pier.version} (${config.pier.environment}) on GitHub-hosted runners |`,
    `| cli | ${config.cli.packageName}@${config.cli.cliVersion} |`,
    `| model | ${config.provider.model} (reasoning ${config.provider.reasoningEffort}) |`,
    `| expected tasks | ${report.coverage.expected} (${report.coverage.expectedEligible} eligible in Docker, ${report.gpuExcludedTasks.length} GPU-excluded) |`,
    `| present | ${report.coverage.present} |`,
    `| missing | ${report.coverage.missing.length} |`,
    `| passed | ${passed} |`,
    `| failed | ${failed} |`,
    `| error | ${errors} |`,
    `| not-evaluated | ${notEvaluated} |`,
    `| **pass rate** | **${(passRate * 100).toFixed(1)}%** |`,
    `| valid cells | ${validCells} of ${expectedEligible.length} (${expectedEligible.length - validCells} without a verdict) |`,
    `| pass rate (valid cells, secondary) | ${passRateValidCells === null ? "null (no valid cell)" : `${(passRateValidCells * 100).toFixed(1)}% (${passed}/${validCells})`} |`,
    `| scoreable | ${scoreable ? "yes" : "no — a verdict is missing"} |`,
    `| pass@1 | ${report.passAt1 === null ? (args.formal ? "null (a verdict is missing)" : "null (diagnostic)") : `${(report.passAt1 * 100).toFixed(1)}%`} |`,
    "",
    "> Self-run on GitHub-hosted runners; not comparable to the published frontierharness.org leaderboard.",
    "",
    "## Per-task verdicts",
    "",
    "| task | disposition | rewards | tokens (in / cache / out) |",
    "| --- | --- | --- | --- |",
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
        validCells,
        passRateValidCells,
        scoreable,
        passAt1: report.passAt1,
      },
      null,
      2,
    )}\n`,
  );
}

main();
