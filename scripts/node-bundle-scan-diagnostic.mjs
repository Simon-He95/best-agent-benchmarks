import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectArchive} from './node-bundle-sanitize.mjs';

const [candidateDir, evidenceDir] = process.argv.slice(2);
const candidate = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-candidate.json', import.meta.url)));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.15.0');
const rootTar = path.join(path.dirname(evidenceDir), 'scanner-root.tar');
let containerId;
let sequence = 0;
function docker(args, outputPath) {
  const prefix = path.join(evidenceDir, String(++sequence).padStart(2, '0'));
  const out = fs.openSync(outputPath ?? prefix + '.stdout.txt', 'wx');
  const err = fs.openSync(prefix + '.stderr.txt', 'wx');
  try {
    execFileSync('docker', args, {stdio: ['ignore', out, err], timeout: 900_000});
  } finally {
    fs.closeSync(out); fs.closeSync(err);
    fs.writeFileSync(prefix + '.argv.json', JSON.stringify(args));
  }
  return outputPath ? '' : fs.readFileSync(prefix + '.stdout.txt', 'utf8').trim();
}
try {
  docker(['pull', '--platform', 'linux/amd64', candidate.task.imageRef]);
  containerId = docker(['create', '--platform', 'linux/amd64', '--network', 'none', '--memory', '6g', '--cpus', '4', candidate.task.imageRef, 'sleep', 'infinity']);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  docker(['start', containerId]);
  docker(['exec', containerId, 'mkdir', '-p', '/opt/agent', '/work']);
  docker(['cp', path.join(candidateDir, 'node-v24.15.0-linux-x64'), containerId + ':/opt/agent/node']);
  docker(['cp', path.join(candidateDir, 'best-agent.cjs'), containerId + ':/opt/agent/best-agent.cjs']);
  docker(['cp', 'scripts/node-bundle-sanitize.mjs', containerId + ':/work/sanitize.mjs']);
  docker(['exec', containerId, '/opt/agent/node/bin/node', '/work/sanitize.mjs', candidate.task.baseCommit]);
  docker(['exec', containerId, 'rm', '/work/sanitize.mjs']);
  docker(['export', containerId], rootTar);
  const result = inspectArchive(rootTar, [], 'root', path.join(evidenceDir, 'root-archive-scan'));
  fs.writeFileSync(path.join(evidenceDir, 'scan.json'), JSON.stringify(result));
  assert(!result.findings.some(finding => finding.reason === 'archive-decoder-error'), 'Archive decoder errors recorded in scan.json');
} finally {
  if (containerId) docker(['rm', '-f', containerId]);
  fs.rmSync(rootTar, {force: true});
}
