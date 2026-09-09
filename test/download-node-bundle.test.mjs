import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyBytes } from '../scripts/download-node-bundle.mjs';

test('candidate hash admission is exact, including a one-byte change', () => {
  const input = Buffer.from('frozen candidate');
  const hash = createHash('sha256').update(input).digest('hex');
  assert.equal(verifyBytes(input, hash, 'fixture'), hash);
  assert.throws(() => verifyBytes(Buffer.from('frozen candidate!'), hash, 'fixture'), /SHA256 mismatch/);
});

test('preflight manifest is diagnostic and pins the non-published CJS and Linux runtime', () => {
  const candidate = JSON.parse(readFileSync(new URL('../config/node-bundle-candidate.json', import.meta.url)));
  assert.equal(candidate.diagnosticOnly, true);
  assert.equal(candidate.passAt1, null);
  assert.equal(candidate.candidateId, 'local-spec100-epoch002-not-published');
  assert.equal(candidate.node.version, '24.15.0');
  assert.match(candidate.task.imageRef, /@sha256:[a-f0-9]{64}$/);
  for (const hash of [candidate.bundle.sha256, candidate.node.archiveSha256, candidate.node.binarySha256]) assert.match(hash, /^[a-f0-9]{64}$/);
});
