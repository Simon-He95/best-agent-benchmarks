import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { benchmarkControlClosureSha256 } from "./admit-generation.mjs";

const root = new URL("..", import.meta.url);
const sha256 = (p) => createHash("sha256").update(readFileSync(new URL(p, root))).digest("hex");

const candidate = JSON.parse(readFileSync(new URL("config/best-agent-candidate.json", root), "utf8"));
const updated = {
  ...candidate,
  harnessSha256: sha256("scripts/swe-bench-harness.mjs"),
  officialEvaluatorSha256: sha256("scripts/swe-bench-official-evaluator.mjs"),
  benchmarkHistorySha256: sha256("scripts/benchmark-history.mjs"),
  benchmarkProviderSha256: sha256("scripts/benchmark-provider.mjs"),
  admissionSha256: sha256("scripts/admit-generation.mjs"),
  evaluatorEntrySha256: sha256("scripts/evaluate-official.mjs"),
  workflowSha256: sha256(".github/workflows/bench.yml"),
  controlClosureSha256: benchmarkControlClosureSha256(),
};
const changed = Object.keys(updated).filter(
  (k) => JSON.stringify(updated[k]) !== JSON.stringify(candidate[k]),
);
console.log("changed fields:", changed);
for (const k of changed) console.log(`  ${k}: ${candidate[k]} -> ${updated[k]}`);
const out = `${JSON.stringify(updated, null, 2)}\n`;
if (process.argv.includes("--write")) {
  if (changed.length === 0) {
    console.log("nothing to update");
  } else {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(new URL("config/best-agent-candidate.json", root), out);
    console.log("config/best-agent-candidate.json updated");
  }
}
