#!/usr/bin/env node
// Reconciles every benchmark result source into one task-level progress ledger:
// docs/benchmark-progress.md (+ results/benchmark-progress.json).
//
// Sources (newest wins for the same task):
//   - local run fragments: swe-bench-results.deepseek-v4-flash-b1.shard-*.json (repo root)
//   - downloaded run artifacts under .tmp/art-* dirs
//   - offline re-evaluations: results/swe-bench-b1-reeval.json
//   - live results: results/swe-bench-results.json
//
// Classification per task: resolved | test-failed | no-diff | transport-loss
// (ECONNRESET/Bad Gateway) | stat-polluted (beta.4 stat bug) | env-blocked |
// relay-overloaded | timed-out | other.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultsDir = resolve(repoRoot, "results");
const docsDir = resolve(repoRoot, "docs");

const BATCH_ORDER = [
  "b1",
  "b1-reeval",
  "b1-rerun",
  "b1-rerun-final",
  "stat-rerun",
  "b1-nopatch",
  "b2",
  "stat-rerun2",
  "b2-testfailed",
  "live",
];

// .tmp artifact dir -> batch name (order matters: later wins for the same task).
const ARTIFACT_BATCH = {
  artifacts: "b1-rerun",
  art3: "b1-rerun-final",
  artsr: "stat-rerun",
  artb2: "b2",
  artsr2: "stat-rerun2",
  artb1n: "b1-nopatch",
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Gathers one record per task from a result file.
function recordsFromResult(file, batch, source) {
  const data = readJson(file);
  if (!data || !Array.isArray(data.tasks)) return [];
  return data.tasks.flatMap((t) => {
    if (!t?.instance_id) return [];
    return [
      {
        instance_id: t.instance_id,
        batch,
        source,
        resolved: Boolean(t.resolved),
        error: t.error,
        failureKind: t.failureKind,
        cliError: t.cliError,
        evaluationError: t.evaluationError,
        environmentError: t.environmentError,
        wallMs: t.wallMs,
        agentTraceBytes: t.agentTraceBytes,
        patchLines: t.patchLines,
        verification: t.verification,
      },
    ];
  });
}

function collectAllRecords() {
  const records = [];

  // 1. Repository-root legacy b1 fragments (the original 125-task b1 run).
  for (const file of readdirSync(repoRoot).filter((f) =>
    f.startsWith("swe-bench-results.deepseek-v4-flash-b1.shard-"),
  )) {
    records.push(...recordsFromResult(resolve(repoRoot, file), "b1", "root-fragment"));
  }

  // 2. Downloaded artifacts under .tmp/art-* and results/.
  const tmpDir = resolve(repoRoot, ".tmp");
  if (existsSync(tmpDir)) {
    for (const dir of readdirSync(tmpDir).filter((d) => d.startsWith("art"))) {
      const candidate = resolve(tmpDir, dir, "swe-bench-results", "swe-bench-results.json");
      if (!existsSync(candidate)) continue;
      const batch = ARTIFACT_BATCH[dir] ?? dir;
      records.push(...recordsFromResult(candidate, batch, "artifact"));
    }
  }

  // 3. Offline re-evaluations.
  const reeval = resolve(resultsDir, "swe-bench-b1-reeval.json");
  if (existsSync(reeval)) records.push(...recordsFromResult(reeval, "b1-reeval", "reeval"));

  // 4. Live latest results (results/swe-bench-results.json) are often ad-hoc local
  // re-evaluations; exclude them so they cannot override full-batch artifacts.
  // const live = resolve(resultsDir, "swe-bench-results.json");
  // if (existsSync(live)) records.push(...recordsFromResult(live, "live", "live"));

  return records;
}

function classify(record) {
  if (record.resolved) return "resolved";
  if (record.environmentBlocked || record.environmentError) return "env-blocked";
  const cli = record.cliError || "";
  if (cli.includes("stat:unknown:malformed")) return "stat-polluted";
  if (cli.includes("ECONNRESET") || cli.includes("Bad Gateway")) return "transport-loss";
  if (cli.includes("relay")) return "relay-overloaded";
  if (record.error === "Agent produced no diff") return "no-diff";
  if (record.failureKind === "test-failed" || record.evaluationError) return "test-failed";
  if (record.error) return "other";
  return "unknown";
}

function main() {
  const records = collectAllRecords();
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.instance_id);
    if (!existing || BATCH_ORDER.indexOf(record.batch) > BATCH_ORDER.indexOf(existing.batch)) {
      byId.set(record.instance_id, record);
    }
  }

  const tasks = [...byId.values()].map((r) => ({
    instance_id: r.instance_id,
    repo: r.instance_id.split("__")[0] ?? "",
    batch: r.batch,
    state: classify(r),
    resolved: r.resolved,
    patchLines: r.patchLines,
    agentTraceBytes: r.agentTraceBytes,
    failingTest: (r.evaluationError || "").match(/(?:FAIL|ERROR): ([^\n]+)/)?.[1]?.slice(0, 60),
    cliError: (r.cliError || "").slice(0, 120),
    wallMs: r.wallMs,
  }));

  const byState = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
  const stateOrder = [
    "resolved",
    "test-failed",
    "no-diff",
    "transport-loss",
    "stat-polluted",
    "env-blocked",
    "relay-overloaded",
    "timed-out",
    "other",
    "unknown",
  ];

  const lines = [];
  lines.push("# Benchmark Progress Ledger");
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Tasks tracked: ${tasks.length}`);
  lines.push("");
  lines.push("## Summary by state");
  lines.push("");
  lines.push("| State | Count |");
  lines.push("|-------|-------|");
  for (const state of stateOrder) {
    if (byState[state] !== undefined) lines.push(`| ${state} | ${byState[state]} |`);
  }
  lines.push("");
  lines.push("## Per-task ledger (instance_id, batch, state, failing test)");
  lines.push("");
  lines.push("| instance_id | batch | state | patchLines | failing test |");
  lines.push("|-------------|-------|-------|------------|--------------|");
  for (const t of tasks.sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    lines.push(
      `| ${t.instance_id} | ${t.batch} | ${t.state} | ${t.patchLines ?? "-"} | ${(t.failingTest || "").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  mkdirSync(docsDir, { recursive: true });
  const mdPath = resolve(docsDir, "benchmark-progress.md");
  const jsonPath = resolve(resultsDir, "benchmark-progress.json");
  writeFileSync(mdPath, lines.join("\n"));
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), byState, tasks }, null, 2),
  );
  process.stdout.write(`wrote> ${mdPath}\nwrote> ${jsonPath}\n`);
  process.stdout.write(`states: ${JSON.stringify(byState)}\n`);
}

main();