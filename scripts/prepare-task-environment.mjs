import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { probeTaskEnvironment } from "./task-environment-probe.mjs";

const runtimeName = ".benchmark-runtime";
const manifestLimit = 64 * 1024;

export function hashPreparationTree(root) {
  const hash = createHash("sha256");
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = lstatSync(file);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      hash.update(JSON.stringify([relative(root, file), kind, stat.mode & 0o777]));
      if (kind === "directory") visit(file);
      else {
        const bytes = kind === "link" ? Buffer.from(readlinkSync(file)) : readFileSync(file);
        hash.update(JSON.stringify(bytes.length));
        hash.update(bytes);
      }
    }
  }
  visit(root);
  return hash.digest("hex");
}

function contained(root, path) {
  const file = resolve(root, path);
  const local = relative(root, file);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith("../")) {
    throw new Error("Preparation path must be beneath its declared root: " + path);
  }
  return file;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifiedFile(reference) {
  if (hashFile(reference.path) !== reference.sha256) {
    throw new Error("Preparation resource hash mismatch: " + reference.path);
  }
  return readFileSync(reference.path, "utf8");
}

function git(repoDir, args) {
  const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

// The list is setup evidence only. Patch capture never consumes it as an exclusion policy.
export function inspectPreparationDelta(repoDir, baseCommit, nativeBuildOutputs) {
  if (git(repoDir, ["rev-parse", "HEAD"]).trim() !== baseCommit ||
      git(repoDir, ["diff", "--name-only", baseCommit, "--"]).trim()) {
    throw new Error("Preparation changed tracked base source or HEAD.");
  }
  const outsideRuntime = (path) => path !== runtimeName && !path.startsWith(runtimeName + "/");
  const unexpected = git(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean).filter(outsideRuntime);
  if (unexpected.length) throw new Error("Unexplained preparation output: " + unexpected.join(", "));
  const ignored = git(repoDir, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean).filter(outsideRuntime);
  const allowed = new Set(nativeBuildOutputs);
  return ignored.map((path) => {
    if (!allowed.has(path)) throw new Error("Undeclared native build output: " + path);
    const file = contained(repoDir, path);
    contained(realpathSync(repoDir), realpathSync(file));
    return { path, sha256: hashFile(file) };
  });
}

function writeManifest(path, manifest) {
  const text = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(text) > manifestLimit) throw new Error("Preparation manifest exceeds 64 KiB.");
  writeFileSync(path, text, { flag: "wx" });
}

export function loadPreparationRecipe(manifestPath, instanceId, baseCommit) {
  const raw = readFileSync(manifestPath);
  if (raw.length > manifestLimit) throw new Error("Preparation recipes exceed 64 KiB.");
  const manifest = JSON.parse(raw);
  const recipes = manifest.tasks.filter((task) => task.instanceId === instanceId);
  if (manifest.schemaVersion !== 1 || recipes.length !== 1 || recipes[0].baseCommit !== baseCommit) {
    throw new Error("No unique frozen public preparation recipe for " + instanceId);
  }
  return { recipe: recipes[0], manifestSha256: createHash("sha256").update(raw).digest("hex") };
}

