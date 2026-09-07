import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkerRunner, MAX_MODEL_CYCLES, publicPreparationPlan, prepareTaskEnvironment, probeWorker, taskWorkspaceCliArgs, workerEnvironment } from "../scripts/swe-ci-worker.mjs";
import { runCliProcess, captureTerminalPatch } from "../scripts/swe-bench-harness.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "swe-ci-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); mkdirSync(join(repo, "django"), { recursive: true });
  writeFileSync(join(repo, "django/__init__.py"), "");
  writeFileSync(join(repo, "setup.cfg"), '[metadata]\nname = Django\n[options]\npython_requires = >=3.10\n');
  const git = args => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(["init", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
  git(["add", "."]); git(["commit", "-m", "public base"]);
  return { root, repo, baseCommit: git(["rev-parse", "HEAD"]) };
}

test("unrestricted CLI profile retains product instructions and maximizes legal cycle budget", () => {
  const args = taskWorkspaceCliArgs("/task/repo");
  for (const [flag, value] of [["--workspace-backend", "plain"], ["--workspace-authorization", "unrestricted"],
    ["--command-policy", "path"], ["--process-isolation", "host"], ["--max-model-cycles", String(MAX_MODEL_CYCLES)]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.equal(MAX_MODEL_CYCLES, Math.floor(Number.MAX_SAFE_INTEGER / 4));
  assert.ok(!args.includes("--no-base-instructions"));
  assert.ok(!args.includes("--tool-exclude"));
  assert.deepEqual(args.flatMap((v, i) => v === "--workspace-grant" ? [args[i + 1]] : []), ["read", "write", "exec"]);
});

test("OS worker invocation clears controller secrets and does not inherit controller HOME", async () => {
  let invocation;
  const run = createWorkerRunner(async options => { invocation = options; return { status: 0 }; }, "/task");
  await run({ args: ["python3", "-V"], cwd: "/task/repo", timeoutMs: 1000 });
  assert.deepEqual(invocation.args.slice(0, 9), ["sudo", "-n", "-H", "-u", "benchworker", "--", "/usr/bin/env", "-i", `PATH=${workerEnvironment("/task").PATH}`]);
  assert.ok(invocation.args.includes("HOME=/task/home"));
  assert.ok(invocation.args.includes("PIP_RETRIES=0"));
  assert.ok(invocation.args.includes("PIP_RESUME_RETRIES=0"));
  assert.ok(invocation.args.includes("PIP_TIMEOUT=60"));
  assert.ok(!invocation.args.some(a => a.startsWith("GITHUB_TOKEN=") || a.startsWith("BENCHMARK_PROVIDER_API_KEY=")));
});

test("public preparation selects only base metadata and preserves setup failure before model entry", async t => {
  const f = fixture(t);
  const p = publicPreparationPlan(f.repo);
  assert.equal(p.python, "3.11.16"); assert.equal(p.module, "django");
  assert.deepEqual(p.support.map(x => x.path), ["setup.cfg"]);
  const calls = [];
  const artifactDir = join(f.root, "preparation");
  await assert.rejects(prepareTaskEnvironment({ repoDir: f.repo, baseCommit: f.baseCommit,
    runtimeDir: join(f.root, "runtime"), artifactDir,
    runWorkerProcess: async options => {
      calls.push(options.args);
      return runCliProcess({ ...options, args: ["/bin/sh", "-c", "printf exact-dependency-error >&2; exit 23"] });
    } }), /exact-dependency-error/);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "uv");
  const receipt = JSON.parse(readFileSync(join(artifactDir, "manifest.json")));
  assert.equal(receipt.status, "preparation-failed"); assert.equal(receipt.steps[0].status, 23);
  assert.equal(readFileSync(join(artifactDir, "step-0.stderr.txt"), "utf8"), "exact-dependency-error");
  assert.ok(!existsSync(join(artifactDir, "attempt-evidence.jsonl")));
});

test("complete process files survive bounded in-memory excerpts and real nonzero exit", async t => {
  const f = fixture(t); const stdoutPath = join(f.root, "stdout"); const stderrPath = join(f.root, "stderr");
  const result = await runCliProcess({ args: [process.execPath, "-e", "process.stdout.write('x'.repeat(9*1024*1024));process.stderr.write('exact-error');process.exitCode=7"],
    cwd: f.root, timeoutMs: 15000, stdoutPath, stderrPath });
  assert.equal(result.status, 7); assert.equal(result.stdoutOverflow, true);
  assert.equal(statSync(stdoutPath).size, 9 * 1024 * 1024);
  assert.equal(readFileSync(stderrPath, "utf8"), "exact-error");
});

for (const [module, metadata, pyproject, id] of [
  ["astropy", "import ah_bootstrap", '[build-system]\nrequires = ["setuptools"]', undefined],
  ["sphinx", "extras_require = {\n    'test': ['pytest']\n}", undefined, "sphinx-pkg-resources"],
  ["sklearn", "from numpy.distutils.core import setup", undefined, "sklearn-numpy-distutils"],
  ["sklearn", "setup()", '[build-system]\nrequires = ["oldest-supported-numpy"]', "sklearn-oldest-supported-numpy"],
  ["sklearn", "setup()", '[build-system]\nrequires = ["meson-python"]', undefined],
]) {
  test(`public packaging selects ${id ?? "no legacy profile"} without task identity`, async t => {
    const root = mkdtempSync(join(tmpdir(), "swe-public-profile-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, module)); writeFileSync(join(root, module, "__init__.py"), "");
    writeFileSync(join(root, "setup.py"), metadata);
    if (pyproject) writeFileSync(join(root, "pyproject.toml"), pyproject);
    const plan = publicPreparationPlan(root);
    assert.equal(plan.dependencyProfile?.id, id);
    if (!id) return;
    if (module === "sphinx") assert.equal(plan.extras, ".[test]");
    const calls = [];
    await assert.rejects(prepareTaskEnvironment({ repoDir: root, baseCommit: "unused", runtimeDir: join(root, "venv"),
      artifactDir: join(root, "preparation"), runWorkerProcess: async options => {
        calls.push(options);
        return { status: calls.length === 3 ? 23 : 0, signal: null, timedOut: false, stderr: "original install failure" };
      } }), /original install failure/);
    assert.equal(calls.length, 3);
    const install = calls[2].args;
    assert.deepEqual(calls[1].args.slice(5), plan.dependencyProfile.bootstrap);
    assert.equal(readFileSync(install[install.indexOf("--constraint") + 1], "utf8"), plan.dependencyProfile.runtimeConstraints.join("\n") + "\n");
    assert.equal(install.includes("--no-build-isolation"), id === "sklearn-numpy-distutils");
    assert.equal(install.includes("--build-constraint"), module === "sphinx");
    if (id === "sklearn-numpy-distutils") assert.equal(calls[2].env.CPPFLAGS, "-Xpreprocessor -fopenmp");
    if (id === "sklearn-oldest-supported-numpy") assert.ok(!("PIP_CONSTRAINT" in calls[2].env));
    const saved = JSON.parse(readFileSync(join(root, "preparation/manifest.json")));
    assert.deepEqual(saved.publicPlan.dependencyProfile, plan.dependencyProfile);
    assert.equal(saved.status, "preparation-failed");
  });
}

test("legacy Astropy acquires only the frozen public helper before normal legacy installation", async t => {
  const f = fixture(t);
  const helper = join(f.root, "upstream-helper"); mkdirSync(helper);
  const git = (cwd, args) => {
    const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(helper, ["init", "-b", "future"]);
  git(helper, ["config", "user.name", "Fixture"]); git(helper, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(helper, "helper.py"), "original = True\n");
  git(helper, ["add", "."]); git(helper, ["commit", "-m", "frozen helper"]);
  const helperCommit = git(helper, ["rev-parse", "HEAD"]);
  writeFileSync(join(helper, "helper.py"), "future = True\n");
  git(helper, ["commit", "-am", "unavailable future"]); git(helper, ["tag", "future"]);
  rmSync(join(f.repo, "django"), { recursive: true }); mkdirSync(join(f.repo, "astropy"));
  writeFileSync(join(f.repo, "astropy/__init__.py"), "");
  writeFileSync(join(f.repo, "setup.py"), "import ah_bootstrap\nimport astropy\nsetup_requires = ['numpy>=1.13.0']\n");
  writeFileSync(join(f.repo, ".gitmodules"), '[submodule "astropy_helpers"]\npath = astropy_helpers\nurl = https://github.com/astropy/astropy-helpers.git\n');
  git(f.repo, ["add", "-A"]);
  git(f.repo, ["update-index", "--add", "--cacheinfo", `160000,${helperCommit},astropy_helpers`]);
  git(f.repo, ["commit", "-m", "legacy public package"]);
  const baseCommit = git(f.repo, ["rev-parse", "HEAD"]);
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ repoDir: f.repo, baseCommit, runtimeDir: join(f.root, "venv"),
    artifactDir: join(f.root, "preparation"), runWorkerProcess: async options => {
      calls.push(options);
      if (options.args[0] === "/usr/bin/git") {
        const args = options.args.map(arg => arg === "https://github.com/astropy/astropy-helpers.git" ? `file://${helper}` : arg);
        return runCliProcess({ ...options, args });
      }
      const install = options.args.includes("-e");
      return { status: install ? 23 : 0, signal: null, timedOut: false, stdout: "", stderr: install ? "original install failure" : "" };
    } }), /original install failure/);
  const profile = publicPreparationPlan(f.repo).dependencyProfile;
  assert.equal(profile.id, "astropy-ah-bootstrap");
  assert.ok(profile.bootstrap.includes("numpy==1.23.5"));
  assert.ok(profile.runtimeConstraints.includes("pytest==7.4.4"));
  const install = calls.at(-1);
  assert.ok(install.args.includes("--no-build-isolation"));
  assert.equal(install.env.CFLAGS, "-Wno-error=incompatible-function-pointer-types -DHAVE_UNISTD_H=1");
  assert.deepEqual(calls.at(-2).args.slice(5), profile.bootstrap);
  assert.equal(calls.filter(c => c.args.includes("fetch")).length, 1);
  assert.deepEqual(calls.find(c => c.args.includes("fetch")).args.slice(-6),
    ["--no-auto-maintenance", "--depth=1", "--no-tags", "--", "https://github.com/astropy/astropy-helpers.git", helperCommit]);
  const checkout = join(f.repo, "astropy_helpers");
  assert.equal(git(checkout, ["rev-parse", "HEAD"]), helperCommit);
  assert.equal(git(checkout, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(git(checkout, ["for-each-ref"]), "");
  assert.equal(git(f.repo, ["diff", baseCommit, "--"]), "");
  const manifest = JSON.parse(readFileSync(join(f.root, "preparation/manifest.json")));
  assert.equal(manifest.publicHelper.commit, helperCommit);
  assert.equal(manifest.status, "preparation-failed");
  assert.match(manifest.error, /original install failure/);
});

test("CFITSIO 4.2 selects the supported system library without changing older bundled recipes", t => {
  const f = fixture(t);
  rmSync(join(f.repo, "django"), { recursive: true });
  mkdirSync(join(f.repo, "astropy/io/fits"), { recursive: true });
  mkdirSync(join(f.repo, "astropy/wcs")); mkdirSync(join(f.repo, "cextern/cfitsio/lib"), { recursive: true });
  writeFileSync(join(f.repo, "astropy/__init__.py"), "");
  writeFileSync(join(f.repo, "astropy/wcs/setup_package.py"), "from setuptools.dep_util import newer_group\n");
  writeFileSync(join(f.repo, "astropy/io/fits/setup_package.py"), "ASTROPY_USE_SYSTEM_CFITSIO\n");
  const header = join(f.repo, "cextern/cfitsio/lib/fitsio.h");
  writeFileSync(header, "#define CFITSIO_VERSION 4.1.0\n");
  assert.equal(publicPreparationPlan(f.repo).dependencyProfile.id, "astropy-setuptools-dep-util");
  writeFileSync(header, "#define CFITSIO_VERSION 4.2.0\n");
  const plan = publicPreparationPlan(f.repo);
  assert.equal(plan.dependencyProfile.id, "astropy-cfitsio42");
  assert.equal(plan.dependencyProfile.env.ASTROPY_USE_SYSTEM_CFITSIO, "1");
  assert.equal(plan.dependencyProfile.systemLibrary.version, "4.7.0");
  writeFileSync(join(f.repo, "astropy/io/fits/setup_package.py"), "bundled only\n");
  assert.equal(publicPreparationPlan(f.repo).dependencyProfile.id, "astropy-setuptools-dep-util");
});

for (const oldest of [false, true]) test(`Matplotlib external library readiness includes an actual Agg render (${oldest ? "oldest-supported-numpy" : "numpy1"})`, async t => {
  const f = fixture(t);
  rmSync(join(f.repo, "django"), { recursive: true }); mkdirSync(join(f.repo, "lib/matplotlib"), { recursive: true });
  writeFileSync(join(f.repo, "lib/matplotlib/__init__.py"), "");
  writeFileSync(join(f.repo, "setupext.py"), "MPLSETUPCFG\n");
  if (oldest) writeFileSync(join(f.repo, "pyproject.toml"), '[build-system]\nrequires = ["oldest-supported-numpy"]\n');
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ repoDir: f.repo, baseCommit: f.baseCommit, runtimeDir: join(f.root, "venv"),
    artifactDir: join(f.root, "preparation"), runWorkerProcess: async options => {
      calls.push(options);
      const failed = options.args.some(arg => arg.includes("canvas.print_png"));
      const stdout = options.args.includes("--modversion") ? "26.6.20\n" : options.args.includes("--variable=libdir") ? "/library\n"
        : options.args[0] === "shasum" ? `${"a".repeat(64)}  /library/libfreetype.6.dylib\n` : "";
      return { status: failed ? 1 : 0, signal: null, timedOut: false, stdout, stderr: failed ? "original Agg failure: np.Inf" : "" };
    } }), /original Agg failure: np.Inf/);
  const install = calls.find(c => c.args.includes("-e"));
  assert.equal(install.args.includes("--build-constraint"), !oldest);
  assert.equal(readFileSync(install.env.MPLSETUPCFG, "utf8"), "[libs]\nsystem_freetype = True\n");
  assert.ok(!install.env.MPLSETUPCFG.startsWith(f.repo));
  assert.ok(!("MPLSETUPCFG" in calls[0].env));
  assert.equal(calls.at(-1).args.some(arg => arg.includes("__freetype_build_type__ == 'system'")), true);
  const manifest = JSON.parse(readFileSync(join(f.root, "preparation/manifest.json")));
  assert.equal(manifest.systemLibrary.sha256, "a".repeat(64));
  assert.equal(manifest.systemLibrary.release, "2.14.3");
  assert.equal(manifest.status, "preparation-failed");
  assert.equal(calls.filter(c => c.args.includes("install")).length, 1);
});

test("pytest private version applies only to its build and must match all three installed identities", async t => {
  const f = fixture(t);
  rmSync(join(f.repo, "django"), { recursive: true }); mkdirSync(join(f.repo, "src/_pytest"), { recursive: true });
  writeFileSync(join(f.repo, "setup.py"), "setup(use_scm_version=True,\nextras_require={\n 'testing': ['hypothesis']\n})\n");
  const plan = publicPreparationPlan(f.repo);
  assert.equal(plan.extras, ".[testing]");
  assert.equal(plan.dependencyProfile.id, "pytest-setuptools-scm");
  const baseCommit = Object.keys(plan.dependencyProfile.ancestors)[0];
  const ancestor = plan.dependencyProfile.ancestors[baseCommit];
  const expected = `${ancestor.release}.post${ancestor.aheadBy}+g${baseCommit}`;
  const calls = [];
  const result = await prepareTaskEnvironment({ repoDir: f.repo, baseCommit, runtimeDir: join(f.root, "venv"),
    artifactDir: join(f.root, "preparation"), runWorkerProcess: async options => {
      calls.push(options);
      return { status: 0, signal: null, timedOut: false, stdout: options.args.includes("rev-parse") ? baseCommit + "\n" : "", stderr: "" };
    } });
  const versionKey = "SETUPTOOLS_SCM_PRETEND_VERSION_FOR_PYTEST";
  assert.equal(calls.filter(c => versionKey in (c.env ?? {})).length, 1);
  const install = calls.find(c => c.args.includes("-e"));
  assert.equal(install.env[versionKey], expected); assert.ok(install.args.includes(".[testing]"));
  assert.ok(!calls.some(c => c.env && "SETUPTOOLS_SCM_PRETEND_VERSION" in c.env));
  assert.ok(!(versionKey in result.env));
  assert.ok(calls.some(c => c.args.some(a => a.includes(`pytest.__version__ == _version.version == metadata.version('pytest') == "${expected}"`))));
  assert.equal(readFileSync(install.args[install.args.indexOf("--build-constraint") + 1], "utf8"), plan.dependencyProfile.buildConstraints.join("\n") + "\n");
  let unknownBaseCalls = 0;
  await assert.rejects(prepareTaskEnvironment({ repoDir: f.repo, baseCommit: "unproven", runtimeDir: join(f.root, "unproven-venv"),
    artifactDir: join(f.root, "unproven-preparation"), runWorkerProcess: async () => { unknownBaseCalls++; } }), /No verified public pytest version provenance/);
  assert.equal(unknownBaseCalls, 0);
});

test("legacy Astropy preparation records compatible build and runtime constraints without retrying", async t => {
  const root = mkdtempSync(join(tmpdir(), "swe-astropy-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "astropy/wcs"), { recursive: true });
  writeFileSync(join(root, "astropy/__init__.py"), "");
  writeFileSync(join(root, "setup.py"), "from setuptools import setup\nsetup()\n");
  assert.equal(publicPreparationPlan(root).dependencyProfile, undefined);
  writeFileSync(join(root, "astropy/wcs/setup_package.py"), "from setuptools.dep_util import newer_group\n");
  const plan = publicPreparationPlan(root);
  assert.equal(plan.dependencyProfile.id, "astropy-setuptools-dep-util");
  assert(plan.support.some(f => f.path === "astropy/wcs/setup_package.py"));
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ repoDir: root, baseCommit: "unused", runtimeDir: join(root, "venv"),
    artifactDir: join(root, "preparation"), runWorkerProcess: async options => {
      calls.push(options);
      return { status: calls.length === 2 ? 23 : 0, signal: null, timedOut: false, stderr: "original Astropy build failure" };
    } }), /original Astropy build failure/);
  assert.equal(calls.length, 2);
  const install = calls[1].args;
  assert.equal(readFileSync(install[install.indexOf("--build-constraint") + 1], "utf8"), "setuptools==68.2.2\n");
  assert.equal(readFileSync(install[install.indexOf("--constraint") + 1], "utf8"), "numpy==1.26.4\n");
  assert.equal(install.includes("--no-build-isolation"), false);
  assert.equal(calls[1].env.CFLAGS, "-Wno-error=incompatible-function-pointer-types");
  const smokeCalls = [];
  mkdirSync(join(root, "smoke"));
  await assert.rejects(prepareTaskEnvironment({ repoDir: root, baseCommit: "unused", runtimeDir: join(root, "smoke", "venv"),
    artifactDir: join(root, "smoke-preparation"), runWorkerProcess: async options => {
      smokeCalls.push(options.args);
      const failed = options.args.some(arg => arg.includes("from astropy.wcs import WCS"));
      return { status: failed ? 1 : 0, signal: null, timedOut: false, stderr: failed ? "original WCS import failure" : "" };
    } }), /original WCS import failure/);
  assert.equal(smokeCalls.filter(args => args.includes("install")).length, 1);
  assert.equal(smokeCalls.at(-1).some(arg => arg.includes("all_world2pix")), true);
  assert.equal(smokeCalls.at(-1).some(arg => arg.includes("fits.CompImageHDU")), true);
});

