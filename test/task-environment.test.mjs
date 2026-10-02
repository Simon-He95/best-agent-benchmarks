import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPreparationTree, inspectPreparationDelta, loadPreparationRecipe, prepareTaskEnvironment } from "../scripts/prepare-task-environment.mjs";
import { buildTaskPrompt, runCliProcess, taskWorkspaceCliArgs } from "../scripts/swe-bench-harness.mjs";

function fixture(t, script = "echo 'public build: missing exact dependency' >&2; exit 23\n") {
  const root = mkdtempSync(join(tmpdir(), "benchmark-public-preparation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  writeFileSync(join(repoDir, "pyproject.toml"), "[build-system]\nrequires = []\n");
  writeFileSync(join(repoDir, ".gitignore"), "*.so\n");
  git("add", "."); git("commit", "-m", "public base");
  const baseCommit = git("rev-parse", "HEAD");
  const runtime = join(root, "runtime");
  const packages = join(root, "packages");
  mkdirSync(join(runtime, "bin"), { recursive: true }); mkdirSync(packages);
  writeFileSync(join(runtime, "bin/python3"), "interpreter fixture\n");
  writeFileSync(join(root, "setup.sh"), script);
  writeFileSync(join(root, "probe.py"), "assert True\n");
  const file = (path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  const recipe = { instanceId: "public-task", baseCommit,
    runtime: { path: runtime, sha256: hashPreparationTree(runtime) },
    packages: { path: packages, sha256: hashPreparationTree(packages) },
    setup: file(join(root, "setup.sh")), probe: file(join(root, "probe.py")),
    support: [{ ...file(join(repoDir, "pyproject.toml")), path: "pyproject.toml" }],
    relocate: [], nativeBuildOutputs: ["native.so"] };
  const manifestPath = join(root, "recipes.json");
  const freeze = () => writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, tasks: [recipe] }));
  freeze();
  return { root, repoDir, baseCommit, recipe, manifestPath, freeze,
    options: { manifestPath, instanceId: recipe.instanceId, baseCommit, repoDir,
      artifactDir: join(root, "evidence"), cliInvocation: ["must-not-launch-task-model"], executionArgs: taskWorkspaceCliArgs(repoDir) } };
}

test("failed public setup preserves stderr and never enters the selected CLI or task model", async (t) => {
  const f = fixture(t);
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ ...f.options, runProcess: async (options) => {
    calls.push(options.args);
    return runCliProcess(options);
  } }), /public build: missing exact dependency/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/bin/sh");
  const manifest = JSON.parse(readFileSync(join(f.options.artifactDir, "manifest.json")));
  assert.equal(manifest.status, "preparation-failed");
  assert.equal(manifest.stage, "setup");
  assert.equal(manifest.setupProcess.status, 23);
  assert.equal(readFileSync(join(f.options.artifactDir, "setup.stderr.txt"), "utf8"), "public build: missing exact dependency\n");
  assert.equal(existsSync(join(f.options.artifactDir, "probe.evidence.jsonl")), false);
});

test("each preparation copies runtime independently and does not mutate its source", async (t) => {
  const f = fixture(t, "echo changed > \"$1/bin/python3\"; exit 1\n");
  await assert.rejects(prepareTaskEnvironment({ ...f.options, runProcess: runCliProcess }), /Public environment setup failed/);
  assert.equal(readFileSync(join(f.recipe.runtime.path, "bin/python3"), "utf8"), "interpreter fixture\n");
  assert.equal(readFileSync(join(f.repoDir, ".benchmark-runtime/bin/python3"), "utf8"), "changed\n");
  assert.equal(hashPreparationTree(f.recipe.runtime.path), f.recipe.runtime.sha256);
});

test("reserved prefix, public evidence mismatch and missing recipe prevent process entry", async (t) => {
  for (const kind of ["collision", "hash", "missing"]) {
    const f = fixture(t);
    if (kind === "collision") mkdirSync(join(f.repoDir, ".benchmark-runtime"));
    if (kind === "hash") { f.recipe.support[0].sha256 = "bad"; f.freeze(); }
    if (kind === "missing") { f.recipe.instanceId = "another-task"; f.freeze(); }
    let calls = 0;
    await assert.rejects(prepareTaskEnvironment({ ...f.options, runProcess: async () => { calls++; } }),
      /Reserved preparation prefix|Public base evidence hash mismatch|No unique frozen public preparation recipe/);
    assert.equal(calls, 0);
  }
});

test("setup delta admits only declared base-ignored native outputs, never tracked or ordinary source changes", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repoDir, "native.so"), "native public build");
  assert.equal(inspectPreparationDelta(f.repoDir, f.baseCommit, ["native.so"])[0].path, "native.so");
  assert.throws(() => inspectPreparationDelta(f.repoDir, f.baseCommit, []), /Undeclared native build output/);
  writeFileSync(join(f.repoDir, "extra.py"), "unexpected");
  assert.throws(() => inspectPreparationDelta(f.repoDir, f.baseCommit, ["native.so"]), /Unexplained preparation output/);
  writeFileSync(join(f.repoDir, "pyproject.toml"), "changed base");
  assert.throws(() => inspectPreparationDelta(f.repoDir, f.baseCommit, ["native.so"]), /Preparation changed tracked base/);
});

test("recipe selection is tied to exact task/base and prompt claims only probed readiness", (t) => {
  const f = fixture(t);
  assert.equal(loadPreparationRecipe(f.manifestPath, "public-task", f.baseCommit).recipe.baseCommit, f.baseCommit);
  assert.throws(() => loadPreparationRecipe(f.manifestPath, "public-task", "another-base"), /No unique frozen/);
  const prompt = buildTaskPrompt("PUBLIC ISSUE", { pythonVersion: "3.9.25" });
  assert.match(prompt, /not evidence that project tests pass/);
  assert.doesNotMatch(prompt, /official test dependencies|exec pytest|acceptance checks/);
  assert.ok(taskWorkspaceCliArgs(f.repoDir).includes("python3=" + join(f.repoDir, ".benchmark-runtime/bin/python3")));
  assert.ok(!taskWorkspaceCliArgs(f.repoDir).includes("--external-read"));
});
