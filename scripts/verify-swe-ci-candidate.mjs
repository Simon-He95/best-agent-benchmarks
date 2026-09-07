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
console.log(JSON.stringify({ candidateId: candidate.candidateId, sourceCommit: null, verified: true, tasks: ids.length }));
