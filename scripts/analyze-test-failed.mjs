// Analyzes test-failed tasks: separates real model failures (FAIL_TO_PASS assertions
// ran and failed) from fake ones (test-run errors: timeout, import errors, missing deps,
// crash, etc. — likely harness/environment issues, not model capability).
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
        if (ids.has(t.instance_id) && t.evaluationError) frag.set(t.instance_id, t);
      }
    } catch {}
  }
}

// Classify evaluationError into "real assertion fail" vs "test-run error".
function classifyEval(errText) {
  const t = errText ?? "";
  const upper = t.toUpperCase();
  if (/FAILED|FAIL:|ERROR:|FAIL TO PASS|assertion|AssertionError|FAIL \(1\)|tests failed|failed -/.test(upper)) {
    return "real-fail"; // assertions actually ran and failed
  }
  if (/timeout|timed out|SIGKILL|killed|Traceback|ModuleNotFound|No module|ImportError|error:|segmentation|core dumped|exit status/.test(upper)) {
    return "test-run-error";
  }
  if (t.length === 0) return "empty";
  return "ambiguous";
}

const counts = { real: 0, runError: 0, ambiguous: 0, missing: 0 };
const samples = { real: [], runError: [], ambiguous: [] };
for (const t of tfs) {
  const fr = frag.get(t.instance_id);
  const kind = fr ? classifyEval(fr.evaluationError) : "missing";
  counts[kind === "real-fail" ? "real" : kind === "test-run-error" ? "runError" : kind] =
    (counts[kind === "real-fail" ? "real" : kind === "test-run-error" ? "runError" : kind] ?? 0) + 1;
  if (kind === "runError" && samples.runError.length < 8) {
    const lines = String(fr.evaluationError).split("\n");
    const hit = lines.find((l) => /timeout|Error|No module|Traceback|killed/i.test(l));
    samples.runError.push(`${t.instance_id}: ${(hit ?? lines.slice(-1)[0]).trim().slice(0, 110)}`);
  }
  if (kind === "ambiguous" && samples.ambiguous.length < 6) {
    const lines = String(fr.evaluationError).split("\n").slice(0, 4).join(" | ");
    samples.ambiguous.push(`${t.instance_id}: ${lines.slice(0, 120)}`);
  }
}

console.log(`test-failed 分类（共 ${tfs.length}）:`);
console.log(`  真模型失败（断言跑了且失败）: ${counts.real}`);
console.log(`  测试运行错误（环境/harness 疑点）: ${counts.runError}`);
console.log(`  模糊/空: ${counts.ambiguous + counts.empty}`);
console.log("");
if (samples.runError.length) {
  console.log("== 测试运行错误样本 ==");
  for (const s of samples.runError) console.log("  " + s);
}
console.log("");
if (samples.ambiguous.length) {
  console.log("== 模糊样本 ==");
  for (const s of samples.ambiguous) console.log("  " + s);
}
