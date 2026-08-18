#!/usr/bin/env node
// Generates the final 500-task attribution report from the reconciled ledger.
// Writes docs/benchmark-final-report.md (human) and results/benchmark-final-report.json.
//
// Attribution per failed task:
//   upstream-400       reasoning_content pass-back 400 (relay instability; rerun usually passes)
//   upstream-transport ECONNRESET / Bad Gateway / Cannot connect
//   env-blocked        evaluation environment failed to build (astropy-era C/build issues)
//   no-diff            agent completed without producing a diff
//   test-failed        agent patch exists but tests fail — MODEL CAPABILITY (needs prompt/model work)
//   other/unknown      unclassified
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

const ledger = readJson(resolve(repoRoot, "results", "benchmark-progress.json"));
if (!ledger) {
  process.stderr.write("ledger missing\n");
  process.exit(1);
}

// Corpus reference patches for patch-vs-reference comparison.
let corpus = [];
try {
  const lines = readFileSync(
    resolve(repoRoot, "results", "corpora", "swe-bench-verified.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  corpus = lines.map((l) => JSON.parse(l));
} catch {
  corpus = [];
}
const byId = new Map(corpus.map((d) => [d.instance_id, d]));

function classify(task) {
  if (task.resolved) return "resolved";
  const cli = task.cliError || "";
  if (task.state === "env-blocked" || task.state === "env") return "env-blocked";
  if (cli.includes("must be passed back")) return "upstream-400";
  if (cli.includes("ECONNRESET") || cli.includes("Bad Gateway") || cli.includes("Cannot connect")) {
    return "upstream-transport";
  }
  if (task.state === "test-failed") return "test-failed";
  if (task.state === "no-diff") return "no-diff";
  return task.state || "unknown";
}

function patchComparison(task) {
  const ref = byId.get(task.instance_id);
  if (!ref) return undefined;
  const modelFiles = [...new Set((task.agentPatch || "").match(/^diff --git a\/(.+?) b/gm) || [])]
    .map((x) => x.replace("diff --git a/", ""));
  const refFiles = [...new Set((ref.patch || "").match(/^diff --git a\/(.+?) b/gm) || [])].map(
    (x) => x.replace("diff --git a/", ""),
  );
  const sameFiles = JSON.stringify(modelFiles.sort()) === JSON.stringify(refFiles.sort());
  const modelLines = ((task.agentPatch || "").match(/^\+(?!\+)/gm) || []).length;
  const refLines = ((ref.patch || "").match(/^\+(?!\+)/gm) || []).length;
  return { sameFiles, modelLines, refLines };
}

const tasks = ledger.tasks || [];
const byAttribution = {};
for (const t of tasks) {
  const a = classify(t);
  byAttribution[a] = (byAttribution[a] || 0) + 1;
}

const order = [
  "resolved",
  "upstream-400",
  "upstream-transport",
  "env-blocked",
  "no-diff",
  "test-failed",
  "other",
  "unknown",
];

const lines = [];
lines.push("# SWE-bench Verified 500-task Final Report");
lines.push("");
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(`- Tasks tracked: ${tasks.length}`);
lines.push("");
lines.push("## Overall");
lines.push("");
const resolved = byAttribution.resolved || 0;
lines.push(`| Metric | Value |`);
lines.push(`|--------|-------|`);
lines.push(
  `| **Resolved** | **${resolved} / ${tasks.length} (${((resolved / tasks.length) * 100).toFixed(1)}%)** |`,
);
lines.push("");

lines.push("## Failure attribution");
lines.push("");
lines.push("| Attribution | Count | Meaning |");
lines.push("|-------------|-------|---------|");
const meaning = {
  "upstream-400": "relay/DeepSeek intermittent reasoning pass-back 400 — rerun usually passes",
  "upstream-transport": "ECONNRESET / Bad Gateway — upstream transient",
  "env-blocked": "evaluation environment could not build (astropy-era C/SDK issues)",
  "no-diff": "agent completed without editing (prompt behavior)",
  "test-failed": "MODEL CAPABILITY — patch present but tests fail",
  other: "unclassified",
  unknown: "missing diagnostics",
};
for (const a of order) {
  if (byAttribution[a]) lines.push(`| ${a} | ${byAttribution[a]} | ${meaning[a] || ""} |`);
}
lines.push("");

lines.push("## Remaining failures per task (model-capability candidates)");
lines.push("");
lines.push("| instance_id | state | failing test | patch vs reference |");
lines.push("|-------------|-------|--------------|--------------------|");
for (const t of tasks.sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
  const a = classify(t);
  if (a === "resolved" || a === "upstream-400" || a === "upstream-transport" || a === "env-blocked") {
    continue;
  }
  const cmp = patchComparison(t);
  const failTest = (t.failingTest || "?").slice(0, 55);
  const cmpStr = cmp ? `${cmp.sameFiles ? "同文件" : "异文件"} (+${cmp.modelLines}/${cmp.refLines})` : "-";
  lines.push(`| ${t.instance_id} | ${a} | ${failTest.replace(/\|/g, "\\|")} | ${cmpStr} |`);
}
lines.push("");

const mdPath = resolve(repoRoot, "docs", "benchmark-final-report.md");
const jsonPath = resolve(repoRoot, "results", "benchmark-final-report.json");
mkdirSync(resolve(repoRoot, "docs"), { recursive: true });
writeFileSync(mdPath, lines.join("\n"));
writeFileSync(
  jsonPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), byAttribution, tasks }, null, 2),
);
process.stdout.write(`wrote> ${mdPath}\nwrote> ${jsonPath}\n`);
process.stdout.write(`attribution: ${JSON.stringify(byAttribution)}\n`);