test("legacy xarray preparation pins public dependencies without changing source or retrying install", async t => {
  const root = mkdtempSync(join(tmpdir(), "swe-xarray-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "xarray"));
  writeFileSync(join(root, "xarray/__init__.py"), "");
  writeFileSync(join(root, "setup.cfg"), "[options]\ninstall_requires =\n numpy >= 1.18\n pandas >= 1.1\n");
  const source = readFileSync(join(root, "setup.cfg"), "utf8");
  assert.equal(publicPreparationPlan(root).dependencyProfile.id, "xarray-numpy1");
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ repoDir: root, baseCommit: "unused", runtimeDir: join(root, "venv"),
    artifactDir: join(root, "preparation"), runWorkerProcess: async options => {
      calls.push(options);
      return { status: calls.length === 2 ? 23 : 0, signal: null, timedOut: false, stderr: "original xarray install failure" };
    } }), /original xarray install failure/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("-e"));
  assert.ok(!calls[1].args.includes("--no-build-isolation"));
  const constraint = calls[1].args[calls[1].args.indexOf("--constraint") + 1];
  assert.equal(readFileSync(constraint, "utf8"), "numpy==1.26.4\npandas==1.5.3\n");
  assert.equal(readFileSync(join(root, "setup.cfg"), "utf8"), source);
  writeFileSync(join(root, "setup.cfg"), "[options]\ninstall_requires = numpy >= 2.0\n");
  assert.equal(publicPreparationPlan(root).dependencyProfile, undefined);
});

