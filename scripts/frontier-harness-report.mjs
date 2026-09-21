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

  // The report states the effort the attempts actually ran at. Each frozen
  // record carries the materialized effort, the records of one run must agree on
  // it, and it must be one the frozen provider profile declares — a run can
  // therefore never be reported under an effort it did not use.
  const effortOptions = config.provider.reasoningEffortOptions;
  const efforts = new Set(
    counted.map((record) => {
      const effort = record.reasoningEffort;
      if (!Array.isArray(effortOptions) || !effortOptions.includes(effort)) {
        throw new Error(
          `${record.task.name} carries no declared reasoning effort (${String(effort)}).`,
        );
      }
      return effort;
    }),
  );
  if (efforts.size > 1) {
    throw new Error(
      `Frozen records disagree on the reasoning effort: ${[...efforts].sort().join(", ")}.`,
    );
  }
  const reasoningEffort = efforts.size === 1 ? [...efforts][0] : config.provider.reasoningEffort;

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

  // Acceptance: the named criteria a run must satisfy before any capability reading
  // may be claimed from it. Every criterion is derived from facts this report owns —
  // the frozen per-task records, the frozen corpus and the frozen provider profile —
  // and every failure is reported rather than thrown, so a broken run still produces
  // a report that says exactly why it cannot support a capability claim.
  //
  // `scoreable` above stays the narrower, older question ("does every expected task
  // have a verdict?"); this block is the stricter one a published number needs, and
  // `passAt1` requires it. The per-task delivery diagnosis (a build that never
  // compiled) is deliberately not repeated here: it belongs to the failure analysis,
  // which owns the verifier logs, and duplicating that judgement would create a
  // second interpretation of the same fact.
  const corpusInstruction = new Map(
    (frozen.tasks ?? []).map((task) => [task.name, task.instructionSha256]),
  );
  const identityOf = (record) =>
    [record.candidateId, record.cliVersion, record.cliBinarySha256, record.candidateManifestSha256]
      .map((value) => (value === undefined || value === null ? "missing" : String(value)))
      .join("|");
  const identities = [...new Set(counted.map(identityOf))].sort();
  const models = [...new Set(counted.map((record) => String(record.model)))].sort();
  const driftedInstructions = counted.filter(
    (record) => record.task.instructionSha256 !== corpusInstruction.get(record.task.name),
  );
  const acceptance = [
    {
      id: "coverage.full",
      status: fullExpected ? "passed" : "failed",
      detail: `${expectedSet.size} of ${corpusEligible.length} Docker-eligible corpus tasks were predeclared`,
    },
    {
      id: "verdicts.complete",
      status: complete && errors === 0 && notEvaluated === 0 ? "passed" : "failed",
      detail: `${present.length} present, ${missing.length} missing, ${errors} error, ${notEvaluated} not-evaluated`,
    },
    {
      id: "candidate.single",
      status: counted.length > 0 && identities.length === 1 ? "passed" : "failed",
      detail:
        identities.length === 1
          ? `${counted.length} records agree on one frozen candidate (${identities[0]})`
          : `${identities.length} distinct candidate identities across ${counted.length} records: ${identities.join(" | ")}`,
    },
    {
      id: "provider.single",
      status: models.length === 1 && models[0] === config.provider.model ? "passed" : "failed",
      detail: `model(s) ${models.join(", ") || "none"} at reasoning effort ${reasoningEffort}; the frozen profile is ${config.provider.model}`,
    },
    {
      id: "instructions.frozen",
      status: counted.length > 0 && driftedInstructions.length === 0 ? "passed" : "failed",
      detail:
        driftedInstructions.length === 0
          ? `${counted.length} records match the frozen instruction hash of their task`
          : `records do not match the frozen instruction hash of their task: ${driftedInstructions
              .map((record) => record.task.name)
              .sort()
              .join(", ")}`,
    },
  ];
  const capabilityMeasurement = acceptance.every((entry) => entry.status === "passed");
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
    provider: { ...config.provider, reasoningEffort },
    formal: args.formal,
    comparability: "diagnostic self-run on GitHub-hosted runners; not comparable to the published frontierharness.org leaderboard",
    gpuExcludedTasks: [...gpuTasks].filter((name) => expectedSet.has(name)),
    // Declared corpus fact, not a recomputed score: these tasks' pinned
    // instructions omit a rule their hidden tests require, so their verdicts stay
    // canonical while a capability comparison excludes them. passRate and passAt1
    // are unchanged.
    specificationGapTasks: (config.specificationGaps?.tasks ?? [])
      .map((entry) => entry.task)
      .filter((name) => expectedSet.has(name)),
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
    // Acceptance is the stricter gate: the formal headline requires every named
    // criterion, so a run that mixes candidates, providers or instruction versions
    // can never carry a capability number.
    acceptance,
    capabilityMeasurement,
    passAt1: args.formal && capabilityMeasurement ? passRate : null,
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
    `| model | ${config.provider.model} (reasoning ${reasoningEffort}) |`,
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
    `| capability measurement | ${capabilityMeasurement ? "yes" : "no — an acceptance criterion failed"} |`,
    `| pass@1 | ${
      report.passAt1 === null
        ? args.formal
          ? `null (${capabilityMeasurement ? "a verdict is missing" : "an acceptance criterion failed"})`
          : "null (diagnostic)"
        : `${(report.passAt1 * 100).toFixed(1)}%`
    } |`,
    "",
    "## Acceptance",
    "",
    "A published capability number requires every criterion below.",
    "",
    "| criterion | status | detail |",
    "| --- | --- | --- |",
    ...acceptance.map(
      (entry) => `| ${entry.id} | ${entry.status === "passed" ? "passed" : "**failed**"} | ${entry.detail} |`,
    ),
    "",
    "> Self-run on GitHub-hosted runners; not comparable to the published frontierharness.org leaderboard.",
    "",
    ...(report.specificationGapTasks.length === 0
      ? []
      : [
          `> Excluded from capability comparisons: ${report.specificationGapTasks.length} task(s) whose pinned`,
          "> instruction omits a rule their hidden tests require",
          `> (${report.specificationGapTasks.join(", ")}). Their verdicts above stand unchanged.`,
          "",
        ]),
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
        reasoningEffort,
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
