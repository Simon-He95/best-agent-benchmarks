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
const transportPath = "config/beta20-transport-recovery.json";
const transport = JSON.parse(readFileSync(resolve(root, transportPath)));
if (hash(transportPath) !== "b1d9302d95181c80f970ccf232626600ea0ad374c8854e419e451a47cf2de344" ||
    transport.candidateId !== candidate.candidateId || transport.diagnosticOnly !== true || transport.passAt1 !== null ||
    transport.scope !== "new-diagnostic-run-linked-to-source-runs" ||
    transport.batch.id !== "beta20-transport-recovery-001" || transport.batch.tasks.length !== 8 ||
    new Set(transport.batch.tasks).size !== 8 || transport.excluded.length !== 8 ||
    JSON.stringify(transport.batch.tasks) !== JSON.stringify(transport.evidence.map(t => t.instanceId)) ||
    transport.batch.tasks.some(id => !ids.includes(id) || transport.excluded.some(t => t.instanceId === id)) ||
    transport.evidence.some(t => t.hasPrediction !== false || t.process.timedOut !== false ||
      t.process.status !== 1 || t.process.signal !== null || t.evidence.prefixValid !== true || t.evidence.complete !== true ||
      t.evidence.rootStatus !== "failed" || t.evidence.rootTerminalCause !== "model-failure" ||
      t.evidence.rootModelFailureReason !== "transport" || !/ECONNRESET|HTTP 502/.test(t.stderr) ||
      !/^diagnostic-[0-9]+$/.test(t.sourceFormalRunId) ||
      ![t.refs.receipt, t.refs.claim, t.refs.evidence, t.refs.processReceipt, t.refs.stdout, t.refs.stderr].every(r => /^[a-f0-9]{64}$/.test(r.sha256)) ||
      t.process.stdout.sha256 !== t.refs.stdout.sha256 || t.process.stderr.sha256 !== t.refs.stderr.sha256)) {
  throw new Error("Frozen transport recovery mismatch");
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
console.log(JSON.stringify({ candidateId: candidate.candidateId, sourceCommit: null, verified: true, tasks: ids.length, residualEnvironmentTasks: remainingIds.length, transportRecoveryTasks: transport.batch.tasks.length }));