test("environment recovery is exactly nine pre-model failures and never the existing prediction", () => {
  const recovery = JSON.parse(readFileSync(new URL("../config/beta20-environment-recovery.json", import.meta.url)));
  const frozen = JSON.parse(readFileSync(new URL("../config/beta20-swe-remaining.json", import.meta.url)));
  assert.equal(recovery.diagnosticOnly, true); assert.equal(recovery.passAt1, null);
  assert.equal(recovery.source.runId, 34099277572); assert.equal(recovery.source.artifactId, 10010795951);
  assert.equal(recovery.batch.tasks.length, 9); assert.equal(new Set(recovery.batch.tasks).size, 9);
  assert.deepEqual(recovery.batch.tasks, recovery.evidence.map(t => t.instanceId));
  assert.ok(recovery.batch.tasks.every(id => frozen.batches.flatMap(b => b.tasks).includes(id)));
  assert.ok(!recovery.batch.tasks.includes(recovery.excludedPrediction.instanceId));
  assert.ok(recovery.evidence.every(t => t.failureStage === "preparation"));
});

test("residual recovery preserves the original nine and freezes only nineteen disjoint pre-model failures", () => {
  const recovery = JSON.parse(readFileSync(new URL("../config/beta20-environment-recovery.json", import.meta.url)));
  const residual = JSON.parse(readFileSync(new URL("../config/beta20-residual-environment-recovery.json", import.meta.url)));
  const frozen = JSON.parse(readFileSync(new URL("../config/beta20-swe-remaining.json", import.meta.url)));
  assert.equal(residual.candidateId, recovery.candidateId);
  assert.equal(residual.diagnosticOnly, true); assert.equal(residual.passAt1, null);
  assert.deepEqual(residual.batches.map(b => b.tasks.length), [10, 9]);
  const ids = residual.batches.flatMap(b => b.tasks);
  assert.equal(new Set(ids).size, 19); assert.deepEqual(ids, residual.evidence.map(t => t.instanceId));
  assert.ok(ids.every(id => frozen.batches.some(b => b.tasks.includes(id)) && !recovery.batch.tasks.includes(id)));
  assert.ok(!ids.includes(recovery.excludedPrediction.instanceId));
  for (const task of residual.evidence) {
    assert.equal(task.failureStage, "preparation"); assert.equal(task.hasPrediction, false); assert.equal(task.hasModelEvidence, false);
    assert.equal(residual.sources[task.sourceWave].runAttempt, 1);
    for (const hash of [task.receiptSha256, task.claimSha256, task.preparationSha256,
      residual.sources[task.sourceWave].artifactSha256, residual.sources[task.sourceWave].resultSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
  }
});

test("pytest profile version anchors match preserved public ancestor proof and exclude the diverged tag", () => {
  const profile = JSON.parse(readFileSync(new URL("../config/swe-python-environments.json", import.meta.url)))["pytest-setuptools-scm"];
  const proofs = ["pytest-public-ancestor-probe.json", "pytest-public-ancestor-7324-5.4.0.json"].map(name => {
    const bytes = readFileSync(new URL("../config/public-python-evidence/" + name, import.meta.url));
    const proof = JSON.parse(bytes);
    return { hash: createHash("sha256").update(bytes).digest("hex"), rows: proof.rows ?? [proof] };
  });
  for (const [base, anchor] of Object.entries(profile.ancestors)) {
    const row = proofs.find(p => p.hash === anchor.evidenceSha256).rows.find(r => r.baseCommit === base && r.tag === anchor.release);
    assert.equal(row.evidence.behind_by, 0); assert.equal(row.evidence.status, "ahead");
    assert.equal(row.evidence.ahead_by, anchor.aheadBy);
    assert.equal(row.evidence.base_commit.sha, anchor.commit); assert.equal(row.evidence.merge_base_commit.sha, anchor.commit);
    assert.notEqual(anchor.release, "5.4.3");
  }
});

test("a different public library version fails before installation and retains the observation", async t => {
  const f = fixture(t);
  rmSync(join(f.repo, "django"), { recursive: true }); mkdirSync(join(f.repo, "matplotlib"));
  writeFileSync(join(f.repo, "matplotlib/__init__.py"), ""); writeFileSync(join(f.repo, "setupext.py"), "MPLSETUPCFG\n");
  let calls = 0;
  await assert.rejects(prepareTaskEnvironment({ repoDir: f.repo, baseCommit: f.baseCommit, runtimeDir: join(f.root, "venv"),
    artifactDir: join(f.root, "preparation"), runWorkerProcess: async () => {
      calls++; return { status: 0, signal: null, timedOut: false, stdout: "27.0.0\n", stderr: "" };
    } }), /Public freetype2 version 27.0.0 does not match frozen 26.6.20/);
  assert.equal(calls, 1);
  const manifest = JSON.parse(readFileSync(join(f.root, "preparation/manifest.json")));
  assert.equal(manifest.status, "preparation-failed"); assert.equal(manifest.steps[0].stdout, "27.0.0\n");
});

test("Sphinx is not prepared when imports pass but the default builder rejects its extension versions", async t => {
  const root = mkdtempSync(join(tmpdir(), "swe-sphinx-builder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sphinx")); writeFileSync(join(root, "sphinx/__init__.py"), "");
  writeFileSync(join(root, "setup.py"), "setup()");
  let builder;
  const calls = [];
  await assert.rejects(prepareTaskEnvironment({ repoDir: root, baseCommit: "unused", runtimeDir: join(root, "venv"),
    artifactDir: join(root, "preparation"), runWorkerProcess: async options => {
      calls.push(options.args);
      if (options.args.at(-1).includes("from sphinx.application import Sphinx")) builder = options.args.at(-1);
      return { status: builder ? 2 : 0, signal: null, timedOut: false, stderr: builder ? "Extension requires Sphinx v5.0" : "" };
    } }), /Extension requires Sphinx v5.0/);
  assert.match(builder, /TemporaryDirectory/); assert.match(builder, /app\.build\(force_all=True\)/);
  assert.ok(calls.some(args => args.includes("pytest") && args.includes("--help")));
  assert.ok(!calls.some(args => args[0] === "/usr/bin/git"));
  assert.equal(JSON.parse(readFileSync(join(root, "preparation/manifest.json"))).status, "preparation-failed");
});

test("terminal patch includes actual source changes without preparation exclusions", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "django/__init__.py"), "changed = True\n");
  writeFileSync(join(f.repo, "test_regression.py"), "assert True\n");
  const patch = captureTerminalPatch({ repoDir: f.repo, baseCommit: f.baseCommit, temporaryIndexPath: join(f.root, "capture.index") });
  assert.match(patch, /changed = True/); assert.match(patch, /test_regression.py/);
});

