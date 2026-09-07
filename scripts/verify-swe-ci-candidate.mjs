import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkControlClosureSha256 } from "./admit-generation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const candidate = JSON.parse(readFileSync(resolve(root, "config/best-agent-candidate.json")));
const hash = p => createHash("sha256").update(readFileSync(resolve(root, p))).digest("hex");
const files = { harnessSha256: "scripts/swe-bench-harness.mjs", officialEvaluatorSha256: "scripts/swe-bench-official-evaluator.mjs",
  benchmarkHistorySha256: "scripts/benchmark-history.mjs", benchmarkProviderSha256: "scripts/benchmark-provider.mjs",
  admissionSha256: "scripts/admit-generation.mjs", evaluatorEntrySha256: "scripts/evaluate-official.mjs",
  workflowSha256: ".github/workflows/bench.yml" };
for (const [key, path] of Object.entries(files)) {
  if (candidate[key] !== hash(path)) throw new Error(`Frozen control hash mismatch: ${path}`);
}
if (candidate.controlClosureSha256 !== benchmarkControlClosureSha256()) throw new Error("Frozen control closure mismatch");
if (candidate.cliVersion !== "0.0.3-beta.20" || candidate.formalBenchmarkReady !== false || candidate.sourceCommit !== null) throw new Error("Unexpected candidate provenance/profile");
const selection = JSON.parse(readFileSync(resolve(root, "config/beta20-swe-remaining.json")));
const ids = selection.batches.flatMap(b => b.tasks);
if (ids.length !== 82 || new Set(ids).size !== 82 || selection.batches.some(b => b.tasks.length > 10) ||
    selection.candidate !== `${candidate.packageName}@${candidate.cliVersion}` || selection.packageIntegrity !== candidate.packageIntegrity) throw new Error("Frozen 82 selection mismatch");
if (process.argv[2] && hash(process.argv[2]) !== candidate.executableSha256) throw new Error("Published executable hash mismatch");
const recovery = JSON.parse(readFileSync(resolve(root, "config/beta20-environment-recovery.json")));
if (recovery.candidateId !== candidate.candidateId || recovery.diagnosticOnly !== true || recovery.passAt1 !== null ||
    recovery.batch.tasks.length !== 9 || new Set(recovery.batch.tasks).size !== 9 ||
    JSON.stringify(recovery.batch.tasks) !== JSON.stringify(recovery.evidence.map(t => t.instanceId)) ||
    recovery.batch.tasks.some(id => !ids.includes(id) || id === recovery.excludedPrediction.instanceId) ||
    recovery.evidence.some(t => t.failureStage !== "preparation" ||
      ![t.receiptSha256, t.claimSha256, t.preparationSha256].every(h => /^[a-f0-9]{64}$/.test(h)))) throw new Error("Frozen environment recovery mismatch");
const residual = JSON.parse(readFileSync(resolve(root, "config/beta20-residual-environment-recovery.json")));
const remainingIds = residual.batches.flatMap(b => b.tasks);
if (residual.candidateId !== candidate.candidateId || residual.diagnosticOnly !== true || residual.passAt1 !== null ||
    remainingIds.length !== 19 || new Set(remainingIds).size !== 19 || residual.batches.some(b => b.tasks.length > 10) ||
    JSON.stringify(remainingIds) !== JSON.stringify(residual.evidence.map(t => t.instanceId)) ||
    remainingIds.some(id => !ids.includes(id) || recovery.batch.tasks.includes(id) || id === recovery.excludedPrediction.instanceId) ||
    residual.evidence.some(t => t.failureStage !== "preparation" || t.hasPrediction !== false || t.hasModelEvidence !== false ||
      !residual.sources[t.sourceWave] || ![t.receiptSha256, t.claimSha256, t.preparationSha256].every(h => /^[a-f0-9]{64}$/.test(h)))) {
  throw new Error("Frozen residual environment recovery mismatch");
}
const profile = JSON.parse(readFileSync(resolve(root, "config/swe-python-environments.json")))["pytest-setuptools-scm"];
const proofs = ["pytest-public-ancestor-probe.json", "pytest-public-ancestor-7324-5.4.0.json"].map(name => {
  const path = "config/public-python-evidence/" + name;
  const proof = JSON.parse(readFileSync(resolve(root, path)));
  return { sha256: hash(path), rows: proof.rows ?? [proof] };
});
for (const [base, ancestor] of Object.entries(profile.ancestors)) {
  const row = proofs.find(p => p.sha256 === ancestor.evidenceSha256)?.rows.find(r => r.baseCommit === base && r.tag === ancestor.release);
  if (!row || row.evidence.behind_by !== 0 || row.evidence.status !== "ahead" || row.evidence.ahead_by !== ancestor.aheadBy ||
      row.evidence.base_commit.sha !== ancestor.commit || row.evidence.merge_base_commit.sha !== ancestor.commit) {
    throw new Error("Unverified public pytest ancestor: " + base);
  }
}
console.log(JSON.stringify({ candidateId: candidate.candidateId, sourceCommit: null, verified: true, tasks: ids.length, residualEnvironmentTasks: remainingIds.length }));
