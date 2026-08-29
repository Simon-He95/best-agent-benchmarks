import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { isolateFrozenGitCommit, resolveCliEntrypoint } from "../scripts/swe-bench-harness.mjs";
import { benchmarkControlClosureSha256, parseAdmissionArgs } from "../scripts/admit-generation.mjs";
import { parseEvaluationArgs } from "../scripts/evaluate-official.mjs";
import { parsePrepareArgs } from "../scripts/prepare-swe-bench.mjs";

test("public benchmark artifacts match the pinned candidate record", () => {
  const candidate = JSON.parse(
    readFileSync(new URL("../config/best-agent-candidate.json", import.meta.url), "utf8"),
  );
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(
    sha256(new URL("../scripts/swe-bench-harness.mjs", import.meta.url)),
    candidate.harnessSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/swe-bench-official-evaluator.mjs", import.meta.url)),
    candidate.officialEvaluatorSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/benchmark-history.mjs", import.meta.url)),
    candidate.benchmarkHistorySha256,
  );
  assert.equal(
    sha256(new URL("../scripts/benchmark-provider.mjs", import.meta.url)),
    candidate.benchmarkProviderSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/admit-generation.mjs", import.meta.url)),
    candidate.admissionSha256,
  );
  assert.equal(
    sha256(new URL("../scripts/evaluate-official.mjs", import.meta.url)),
    candidate.evaluatorEntrySha256,
  );
  assert.equal(
    sha256(new URL("../.github/workflows/bench.yml", import.meta.url)),
    candidate.workflowSha256,
  );
  assert.equal(benchmarkControlClosureSha256(), candidate.controlClosureSha256);
});

test("configuration paths are explicit and bounded at the process boundary", () => {
  assert.throws(() => resolveCliEntrypoint({ BEST_AGENT_CLI_PATH: "relative" }), /absolute/u);
  assert.deepEqual(
    parsePrepareArgs([
      "--corpus",
      "/tmp/corpus.jsonl",
      "--manifest",
      "/tmp/manifest.json",
      "--evaluator-source",
      "/tmp/swe-bench",
    ]),
    {
      corpusPath: "/tmp/corpus.jsonl",
      manifestPath: "/tmp/manifest.json",
      evaluatorSourceDir: "/tmp/swe-bench",
    },
  );
  assert.equal(
    parseEvaluationArgs([
      "--admission-receipt",
      "/tmp/admission.json",
      "--manifest",
      "/tmp/manifest.json",
      "--output",
      "/tmp/output.json",
    ]).concurrency,
    1,
  );
  assert.deepEqual(parseEvaluationArgs(["--verify-report", "/tmp/report.json"]), {
    verifyReportPath: "/tmp/report.json",
  });
  assert.throws(
    () => parseEvaluationArgs(["--verify-report", "/tmp/report.json", "--concurrency", "2"]),
    /only evaluation mode/u,
  );
  assert.equal(
    parseAdmissionArgs([
      "--results",
      "/tmp/results",
      "--plan",
      "/tmp/plan.json",
      "--corpus",
      "/tmp/corpus.jsonl",
      "--output",
      "/tmp/admission.json",
    ]).outputPath,
    "/tmp/admission.json",
  );
  assert.throws(
    () =>
      parseAdmissionArgs([
        "--results",
        "/tmp/results",
        "--plan",
        "/tmp/plan.json",
        "--candidate",
        "/tmp/candidate.json",
        "--corpus",
        "/tmp/corpus.jsonl",
        "--output",
        "/tmp/admission.json",
      ]),
    /Unknown admission argument/u,
  );
});

