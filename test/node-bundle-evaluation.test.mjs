import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {mock} from 'node:test';
import * as official from '../scripts/swe-bench-official-evaluator.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const candidate = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json')));
const generationPath = path.join(repository, 'config/node-bundle-generation.json');
const profile = JSON.parse(fs.readFileSync(path.join(repository, 'config/swe-bench-verified.json')));
const id = candidate.task.instanceId, runId = '123456';
const imageId = 'sha256:' + 'a'.repeat(64), containerId = 'b'.repeat(64);
const [imageRepository, imageDigest] = candidate.task.imageRef.split('@');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let state;
mock.module('../scripts/swe-bench-official-evaluator.mjs', {namedExports: {
  ...official,
  evaluateFrozenPrediction: async options => {
    state.evaluations++;
    state.options = options;
    if (state.throwEvaluator) throw new Error('simulated evaluator interruption');
    const prediction = official.readFrozenPrediction(options.predictionPath);
    const report = {schema_version: 2, submitted_ids: [id], completed_ids: [id], resolved_ids: state.unresolved ? [] : [id], unresolved_ids: state.unresolved ? [id] : [], error_ids: []};
    state.record = official.projectOfficialRunReport({report, prediction, provenance: {evaluatorVersion: official.OFFICIAL_EVALUATOR_VERSION, evaluatorCommit: official.OFFICIAL_EVALUATOR_COMMIT, datasetRevision: profile.sourceRevision, imageRef: imageRepository + ':latest', imageDigest, platform: 'linux/amd64', officialRunId: official.officialRunIdFor(prediction), wallMs: 1}});
    return state.record;
  },
}});
mock.module('node:child_process', {namedExports: {spawnSync: (executable, args) => {
  state.commands.push({executable, args});
  assert.equal(executable, '/fixture/docker');
  if (args[0] === 'ps') {
    const name = `sweb.eval.${id}.${official.officialRunIdFor({evaluationBatchId: `remaining63-node-${runId}`, instanceId: id})}`;
    const filter = args[args.length - 1];
    assert.equal(filter, 'name=^/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    return {status: state.listFailure ? 1 : 0, signal: null, stdout: state.present ? containerId + '\n' : '', stderr: state.listFailure ? 'daemon unavailable' : ''};
  }
  assert.equal(args[0], 'inspect');
  assert.equal(args.at(-1), containerId);
  const name = `sweb.eval.${id}.${official.officialRunIdFor({evaluationBatchId: `remaining63-node-${runId}`, instanceId: id})}`;
  return {status: 0, signal: null, stderr: '', stdout: JSON.stringify({Id: containerId, Name: state.wrongName ? '/unrelated' : '/' + name, Image: state.wrongImage ? 'sha256:' + 'c'.repeat(64) : imageId, State: {Running: Boolean(state.running), Restarting: false, Status: state.running ? 'running' : 'exited'}})};
}}});
const {evaluateNodeBundleTask} = await import('../scripts/evaluate-node-bundle-one.mjs');

function fixture(t) {
  state = {evaluations: 0, commands: []};
  const evidenceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'node-evaluation-')));
  t.after(() => fs.rmSync(evidenceDir, {recursive: true, force: true}));
  const files = new Map();
  const put = (relative, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2));
    const file = path.join(evidenceDir, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
    files.set(relative, bytes);
  };
  const get = relative => JSON.parse(fs.readFileSync(path.join(evidenceDir, relative)));
  const audit = () => put('credential-audit.json', {safe: true, checkedAt: new Date().toISOString(), files: [...files.keys()].filter(p => p !== 'credential-audit.json').map(relative => {const bytes = fs.readFileSync(path.join(evidenceDir, relative)); return {path: relative, sizeBytes: bytes.length, sha256: hash(bytes)};})});
  const evidence = {prefixValid: true, complete: true, rootStatus: 'completed'};
  const patch = Buffer.from('diff --git a/example b/example\nnew file mode 100644\n--- /dev/null\n+++ b/example\n@@ -0,0 +1 @@\n+example\n');
  const receipt = {status: 'captured', baseCommit: candidate.task.baseCommit, bytes: patch.length, sha256: hash(patch), method: 'trusted-base-git-private-index-to-terminal-worktree', originalIndexUnchanged: true};
  put('terminal/captured/diagnostic.patch', patch);
  put('terminal/captured/receipt.json', receipt);
  put('terminal/evidence-admission.json', evidence);
  put('stdout.txt', Buffer.from('model stdout'));
  put('stderr.txt', Buffer.from(''));
  const processReceipt = {status: 0, signal: null, timedOut: false, containerClosed: true, stdoutSha256: hash(files.get('stdout.txt')), stderrSha256: hash('')};
  put('process-receipt.json', processReceipt);
  const exports = ['attempt.jsonl', 'artifacts.tar', 'runtime.tar', 'workspace.tar'].map(target => {const bytes = Buffer.from('fixture ' + target); put('terminal/' + target, bytes); return {target, status: 0, signal: null, timedOut: false, sha256: hash(bytes)};});
  put('terminal/exports.json', exports);
  put('terminal/workspace-admission.json', {passed: true});
  put('terminal/summary.json', {instanceId: id, evaluationBatchId: `remaining63-node-${runId}`, attemptId: `${id}-node-${runId}-001`, status: 'completed', containerClosed: true, containerRemoved: true, captureContainerRemoved: true, modelAbsence: 'model-absence', captureAbsence: 'capture-absence', containerId, captureContainerId: containerId, process: processReceipt, evidence, exports, capture: receipt, predictionEligible: true, predictionPresent: true});
  put('terminal/prediction.json', official.createFrozenPrediction({schemaVersion: 1, evaluationBatchId: `remaining63-node-${runId}`, attemptId: `${id}-node-${runId}-001`, instanceId: id, modelNameOrPath: 'openai/deepseek-v4-flash', modelPatch: patch.toString()}));
  put('official-environment.json', {instanceId: id, baseCommit: candidate.task.baseCommit, imageId, imageRef: candidate.task.imageRef, imageDigest, containerId, platform: 'linux/amd64', bundleSha256: candidate.bundle.sha256});
  put('sanitation.json', {content: {passed: true}});
  put('preflight-verification.json', {modelAttempt: false});
  put('launch-prompt.txt', Buffer.from('public fixture prompt'));
  for (const role of ['model', 'capture']) {
    const name = role + '-absence';
    put(name + '.stdout.txt', Buffer.from('')); put(name + '.stderr.txt', Buffer.from(''));
    put(name + '.process.json', {args: ['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + containerId], status: 0, signal: null, timedOut: false, stdout: {bytes: 0, sha256: hash('')}, stderr: {bytes: 0, sha256: hash('')}});
  }
  const admission = {stage: 'model', instanceId: id, baseCommit: candidate.task.baseCommit, imageId, imageRef: candidate.task.imageRef, sanitationSha256: hash(files.get('sanitation.json')), preflightSha256: hash(files.get('preflight-verification.json')), promptSha256: hash(files.get('launch-prompt.txt')), officialEnvironmentSha256: hash(fs.readFileSync(path.join(evidenceDir, 'official-environment.json'))), candidateManifestSha256: hash(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json'))), generationManifestSha256: hash(fs.readFileSync(generationPath))};
  put('model-admission.json', admission);
  put('model-claim.json', {...admission, runId, evaluationBatchId: `remaining63-node-${runId}`, attemptId: `${id}-node-${runId}-001`, attempt: 1, diagnosticOnly: true, passAt1: null});
  const manifestPath = path.join(evidenceDir, 'official-evaluator-manifest.json');
  put('official-evaluator-manifest.json', {schemaVersion: 1, profileId: profile.profileId, evaluatorPython: '/fixture/python', evaluatorSourceDir: '/fixture/source', gitExecutable: '/fixture/git', dockerExecutable: '/fixture/docker', evaluatorVersion: official.OFFICIAL_EVALUATOR_VERSION, evaluatorCommit: official.OFFICIAL_EVALUATOR_COMMIT, dataset: {schemaVersion: 1, profileId: profile.profileId, sourceDatasetName: profile.sourceDatasetName, split: profile.split, sourceRevision: profile.sourceRevision, localDatasetJsonlPath: '/fixture/corpus.jsonl', localDatasetJsonlSha256: profile.jsonlSha256, localDatasetJsonlBytes: profile.jsonlBytes, selectedInstanceIds: [id, ...Array.from({length: 499}, (_, n) => `fixture__instance-${String(n).padStart(3, '0')}`)].sort()}, platform: 'linux/amd64', evaluationTimeoutSeconds: 1800, imagePullTimeoutSeconds: 900});
  audit();
  return {evidenceDir, manifestPath, runId, put, get, audit, files};
}

test('evaluates once and preserves the exact canonical record and same image identity', async t => {
  const f = fixture(t);
  const result = await evaluateNodeBundleTask(f);
  assert.equal(result.disposition, 'resolved');
  assert.equal(state.evaluations, 1);
  assert.deepEqual(f.get('official-record.json'), state.record);
  assert.equal(f.get('image-manifest.json').evaluationBatchId, `remaining63-node-${runId}`);
  assert.equal(f.get('image-manifest.json').entries[0].imageDigest, imageDigest);
  assert.equal(f.get('evaluation-closure.json').state, 'absent');
  assert(!fs.existsSync(path.join(f.evidenceDir, 'active-operation.lock')));
  await assert.rejects(evaluateNodeBundleTask(f), /prevents rerun/);
  assert.equal(state.evaluations, 1);
});

test('preserves an official test failure without retry or reinterpretation', async t => {
  const f = fixture(t); state.unresolved = true;
  const result = await evaluateNodeBundleTask(f);
  assert.equal(result.disposition, 'test-failed');
  assert.deepEqual(f.get('official-record.json'), state.record);
  assert.equal(state.evaluations, 1);
});

test('no prediction persists not-evaluated without starting the evaluator', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.evidenceDir, 'terminal/prediction.json'));
  f.files.delete('terminal/prediction.json');
  f.put('terminal/summary.json', {...f.get('terminal/summary.json'), predictionPresent: false, predictionEligible: false});
  f.audit();
  const result = await evaluateNodeBundleTask(f);
  assert.equal(result.disposition, 'not-evaluated');
  assert.deepEqual(f.get('evaluation-disposition.json'), result);
  const persisted = fs.readFileSync(path.join(f.evidenceDir, 'evaluation-disposition.json'));
  await assert.rejects(evaluateNodeBundleTask(f), /prevents rerun/);
  assert.deepEqual(fs.readFileSync(path.join(f.evidenceDir, 'evaluation-disposition.json')), persisted);
  assert.equal(state.evaluations, 0);
  assert.equal(state.commands.length, 0);
  assert(!fs.existsSync(path.join(f.evidenceDir, 'official-record.json')));
});

for (const scenario of ['unsafe-audit', 'omitted-manifest', 'changed-manifest', 'changed-audited-bytes', 'omitted-prediction', 'incomplete-terminal', 'patch-mismatch', 'image-mismatch', 'wrong-attempt', 'model-admission-mismatch', 'generation-not-closed', 'wrong-absence-id', 'absence-output', 'missing-export', 'symlink']) {
  test('refuses ' + scenario + ' before any external call', async t => {
    const f = fixture(t);
    if (scenario === 'unsafe-audit') f.put('credential-audit.json', {...f.get('credential-audit.json'), safe: false});
    if (scenario === 'omitted-manifest') f.put('credential-audit.json', {...f.get('credential-audit.json'), files: f.get('credential-audit.json').files.filter(entry => entry.path !== 'official-evaluator-manifest.json')});
    if (scenario === 'changed-manifest') fs.appendFileSync(f.manifestPath, ' ');
    if (scenario === 'changed-audited-bytes') fs.appendFileSync(path.join(f.evidenceDir, 'terminal/summary.json'), ' ');
    if (scenario === 'omitted-prediction') f.put('credential-audit.json', {...f.get('credential-audit.json'), files: f.get('credential-audit.json').files.filter(entry => entry.path !== 'terminal/prediction.json')});
    if (scenario === 'incomplete-terminal') {f.put('terminal/evidence-admission.json', {prefixValid: true, complete: false, rootStatus: 'failed'}); f.audit();}
    if (scenario === 'patch-mismatch') {f.put('terminal/captured/diagnostic.patch', Buffer.from('changed')); f.audit();}
    if (scenario === 'image-mismatch') {f.put('official-environment.json', {...f.get('official-environment.json'), imageDigest: 'sha256:' + 'f'.repeat(64)}); f.audit();}
    if (scenario === 'wrong-attempt') {f.put('terminal/prediction.json', {...f.get('terminal/prediction.json'), attemptId: id + '-node-another-001'}); f.audit();}
    if (scenario === 'model-admission-mismatch') {f.put('model-admission.json', {...f.get('model-admission.json'), officialEnvironmentSha256: '0'.repeat(64)}); f.audit();}
    if (scenario === 'generation-not-closed') {f.put('terminal/summary.json', {...f.get('terminal/summary.json'), captureContainerRemoved: false}); f.audit();}
    if (scenario === 'wrong-absence-id') {const receipt = f.get('model-absence.process.json'); receipt.args[receipt.args.length - 1] = 'id=' + 'd'.repeat(64); f.put('model-absence.process.json', receipt); f.audit();}
    if (scenario === 'absence-output') {f.put('capture-absence.stdout.txt', Buffer.from(containerId)); f.audit();}
    if (scenario === 'missing-export') {f.put('credential-audit.json', {...f.get('credential-audit.json'), files: f.get('credential-audit.json').files.filter(entry => entry.path !== 'terminal/runtime.tar')});}
    if (scenario === 'symlink') {const file = path.join(f.evidenceDir, 'process-receipt.json'); fs.renameSync(file, file + '.real'); fs.symlinkSync(file + '.real', file);}
    await assert.rejects(evaluateNodeBundleTask(f));
    assert.equal(state.evaluations, 0);
    assert.equal(state.commands.length, 0);
    assert(!fs.existsSync(path.join(f.evidenceDir, 'evaluation-claim.json')));
  });
}

test('shared model lock prevents an evaluation claim', async t => {
  const f = fixture(t); f.put('active-operation.lock', {stage: 'model'});
  await assert.rejects(evaluateNodeBundleTask(f), {code: 'EEXIST'});
  assert.equal(state.evaluations, 0);
  assert.deepEqual(f.get('active-operation.lock'), {stage: 'model'});
  assert(!fs.existsSync(path.join(f.evidenceDir, 'evaluation-claim.json')));
});

test('unexpected evaluator exception preserves infrastructure uncertainty and closure evidence', async t => {
  const f = fixture(t); state.throwEvaluator = true;
  const result = await evaluateNodeBundleTask(f);
  assert.equal(result.disposition, 'inconclusive');
  assert.equal(f.get('official-record.json').reason, 'uncertain-external-effect');
  assert.match(f.get('official/evaluation-error.json').error, /interruption/);
  assert.equal(f.get('evaluation-closure.json').closed, true);
  assert.equal(state.evaluations, 1);
});

for (const scenario of ['stopped', 'running', 'wrongName', 'wrongImage', 'listFailure']) {
  test('exact container closure: ' + scenario, async t => {
    const f = fixture(t); state.present = true;
    if (scenario !== 'stopped') state[scenario] = true;
    if (scenario === 'stopped') await evaluateNodeBundleTask(f);
    else await assert.rejects(evaluateNodeBundleTask(f), /closure unconfirmed/);
    assert.equal(f.get('evaluation-closure.json').closed, scenario === 'stopped');
    assert.equal(fs.existsSync(path.join(f.evidenceDir, 'active-operation.lock')), scenario !== 'stopped');
    assert(fs.existsSync(path.join(f.evidenceDir, 'evaluation-claim.json')));
    assert.deepEqual(f.get('official-record.json'), state.record);
    const closure = f.get('evaluation-closure.json');
    assert.equal(closure.commands[0].status, scenario === 'listFailure' ? 1 : 0);
    assert.equal(closure.commands[0].stdout, containerId + '\n');
    if (scenario === 'listFailure') assert.equal(closure.commands[0].stderr, 'daemon unavailable');
    assert.equal(state.evaluations, 1);
  });
}
