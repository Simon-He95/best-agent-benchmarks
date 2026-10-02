#!/usr/bin/env node
/**
 * FrontierHarness candidate delivery verification.
 *
 * The frontier-harness candidate job builds a fresh linux-x64-gnu SEA from the
 * pinned best-agent commit and freezes a hash receipt, but a receipt only proves
 * that the bytes are the bytes that were built. What it cannot show is that the
 * delivery this benchmark consumes is usable. `pnpm pack:tui` does run the
 * project's own gates (`pnpm -w build`, which includes `pnpm typecheck`) and does
 * smoke-test the packages it packs — but it verifies the `pnpm pack` tarballs on
 * the host that built them, whereas the candidate job ships a *different* tarball
 * it assembles itself (`npm install --prefix <stage> --omit=dev` + `tar czf`), and
 * nothing ever starts that one or records a verdict bound to its bytes. This module
 * is the delivery gate between "an artifact exists" and "a benchmark run may use
 * it": it re-checks packaging, source typecheck and the built artifact against the
 * delivered bytes, and fails closed.
 *
 * Ownership: `candidate.json` is the freeze step's identity receipt — written once by
 * the candidate job and never rewritten, because its bytes are the frozen
 * `candidateManifestSha256` of every per-task record. This module is therefore the
 * sole writer of a separate `delivery-verification.json`, which binds its evidence to
 * the exact receipt hash it verified. The job's exit status is the gate (`fh-generate`
 * depends on `fh-candidate`); no downstream module re-derives "the delivery is usable"
 * from the record, so the fact keeps one owner and one direction.
 * Verification only ever runs against a pristine delivery: the file-set check below
 * still requires exactly the frozen files, so a directory that already carries a
 * record is rejected instead of re-verified.
 *
 * Checks (all recorded in the verification record):
 *   packaging   the candidate directory is exactly the frozen file set, the receipt
 *               identity matches config/frontier-harness.json#cli, the tarball and
 *               build report bytes match the receipt, and the tarball extracts to a
 *               staged package whose declared `bin` targets, packaged runtime node,
 *               and receipt runtime dependency closure are all present.
 *   typecheck   the delivered pinned checkout's own `typecheck` script exits 0.
 *               `pnpm -w build` already runs it, so this is an explicit
 *               confirmation bound to the delivered bytes, not the only gate.
 *   runtime     the packed executable answers its version query with the frozen CLI
 *               version and the packaged node reports the frozen node version. This
 *               only means something on the target platform, so it is reported as
 *               `skipped` (never `passed`) unless --expect-runtime is declared, and
 *               with --expect-runtime the host must actually be the frozen target:
 *               a runtime result gathered on any other host is not evidence about
 *               the artifact a benchmark would run.
 *
 * Usage:
 *   node scripts/verify-frontier-harness-candidate.mjs \
 *     --candidate-dir results/candidate \
 *     [--source-dir tools/best-agent-source] \
 *     [--expect-runtime]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const CANDIDATE_FILES = ["best-agent-cli.tgz", "build-report.json", "candidate.json"];
/** This module's own record; see the ownership note above. */
export const VERIFICATION_FILE = "delivery-verification.json";
const RUNTIME_NODE = "runtime/bin/node";

/** The SEA binary name the staged package ships for a frozen target id. */
export function targetBinaryName(target) {
  return String(target).startsWith("win32") ? "best-agent.exe" : "best-agent";
}

/**
 * The host a frozen target id runs on, as `process.platform`/`process.arch` spell
 * it: `linux-x64-gnu` -> linux/x64, `darwin-arm64` -> darwin/arm64.
 *
 * @param {string} target a frozen target id
 * @returns {{ platform: string, arch: string }}
 */
export function targetHost(target) {
  const [platform, arch] = String(target).split("-");
  return { platform, arch };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    candidateDir: resolve(repoRoot, "results", "candidate"),
    sourceDir: undefined,
    expectRuntime: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--candidate-dir":
        parsed.candidateDir = resolve(argv[++i]);
        break;
      case "--source-dir":
        parsed.sourceDir = resolve(argv[++i]);
        break;
      case "--expect-runtime":
        parsed.expectRuntime = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return parsed;
}

function defaultRun(command, args, options) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

/** Trailing output of a failed command, bounded so a report stays readable. */
function commandFailure(result) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text.length > 2000 ? `…${text.slice(-2000)}` : text;
}

