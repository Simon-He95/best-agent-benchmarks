import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_FILES,
  VERIFICATION_FILE,
  sha256File,
  targetBinaryName,
  targetHost,
  verifyDelivery,
} from "../scripts/verify-frontier-harness-candidate.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "verify-frontier-harness-candidate.mjs");
const config = JSON.parse(
  readFileSync(new URL("../config/frontier-harness.json", import.meta.url), "utf8"),
);

const NODE_VERSION = "v24.15.0";
/**
 * The frozen target is linux-x64-gnu, so every runtime check is exercised against
 * that host explicitly. `main()` never injects a host: the CLI always uses the real
 * process, which is what makes the check fail closed off-target.
 */
const TARGET_HOST = targetHost(config.cli.target);

function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/**
 * Build a candidate directory with the real delivered layout (a `tar czf -C
 * <stage> .` of the staged platform package plus the packaged runtime node) but a
 * stub executable, so the delivery checks run without a linux SEA.
 *
 * @returns {{ dir: string, stage: string }} the candidate directory and the stage
 *   directory it was packed from (a sibling, so the delivered file set is exact).
 */
function buildCandidate({ overrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fh-delivery-test-"));
  const stage = mkdtempSync(join(tmpdir(), "fh-delivery-stage-"));
  const binary = targetBinaryName(config.cli.target);
  mkdirSync(join(stage, "bin"), { recursive: true });
  mkdirSync(join(stage, "runtime", "bin"), { recursive: true });
  writeExecutable(
    join(stage, "bin", binary),
    overrides.binaryScript ?? `#!/bin/sh\necho ${config.cli.cliVersion}\n`,
  );
  writeExecutable(
    join(stage, "runtime", "bin", "node"),
    overrides.nodeScript ?? `#!/bin/sh\necho ${NODE_VERSION}\n`,
  );
  const runtimeDependencies = overrides.runtimeDependencies ?? { "@scope/dep": "1.2.3" };
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: config.cli.packageName,
        version: config.cli.cliVersion,
        bin: { [`best-agent-${config.cli.target}`]: `./bin/${binary}` },
        dependencies: runtimeDependencies,
      },
      null,
      2,
    )}\n`,
  );
  if (overrides.skipClosure !== true) {
    for (const [name, version] of Object.entries(runtimeDependencies)) {
      const depDir = join(stage, "node_modules", ...name.split("/"));
      mkdirSync(depDir, { recursive: true });
      writeFileSync(join(depDir, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`);
    }
  }
  const tarball = join(dir, "best-agent-cli.tgz");
  const packed = spawnSync("tar", ["czf", tarball, "-C", stage, "."]);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  writeFileSync(join(dir, "build-report.json"), `${JSON.stringify({ artifact: { kind: "sea" } })}\n`);
  const receipt = {
    schemaVersion: 1,
    packageName: config.cli.packageName,
    cliVersion: config.cli.cliVersion,
    sourceRepository: config.cli.sourceRepository,
    sourceCommit: config.cli.sourceCommit,
    target: config.cli.target,
    lockfileSha256: "0".repeat(64),
    binarySha256: sha256File(join(stage, "bin", binary)),
    buildReportSha256: sha256File(join(dir, "build-report.json")),
    tarballSha256: sha256File(tarball),
    runtimeDependencies,
    runtimeLockSha256: "0".repeat(64),
    nodeVersion: NODE_VERSION,
    nodeBinarySha256: sha256File(join(stage, "runtime", "bin", "node")),
  };
  Object.assign(receipt, overrides.receipt ?? {});
  writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (overrides.extraFile) writeFileSync(join(dir, overrides.extraFile), "");
  return { dir, stage };
}

