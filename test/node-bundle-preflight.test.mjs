import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {verifyCandidate, verifyProbeTranscript, runRecordedStep} from '../scripts/swe-node-bundle-preflight.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'node-bundle-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function candidate(t) {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'node-v24.15.0-linux-x64/bin'), {recursive: true});
  const files = ['best-agent.cjs', 'node-v24.15.0-linux-x64.tar.xz', 'node-v24.15.0-linux-x64/bin/node'];
  const hashes = files.map(name => {
    fs.writeFileSync(path.join(root, name), name);
    return createHash('sha256').update(name).digest('hex');
  });
  const manifest = {
    bundle: {sha256: hashes[0], bytes: files[0].length},
    node: {version: '24.15.0', archiveSha256: hashes[1], binarySha256: hashes[2]},
    task: {instanceId: 'django__django-10097', pythonPrefix: '/opt/miniconda3/envs/testbed', baseCommit: 'a'.repeat(40), imageRef: 'swebench/sweb.eval.x86_64.django_1776_django-10097@sha256:' + 'b'.repeat(64)},
  };
  return {root, files, manifest};
}

for (const index of [0, 1, 2]) {
  test('rejects modified ' + ['CJS', 'Node archive', 'Node executable'][index] + ' before invocation', t => {
    const f = candidate(t);
    assert.equal(verifyCandidate(f.manifest, f.root).length, 3);
    fs.appendFileSync(path.join(f.root, f.files[index]), 'changed');
    assert.throws(() => verifyCandidate(f.manifest, f.root), /SHA256 mismatch/);
  });
}

test('preserves complete nonzero process output without copying private content into the error', async t => {
  const root = directory(t);
  const secretSource = 'private-minified-candidate-line';
  await assert.rejects(runRecordedStep(root, 'failure', [process.execPath, '-e', `process.stdout.write('x'.repeat(9*1024*1024));process.stderr.write(${JSON.stringify(secretSource)});process.exitCode=23;`], 10_000), error => {
    assert.match(error.message, /failure failed/);
    assert(!error.message.includes(secretSource));
    return true;
  });
  assert.equal(fs.statSync(path.join(root, 'failure.stdout.txt')).size, 9 * 1024 * 1024);
  assert.equal(fs.readFileSync(path.join(root, 'failure.stderr.txt'), 'utf8'), secretSource);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'failure.process.json')));
  assert.equal(receipt.status, 23);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.stdoutOverflow, true);
  assert.equal(receipt.stderr.bytes, secretSource.length);
});

test('records timeout separately from exit failure', async t => {
  const root = directory(t);
  await assert.rejects(runRecordedStep(root, 'timeout', [process.execPath, '-e', "process.stdout.write('started');setInterval(()=>{},1000)"], 500), /timeout failed/);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'timeout.process.json')));
  assert.equal(receipt.timedOut, true);
  assert.equal(fs.readFileSync(path.join(root, 'timeout.stdout.txt'), 'utf8'), 'started');
});

function transcript(reads) {
  const names = ['write', 'exec', 'write', 'read', 'stat', 'list', 'search', 'edit', 'process-start', ...Array(reads).fill('process-read')];
  const results = [], rows = [{type: 'model-request', sequence: 1, request: {messages: []}}], wire = [{messages: []}];
  for (const [index, name] of names.entries()) {
    const callId = 'call-' + index;
    const input = name === 'process-read' ? {processRef: {id: 'process-1'}} : {};
    const payload = name === 'process-start' ? {processRef: {id: 'process-1'}} : {status: index === names.length - 1 ? 'exited' : 'running'};
    const result = {kind: 'tool', result: {callId, name, closure: {kind: 'known', status: 'succeeded', payload}}};
    rows.push({type: 'model-outcome', sequence: 2 * index + 2, outcome: {candidate: {toolCalls: [{callId, name, input}]}}});
    results.push(result);
    rows.push({type: 'model-request', sequence: 2 * index + 3, request: {messages: structuredClone(results)}});
    wire.push({messages: results.map(entry => ({tool_call_id: entry.result.callId, content: JSON.stringify(entry.result.closure)}))});
  }
  rows.push({type: 'terminal-snapshot', snapshot: {transcript: results}});
  return {rows, wire};
}

test('accepts a second process-read while preserving every first-next/provider closure', () => {
  const f = transcript(2);
  assert.deepEqual(verifyProbeTranscript(f.rows, f.wire), {toolResults: 11, processReads: 2, firstNextExact: 11, providerWireExact: 11});
});

test('rejects altered provider closure and a poll for a different process', () => {
  const f = transcript(2);
  f.wire[1].messages[0].content = JSON.stringify({kind: 'unknown'});
  assert.throws(() => verifyProbeTranscript(f.rows, f.wire));
  const wrongProcess = transcript(2);
  wrongProcess.rows.find(row => row.type === 'model-outcome' && row.outcome.candidate.toolCalls[0].name === 'process-read').outcome.candidate.toolCalls[0].input.processRef.id = 'other';
  assert.throws(() => verifyProbeTranscript(wrongProcess.rows, wrongProcess.wire));
});
