import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliArchiveEnvironment, downloadIbenchCli } from "../scripts/ibench-cli-artifact.mjs";

const bytes = Buffer.from("owned standalone archive");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const artifact = { repository: "owner/private", releaseTag: "owned", assetName: "owned.tar.gz", bytes: bytes.length, sha256, sourceCommit: "a".repeat(40) };

test("CLI archive admission requires the selected bytes and propagates only frozen metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "ibench-archive-"));
  try {
    const archive = join(root, "candidate.tar.gz");
    writeFileSync(archive, bytes);
    const profile = { cli: { install: "standalone-archive", version: "0.0.21", artifact } };
    assert.throws(() => cliArchiveEnvironment(profile, {}), /before model admission/);
    assert.deepEqual(cliArchiveEnvironment(profile, { BEST_AGENT_CLI_ARCHIVE: archive }), {
      BEST_AGENT_CLI_ARCHIVE: archive, BEST_AGENT_CLI_ARCHIVE_SHA256: sha256, BEST_AGENT_CLI_ARCHIVE_VERSION: "0.0.21",
    });
    writeFileSync(archive, "changed");
    assert.throws(() => cliArchiveEnvironment(profile, { BEST_AGENT_CLI_ARCHIVE: archive }), /SHA256 mismatch/);
    assert.deepEqual(cliArchiveEnvironment({ cli: { install: "npm-in-container" } }, { BEST_AGENT_CLI_ARCHIVE: archive }), {
      BEST_AGENT_CLI_ARCHIVE: "", BEST_AGENT_CLI_ARCHIVE_SHA256: "", BEST_AGENT_CLI_ARCHIVE_VERSION: "",
    });
    assert.throws(() => cliArchiveEnvironment({ cli: { install: "typo" } }, {}), /Unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private archive download verifies metadata and bytes without retaining the token", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ibench-download-"));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ id: 1, assets: [{ id: 2, name: artifact.assetName, size: bytes.length, digest: `sha256:${sha256}` }] });
    return new Response(bytes);
  });
  try {
    const directory = join(root, "candidate");
    const archive = await downloadIbenchCli(artifact, directory, "owned-private-token");
    assert.deepEqual(readFileSync(archive), bytes);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Authorization, "Bearer owned-private-token");
    assert(!readFileSync(join(directory, "receipt.json"), "utf8").includes("owned-private-token"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wrong remote digest refuses the download before installing or writing bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ibench-mismatch-"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ assets: [{ id: 2, name: artifact.assetName, size: bytes.length, digest: `sha256:${"0".repeat(64)}` }] });
  });
  try {
    const directory = join(root, "candidate");
    await assert.rejects(downloadIbenchCli(artifact, directory, "token"));
    assert.equal(calls, 1);
    assert(!existsSync(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt download is refused after the matching remote metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ibench-corrupt-"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ assets: [{ id: 2, name: artifact.assetName, size: bytes.length, digest: `sha256:${sha256}` }] })
    : new Response(Buffer.alloc(bytes.length)));
  try {
    const directory = join(root, "candidate");
    await assert.rejects(downloadIbenchCli(artifact, directory, "token"));
    assert.equal(calls, 2);
    assert(!existsSync(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