test("repository contains no second SWE-bench grader", () => {
  const runner = readFileSync(new URL("../scripts/swe-bench-harness.mjs", import.meta.url), "utf8");
  const evaluator = readFileSync(
    new URL("../scripts/evaluate-official.mjs", import.meta.url),
    "utf8",
  );
  for (const source of [runner, evaluator]) {
    assert.doesNotMatch(source, /FAIL_TO_PASS/u);
    assert.doesNotMatch(source, /test_patch/u);
    assert.doesNotMatch(source, /-m["']?,\s*["']pytest/u);
  }
  assert.match(evaluator, /summarizeOfficialEvaluations/u);
  assert.match(evaluator, /projectBenchmarkTaskDisposition/u);
  assert.match(evaluator, /--admission-receipt/u);
  assert.match(evaluator, /--verify-report/u);
  assert.match(evaluator, /localDatasetJsonlSha256 !== receipt\.corpus\.sha256/u);
  assert.match(evaluator, /selectedInstanceIds\) !== JSON\.stringify\(selected\)/u);
  assert.doesNotMatch(evaluator, /readdirSync/u);
  assert.ok(
    evaluator.indexOf("writeDurableJson(claimPath") <
      evaluator.indexOf("evaluateFrozenPrediction({"),
  );
  assert.doesNotMatch(runner, /evaluateFrozenPrediction/u);
  assert.doesNotMatch(
    runner.match(/function taskResult[\s\S]*?\n\}/u)?.[0] ?? "",
    /timedOut:\s*false/u,
  );
  assert.match(
    readFileSync(new URL("../scripts/swe-bench-official-evaluator.mjs", import.meta.url), "utf8"),
    /Direct Docker evaluation is unavailable/u,
  );
});

