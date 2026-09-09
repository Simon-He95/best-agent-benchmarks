import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBytes} from './download-node-bundle.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Recovery never invokes the model, so the frozen private CJS bundle is not needed.
// The pinned Node runtime is a public nodejs.org distribution verified against the
// frozen candidate hashes; no source-repository token is required or accepted.
export async function downloadPinnedNode(directory) {
  const candidate = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json')));
  assert(process.platform === 'linux' && process.arch === 'x64', 'The pinned Node runtime is the frozen linux-x64 build');
  const root = path.resolve(directory);
  fs.mkdirSync(root);
  const archiveName = `node-v${candidate.node.version}-linux-x64.tar.xz`;
  const nodeUrl = `https://nodejs.org/dist/v${candidate.node.version}/${archiveName}`;
  const archivePath = path.join(root, archiveName);
  const response = await fetch(nodeUrl, {signal: AbortSignal.timeout(120_000)});
  assert(response.ok, `Node download HTTP ${response.status} ${response.statusText}`);
  fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()), {flag: 'wx'});
  verifyBytes(fs.readFileSync(archivePath), candidate.node.archiveSha256, 'Node archive');
  execFileSync('tar', ['-xJf', archivePath, '-C', root], {timeout: 60_000});
  const binary = path.join(root, archiveName.replace('.tar.xz', ''), 'bin/node');
  verifyBytes(fs.readFileSync(binary), candidate.node.binarySha256, 'Node executable');
  const receipt = {candidateId: candidate.candidateId, nodeUrl, archiveSha256: candidate.node.archiveSha256, binarySha256: candidate.node.binarySha256, privateTokenUsed: false, at: new Date().toISOString()};
  fs.writeFileSync(path.join(root, 'download-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node download-pinned-node.mjs <new-directory>');
  await downloadPinnedNode(process.argv[2]);
}
