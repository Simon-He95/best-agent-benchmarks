#!/usr/bin/env node
// One-command post-run processing for the SWE-bench verification pipeline:
//   node scripts/process-run.mjs <run-id> [batch-name]
//
// 1. Downloads the run artifacts into .tmp/art-<batch-name> (the reconcile order
//    entry point), 2. re-runs the ledger reconciliation, 3. emits a classification
//    of NEW failures in this run (upstream-400 / transport / env / test-failed /
//    no-diff / resolved), 4. writes /tmp/rerun-candidates-<batch>.txt with the
//    non-resolved, non-model-capability tasks (upstream/environment candidates).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const runId = process.argv[2];
const batch = process.argv[3] ?? runId;
if (!runId) {
  process.stderr.write("usage: node scripts/process-run.mjs <run-id> [batch-name]\n");
  process.exit(1);
}

// 1. Download.
const artDir = resolve(repoRoot, ".tmp", `art-${batch}`);
mkdirSync(artDir, { recursive: true });
execSync(`gh run download ${runId} --dir ${artDir}`, { stdio: "inherit", cwd: repoRoot });

// 2. Collect tasks from this run's fragments.
function walk(dir, out) {
  for (const f of readdirSafe(dir)) {
    const p = resolve(dir, f);
    const st = statSafe(p);
    if (st?.isDirectory()) walk(p, out);
    else if (f.endsWith(".json") && f.includes("swe-bench-results")) out.push(p);
  }
}
import { readdirSync, statSync } from "node:fs";
function readdirSafe(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

const files = [];
walk(artDir, files);
const tasks = [];
for (const f of files) {
  try {
    const r = JSON.parse(readFileSync(f, "utf8"));
    tasks.push(...(r.tasks ?? []));
  } catch {}
}
const seen = new Map();
for (const t of tasks) if (!seen.has(t.instance_id)) seen.set(t.instance_id, t);
const unique = [...seen.values()];

// 3. Classify this run's failures.
const cls = { resolved: 0, "upstream-400": [], transport: [], env: [], "test-failed": [], "no-diff": [], retried: [], other: [] };
for (const t of unique) {
  const cli = t.cliError || "";
  if (t.resolved) {
    cls.resolved++;
    if (t.retriedTransport) cls.retried.push(t.instance_id);
    continue;
  }
  if (cli.includes("must be passed back")) cls["upstream-400"].push(t.instance_id);
  else if (cli.includes("ECONNRESET") || cli.includes("Bad Gateway") || cli.includes("Cannot connect")) cls.transport.push(t.instance_id);
  else if (t.environmentError) cls.env.push(t.instance_id);
  else if (t.failureKind === "test-failed") cls["test-failed"].push(t.instance_id);
  else if (t.error === "Agent produced no diff") cls["no-diff"].push(t.instance_id);
  else cls.other.push(t.instance_id);
}

// 4. Rerun candidates: upstream + env (NOT test-failed/no-diff = model capability).
const candidates = [...cls["upstream-400"], ...cls.transport, ...cls.env];
if (candidates.length > 0) {
  const out = resolve("/tmp", `rerun-candidates-${batch}.txt`);
  writeFileSync(out, candidates.join(","));
  process.stdout.write(`rerun candidates (upstream+env): ${candidates.length} -> ${out}\n`);
}

// 5. Reconcile ledger if present.
try {
  execSync("node scripts/reconcile-progress.mjs", { cwd: repoRoot, stdio: "inherit" });
} catch {}

process.stdout.write(
  `\n=== ${batch} (run ${runId}) ===\n` +
    `resolved: ${cls.resolved} (retried: ${cls.retried.join(",") || "-"})\n` +
    `upstream-400: ${cls["upstream-400"].length} [${cls["upstream-400"].length ? cls["upstream-400"].join(",") : "-"}]\n` +
    `transport: ${cls.transport.length} [${cls.transport.length ? cls.transport.join(",") : "-"}]\n` +
    `env: ${cls.env.length} [${cls.env.length ? cls.env.join(",") : "-"}]\n` +
    `test-failed(model): ${cls["test-failed"].length}\n` +
    `no-diff: ${cls["no-diff"].length}\n` +
    `other: ${cls.other.length}\n`,
);