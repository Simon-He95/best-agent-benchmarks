import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  BEST_AGENT_EVALUATOR_COMMIT,
  resolveBestAgentSource,
  verifyBestAgentSource,
} from "../scripts/swe-bench-harness.mjs";
import { parseEvaluationArgs } from "../scripts/evaluate-official.mjs";
import { parsePrepareArgs } from "../scripts/prepare-swe-bench.mjs";

test("benchmark runner accepts only the pinned canonical best-agent source", () => {
  const sourceDir = mkdtempSync(resolve(tmpdir(), "best-agent-benchmark-source-"));
  mkdirSync(resolve(sourceDir, "scripts"));
  writeFileSync(resolve(sourceDir, "scripts", "swe-bench-harness.mjs"), "export {};\n");
  try {
    assert.equal(
      verifyBestAgentSource(sourceDir, (_command, args) =>
        args.includes("rev-parse")
          ? { status: 0, stdout: `${BEST_AGENT_EVALUATOR_COMMIT}\n` }
          : { status: 0, stdout: "" },
      ),
      resolve(sourceDir, "scripts", "swe-bench-harness.mjs"),
    );
    assert.throws(
      () => verifyBestAgentSource(sourceDir, () => ({ status: 0, stdout: `${"0".repeat(40)}\n` })),
      /must be pinned/u,
    );
    assert.throws(
      () =>
        verifyBestAgentSource(sourceDir, (_command, args) =>
          args.includes("rev-parse")
            ? { status: 0, stdout: `${BEST_AGENT_EVALUATOR_COMMIT}\n` }
            : { status: 0, stdout: " M scripts/swe-bench-harness.mjs\n" },
        ),
      /no tracked working-tree changes/u,
    );
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("configuration paths are explicit and bounded at the process boundary", () => {
  assert.throws(() => resolveBestAgentSource({ BEST_AGENT_SOURCE_DIR: "relative" }), /absolute/u);
  assert.deepEqual(
    parsePrepareArgs(["--corpus", "/tmp/corpus.jsonl", "--manifest", "/tmp/manifest.json"]),
    {
      sourceDir: resolveBestAgentSource(),
      corpusPath: "/tmp/corpus.jsonl",
      manifestPath: "/tmp/manifest.json",
    },
  );
  assert.equal(
    parseEvaluationArgs([
      "--report",
      "/tmp/report.json",
      "--predictions",
      "/tmp/predictions",
      "--manifest",
      "/tmp/manifest.json",
      "--output",
      "/tmp/output.json",
    ]).concurrency,
    1,
  );
});

test("repository contains no second SWE-bench grader", () => {
  const runner = readFileSync(new URL("../scripts/swe-bench-harness.mjs", import.meta.url), "utf8");
  const evaluator = readFileSync(new URL("../scripts/evaluate-official.mjs", import.meta.url), "utf8");
  for (const source of [runner, evaluator]) {
    assert.doesNotMatch(source, /FAIL_TO_PASS/u);
    assert.doesNotMatch(source, /test_patch/u);
    assert.doesNotMatch(source, /-m["']?,\s*["']pytest/u);
  }
  assert.match(evaluator, /summarizeOfficialEvaluations/u);
  assert.match(evaluator, /projectBenchmarkTaskDisposition/u);
});
