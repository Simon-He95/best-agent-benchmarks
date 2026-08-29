// Samples test-failed agent traces to judge rescue-ability:
//  - "root-cause" tasks: model identified the bug location but failed the assertion
//    (LSP/verification feedback could help)
//  - "lost" tasks: model never found the bug (tools won't help much)
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(resolve(repoRoot, "results/benchmark-progress.json"), "utf8"),
);
const tfs = ledger.tasks.filter((t) => t.state === "test-failed");
const ids = new Set(tfs.map((t) => t.instance_id));

function walk(dir, out) {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".json")) out.push(p);
  }
}
const frag = new Map();
for (const dir of readdirSync(resolve(repoRoot, ".tmp")).filter((x) => x.startsWith("art"))) {
  const files = [];
  walk(resolve(repoRoot, ".tmp", dir), files);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const t of r.tasks ?? []) {
        if (ids.has(t.instance_id)) frag.set(t.instance_id, t);
      }
    } catch {}
  }
}

// Heuristic on the final assistant trace: does the model claim to have found & fixed
// a root cause, or did it drift / admit defeat / never locate the issue?
const samples = [];
for (const t of tfs) {
  const fr = frag.get(t.instance_id);
  const trace = String(fr?.agentTrace ?? "");
  if (trace.length < 120) continue;
  const lower = trace.toLowerCase();
  let bucket = "unknown";
  if (/could not|unable to|i couldn't|failed to reproduce|can't reproduce|not sure|uncertain|did not find|no obvious|couldn't find/.test(lower)) {
    bucket = "lost-no-root-cause";
  } else if (/root cause|the issue is|the bug|the problem is|traced|identified|located|reproduced|investigated|found that|the fix is/.test(lower)) {
    bucket = "found-root-cause";
  }
  samples.push({ id: t.instance_id, bucket, trace: trace.slice(0, 260) });
  if (samples.filter((s) => s.bucket === "found-root-cause").length >= 10 && samples.length >= 24) break;
}

const counts = {};
for (const s of samples) counts[s.bucket] = (counts[s.bucket] ?? 0) + 1;
console.log(`抽样 ${samples.length} 个 test-failed 的 agent 最终总结:`);
console.log(`  声称找到根因/修复: ${counts["found-root-cause"] ?? 0}`);
console.log(`  承认没找到/无法复现: ${counts["lost-no-root-cause"] ?? 0}`);
console.log(`  其他: ${counts["unknown"] ?? 0}`);
console.log("");
console.log("== found-root-cause 样本 ==");
for (const s of samples.filter((x) => x.bucket === "found-root-cause").slice(0, 5)) {
  console.log(`--- ${s.id} ---`);
  console.log("  " + s.trace.replace(/\n/g, " ").slice(0, 240));
}
console.log("");
console.log("== lost 样本 ==");
for (const s of samples.filter((x) => x.bucket === "lost-no-root-cause").slice(0, 5)) {
  console.log(`--- ${s.id} ---`);
  console.log("  " + s.trace.replace(/\n/g, " ").slice(0, 240));
}
