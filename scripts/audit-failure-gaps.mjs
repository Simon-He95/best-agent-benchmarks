// Systematic failure audit: for every REAL model failure (test-failed), compare the
// gold test patch (FAIL_TO_PASS assertions) against the agent's patch and emit a
// structured semantic-gap report for review. Output: docs/failure-gaps.md
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const corpusPath = resolve(repoRoot, "results/corpora", "swe-bench-verified.jsonl");
const ledger = JSON.parse(
  readFileSync(resolve(repoRoot, "results/benchmark-progress.json"), "utf8"),
);

// Corpus lookup.
const corpus = new Map(
  readFileSync(corpusPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      const t = JSON.parse(l);
      return [t.instance_id, t];
    }),
);

// Collect latest fragment per task (agentPatch, evaluationError).
function walk(dir, out) {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith(".json") && f.includes("swe-bench-results")) out.push(p);
  }
}
const frag = new Map();
for (const dir of readdirSync(resolve(repoRoot, ".tmp")).filter((d) => d.startsWith("art"))) {
  const files = [];
  walk(resolve(repoRoot, ".tmp", dir), files);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const t of r.tasks ?? []) {
        if (t.agentPatch) frag.set(t.instance_id, t);
      }
    } catch {}
  }
}

// --- parsing helpers ---
function parseDiffFiles(diffText) {
  const files = [];
  for (const m of String(diffText).matchAll(/^\+\+\+ b\/(.+)$/gm)) files.push(m[1]);
  return files;
}

/** Extract gold-test assertion signals from a test_patch. */
function extractAssertionSignals(testPatch) {
  const signals = [];
  for (const line of String(testPatch).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("+") || t === "+++") continue;
    const body = t.slice(1).trim();
    if (
      /assertEqual|assertIn|assertNotIn|assertRaises|assertIsNone|assertIsNotNone|assertTrue|assertFalse|assertAlmostEqual|assertRaisesMessage|assertWarns/.test(body)
    ) {
      signals.push(body.slice(0, 140));
    }
  }
  return signals;
}

function parseAgentChanges(agentPatch) {
  const changed = new Map();
  for (const m of String(agentPatch).matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    const file = m[2];
    changed.set(file, (changed.get(file) ?? 0) + 1);
  }
  return [...changed.keys()];
}

// --- audit ---
const failed = ledger.tasks.filter((t) => t.state === "test-failed" && !t.resolved);
const lines = [];
lines.push("# Benchmark Failure Audit (semantic gap: gold test vs agent patch)");
lines.push("");
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(`- Real model failures audited: ${failed.length}`);
lines.push("- Source: gold `test_patch` assertions vs agent `agentPatch` (from `.tmp/art-*` fragments)");
lines.push("");
lines.push("## Legend");
lines.push("- **gold asserts**: new/changed FAIL_TO_PASS assertions (the precise behavior the fix must satisfy)");
lines.push("- **agent files**: source files the agent modified");
lines.push("- **gap signal**: the agent patch misses the file/behavior the gold test exercises (or assertion values the agent likely got wrong)");
lines.push("");

let audited = 0;
for (const lt of failed) {
  const task = corpus.get(lt.instance_id);
  if (!task) continue;
  const fr = frag.get(lt.instance_id);
  if (!fr?.agentPatch) continue;
  const testPatch = task.test_patch ?? "";
  const agentPatch = fr.agentPatch;
  const agentFiles = parseAgentChanges(agentPatch);
  const goldFiles = parseDiffFiles(testPatch).filter((f) => f.includes("test"));
  const asserts = extractAssertionSignals(testPatch);
  if (asserts.length === 0 && goldFiles.length === 0) continue;

  audited += 1;
  lines.push(`## ${lt.instance_id}`);
  const failToPass = task.FAIL_TO_PASS ? JSON.parse(task.FAIL_TO_PASS).join("; ") : "";
  if (failToPass) lines.push(`- FAIL_TO_PASS: ${failToPass}`);
  lines.push(`- gold test files: ${goldFiles.join(", ") || "-"}`);
  lines.push(`- agent modified: ${agentFiles.join(", ") || "(none)"}`);
  // Gap signal: gold test file's base module vs agent's source files.
  const testBase = goldFiles.map((f) => f.split("/")[1] ?? f).join("|");
  lines.push(`- gold asserts (${asserts.length}):`);
  for (const a of asserts.slice(0, 12)) lines.push(`  - \`${a}\``);
  lines.push("");
}

lines.push(`\n_Audited ${audited} tasks (had both gold test assertions and an agent patch)._`);
writeFileSync(resolve(repoRoot, "docs/failure-gaps.md"), lines.join("\n") + "\n");
process.stdout.write(`wrote docs/failure-gaps.md — audited ${audited} failures with semantic gap material\n`);
