// Clusters the env-blocked tasks by their actual error cause (latest fragment).
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(resolve(repoRoot, "results/benchmark-progress.json"), "utf8"),
);
const envs = ledger.tasks.filter((t) => t.state === "env-blocked");
const ids = new Set(envs.map((t) => t.instance_id));

function walk(dir, out) {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".json")) out.push(p);
  }
}

const tmpDir = resolve(repoRoot, ".tmp");
const frag = new Map();
for (const dir of readdirSync(tmpDir).filter((x) => x.startsWith("art"))) {
  const files = [];
  walk(resolve(tmpDir, dir), files);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const t of r.tasks ?? []) {
        if (ids.has(t.instance_id) && t.environmentError) {
          frag.set(t.instance_id, t); // later art dirs override earlier
        }
      }
    } catch {}
  }
}

function classify(errText) {
  const t = errText ?? "";
  if (/unsupported option '-fopenmp'|extra options: '-fopenmp'|libgomp|openmp/.test(t)) return "OpenMP(-fopenmp, macOS clang 无 libomp)";
  if (/freetype|ftgzip|zconf|FAR Bytef|freetype-2\.6\.1|libtool/.test(t)) return "matplotlib 内置 freetype 2.6.1 编译(Xcode26/libtool)";
  if (/use of undeclared identifier '__null'/.test(t)) return "__null(C 模式误用)";
  if (/expected identifier or '\('/.test(t) && /_stdio\.h/.test(t)) return "Xcode26 SDK _stdio.h NULL 冲突";
  if (/No module named 'Cython'/.test(t)) return "缺 Cython";
  if (/Multiple top-level packages/.test(t)) return "setuptools flat-layout";
  if (/ModuleNotFoundError|No module named/.test(t)) return "缺 Python 依赖";
  if (/OSError: \[Errno 66\]|Directory not empty/.test(t)) return "setup_requires os.rename Errno66";
  if (/fetch_build_egg|setup_requires/.test(t)) return "setup_requires 机制失败";
  if (t.length > 0) {
    // one-line cause: first error-ish line, minus the /var/folders noise
    const line = t.split("\n").find((l) => /error:|Error:|fatal|clang|gcc|No module/i.test(l));
    return "其他: " + (line ?? t.split("\n").slice(-2).join(" ")).replace(/\/private[^ ]*/g, "<T>").slice(0, 100);
  }
  return "无环境错误记录";
}

const clusters = {};
for (const t of envs) {
  const fr = frag.get(t.instance_id);
  const cause = classify(fr?.environmentError ?? fr?.error ?? "");
  clusters[cause] = clusters[cause] ?? [];
  clusters[cause].push(t.instance_id);
}

console.log("env-blocked 归因聚类（共 " + envs.length + "）:\n");
for (const [cause, items] of Object.entries(clusters).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`[${items.length}] ${cause}`);
  console.log("    " + items.join(", "));
  console.log("");
}