test("watchdog closes an owned detached descendant holding output pipes", async t => {
  const f = fixture(t);
  const pidFile = join(f.root, "child.pid");
  let childPid;
  t.after(() => { if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch {} } });
  const script = `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('.'),50)"],{detached:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const start = Date.now();
  const result = await runCliProcess({ args: [process.execPath, "-e", script], cwd: f.root, timeoutMs: 250,
    forceCleanup: () => { childPid = Number(readFileSync(pidFile, "utf8")); process.kill(-childPid, "SIGKILL"); } });
  assert.equal(result.timedOut, true); assert.equal(result.timeoutClosure, "forced");
  assert.ok(Date.now() - start < 8000); assert.ok(result.stdout.length > 0);
});

for (const stream of [undefined, false, true]) {
  test(`scripted probe HTTP contract respects stream=${stream}`, async t => {
    const f = fixture(t);
    mkdirSync(join(f.root, "staging"));
    const result = await probeWorker({ repoDir: f.repo, taskDir: f.root,
      artifactDir: join(f.root, "probe"), cliInvocation: ["http-contract-test"], env: { VIRTUAL_ENV: join(f.root, "venv") }, projectModule: "django",
      inspectEvidence: () => ({ complete: true, rootStatus: "completed" }),
      runWorkerProcess: async ({ env }) => {
        for (let round = 0; round < 2; round++) {
          const response = await fetch(`${env.BEST_AGENT_PROVIDER_BASE_URL}/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ stream, messages: round === 0 ? [] : [{ role: "tool", content: "WORKER_PROBE_OK" }] }),
          });
          assert.equal(response.status, 200);
          const text = await response.text();
          if (stream === true) {
            assert.match(response.headers.get("content-type"), /text\/event-stream/);
            const chunks = text.split("\n\n").filter(x => x && x !== "data: [DONE]").map(x => JSON.parse(x.slice(6)));
            assert.equal(chunks[0].object, "chat.completion.chunk");
            assert.equal(chunks.at(-1).choices[0].finish_reason, round === 0 ? "tool_calls" : "stop");
          } else {
            assert.match(response.headers.get("content-type"), /application\/json/);
            const payload = JSON.parse(text);
            assert.equal(payload.object, "chat.completion");
            assert.equal(payload.choices[0].finish_reason, round === 0 ? "tool_calls" : "stop");
            assert.ok(payload.choices[0].message);
            if (round === 0) {
              const toolArgs = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
              assert.deepEqual(toolArgs.args, ["-B", join(f.root, "worker-probe.py")]);
              assert.ok(toolArgs.args.every(arg => !/[\r\n\0]/.test(arg)));
              const source = readFileSync(toolArgs.args[1], "utf8");
              assert.match(source, /WORKER_PROBE_OK/);
              assert.match(source, /assert Path\(sys.prefix\).resolve\(\)==venv/);
              assert.match(source, /assert Path\(module.__file__\).resolve\(\).is_relative_to\(repo\)/);
              assert.match(source, /importlib.import_module\("django"\)/);
            }
          }
        }
        writeFileSync(join(f.root, "staging/probe.evidence.jsonl"), "HTTP-contract-only\n");
        return { status: 0 };
      },
    });
    assert.equal(result.requests, 2);
  });
}

test("frozen beta20 selection is 82 unique tasks in mutually exclusive bounded waves", () => {
  const s = JSON.parse(readFileSync(new URL("../config/beta20-swe-remaining.json", import.meta.url)));
  const ids = s.batches.flatMap(b => b.tasks);
  assert.equal(ids.length, 82); assert.equal(new Set(ids).size, 82);
  assert.equal(s.historicalResolved, 418); assert.equal(s.passAt1, null);
  assert.ok(ids.includes("django__django-13794")); assert.ok(ids.includes("django__django-16667"));
  assert.ok(s.batches.every(b => b.tasks.length > 0 && b.tasks.length <= 10));
});
