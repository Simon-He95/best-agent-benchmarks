import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKER = "benchworker";
export const MAX_MODEL_CYCLES = 2251799813685247;
export const WORKER_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function taskWorkspaceCliArgs(repoDir) {
  return ["run", "--workspace", repoDir, "--workspace-backend", "plain",
    "--workspace-authorization", "unrestricted", "--command-policy", "path",
    "--process-isolation", "host", "--workspace-grant", "read",
    "--workspace-grant", "write", "--workspace-grant", "exec",
    "--max-model-cycles", String(MAX_MODEL_CYCLES)];
}

export function workerEnvironment(taskDir) {
  return { PATH: WORKER_PATH, HOME: join(taskDir, "home"), TMPDIR: join(taskDir, "tmp"),
    PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_CACHE_DIR: "1",
    PIP_RETRIES: "0", PIP_RESUME_RETRIES: "0", PIP_TIMEOUT: "60", UV_HTTP_RETRIES: "0", UV_PYTHON_INSTALL_DIR: join(taskDir, "python"),
    UV_CACHE_DIR: join(taskDir, "uv-cache") };
}

export function prepareWorkerDirectory(taskDir) {
  for (const name of ["home", "tmp", "staging"]) mkdirSync(join(taskDir, name), { recursive: true });
  const result = spawnSync("sudo", ["-n", "chown", "-R", `${WORKER}:staff`, taskDir], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Cannot assign task directory to worker");
}

export function createWorkerRunner(runProcess, taskDir) {
  return async ({ args, cwd, timeoutMs, env = {}, stdoutPath, stderrPath }) => runProcess({
    args: ["sudo", "-n", "-H", "-u", WORKER, "--", "/usr/bin/env", "-i",
      ...Object.entries({ ...workerEnvironment(taskDir), ...env }).map(([k, v]) => `${k}=${v}`), ...args],
    cwd, timeoutMs, env: { PATH: WORKER_PATH }, stdoutPath, stderrPath, forceCleanup: stopWorkerProcesses,
  });
}

export function stopWorkerProcesses() {
  // This account belongs exclusively to the current hosted generation job.
  const result = spawnSync("sudo", ["-n", "pkill", "-KILL", "-u", WORKER], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || "Cannot close worker processes");
}

export function workerGitRunner(taskDir) {
  return (_command, args, options) => spawnSync("sudo", ["-n", "-H", "-u", WORKER, "--", "/usr/bin/env", "-i",
    ...Object.entries({ ...workerEnvironment(taskDir), GIT_INDEX_FILE: options.env.GIT_INDEX_FILE }).map(([k, v]) => `${k}=${v}`),
    "/usr/bin/git", ...args], { ...options, env: { PATH: WORKER_PATH } });
}

export function taskProviderEnvironment(taskDir, timeoutMs, environment = process.env) {
  const credentials = join(taskDir, "credentials");
  mkdirSync(credentials);
  const providerPath = join(credentials, "provider.json");
  cpSync(environment.BEST_AGENT_PROVIDER_CONFIG, providerPath, { errorOnExist: true, force: false });
  const dimcodeHome = join(credentials, "dimcode");
  cpSync(environment.DIMCODE_HOME, dimcodeHome, { recursive: true, errorOnExist: true, force: false });
  prepareWorkerDirectory(taskDir);
  return { BEST_AGENT_PROVIDER_CONFIG: providerPath, DIMCODE_HOME: dimcodeHome,
    BEST_AGENT_PROVIDER_TIMEOUT_MS: String(timeoutMs), BEST_AGENT_STORAGE_ROOT: join(taskDir, "storage") };
}

export function publicPreparationPlan(repoDir) {
  const files = ["pyproject.toml", "setup.cfg", "setup.py", "tox.ini", "requirements_dev.txt",
    "requirements/test.txt", "requirements/tests.txt", "tests/requirements/py3.txt", "astropy/wcs/setup_package.py",
    "astropy/units/quantity_helper/function_helpers.py", "astropy/table/_np_utils.pyx",
    "astropy/tests/plugins/config.py", "astropy/io/fits/setup_package.py", "cextern/cfitsio/lib/fitsio.h",
    "cextern/cfitsio/lib/group.c", "ah_bootstrap.py", ".gitmodules", "setupext.py", "mplsetup.cfg.template"];
  const support = files.filter(p => existsSync(join(repoDir, p))).map(path => {
    const bytes = readFileSync(join(repoDir, path));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const metadata = support.filter(f => ["setup.py", "setup.cfg", "pyproject.toml"].includes(f.path))
    .map(f => readFileSync(join(repoDir, f.path), "utf8")).join("\n");
  if (!metadata) throw new Error("Public checkout has no Python package metadata");
  const python = /(?:python_requires|requires-python)\s*=\s*["']?>=3\.(?:10|11)\b/.test(metadata) ? "3.11.16" : "3.9.25";
  const testExtra = metadata.match(/(?:^|\n)\s*(?:(test|testing)\s*=\s*(?:\[|#|\n)|['"](test|testing)['"]\s*:\s*\[)/);
  const extras = testExtra ? `.[${testExtra[1] ?? testExtra[2]}]` : ".";
  const requirements = ["requirements/test.txt", "requirements/tests.txt", "tests/requirements/py3.txt"]
    .filter(p => existsSync(join(repoDir, p)));
  const module = ["django", "astropy", "matplotlib", "requests", "xarray", "pylint", "sklearn", "sphinx", "sympy"]
    .find(name => existsSync(join(repoDir, name, "__init__.py")) || existsSync(join(repoDir, "lib", name, "__init__.py")) || existsSync(join(repoDir, "src", name, "__init__.py")))
    ?? (existsSync(join(repoDir, "src", "_pytest")) ? "pytest" : undefined);
  if (!module) throw new Error("Cannot determine public project import entry");
  const astropyWcsSetup = support.find(f => f.path === "astropy/wcs/setup_package.py");
  const cfitsioHeader = support.find(f => f.path === "cextern/cfitsio/lib/fitsio.h");
  const fitsSetup = support.find(f => f.path === "astropy/io/fits/setup_package.py");
  const matplotlibSetup = support.find(f => f.path === "setupext.py");
  const profileId = module === "astropy" && cfitsioHeader && fitsSetup &&
    /#define CFITSIO_VERSION\s+4\.2\.0\b/.test(readFileSync(join(repoDir, cfitsioHeader.path), "utf8")) &&
    readFileSync(join(repoDir, fitsSetup.path), "utf8").includes("ASTROPY_USE_SYSTEM_CFITSIO") ? "astropy-cfitsio42"
    : module === "astropy" && astropyWcsSetup &&
    readFileSync(join(repoDir, astropyWcsSetup.path), "utf8").includes("from setuptools.dep_util import newer_group") ? "astropy-setuptools-dep-util"
    : module === "astropy" && !existsSync(join(repoDir, "pyproject.toml")) && metadata.includes("import ah_bootstrap") ? "astropy-ah-bootstrap"
    : module === "matplotlib" && matplotlibSetup && readFileSync(join(repoDir, matplotlibSetup.path), "utf8").includes("MPLSETUPCFG")
      ? (metadata.includes("oldest-supported-numpy") ? "matplotlib-oldest-supported-numpy" : "matplotlib-numpy1")
    : module === "pytest" && metadata.includes("use_scm_version") ? "pytest-setuptools-scm"
    : module === "xarray" && /numpy\s*>=\s*1\./.test(metadata) ? "xarray-numpy1"
    : module === "sphinx" ? "sphinx-pkg-resources"
    : module === "sklearn" && !existsSync(join(repoDir, "pyproject.toml")) && metadata.includes("numpy.distutils") ? "sklearn-numpy-distutils"
    : module === "sklearn" && metadata.includes("oldest-supported-numpy") ? "sklearn-oldest-supported-numpy" : undefined;
  const profileBytes = readFileSync(new URL("../config/swe-python-environments.json", import.meta.url));
  const dependencyProfile = profileId === undefined ? undefined : { id: profileId,
    configSha256: createHash("sha256").update(profileBytes).digest("hex"), ...JSON.parse(profileBytes)[profileId] };
  return { python, extras, requirements, module, support, dependencyProfile };
}

export async function prepareTaskEnvironment({ repoDir, baseCommit, runtimeDir, artifactDir, runWorkerProcess }) {
  mkdirSync(artifactDir, { recursive: true });
  const steps = [];
  const manifest = { schemaVersion: 1, baseCommit, runtimeDir, status: "preparing", steps };
  const save = () => writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  try {
    const plan = publicPreparationPlan(repoDir);
    manifest.publicPlan = plan;
    const profile = plan.dependencyProfile;
    const env = { VIRTUAL_ENV: runtimeDir, PATH: `${runtimeDir}/bin:${WORKER_PATH}`, ...profile?.env };
    const run = async (args, processEnv = env, cwd = repoDir) => {
      const prefix = join(artifactDir, `step-${steps.length}`);
      const stepEnv = { ...processEnv, PIP_VERBOSE: "1" };
      const result = await runWorkerProcess({ args, cwd, timeoutMs: args.includes("install") ? 1_800_000 : 600_000, env: stepEnv,
        stdoutPath: `${prefix}.stdout.txt`, stderrPath: `${prefix}.stderr.txt` });
      steps.push({ args, cwd, env: stepEnv, ...result });
      if (result.error || result.status !== 0 || result.signal !== null || result.timedOut) {
        throw result.error ?? new Error(result.stderr || result.stdout || `Preparation process exit ${result.status}, signal ${result.signal}`);
      }
      return result;
    };
    if (profile?.systemLibrary) {
      const library = profile.systemLibrary;
      const version = await run(["pkg-config", "--modversion", library.pkgConfig]);
      if (version.stdout.trim() !== library.version) throw new Error(`Public ${library.pkgConfig} version ${version.stdout.trim()} does not match frozen ${library.version}`);
      const directory = await run(["pkg-config", "--variable=libdir", library.pkgConfig]);
      const path = join(directory.stdout.trim(), library.dylib);
      const digest = await run(["shasum", "-a", "256", path]);
      manifest.systemLibrary = { ...library, path, sha256: digest.stdout.split(/\s/)[0] };
      if (plan.module === "matplotlib") {
        const path = join(dirname(runtimeDir), "mplsetup.cfg");
        const content = "[libs]\nsystem_freetype = True\n";
        writeFileSync(path, content, { flag: "wx", mode: 0o644 });
        env.MPLSETUPCFG = path;
        manifest.externalConfig = { path, sha256: createHash("sha256").update(content).digest("hex") };
      }
    }
    if (profile?.id === "astropy-ah-bootstrap") {
      const link = await run(["/usr/bin/git", "ls-tree", baseCommit, "--", "astropy_helpers"]);
      const commit = /^160000 commit ([a-f0-9]{40})\tastropy_helpers\n$/.exec(link.stdout)?.[1];
      if (!commit) throw new Error("Public astropy_helpers gitlink is missing: " + link.stdout);
      const declared = await run(["/usr/bin/git", "config", "-f", ".gitmodules", "--get", "submodule.astropy_helpers.url"]);
      const url = declared.stdout.trim();
      if (url !== "https://github.com/astropy/astropy-helpers.git") throw new Error("Unverified public astropy_helpers source: " + url);
      const helperDir = join(repoDir, "astropy_helpers");
      await run(["/usr/bin/git", "submodule", "init", "--", "astropy_helpers"]);
      await run(["/usr/bin/git", "init", "astropy_helpers"]);
      await run(["/usr/bin/git", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--no-auto-maintenance", "--depth=1", "--no-tags", "--", url, commit], env, helperDir);
      await run(["/usr/bin/git", "checkout", "--detach", commit], env, helperDir);
      const head = await run(["/usr/bin/git", "rev-parse", "HEAD"], env, helperDir);
      const count = await run(["/usr/bin/git", "rev-list", "--count", "HEAD"], env, helperDir);
      const refs = await run(["/usr/bin/git", "for-each-ref"], env, helperDir);
      if (head.stdout.trim() !== commit || count.stdout.trim() !== "1" || refs.stdout) throw new Error("Public helper checkout is not the single frozen gitlink commit");
      manifest.publicHelper = { path: "astropy_helpers", commit, url };
    }
    let versionEnv = {};
    if (profile?.id === "pytest-setuptools-scm") {
      const ancestor = profile.ancestors[baseCommit];
      if (!ancestor) throw new Error("No verified public pytest version provenance for base " + baseCommit);
      const version = `${ancestor.release}.post${ancestor.aheadBy}+g${baseCommit}`;
      manifest.publicVersion = { version, meaning: profile.versionMeaning, baseCommit, ancestor };
      versionEnv = { SETUPTOOLS_SCM_PRETEND_VERSION_FOR_PYTEST: version };
    }
    const constraints = [];
    if (profile) {
      for (const [kind, flag] of [["runtimeConstraints", "--constraint"], ["buildConstraints", "--build-constraint"]]) {
        if (!profile[kind].length) continue;
        const path = join(dirname(runtimeDir), `public-${kind}.txt`);
        writeFileSync(path, profile[kind].join("\n") + "\n", { flag: "wx", mode: 0o644 });
        constraints.push(flag, path);
      }
    }
    const commands = [
      ["uv", "venv", "--seed", "--python", plan.python, runtimeDir],
      ...(profile?.bootstrap.length ? [[join(runtimeDir, "bin/python"), "-m", "pip", "install", "--no-compile", ...profile.bootstrap]] : []),
      [join(runtimeDir, "bin/python"), "-m", "pip", "install", "--no-compile", "-e", plan.extras,
        ...constraints, ...(profile?.noBuildIsolation ? ["--no-build-isolation"] : []),
        ...(plan.module === "pytest" ? [] : ["pytest"]), ...plan.requirements.flatMap(p => ["-r", p])],
      [join(runtimeDir, "bin/python"), "-m", "pip", "check"],
      [join(runtimeDir, "bin/python"), "-m", "pip", "freeze", "--all"],
      [join(runtimeDir, "bin/python"), "-B", "-c", `import ${plan.module}; import sys,ssl,sqlite3; print(sys.version); print(${plan.module}.__file__); print(ssl.OPENSSL_VERSION); print(sqlite3.sqlite_version)`],
      plan.module === "django" ? [join(runtimeDir, "bin/python"), "-B", "tests/runtests.py", "--help"]
        : [join(runtimeDir, "bin/python"), "-B", "-m", "pytest", "--help"],
      ...(plan.module === "xarray" ? [[join(runtimeDir, "bin/python"), "-B", "-c",
        "import xarray as xr; a=xr.DataArray([1,2,3],dims=['x']); assert a.sum().item()==6; print(a)"]] : []),
      ...(plan.module === "astropy" ? [[join(runtimeDir, "bin/python"), "-B", "-c",
        ["from astropy.wcs import WCS", "from astropy.io import fits", "import io, numpy as np",
          "w=WCS(naxis=2); xy=np.array([[0.,0.],[1.,2.]])",
          "assert np.allclose(w.all_world2pix(w.all_pix2world(xy,0),0),xy)",
          "a=np.arange(24,dtype=np.int16).reshape(4,6); b=io.BytesIO()",
          "fits.CompImageHDU(a).writeto(b); b.seek(0)",
          "with fits.open(b) as hdus: assert np.array_equal(hdus[1].data,a)",
          "print('WCS and compressed FITS roundtrip OK', np.__version__)",
        ].join("\n")]] : []),
      ...(plan.module === "matplotlib" && profile?.systemLibrary ? [[join(runtimeDir, "bin/python"), "-B", "-c", [
        "import io, matplotlib", "matplotlib.use('Agg')", "from matplotlib.figure import Figure",
        "from matplotlib.backends.backend_agg import FigureCanvasAgg", "from matplotlib import ft2font",
        `assert ft2font.__freetype_version__ == ${JSON.stringify(profile.systemLibrary.release)}`,
        "assert ft2font.__freetype_build_type__ == 'system'",
        "fig=Figure(figsize=(2,2)); canvas=FigureCanvasAgg(fig); ax=fig.subplots(); ax.plot([0,1],[0,1]); ax.set_title('Environment probe')",
        "b=io.BytesIO(); canvas.print_png(b); assert b.getvalue().startswith(b'\\x89PNG\\r\\n\\x1a\\n') and len(b.getvalue())>100",
        "print('Agg PNG OK', len(b.getvalue()), ft2font.__freetype_version__)",
      ].join("\n")]] : []),
      ...(manifest.publicVersion ? [[join(runtimeDir, "bin/python"), "-B", "-c", [
        "import pytest, importlib.metadata as metadata", "from _pytest import _version",
        `assert pytest.__version__ == _version.version == metadata.version('pytest') == ${JSON.stringify(manifest.publicVersion.version)}`,
        "print(pytest.__version__)",
      ].join("\n")]] : []),
      ...(plan.module === "sphinx" ? [[join(runtimeDir, "bin/python"), "-B", "-c", [
        "from pathlib import Path", "from tempfile import TemporaryDirectory", "from sphinx.application import Sphinx",
        "with TemporaryDirectory() as tmp:", " p = Path(tmp)",
        " (p / 'conf.py').write_text(\"project = 'Environment probe'\\nmaster_doc = 'index'\\n\")",
        " (p / 'index.rst').write_text('Environment probe\\n=================\\n')",
        " app = Sphinx(str(p), str(p), str(p / 'out'), str(p / 'doctrees'), 'html', warningiserror=True)",
        " app.build(force_all=True)", " raise SystemExit(app.statuscode)",
      ].join("\n")]] : []),
    ];
    for (const args of commands) await run(args, args.includes("-e") ? { ...env, ...versionEnv } : env);
    const git = async (name, args) => {
      const result = await runWorkerProcess({ args: ["/usr/bin/git", ...args], cwd: repoDir, timeoutMs: 60_000,
        stdoutPath: join(artifactDir, `${name}.stdout.txt`), stderrPath: join(artifactDir, `${name}.stderr.txt`) });
      steps.push({ args: ["/usr/bin/git", ...args], ...result });
      return result;
    };
    const head = await git("head", ["rev-parse", "HEAD"]);
    const diff = await git("diff", ["diff", "--exit-code", baseCommit, "--"]);
    if (head.status !== 0 || head.stdout.trim() !== baseCommit || diff.status !== 0 || diff.stdout) {
      throw new Error("Public preparation changed frozen HEAD or tracked source: " + (head.stderr || diff.stderr || diff.stdout));
    }
    const generated = await git("generated", ["ls-files", "--others"]);
    if (generated.status !== 0) throw new Error(generated.stderr);
    manifest.generatedFiles = generated.stdout.split("\n").filter(Boolean);
    manifest.status = "prepared";
    manifest.env = env;
    save();
    return { ...plan, env, receiptPath: join(artifactDir, "manifest.json") };
  } catch (error) {
    manifest.status = "preparation-failed";
    manifest.error = String(error);
    save();
    throw error;
  }
}

export async function probeWorker({ repoDir, taskDir, artifactDir, cliInvocation, env, projectModule, runWorkerProcess, inspectEvidence }) {
  mkdirSync(artifactDir, { recursive: true });
  const privateCanary = join(artifactDir, "private-canary.txt");
  writeFileSync(privateCanary, "controller-private", { flag: "wx", mode: 0o600 });
  const outside = join(taskDir, "outside-workspace.txt");
  const stagedEvidence = join(taskDir, "staging", "probe.evidence.jsonl");
  const requests = [];
  const source = `from pathlib import Path\nimport subprocess,sys,os,json,importlib,importlib.metadata\nrepo=Path(${JSON.stringify(repoDir)}).resolve()\nvenv=Path(${JSON.stringify(env.VIRTUAL_ENV)}).resolve()\nmodule=importlib.import_module(${JSON.stringify(projectModule)})\nidentity={'cwd':os.getcwd(),'executable':sys.executable,'prefix':sys.prefix,'projectModule':${JSON.stringify(projectModule)},'modulePath':module.__file__,'dependencies':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}\nprint(json.dumps(identity,sort_keys=True),flush=True)\nassert Path.cwd().resolve()==repo, identity\nassert Path(sys.prefix).resolve()==venv, identity\nassert Path(sys.executable).parent.resolve()==venv/'bin', identity\nassert Path(module.__file__).resolve().is_relative_to(repo), identity\np=Path(${JSON.stringify(outside)})\np.write_text('outside-ok')\nassert p.read_text()=='outside-ok'\ntry:\n Path(${JSON.stringify(privateCanary)}).read_bytes()\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('controller-private material was readable')\nr=subprocess.run(['sh','-c','printf child-ok'],capture_output=True,text=True)\nassert r.returncode==0 and r.stdout=='child-ok', (r.returncode,r.stderr)\nprint('WORKER_PROBE_OK')`;
  const scriptPath = join(taskDir, "worker-probe.py");
  writeFileSync(scriptPath, source, { flag: "wx", mode: 0o644 });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const call = requests.length === 1;
      const message = call ? { role: "assistant", content: "", tool_calls: [{ id: "worker-probe", type: "function",
        function: { name: "exec", arguments: JSON.stringify({ command: "python3", args: ["-B", scriptPath], cwd: repoDir }) } }] }
        : { role: "assistant", content: "worker probe complete" };
      if (requests.length > 2) throw new Error("Unexpected worker probe model request");
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "probe", model: "scripted-probe", object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = call ? { ...message, tool_calls: message.tool_calls.map(t => ({ ...t, index: 0 })) } : message;
      res.end([{ id: "probe", model: "scripted-probe", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "probe", model: "scripted-probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runWorkerProcess({ args: [...cliInvocation, ...taskWorkspaceCliArgs(repoDir),
      "--attempt-evidence", stagedEvidence, "Engineering probe only."], cwd: repoDir, timeoutMs: 90_000,
      env: { ...env, BEST_AGENT_PROVIDER_KIND: "openai", BEST_AGENT_PROVIDER_MODEL: "scripted-probe",
        BEST_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, BEST_AGENT_PROVIDER_API_KEY: "local-probe-only",
        BEST_AGENT_PROVIDER_COMPATIBILITY_MODE: "compatible", BEST_AGENT_PROVIDER_CONFIG: join(taskDir, "absent.json"),
        BEST_AGENT_PROVIDER_TIMEOUT_MS: "60000", BEST_AGENT_STORAGE_ROOT: join(taskDir, "probe-storage") },
      stdoutPath: join(artifactDir, "stdout.txt"), stderrPath: join(artifactDir, "stderr.txt") });
    writeFileSync(join(artifactDir, "process.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    cpSync(stagedEvidence, join(artifactDir, "attempt-evidence.jsonl"), { errorOnExist: true, force: false });
    const evidence = inspectEvidence(join(artifactDir, "attempt-evidence.jsonl"));
    const tool = requests.at(-1)?.messages.filter(m => m.role === "tool").at(-1);
    if (result.status !== 0 || !evidence.complete || evidence.rootStatus !== "completed" || requests.length !== 2 || !tool?.content.includes("WORKER_PROBE_OK")) {
      throw new Error("Published CLI worker probe failed: " + JSON.stringify({ result, evidence, tool }));
    }
    return { benchmarkAttempt: false, requests: requests.length, evidence, outsideWorkspace: true, controllerPrivateDenied: true };
  } finally {
    writeFileSync(join(artifactDir, "requests.json"), JSON.stringify(requests, null, 2), { flag: "wx" });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
