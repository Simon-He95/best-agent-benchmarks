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
    PIP_RETRIES: "0", UV_HTTP_RETRIES: "0", UV_PYTHON_INSTALL_DIR: join(taskDir, "python"),
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
    "requirements/test.txt", "requirements/tests.txt", "tests/requirements/py3.txt"];
  const support = files.filter(p => existsSync(join(repoDir, p))).map(path => {
    const bytes = readFileSync(join(repoDir, path));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const metadata = support.filter(f => ["setup.py", "setup.cfg", "pyproject.toml"].includes(f.path))
    .map(f => readFileSync(join(repoDir, f.path), "utf8")).join("\n");
  if (!metadata) throw new Error("Public checkout has no Python package metadata");
  const python = /(?:python_requires|requires-python)\s*=\s*["']?>=3\.(?:10|11)\b/.test(metadata) ? "3.11.16" : "3.9.25";
  const extras = /(?:^|\n)test\s*=\s*(?:\[|#|\n)/.test(metadata) ? ".[test]" : ".";
  const requirements = ["requirements/test.txt", "requirements/tests.txt", "tests/requirements/py3.txt"]
    .filter(p => existsSync(join(repoDir, p)));
  const module = ["django", "astropy", "matplotlib", "requests", "xarray", "pylint", "sklearn", "sphinx", "sympy"]
    .find(name => existsSync(join(repoDir, name, "__init__.py")) || existsSync(join(repoDir, "lib", name, "__init__.py")) || existsSync(join(repoDir, "src", name, "__init__.py")))
    ?? (existsSync(join(repoDir, "src", "_pytest")) ? "pytest" : undefined);
  if (!module) throw new Error("Cannot determine public project import entry");
  return { python, extras, requirements, module, support };
}

export async function prepareTaskEnvironment({ repoDir, baseCommit, runtimeDir, artifactDir, runWorkerProcess }) {
  mkdirSync(artifactDir, { recursive: true });
  const steps = [];
  const manifest = { schemaVersion: 1, baseCommit, runtimeDir, status: "preparing", steps };
  const save = () => writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  try {
    const plan = publicPreparationPlan(repoDir);
    manifest.publicPlan = plan;
    const env = { VIRTUAL_ENV: runtimeDir, PATH: `${runtimeDir}/bin:${WORKER_PATH}` };
    const commands = [
      ["uv", "venv", "--seed", "--python", plan.python, runtimeDir],
      [join(runtimeDir, "bin/python"), "-m", "pip", "install", "--no-compile", "-e", plan.extras,
        ...(plan.module === "pytest" ? [] : ["pytest"]), ...plan.requirements.flatMap(p => ["-r", p])],
      [join(runtimeDir, "bin/python"), "-m", "pip", "check"],
      [join(runtimeDir, "bin/python"), "-m", "pip", "freeze", "--all"],
      [join(runtimeDir, "bin/python"), "-B", "-c", `import ${plan.module}; import sys,ssl,sqlite3; print(sys.version); print(${plan.module}.__file__); print(ssl.OPENSSL_VERSION); print(sqlite3.sqlite_version)`],
      plan.module === "django" ? [join(runtimeDir, "bin/python"), "-B", "tests/runtests.py", "--help"]
        : [join(runtimeDir, "bin/python"), "-B", "-m", "pytest", "--help"],
    ];
    for (const [index, args] of commands.entries()) {
      const prefix = join(artifactDir, `step-${index}`);
      const result = await runWorkerProcess({ args, cwd: repoDir, timeoutMs: 600_000, env,
        stdoutPath: `${prefix}.stdout.txt`, stderrPath: `${prefix}.stderr.txt` });
      steps.push({ args, ...result });
      if (result.error || result.status !== 0 || result.signal !== null || result.timedOut) {
        throw result.error ?? new Error(result.stderr || result.stdout || `Preparation process exit ${result.status}, signal ${result.signal}`);
      }
    }
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

export async function probeWorker({ repoDir, taskDir, artifactDir, cliInvocation, env, runWorkerProcess, inspectEvidence }) {
  mkdirSync(artifactDir, { recursive: true });
  const privateCanary = join(artifactDir, "private-canary.txt");
  writeFileSync(privateCanary, "controller-private", { flag: "wx", mode: 0o600 });
  const outside = join(taskDir, "outside-workspace.txt");
  const stagedEvidence = join(taskDir, "staging", "probe.evidence.jsonl");
  const requests = [];
  const source = `from pathlib import Path\nimport subprocess,sys,os\np=Path(${JSON.stringify(outside)})\np.write_text('outside-ok')\nassert p.read_text()=='outside-ok'\ntry:\n Path(${JSON.stringify(privateCanary)}).read_bytes()\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('controller-private material was readable')\nr=subprocess.run(['sh','-c','printf child-ok'],capture_output=True,text=True)\nassert r.returncode==0 and r.stdout=='child-ok', (r.returncode,r.stderr)\nprint('WORKER_PROBE_OK')`;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const call = requests.length === 1;
      const message = call ? { role: "assistant", content: "", tool_calls: [{ id: "worker-probe", type: "function",
        function: { name: "exec", arguments: JSON.stringify({ command: "python3", args: ["-B", "-c", source], cwd: repoDir }) } }] }
        : { role: "assistant", content: "worker probe complete" };
      if (requests.length > 2) throw new Error("Unexpected worker probe model request");
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
