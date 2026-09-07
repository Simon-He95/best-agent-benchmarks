import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      artifactDir: join(f.root, "probe"), cliInvocation: ["http-contract-test"], env: {},
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
              assert.match(readFileSync(toolArgs.args[1], "utf8"), /WORKER_PROBE_OK/);
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
