import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {assertReadOnly, gitProbes, parseDiagnosis} from '../scripts/node-bundle-batch-diagnose.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const batch = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-batch-1.json')));
const entry = batch.tasks[0];

test('diagnostic probes are read-only git queries against /testbed', () => {
  const probes = gitProbes(entry);
  assert(probes.length >= 10);
  assertReadOnly(probes);
  assert.deepEqual(probes[0][1], ['git', '-C', '/testbed', 'rev-parse', 'HEAD']);
  assert(probes.some(([name, argv]) => name === 'base-tree' && argv.includes(entry.baseCommit + '^{tree}')));
  // Mutating git subcommands must never appear in a probe.
  for (const mutation of ['add', 'commit', 'reset', 'checkout', 'clean', 'rm', 'apply']) {
    assert.throws(() => assertReadOnly([['x', ['git', '-C', '/testbed', mutation, 'file']]]), /must not mutate/);
  }
});

test('parseDiagnosis records head/base facts and bounds unbounded outputs', () => {
  const outputs = {
    'head-sha': '1'.repeat(40) + '\n',
    'head-tree': '2'.repeat(40) + '\n',
    'base-tree': '3'.repeat(40) + '\n',
    'base-present': 'commit\n',
    'head-log': 'aaaa short\nbbbb short\n',
    'commit-count': '2\n',
    'refs': '1'.repeat(40) + ' refs/heads/master\n',
    'diff-name-only': Array.from({length: 250}, (_, n) => `file-${n}.py`).join('\n') + '\n',
    'status-porcelain': ' M existing.py\n',
    'ls-files': 'a.py\nb.py\nc.py\n',
  };
  const diagnosis = parseDiagnosis(entry, outputs);
  assert.equal(diagnosis.instanceId, entry.instanceId);
  assert.equal(diagnosis.headSha, '1'.repeat(40));
  assert.equal(diagnosis.baseTree, '3'.repeat(40));
  assert.equal(diagnosis.baseObjectPresent, 'commit');
  assert.equal(diagnosis.diffFileCount, 250);
  assert.equal(diagnosis.diffFiles.length, 200);
  assert.equal(diagnosis.diffFileSampleComplete, false, 'diff list beyond 200 must be marked truncated');
  assert.equal(diagnosis.statusEntryCount, 1);
  assert.deepEqual(diagnosis.statusSample, [' M existing.py']);
  assert.equal(diagnosis.trackedFileCount, 3);
});

test('parseDiagnosis records absent probes as null instead of guessing', () => {
  const diagnosis = parseDiagnosis(entry, {'head-sha': ''});
  assert.equal(diagnosis.headSha, null, 'empty stdout is not a head sha');
  assert.equal(diagnosis.baseTree, null);
  assert.equal(diagnosis.diffFileCount, null);
  assert.equal(diagnosis.statusEntryCount, null);
  assert.equal(diagnosis.trackedFileCount, null);
  assert.equal(diagnosis.headLog, null);
});
