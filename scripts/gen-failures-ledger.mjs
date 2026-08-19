// Generates docs/benchmark-failures.md — every unresolved task with its state, batch,
// wall time, patch size, and a one-line error head (full material lives in .tmp/art-*).
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(resolve(repoRoot, "results/benchmark-progress.json"), "utf8"),
);

function walk(dir, out) {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".json")) out.push(p);
  }
}

const tmpDir = resolve(repoRoot, ".tmp");
const artDirs = existsSync(tmpDir)
  ? readdirSync(tmpDir)
      .filter((x) => x.startsWith("art") && statSync(resolve(tmpDir, x)).isDirectory())
      .map((x) => resolve(tmpDir, x))
  : [];

// instance_id -> newest fragment record (later art dirs override earlier).
const frag = new Map();
for (const dir of artDirs) {
  const batch = dir.replace(/.*[\\/]/, "");
  const files = [];
  walk(dir, files);
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(f, "utf8"));
      for (const t of r.tasks ?? []) {
        if (!frag.has(t.instance_id)) frag.set(t.instance_id, { batch, t });
      }
    } catch {}
  }
}

const fails = ledger.tasks.filter((t) => !t.resolved);
const lines = [];
lines.push("# Benchmark Failure Ledger (for debugging)");
lines.push("");
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(
  `- Failed tasks: ${fails.length} / ${ledger.tasks.length} (official no-hints ledger)`,
);
lines.push(
  "- Full debug material (agentPatch, environmentError, cliError, agentTrace) lives in `.tmp/art-*` fragments; re-fetch any run with `gh run download <run-id> --dir .tmp/art-<batch>`.",
);
lines.push("");
lines.push("| instance_id | state | batch | wallMs | patchLines | error head |");
lines.push("|---|---|---|---|---|---|");

const byRepo = {};
for (const t of fails) {
  const fr = frag.get(t.instance_id);
  let head = "";
  if (fr) {
    const raw = String(fr.t.evaluationError || fr.t.error || fr.t.cliError || "");
    const hit = raw
      .split("\n")
      .find((l) =>
        /error:|Error:|FAIL|Traceback|No module|openmp|not found|fatal|undefined symbol/i.test(
          l,
        ),
      );
    head = (hit ?? "").trim().slice(0, 110);
  }
  const repo = t.instance_id.split("__")[0] ?? "?";
  byRepo[repo] = (byRepo[repo] ?? 0) + 1;
  lines.push(
    [
      `| ${t.instance_id}`,
      t.state,
      fr ? fr.batch : t.batch,
      t.wallMs ? `${Math.round(t.wallMs / 1000)}s` : "-",
      t.patchLines ?? "-",
      head,
      "|",
    ].join(" | "),
  );
}

lines.push("");
lines.push("## By repo");
for (const [r, n] of Object.entries(byRepo).sort((a, b) => b[1] - a[1])) {
  lines.push(`- ${r}: ${n}`);
}

writeFileSync(resolve(repoRoot, "docs/benchmark-failures.md"), lines.join("\n") + "\n");
process.stdout.write(`wrote docs/benchmark-failures.md (${fails.length} failed tasks)\n`);