export async function prepareTaskEnvironment({
  manifestPath, instanceId, baseCommit, repoDir, artifactDir, cliInvocation, executionArgs, runProcess, inspectEvidence,
}) {
  mkdirSync(artifactDir, { recursive: false });
  const receiptPath = join(artifactDir, "manifest.json");
  let manifest = { schemaVersion: 1, instanceId, baseCommit, status: "preparing", stage: "recipe" };
  try {
    const loaded = loadPreparationRecipe(manifestPath, instanceId, baseCommit);
    const recipe = loaded.recipe;
    manifest = { ...manifest, recipeManifestSha256: loaded.manifestSha256 };
    const runtimeDir = join(repoDir, runtimeName);
    if (existsSync(runtimeDir)) throw new Error("Reserved preparation prefix already exists: " + runtimeName);
    inspectPreparationDelta(repoDir, baseCommit, []);
    const support = recipe.support.map((item) => {
      const path = contained(repoDir, item.path);
      contained(realpathSync(repoDir), realpathSync(path));
      if (hashFile(path) !== item.sha256) throw new Error("Public base evidence hash mismatch: " + item.path);
      return item;
    });
    if (!support.length) throw new Error("Public base interpreter/build evidence is required.");
    verifiedFile(recipe.setup);
    const probeSource = verifiedFile(recipe.probe);
    for (const resource of [recipe.runtime, recipe.packages]) {
      if (hashPreparationTree(resource.path) !== resource.sha256) {
        throw new Error("Preparation resource tree hash mismatch: " + resource.path);
      }
    }
    manifest = { ...manifest, support, runtime: recipe.runtime, packages: recipe.packages,
      setup: recipe.setup, probe: recipe.probe, stage: "copy" };
    cpSync(recipe.runtime.path, runtimeDir, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    for (const path of recipe.relocate) {
      const target = contained(runtimeDir, path);
      contained(realpathSync(runtimeDir), realpathSync(target));
      writeFileSync(target, readFileSync(target, "utf8").replaceAll(recipe.runtime.path, runtimeDir));
    }
    const python = join(runtimeDir, "bin", "python3");
    contained(realpathSync(runtimeDir), realpathSync(python));
    manifest.stage = "setup";
    const setup = await runProcess({
      args: ["/bin/sh", recipe.setup.path, runtimeDir, recipe.packages.path],
      cwd: repoDir,
      timeoutMs: 600_000,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        PYTHONDONTWRITEBYTECODE: "1", PIP_NO_INDEX: "1", PIP_FIND_LINKS: recipe.packages.path,
        PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_CACHE_DIR: "1",
      },
    });
    writeFileSync(join(artifactDir, "setup.stdout.txt"), setup.stdout, { flag: "wx" });
    writeFileSync(join(artifactDir, "setup.stderr.txt"), setup.stderr, { flag: "wx" });
    manifest.setupProcess = { status: setup.status, signal: setup.signal, timedOut: setup.timedOut,
      stdoutOverflow: setup.stdoutOverflow, stderrOverflow: setup.stderrOverflow };
    manifest.setupOutput = ["setup.stdout.txt", "setup.stderr.txt"].map((name) => {
      const path = join(artifactDir, name);
      return { path, bytes: statSync(path).size, sha256: hashFile(path) };
    });
    if (setup.error) throw setup.error;
    if (setup.status !== 0 || setup.signal !== null || setup.timedOut || setup.stdoutOverflow || setup.stderrOverflow) {
      throw new Error("Public environment setup failed: " + (setup.stderr || setup.stdout || JSON.stringify(manifest.setupProcess)));
    }
    manifest.stage = "setup-delta";
    inspectPreparationDelta(repoDir, baseCommit, recipe.nativeBuildOutputs);
    manifest.stage = "selected-entry-probe";
    manifest.selectedProbe = await probeTaskEnvironment({
      repoDir, artifactDir, cliInvocation, executionArgs, probeSource, runProcess, inspectEvidence,
    });
    manifest.nativeBuildOutputs = inspectPreparationDelta(repoDir, baseCommit, recipe.nativeBuildOutputs);
    manifest.runtimeInitialSha256 = hashPreparationTree(runtimeDir);
    manifest.probeArtifacts = ["probe.evidence.jsonl", "probe.stdout.txt", "probe.stderr.txt", "probe.process.json", "probe.requests.json"]
      .map((name) => { const path = join(artifactDir, name); return { path, bytes: statSync(path).size, sha256: hashFile(path) }; });
    manifest.status = "prepared";
    manifest.stage = "complete";
    writeManifest(receiptPath, manifest);
    return { python, pythonVersion: manifest.selectedProbe.pythonVersion, receiptPath };
  } catch (error) {
    // This is a pre-model failure receipt, not a replacement tool error or a retry decision.
    let failure = { ...manifest, status: "preparation-failed",
      error: error instanceof Error ? error.message : String(error) };
    if (Buffer.byteLength(JSON.stringify(failure)) > manifestLimit) {
      const path = join(artifactDir, "failure.json");
      writeFileSync(path, JSON.stringify(failure), { flag: "wx" });
      failure = { schemaVersion: 1, instanceId, baseCommit, status: "preparation-failed",
        stage: manifest.stage, detail: { path, sha256: hashFile(path) } };
    }
    writeManifest(receiptPath, failure);
    throw error;
  }
}