test("hosted generation uses the public package and caps each batch at ten tasks", () => {
  const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /repository:\s*Simon-He95\/best-agent(?:\s|$)/u);
  assert.match(workflow, /candidate\.json"\)\.packageName/u);
  assert.match(workflow, /candidate\.json"\)\.packageIntegrity/u);
  assert.match(workflow, /node_modules\/\$\{CLI_PACKAGE\}\/bin\/best-agent/u);
  assert.match(workflow, /count > 10/u);
  assert.match(workflow, /name: swe-bench-corpus-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /needs: \[plan, smoke, corpus, isolation\]/u);
  assert.match(workflow, /node scripts\/isolation-smoke\.mjs/u);
  assert.match(workflow, /brew install ripgrep/u);
  assert.match(workflow, /node scripts\/sandbox-network-smoke\.mjs/u);
  assert.match(workflow, /if: always\(\)[\s\S]*swe-bench-results\.\*\.tasks/u);
  assert.match(workflow, /node scripts\/admit-generation\.mjs/u);
  assert.match(workflow, /github-jobs\.json/u);
  assert.match(workflow, /benchmark-headless-smoke-/u);
  assert.match(workflow, /benchmark-repository-isolation-/u);
  assert.match(workflow, /if: \$\{\{ always\(\) && inputs\.run_full_verified \}\}/u);
  assert.match(workflow, /Collect terminal benchmark evidence/u);
  assert.match(workflow, /github-failures\.json/u);
  assert.match(workflow, /github-failed-steps\.log/u);
});

test("the model workspace retains only the frozen base commit", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-git-isolation-"));
  const repository = join(root, "repo");
  try {
    assert.equal(spawnSync("git", ["init", repository]).status, 0);
    assert.equal(
      spawnSync("git", ["config", "user.email", "bench@example.invalid"], { cwd: repository })
        .status,
      0,
    );
    assert.equal(
      spawnSync("git", ["config", "user.name", "Benchmark"], { cwd: repository }).status,
      0,
    );
    writeFileSync(join(repository, "value.txt"), "base\n");
    assert.equal(spawnSync("git", ["add", "value.txt"], { cwd: repository }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "base"], { cwd: repository }).status, 0);
    const base = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(join(repository, "value.txt"), "future\n");
    assert.equal(spawnSync("git", ["commit", "-am", "future"], { cwd: repository }).status, 0);
    const future = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(
      spawnSync("git", ["remote", "add", "origin", repository], { cwd: repository }).status,
      0,
    );
    assert.equal(
      spawnSync("git", ["update-ref", "refs/remotes/origin/main", future], { cwd: repository })
        .status,
      0,
    );
    assert.equal(
      spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
        cwd: repository,
      }).status,
      0,
    );
    assert.equal(spawnSync("git", ["checkout", "--detach", base], { cwd: repository }).status, 0);
    writeFileSync(join(repository, ".git", "shallow"), `${base}\n${future}\n`);

    const isolated = isolateFrozenGitCommit(repository);
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.equal(
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).stdout.trim(),
      base,
    );
    assert.equal(
      spawnSync("git", ["remote"], { cwd: repository, encoding: "utf8" }).stdout.trim(),
      "",
    );
    assert.equal(
      spawnSync("git", ["for-each-ref"], { cwd: repository, encoding: "utf8" }).stdout.trim(),
      "",
    );
    assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD@{1}"], { cwd: repository }).status, 128);
    assert.equal(readFileSync(join(repository, ".git", "shallow"), "utf8").trim(), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formal generation contains no automatic model or acquisition retry", () => {
  const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");
  const smoke = readFileSync(new URL("../scripts/smoke.mjs", import.meta.url), "utf8");
  const harness = readFileSync(
    new URL("../scripts/swe-bench-harness.mjs", import.meta.url),
    "utf8",
  );
  const evaluatorEntry = readFileSync(
    new URL("../scripts/evaluate-official.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /for attempt in/u);
  assert.doesNotMatch(workflow, /scripts\/relay-health\.mjs/u);
  assert.doesNotMatch(smoke, /MAX_RELAY_RETRIES|for \(let attempt/u);
  assert.doesNotMatch(harness, /GIT_NETWORK_RETRY|for \(let attempt/u);
  assert.match(evaluatorEntry, /openSync\(path, "wx"\)/u);
  assert.match(evaluatorEntry, /uncertain-external-effect/u);
});

test("beta.9 diagnostic plan is the frozen ledger's complete non-resolved population", () => {
  const ledgerPath = new URL("../results/benchmark-progress.json", import.meta.url);
  const ledgerBytes = readFileSync(ledgerPath);
  const ledger = JSON.parse(ledgerBytes);
  const manifest = JSON.parse(
    readFileSync(new URL("../config/beta9-failure-rerun-batches.json", import.meta.url), "utf8"),
  );
  const plannedIds = manifest.batches.flatMap((batch) => batch.tasks);
  const expectedIds = ledger.tasks
    .filter((task) => task.state !== "resolved")
    .map((task) => task.instance_id);

  assert.equal(createHash("sha256").update(ledgerBytes).digest("hex"), manifest.ledgerSha256);
  assert.deepEqual(plannedIds, expectedIds);
  assert.equal(manifest.taskCount, plannedIds.length);
  assert.equal(new Set(plannedIds).size, plannedIds.length);
  assert.ok(manifest.batches.every((batch) => batch.tasks.length <= 10));
});

test("full Verified plan is a candidate-independent exact 500-task population", () => {
  const profile = JSON.parse(
    readFileSync(new URL("../config/swe-bench-verified.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(new URL("../config/swe-bench-full-batches.json", import.meta.url), "utf8"),
  );
  const plannedIds = manifest.batches.flatMap((batch) => batch.tasks);

  assert.equal(manifest.profileId, profile.profileId);
  assert.equal(manifest.corpusSha256, profile.jsonlSha256);
  assert.equal(manifest.taskCount, profile.taskCount);
  assert.equal(plannedIds.length, 500);
  assert.equal(new Set(plannedIds).size, plannedIds.length);
  assert.equal(manifest.maxBatchSize, 5);
  assert.equal(manifest.batches.length, 100);
  assert.ok(manifest.batches.every((batch) => batch.tasks.length === 5));
  assert.equal("candidateVersion" in manifest, false);

  const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");
  assert.match(workflow, /run_full_verified:/u);
  assert.match(workflow, /Full plan must exact-cover the frozen corpus in corpus order\./u);
  assert.match(workflow, /Full Verified runs must pin the candidate provider model\./u);
});

test("repository instructions forbid mixed-generation and evaluator-driven scoring", () => {
  const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(instructions, /one frozen candidate running all 500 frozen tasks/u);
  assert.match(
    instructions,
    /Never combine candidates, rescue runs, or selected failure reruns into pass@1/u,
  );
  assert.match(instructions, /canonical record are the only grader/u);
  assert.match(instructions, /Do not retry or overwrite a canonical verdict/u);
  assert.match(instructions, /repository containing only the frozen `base_commit`/u);
  assert.match(instructions, /complete inference-time trajectory for every task/u);
  assert.match(
    instructions,
    /closed-book claim requires a mechanically verified network boundary/u,
  );
});

test("a candidate can start a formal full run only after fairness admission", () => {
  const candidate = JSON.parse(
    readFileSync(new URL("../config/best-agent-candidate.json", import.meta.url), "utf8"),
  );
  const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");
  assert.equal(typeof candidate.formalBenchmarkReady, "boolean");
  assert.match(workflow, /candidate\.formalBenchmarkReady !== true/u);
  assert.match(workflow, /has not passed the formal benchmark fairness gates/u);
});
