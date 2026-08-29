// Analyzes failed tasks from the beta.8 batches (#67/#68) — why did they still fail.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(resolve(repoRoot, "results/benchmark-progress.json"), "utf8"),
);

// beta.8 completed batches so far: r1 (#67), r2 (#68)
const batchNames = ["r1", "r2", "rb3"];
const ids = new Set();
const byTask = new Map();
for (const bn of batchNames) {
  const dir = resolve(repoRoot, ".tmp", `art-${bn}`);
  const walk = (d, out) => {
    for (const f of readdirSync(d)) {
      const p = resolve(d, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, out);
      else if (f.endsWith(".json") && f.includes("swe-bench-results")) out.push(p);
    }
  };
  const files = [];
  walk(dir, files);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const t of r.tasks ?? []) {
        ids.add(t.instance_id);
        byTask.set(t.instance_id, { t, batch: bn });
      }
    } catch {}
  }
}

// Only tasks that are still failing in the ledger (beta.8 did not resolve them).
const failed = ledger.tasks.filter(
  (lt) => !lt.resolved && ids.has(lt.instance_id),
);
console.log(`beta.8 已跑批次中仍失败的任务: ${failed.length}\n`);

function classify(t) {
  const evalErr = String(t.evaluationError ?? "");
  const cliErr = String(t.cliError ?? "");
  if (/max-model-cycles|cycle limit/i.test(cliErr)) return "CLI max-model-cycles";
  if (/transport|ECONNRESET|ETIMEDOUT|Bad Gateway|无效的令牌|must be passed back/i.test(cliErr))
    return "transport/认证";
  if (/Agent produced no diff/.test(String(t.error ?? ""))) return "no-diff（模型未产出补丁）";
  if (t.timedOut) return "超时（30min 未完成）";
  if (/timeout|timed out|SIGKILL|killed/i.test(evalErr)) return "测试运行超时";
  if (/ModuleNotFound|No module|ImportError/i.test(evalErr)) return "测试缺依赖";
  if (/FAILED|FAIL:|AssertionError|tests failed/i.test(evalErr)) return "真实断言失败";
  if (/Traceback/.test(evalErr)) return "测试运行异常(Traceback)";
  if (evalErr) return "测试失败(其他): " + evalErr.split("\n").slice(-1)[0].slice(0, 70);
  if (cliErr) return "CLI 失败: " + cliErr.split("\n")[0].slice(0, 70);
  return "其他";
}

const clusters = {};
const detail = [];
for (const lt of failed) {
  const { t, batch } = byTask.get(lt.instance_id) ?? {};
  const cause = classify(t ?? {});
  clusters[cause] = clusters[cause] ?? [];
  clusters[cause].push(lt.instance_id);
  if (cause.startsWith("真实断言失败")) {
    detail.push({ id: lt.instance_id, batch, eval: String(t?.evaluationError ?? "").split("\n").slice(-2).join(" ").slice(0, 120) });
  }
}

for (const [cause, items] of Object.entries(clusters).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`[${items.length}] ${cause}`);
  console.log("   " + items.join(", "));
  console.log("");
}

if (detail.length) {
  console.log("== 真实断言失败样本 ==");
  for (const d of detail.slice(0, 8)) console.log(`  ${d.id} (${d.batch}): ${d.eval}`);
}