/** A fake pinned source checkout whose only relevant fact is its typecheck gate. */
function buildSource({ typecheck = "tsc -b --pretty false" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fh-delivery-source-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "best-agent", scripts: typecheck === null ? {} : { typecheck } },
      null,
      2,
    )}\n`,
  );
  return dir;
}

/** Delegate every command to the host except the source repository's typecheck gate. */
function stubTypecheck({ status = 0, stderr = "" } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    if (command === "pnpm") {
      calls.push({ command, args, cwd: options.cwd });
      return { status, stdout: status === 0 ? "typecheck ok" : "", stderr };
    }
    return spawnSync(command, args, { encoding: "utf8", ...options });
  };
  return { run, calls };
}

function statuses(result) {
  return Object.fromEntries(result.checks.map((entry) => [entry.id, entry.status]));
}

function statusOf(result, id) {
  return result.checks.find((entry) => entry.id === id).detail;
}

/** Run `fn` with the temp directories it needs, cleaned up afterwards. */
function withTemp(t, paths) {
  t.after(() => {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  });
}

test("candidate delivery verification passes a packaged, typechecked, runnable candidate", (t) => {
  const { dir, stage } = buildCandidate();
  const source = buildSource();
  withTemp(t, [dir, stage, source]);
  const { run, calls } = stubTypecheck();
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    sourceDir: source,
    expectRuntime: true,
    run,
    host: TARGET_HOST,
  });
  assert.deepEqual(statuses(result), {
    "packaging.files": "passed",
    "packaging.receipt": "passed",
    "packaging.bytes": "passed",
    "packaging.tarball": "passed",
    "packaging.runtimeClosure": "passed",
    "typecheck.source": "passed",
    "runtime.binary": "passed",
  });
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [{ command: "pnpm", args: ["typecheck"], cwd: source }]);
});

test("candidate delivery verification fails when the delivered tarball omits the runtime closure", (t) => {
  const { dir, stage } = buildCandidate({ overrides: { skipClosure: true } });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({ candidateDir: dir, config, expectRuntime: false });
  assert.equal(statuses(result)["packaging.runtimeClosure"], "failed");
  assert.match(statusOf(result, "packaging.runtimeClosure"), /@scope\/dep/u);
  assert.equal(result.verified, false);
});

test("candidate delivery verification fails when the packed executable cannot answer its version query", (t) => {
  const { dir, stage } = buildCandidate({ overrides: { binaryScript: "#!/bin/sh\nexit 3\n" } });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    expectRuntime: true,
    host: TARGET_HOST,
  });
  assert.equal(statuses(result)["runtime.binary"], "failed");
  assert.match(statusOf(result, "runtime.binary"), /exited 3/u);
});

test("candidate delivery verification fails when the packed executable reports another version", (t) => {
  const { dir, stage } = buildCandidate({
    overrides: { binaryScript: "#!/bin/sh\necho 0.0.0-stale\n" },
  });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    expectRuntime: true,
    host: TARGET_HOST,
  });
  assert.equal(statuses(result)["runtime.binary"], "failed");
  assert.match(statusOf(result, "runtime.binary"), /0\.0\.0-stale/u);
});

test("candidate delivery verification fails when the packaged node is not the frozen one", (t) => {
  const { dir, stage } = buildCandidate({
    overrides: { nodeScript: "#!/bin/sh\necho v20.0.0\n" },
  });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    expectRuntime: true,
    host: TARGET_HOST,
  });
  assert.equal(statuses(result)["runtime.binary"], "failed");
  assert.match(statusOf(result, "runtime.binary"), /v20\.0\.0/u);
});

test("a runtime result gathered off the frozen target is refused, not accepted as evidence", (t) => {
  const { dir, stage } = buildCandidate();
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    expectRuntime: true,
    // Every other check passes and the stub binary would answer correctly; only the
    // host is wrong, which must be enough to refuse the claim.
    host: { platform: "darwin", arch: "arm64" },
  });
  assert.equal(statuses(result)["runtime.binary"], "failed");
  assert.match(statusOf(result, "runtime.binary"), /not the frozen target linux-x64-gnu/u);
  assert.equal(result.verified, false);
});

test("candidate delivery verification fails when the receipt does not match the frozen identity", (t) => {
  const { dir, stage } = buildCandidate({ overrides: { receipt: { sourceCommit: "0".repeat(40) } } });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({ candidateDir: dir, config, expectRuntime: false });
  assert.equal(statuses(result)["packaging.receipt"], "failed");
  assert.match(statusOf(result, "packaging.receipt"), /sourceCommit/u);
});

test("candidate delivery verification fails when the tarball bytes drift from the receipt", (t) => {
  const { dir, stage } = buildCandidate();
  withTemp(t, [dir, stage]);
  const receipt = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8"));
  writeFileSync(
    join(dir, "candidate.json"),
    `${JSON.stringify({ ...receipt, tarballSha256: "1".repeat(64) }, null, 2)}\n`,
  );
  const result = verifyDelivery({ candidateDir: dir, config, expectRuntime: false });
  assert.equal(statuses(result)["packaging.bytes"], "failed");
});

test("candidate delivery verification fails when the delivered file set is not exactly the frozen set", (t) => {
  const { dir, stage } = buildCandidate({ overrides: { extraFile: "notes.txt" } });
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({ candidateDir: dir, config, expectRuntime: false });
  assert.equal(statuses(result)["packaging.files"], "failed");
});

test("candidate delivery verification never counts a skipped check as verified", (t) => {
  const { dir, stage } = buildCandidate();
  withTemp(t, [dir, stage]);
  const result = verifyDelivery({ candidateDir: dir, config, expectRuntime: false });
  assert.equal(statuses(result)["typecheck.source"], "skipped");
  assert.equal(statuses(result)["runtime.binary"], "skipped");
  assert.equal(result.verified, false);
});

test("candidate delivery verification fails when the pinned source cannot typecheck", (t) => {
  const { dir, stage } = buildCandidate();
  const source = buildSource();
  withTemp(t, [dir, stage, source]);
  const { run } = stubTypecheck({
    status: 2,
    stderr: "error TS2322: Type 'string' is not assignable to type 'number'",
  });
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    sourceDir: source,
    expectRuntime: true,
    run,
    host: TARGET_HOST,
  });
  assert.equal(statuses(result)["typecheck.source"], "failed");
  assert.match(statusOf(result, "typecheck.source"), /TS2322/u);
  assert.equal(result.verified, false);
});

test("candidate delivery verification fails closed when the pinned source declares no typecheck gate", (t) => {
  const { dir, stage } = buildCandidate();
  const source = buildSource({ typecheck: null });
  withTemp(t, [dir, stage, source]);
  const result = verifyDelivery({
    candidateDir: dir,
    config,
    sourceDir: source,
    expectRuntime: true,
    host: TARGET_HOST,
  });
  assert.equal(statuses(result)["typecheck.source"], "failed");
  assert.match(statusOf(result, "typecheck.source"), /no typecheck script/u);
});

test("the entry point writes its own record and leaves the frozen receipt byte-identical", (t) => {
  const { dir, stage } = buildCandidate();
  const source = buildSource();
  const bin = mkdtempSync(join(tmpdir(), "fh-delivery-bin-"));
  withTemp(t, [dir, stage, source, bin]);
  writeExecutable(join(bin, "pnpm"), "#!/bin/sh\necho typecheck ok\n");
  const receiptPath = join(dir, "candidate.json");
  const receiptBefore = readFileSync(receiptPath);
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--candidate-dir", dir, "--source-dir", source, "--expect-runtime"],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  // The identity receipt has exactly one writer: the candidate freeze step. Its
  // bytes are the frozen candidateManifestSha256, so verification must not touch it.
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal("deliveryVerification" in receipt, false);
  const record = JSON.parse(readFileSync(join(dir, VERIFICATION_FILE), "utf8"));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.candidateManifestSha256, sha256File(receiptPath));
  // The entry point always uses the real host, so the claim is only admitted on the
  // frozen target. This test therefore asserts the exact host-dependent outcome
  // instead of assuming one: on the target every check passes, anywhere else the
  // runtime check refuses to answer and the record says why.
  const onTarget =
    process.platform === TARGET_HOST.platform && process.arch === TARGET_HOST.arch;
  assert.equal(record.verified, onTarget);
  assert.equal(result.status === 0, onTarget, result.stderr);
  assert.equal(record.runner.platform, process.platform);
  const runtime = record.checks.find((entry) => entry.id === "runtime.binary");
  if (onTarget) {
    assert.deepEqual(
      record.checks.map((entry) => entry.status),
      Array.from({ length: 7 }, () => "passed"),
    );
  } else {
    assert.equal(runtime.status, "failed");
    assert.match(runtime.detail, /not the frozen target linux-x64-gnu/u);
    assert.match(result.stderr, /Candidate delivery verification failed/u);
  }
  assert.equal(CANDIDATE_FILES.length, 3);
  assert.equal(VERIFICATION_FILE, "delivery-verification.json");

  // Verification is defined for a pristine delivery only, so a second pass over an
  // already-recorded directory fails closed instead of re-verifying or overwriting.
  const again = spawnSync(
    process.execPath,
    [scriptPath, "--candidate-dir", dir, "--source-dir", source, "--expect-runtime"],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /must contain exactly/u);
});

test("the candidate delivery verification entry point fails closed and still records the failure", (t) => {
  const { dir, stage } = buildCandidate({ overrides: { binaryScript: "#!/bin/sh\nexit 1\n" } });
  withTemp(t, [dir, stage]);
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--candidate-dir", dir, "--expect-runtime"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Candidate delivery verification failed/u);
  const record = JSON.parse(readFileSync(join(dir, VERIFICATION_FILE), "utf8"));
  assert.equal(record.verified, false);
  assert.equal(
    record.checks.find((entry) => entry.id === "runtime.binary").status,
    "failed",
  );
  assert.equal("deliveryVerification" in JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")), false);
});
