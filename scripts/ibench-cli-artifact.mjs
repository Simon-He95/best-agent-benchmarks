import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function cliArchiveEnvironment(profile, environment = process.env) {
  assert(["npm-in-container", "standalone-archive"].includes(profile.cli?.install), "Unsupported CLI installation mode");
  if (profile.cli.install === "npm-in-container") return {
    BEST_AGENT_CLI_ARCHIVE: "", BEST_AGENT_CLI_ARCHIVE_SHA256: "", BEST_AGENT_CLI_ARCHIVE_VERSION: "",
  };
  const archive = environment.BEST_AGENT_CLI_ARCHIVE;
  assert(archive, "Download the frozen CLI archive before model admission");
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.equal(digest, profile.cli.artifact.sha256, "Frozen CLI archive SHA256 mismatch");
  return {
    BEST_AGENT_CLI_ARCHIVE: resolve(archive),
    BEST_AGENT_CLI_ARCHIVE_SHA256: digest,
    BEST_AGENT_CLI_ARCHIVE_VERSION: profile.cli.version,
  };
}

export async function downloadIbenchCli(artifact, directory, token) {
  assert(token, "BEST_AGENT_SOURCE_TOKEN is required for private candidate download");
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256));
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(artifact.assetName));
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const metadata = await fetch(`https://api.github.com/repos/${artifact.repository}/releases/tags/${artifact.releaseTag}`, { headers, signal: AbortSignal.timeout(30000) });
  assert(metadata.ok, `Private candidate lookup HTTP ${metadata.status}`);
  const release = await metadata.json();
  const selected = release.assets.filter(asset => asset.name === artifact.assetName);
  assert.equal(selected.length, 1, "Exactly one frozen CLI asset is required");
  const asset = selected[0];
  assert.equal(asset.size, artifact.bytes);
  assert.equal(asset.digest, `sha256:${artifact.sha256}`);
  const response = await fetch(`https://api.github.com/repos/${artifact.repository}/releases/assets/${asset.id}`, {
    headers: { ...headers, Accept: "application/octet-stream" }, signal: AbortSignal.timeout(120000),
  });
  assert(response.ok, `Private candidate download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  mkdirSync(directory);
  const archive = resolve(directory, artifact.assetName);
  writeFileSync(archive, bytes, { flag: "wx" });
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ ...artifact, releaseId: release.id, assetId: asset.id }) + "\n", { flag: "wx" });
  return archive;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const profile = JSON.parse(readFileSync(new URL("../config/ibench.json", import.meta.url), "utf8"));
  if (profile.cli.install === "standalone-archive") {
    const archive = await downloadIbenchCli(profile.cli.artifact, resolve(process.argv[2]), process.env.BEST_AGENT_SOURCE_TOKEN);
    appendFileSync(process.env.GITHUB_ENV, `BEST_AGENT_CLI_ARCHIVE=${archive}\n`);
  }
}