/** `tar czf -C <stage> .` writes `./`-prefixed members; compare without the prefix. */
function normalizeMember(name) {
  return name.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function listTarMembers(tarball, run) {
  const result = run("tar", ["-tzf", tarball]);
  if (result.status !== 0) {
    throw new Error(`tarball is not a readable gzip tar: ${commandFailure(result)}`);
  }
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeMember),
  );
}

/**
 * Verify one delivery of the frozen candidate. Every check is recorded, so a
 * caller always gets the full evidence list even when the first check fails.
 *
 * @param {{ candidateDir: string, config: object, sourceDir?: string, expectRuntime?: boolean, run?: Function }} options
 * @returns {{ verified: boolean, checks: Array<{id: string, status: string, detail: string}> }}
 */
export function verifyDelivery({
  candidateDir,
  config,
  sourceDir,
  expectRuntime = false,
  run = defaultRun,
  host = { platform: process.platform, arch: process.arch },
}) {
  const checks = [];
  const record = (id, detail) => checks.push({ id, status: "passed", detail });
  const check = (id, fn) => {
    try {
      const detail = fn();
      if (detail === undefined) return;
      record(id, String(detail));
    } catch (error) {
      checks.push({ id, status: "failed", detail: String(error?.message ?? error) });
    }
  };

  const cli = config.cli ?? {};
  const tarball = join(candidateDir, "best-agent-cli.tgz");
  const receiptPath = join(candidateDir, "candidate.json");
  let receipt;

  check("packaging.files", () => {
    const files = readdirSync(candidateDir).sort();
    const expected = [...CANDIDATE_FILES].sort();
    if (JSON.stringify(files) !== JSON.stringify(expected)) {
      throw new Error(
        `a delivered candidate must contain exactly ${expected.join(", ")}; found ${files.join(", ")}`,
      );
    }
    return expected.join(", ");
  });

  check("packaging.receipt", () => {
    if (!existsSync(receiptPath)) throw new Error("candidate.json is missing");
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.schemaVersion !== 1) {
      throw new Error(`receipt schemaVersion must be 1, got ${String(receipt.schemaVersion)}`);
    }
    for (const field of ["packageName", "cliVersion", "sourceRepository", "sourceCommit", "target"]) {
      if (receipt[field] !== cli[field]) {
        throw new Error(
          `receipt ${field} ${String(receipt[field])} does not match the frozen config value ${String(cli[field])}`,
        );
      }
    }
    return `${receipt.packageName}@${receipt.cliVersion} ${receipt.target} ${receipt.sourceCommit.slice(0, 7)}`;
  });

  check("packaging.bytes", () => {
    for (const [field, path] of [
      ["tarballSha256", tarball],
      ["buildReportSha256", join(candidateDir, "build-report.json")],
    ]) {
      const actual = sha256File(path);
      if (actual !== receipt[field]) {
        throw new Error(`${field} mismatch: ${actual} != ${String(receipt[field])}`);
      }
    }
    return `tarball ${receipt.tarballSha256.slice(0, 12)} matches the receipt`;
  });

  let extracted;
  let executableMember;
  check("packaging.tarball", () => {
    const members = listTarMembers(tarball, run);
    const stage = mkdtempSync(join(tmpdir(), "fh-candidate-verify-"));
    extracted = stage;
    const unpacked = run("tar", ["-xzf", tarball, "-C", stage]);
    if (unpacked.status !== 0) {
      throw new Error(`tarball did not extract: ${commandFailure(unpacked)}`);
    }
    const manifestPath = join(stage, "package.json");
    if (!existsSync(manifestPath)) throw new Error("tarball ships no package.json");
    const staged = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (staged.name !== receipt.packageName || staged.version !== receipt.cliVersion) {
      throw new Error(
        `staged package is ${staged.name}@${staged.version}, receipt says ${receipt.packageName}@${receipt.cliVersion}`,
      );
    }
    // The delivered tarball is the staged platform package, so its packed
    // executable is whatever the manifest's own `bin` map points at.
    const declared = Object.values(staged.bin ?? {}).map(normalizeMember);
    if (declared.length === 0) throw new Error("staged package declares no bin entry");
    for (const member of declared) {
      if (!members.has(member)) {
        throw new Error(`declared bin target ${member} is not in the tarball`);
      }
      if ((statSync(join(stage, member)).mode & 0o111) === 0) {
        throw new Error(`declared bin target ${member} is not executable`);
      }
    }
    if (!members.has(RUNTIME_NODE)) {
      throw new Error(`packaged runtime ${RUNTIME_NODE} is not in the tarball`);
    }
    executableMember =
      declared.find((member) => member.split("/").pop() === targetBinaryName(cli.target)) ??
      declared[0];
    return `${members.size} members incl. ${declared.join(", ")}`;
  });

  check("packaging.runtimeClosure", () => {
    const declared = receipt.runtimeDependencies ?? {};
    const missing = [];
    for (const [name, version] of Object.entries(declared)) {
      const manifest = join(extracted, "node_modules", ...name.split("/"), "package.json");
      if (!existsSync(manifest)) {
        missing.push(`${name} (absent)`);
        continue;
      }
      const installed = JSON.parse(readFileSync(manifest, "utf8")).version;
      if (installed !== version) missing.push(`${name} (${installed} != ${version})`);
    }
    if (missing.length) {
      throw new Error(`the tarball does not ship its declared runtime closure: ${missing.join(", ")}`);
    }
    return `${Object.keys(declared).length} runtime dependencies present`;
  });

  if (sourceDir === undefined) {
    checks.push({
      id: "typecheck.source",
      status: "skipped",
      detail: "no --source-dir was given, so the pinned source typecheck gate was not run",
    });
  } else {
    check("typecheck.source", () => {
      const manifestPath = join(sourceDir, "package.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`--source-dir ${sourceDir} has no package.json`);
      }
      const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
      if (typeof scripts.typecheck !== "string") {
        throw new Error(
          "the pinned source declares no typecheck script, so the delivery cannot prove it typechecked",
        );
      }
      const result = run("pnpm", ["typecheck"], { cwd: sourceDir, maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) {
        throw new Error(`pnpm typecheck exited ${String(result.status)}: ${commandFailure(result)}`);
      }
      return `pnpm typecheck (${scripts.typecheck}) exited 0`;
    });
  }

  if (!expectRuntime) {
    checks.push({
      id: "runtime.binary",
      status: "skipped",
      detail: "the target platform may differ from this host; pass --expect-runtime on the target",
    });
  } else {
    check("runtime.binary", () => {
      // A runtime result is only evidence about the frozen target when the host is
      // the frozen target; otherwise the check would answer a different question.
      const expected = targetHost(cli.target);
      if (host.platform !== expected.platform || host.arch !== expected.arch) {
        throw new Error(
          `this host is ${host.platform}/${host.arch}, not the frozen target ${cli.target} (${expected.platform}/${expected.arch}); a runtime result from another host is not evidence about the delivered artifact`,
        );
      }
      if (executableMember === undefined) {
        throw new Error("the delivered tarball never yielded a packed executable to run");
      }
      const binary = join(extracted, executableMember);
      chmodSync(binary, statSync(binary).mode | 0o111);
      const result = run(binary, ["--version"], { cwd: extracted });
      if (result.status !== 0) {
        throw new Error(`packed executable exited ${String(result.status)}: ${commandFailure(result)}`);
      }
      const reported = String(result.stdout ?? "").trim();
      if (reported !== receipt.cliVersion) {
        throw new Error(`packed executable reports version ${JSON.stringify(reported)}`);
      }
      const node = run(join(extracted, RUNTIME_NODE), ["--version"], { cwd: extracted });
      if (node.status !== 0 || String(node.stdout ?? "").trim() !== receipt.nodeVersion) {
        throw new Error(
          `packaged node reports ${JSON.stringify(String(node.stdout ?? "").trim())}, receipt says ${String(receipt.nodeVersion)}`,
        );
      }
      return `best-agent --version -> ${reported}; packaged node -> ${receipt.nodeVersion}`;
    });
  }

  if (extracted !== undefined) rmSync(extracted, { recursive: true, force: true });

  return {
    verified: checks.every((entry) => entry.status === "passed"),
    checks,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(join(repoRoot, "config", "frontier-harness.json"), "utf8"));
  const receiptPath = join(args.candidateDir, "candidate.json");
  const { verified, checks } = verifyDelivery({
    candidateDir: args.candidateDir,
    config,
    sourceDir: args.sourceDir,
    expectRuntime: args.expectRuntime,
  });
  const record = {
    schemaVersion: 1,
    // Binds this evidence to the exact receipt bytes it was gathered against; the
    // harness freezes the same hash as candidateManifestSha256.
    candidateManifestSha256: sha256File(receiptPath),
    verified,
    runner: { node: process.version, platform: process.platform, arch: process.arch },
    checks,
  };
  writeFileSync(join(args.candidateDir, VERIFICATION_FILE), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (!verified) {
    throw new Error(
      `Candidate delivery verification failed: ${checks
        .filter((entry) => entry.status !== "passed")
        .map((entry) => `${entry.id} (${entry.status}) ${entry.detail}`)
        .join("; ")}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
