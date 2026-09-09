import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyBytes(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, expected, `${label} SHA256 mismatch`);
  return actual;
}

export async function downloadCandidate(directory) {
  const candidate = JSON.parse(readFileSync(new URL('../config/node-bundle-candidate.json', import.meta.url)));
  const token = process.env.BEST_AGENT_SOURCE_TOKEN;
  assert(token, 'BEST_AGENT_SOURCE_TOKEN is required only for private asset download');
  const root = resolve(directory);
  mkdirSync(root);
  const releaseResponse = await fetch(`https://api.github.com/repos/${candidate.bundle.repository}/releases/tags/${candidate.bundle.releaseTag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
  });
  assert(releaseResponse.ok, `Private release lookup HTTP ${releaseResponse.status} ${releaseResponse.statusText}`);
  const release = await releaseResponse.json();
  const assets = release.assets.filter(asset => asset.name === candidate.bundle.assetName);
  assert.equal(assets.length, 1, 'Exactly one frozen candidate asset is required');
  const asset = assets[0];
  assert.equal(asset.size, candidate.bundle.bytes);
  assert.equal(asset.digest, `sha256:${candidate.bundle.sha256}`);
  const assetUrl = `https://api.github.com/repos/${candidate.bundle.repository}/releases/assets/${asset.id}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' };
  const bundleResponse = await fetch(assetUrl, { headers, signal: AbortSignal.timeout(120000) });
  assert(bundleResponse.ok, `Private candidate download HTTP ${bundleResponse.status} ${bundleResponse.statusText}`);
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  verifyBytes(bundle, candidate.bundle.sha256, 'CJS');
  assert.equal(bundle.length, candidate.bundle.bytes);
  writeFileSync(resolve(root, 'best-agent.cjs'), bundle, { flag: 'wx' });
  const archiveName = `node-v${candidate.node.version}-linux-x64.tar.xz`;
  const nodeUrl = `https://nodejs.org/dist/v${candidate.node.version}/${archiveName}`;
  const nodeResponse = await fetch(nodeUrl, { signal: AbortSignal.timeout(120000) });
  assert(nodeResponse.ok, `Node download HTTP ${nodeResponse.status} ${nodeResponse.statusText}`);
  const archive = Buffer.from(await nodeResponse.arrayBuffer());
  verifyBytes(archive, candidate.node.archiveSha256, 'Node archive');
  writeFileSync(resolve(root, archiveName), archive, { flag: 'wx' });
  execFileSync('tar', ['-xJf', resolve(root, archiveName), '-C', root], { timeout: 60000 });
  verifyBytes(readFileSync(resolve(root, archiveName.replace('.tar.xz', ''), 'bin/node')), candidate.node.binarySha256, 'Node executable');
  writeFileSync(resolve(root, 'download-receipt.json'), JSON.stringify({
    candidateId: candidate.candidateId, bundleSha256: candidate.bundle.sha256,
    privateReleaseId: release.id, privateAssetId: asset.id, nodeUrl, archiveSha256: candidate.node.archiveSha256,
    binarySha256: candidate.node.binarySha256, at: new Date().toISOString(), retries: 0,
  }, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node download-node-bundle.mjs <new-candidate-directory>');
  await downloadCandidate(process.argv[2]);
}
