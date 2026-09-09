import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {admitRecoveryRun, buildRecoverySummary, readRecoveryConfig, recoveryPrediction, verifyFrozenSource} from '../scripts/node-bundle-recovery.mjs';
import {captureExec, modelRemovalSafe, predictionEligible} from '../scripts/generate-node-bundle-one.mjs';
import {readFrozenPrediction} from '../scripts/swe-bench-official-evaluator.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const candidate = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json')));
const generation = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-generation.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the frozen recovery manifest matches the real candidate and generation configuration', () => {
  const recovery = readRecoveryConfig(candidate, generation);
  assert.equal(recovery.source.runId, '34376814789');
  assert.equal(recovery.attempt.attemptId, 'django__django-10097-node-34376814789-001');
  assert.equal(recovery.attempt.evaluationBatchId, 'remaining63-node-34376814789');
  assert.equal(recovery.attempt.imageRef, candidate.task.imageRef);
  assert.equal(recovery.expected.baseGit.objects, 8173);
  assert(recovery.evidence['terminal/workspace.tar'].sizeBytes > 1_000_000);
  assert.equal(recovery.evidence['terminal/attempt.jsonl'].sha256, 'f3b280b29ff0a6153b229bbac10c3b2fc6f38dab79e53177a380bafa5852d79a');
  assert.equal(recovery.evidence['terminal/workspace.tar'].sha256, 'bac6fb8788b0740c8fb4ff7d5910a6a69df53e670396df50fadd4cec8d56a37c');
});

const preModelRuns = [
  {runId: '100', headSha: 'h1', jobId: 11, failedStep: 'F1', skippedSteps: ['S1', 'S2']},
  {runId: '200', headSha: 'h2', jobId: 22, failedStep: 'F2', skippedSteps: ['S3']},
];
const source = {
  runId: '300', headSha: 'h3', jobId: 33, failedStep: 'Model', skippedSteps: ['Eval'],
  succeededSteps: ['Publish1', 'Publish2'], modelAttempt: true, predictionPresent: false, officialEvaluation: 'not-evaluated',
};
const hostedRun = (id, headSha) => ({id, head_sha: headSha, status: 'completed', conclusion: 'failure', run_attempt: 1});
const stepsFor = declaration => [
  {name: declaration.failedStep, conclusion: 'failure'},
  ...declaration.skippedSteps.map(name => ({name, conclusion: 'skipped'})),
  ...(declaration.succeededSteps ?? []).map(name => ({name, conclusion: 'success'})),
];
const jobsByRun = () => Object.fromEntries([preModelRuns[0], preModelRuns[1], source].map(declaration => [declaration.runId, {jobs: [{id: declaration.jobId, status: 'completed', conclusion: 'failure', steps: stepsFor(declaration)}]}]));

test('admits recovery exactly when the hosted run population matches the frozen declarations', () => {
  const oneRuns = [hostedRun(100, 'h1'), hostedRun(200, 'h2'), hostedRun(300, 'h3')];
  admitRecoveryRun(oneRuns, [], '999', preModelRuns, source, jobsByRun());
  for (const mutation of [
    () => admitRecoveryRun(oneRuns, [hostedRun(888, 'h8')], '999', preModelRuns, source, jobsByRun()),
    () => admitRecoveryRun([...oneRuns, hostedRun(400, 'h4')], [], '999', preModelRuns, source, jobsByRun()),
    () => admitRecoveryRun([hostedRun(100, 'changed'), hostedRun(200, 'h2'), hostedRun(300, 'h3')], [], '999', preModelRuns, source, jobsByRun()),
    () => admitRecoveryRun(oneRuns.map(run => run.id === 300 ? {...run, run_attempt: 2} : run), [], '999', preModelRuns, source, jobsByRun()),
  ]) assert.throws(mutation);
  const tamperedJobs = jobsByRun();
  tamperedJobs[300].jobs[0].steps.find(step => step.name === 'Eval').conclusion = 'success';
  assert.throws(() => admitRecoveryRun(oneRuns, [], '999', preModelRuns, source, tamperedJobs), /conclusion/);
  assert.throws(() => admitRecoveryRun(oneRuns, [], '999', preModelRuns, {...source, predictionPresent: true}, jobsByRun()), /prediction/);
});

function fixtureSource(t, {recovery, mutate}) {
  const sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-source-')));
  t.after(() => fs.rmSync(sourceDir, {recursive: true, force: true}));
  const files = new Map();
  const put = (relative, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const file = path.join(sourceDir, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
    files.set(relative, bytes);
  };
  const patch = Buffer.from('diff --git a/django/core/validators.py b/django/core/validators.py\n--- a/django/core/validators.py\n+++ b/django/core/validators.py\n');
  const receipt = {status: 'captured', baseCommit: recovery.attempt.baseCommit, bytes: patch.length, sha256: hash(patch), method: 'trusted-base-git-private-index-to-terminal-worktree', originalIndexUnchanged: true};
  const exports = ['attempt.jsonl', 'artifacts.tar', 'runtime.tar', 'workspace.tar'].map(target => {
    const bytes = Buffer.from('frozen ' + target);
    put('terminal/' + target, bytes);
    return {source: '/testbed', target, status: 0, signal: null, timedOut: false, sha256: hash(bytes)};
  });
  put('terminal/summary.json', {
    instanceId: recovery.attempt.instanceId, evaluationBatchId: recovery.attempt.evaluationBatchId, attemptId: recovery.attempt.attemptId,
    status: 'failed', stage: 'capture', diagnosticOnly: true, passAt1: null, modelAttempt: true, predictionEligible: false, predictionPresent: false,
    containerClosed: true, containerRemoved: true, captureContainerRemoved: true, containerId: recovery.attempt.containerId,
    captureContainerId: 'd'.repeat(64), modelAbsence: 'model-absence',
    process: {status: 0, signal: null, timedOut: false}, exports,
    evidence: {prefixValid: true, complete: true, reason: 'complete', rootStatus: 'completed', rootTerminalCause: 'completed'},
  });
  put('terminal/captured/receipt.json', receipt);
  put('generation-claim.json', {runId: recovery.source.runId, startedAt: '2026-09-09T16:28:17.307Z', diagnosticOnly: true, passAt1: null});
  put('run-claim.json', {runId: recovery.source.runId, runAttempt: 1, candidateId: recovery.candidateId, modelAttempt: false, diagnosticOnly: true, passAt1: null, at: '2026-09-09T16:27:42.472Z'});
  put('controller-generate-failure.json', {stage: 'generate', error: 'Error: Generation did not complete; official evaluation is not admitted', stack: 'Error: ...'});
  put('sanitation.json', {content: {passed: true}, git: {baseCommit: recovery.attempt.baseCommit, commitObjects: 1, objects: recovery.expected.baseGit.objects, objectSetSha256: recovery.expected.baseGit.objectSetSha256, allObjectsReachableFromBase: true}});
  put('baseline-capture/receipt.json', {status: 'captured', baseCommit: recovery.attempt.baseCommit, bytes: 0, sha256: hash(''), method: 'trusted-base-git-private-index-to-terminal-worktree', originalIndexUnchanged: true});
  put('official-environment.json', {instanceId: recovery.attempt.instanceId, baseCommit: recovery.attempt.baseCommit, containerId: recovery.attempt.containerId, imageId: recovery.attempt.imageId, imageRef: recovery.attempt.imageRef, imageDigest: recovery.attempt.imageRef.split('@')[1], bundleSha256: candidate.bundle.sha256, platform: 'linux/amd64'});
  put('preflight-verification.json', {modelAttempt: false});
  put('launch-prompt.txt', Buffer.from('public fixture launch prompt'));
  const admission = {
    stage: 'model', instanceId: recovery.attempt.instanceId, baseCommit: recovery.attempt.baseCommit,
    imageId: recovery.attempt.imageId, imageRef: recovery.attempt.imageRef,
    officialEnvironmentSha256: hash(fs.readFileSync(path.join(sourceDir, 'official-environment.json'))),
    sanitationSha256: hash(fs.readFileSync(path.join(sourceDir, 'sanitation.json'))),
    preflightSha256: hash(fs.readFileSync(path.join(sourceDir, 'preflight-verification.json'))),
    promptSha256: hash(fs.readFileSync(path.join(sourceDir, 'launch-prompt.txt'))),
    candidateManifestSha256: recovery.expected.candidateConfigSha256, generationManifestSha256: 'c'.repeat(64),
  };
  put('model-admission.json', admission);
  put('model-claim.json', {...admission, runId: recovery.source.runId, evaluationBatchId: recovery.attempt.evaluationBatchId, attemptId: recovery.attempt.attemptId, attempt: 1, diagnosticOnly: true, passAt1: null});
  put('model.process.json', {status: 0, signal: null, timedOut: false});
  put('evaluation-disposition.json', {instanceId: recovery.attempt.instanceId, diagnosticOnly: true, passAt1: null, disposition: 'not-evaluated', reason: 'generation-incomplete'});
  const evidenceEntries = {};
  for (const [relative, bytes] of files) evidenceEntries[relative] = {sizeBytes: bytes.length, sha256: hash(bytes)};
  const manifest = {...recovery, evidence: evidenceEntries};
  if (mutate) mutate({sourceDir, put, files, manifest});
  return {sourceDir, manifest, files};
}

test('verifyFrozenSource admits exact frozen evidence and rejects any single-byte tampering', t => {
  const recovery = readRecoveryConfig();
  const inspectAttempt = () => ({prefixValid: true, complete: true, rootStatus: 'completed'});
  const {sourceDir, manifest} = fixtureSource(t, {recovery});
  const receipt = verifyFrozenSource(sourceDir, manifest, inspectAttempt);
  assert.equal(receipt.sourceRunId, recovery.source.runId);
  assert.equal(receipt.verifiedFiles, Object.keys(manifest.evidence).length);
  const file = path.join(sourceDir, 'sanitation.json');
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 2) + ' \n');
  assert.throws(() => verifyFrozenSource(sourceDir, manifest, inspectAttempt), /hash changed/);
});

test('verifyFrozenSource rejects a source whose trajectory evidence is incomplete', t => {
  const recovery = readRecoveryConfig();
  const {sourceDir, manifest} = fixtureSource(t, {recovery});
  const inspectAttempt = () => ({prefixValid: true, complete: false, rootStatus: 'completed'});
  assert.throws(() => verifyFrozenSource(sourceDir, manifest, inspectAttempt), /not complete/);
  const inspectPrefix = () => ({prefixValid: false, complete: true, rootStatus: 'completed'});
  assert.throws(() => verifyFrozenSource(sourceDir, manifest, inspectPrefix), /not intact/);
});

test('the recovery summary is prediction-eligible and preserves the frozen attempt identity', t => {
  const recovery = readRecoveryConfig();
  const {sourceDir} = fixtureSource(t, {recovery});
  const sourceSummary = JSON.parse(fs.readFileSync(path.join(sourceDir, 'terminal/summary.json'), 'utf8'));
  const patch = Buffer.from('diff --git a/x b/x\n');
  const captureReceipt = {status: 'captured', baseCommit: recovery.attempt.baseCommit, bytes: patch.length, sha256: hash(patch), method: 'trusted-base-git-private-index-to-terminal-worktree', originalIndexUnchanged: true};
  const summary = buildRecoverySummary(sourceSummary, captureReceipt, 'c'.repeat(64), {sourceRunId: recovery.source.runId});
  assert.equal(summary.attemptId, recovery.attempt.attemptId);
  assert.equal(summary.evaluationBatchId, recovery.attempt.evaluationBatchId);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.captureAbsence, 'capture-absence');
  assert.equal(summary.containerId, sourceSummary.containerId);
  assert.equal(modelRemovalSafe(summary), true);
  assert.equal(predictionEligible(summary), true);
  for (const mutation of [{containerClosed: false}, {captureContainerRemoved: false}, {evidence: {...summary.evidence, complete: false}}, {capture: {...captureReceipt, bytes: 0}}, {process: {...summary.process, timedOut: true}}]) {
    assert.equal(predictionEligible({...summary, ...mutation}), false);
  }
  const prediction = recoveryPrediction(patch.toString('utf8'), captureReceipt.sha256, recovery);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-prediction-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const predictionPath = path.join(directory, 'prediction.json');
  fs.writeFileSync(predictionPath, JSON.stringify(prediction, null, 2) + '\n');
  const loaded = readFrozenPrediction(predictionPath);
  assert.equal(loaded.attemptId, recovery.attempt.attemptId);
  assert.equal(loaded.modelPatchSha256, captureReceipt.sha256);
  assert.equal(loaded.modelNameOrPath, candidate.candidateId + '-' + generation.provider.model);
});

test('the main flow capture steps execute with a working-directory-safe exec form', t => {
  assert.deepEqual(captureExec('abc123', 'rm', '-rf', '/testbed'), ['exec', '-w', '/', 'abc123', 'rm', '-rf', '/testbed']);
  const source = fs.readFileSync(path.join(repository, 'scripts/generate-node-bundle-one.mjs'), 'utf8');
  for (const name of ['capture-clear-original', 'capture-directories', 'capture-place-worktree']) {
    assert.match(source, new RegExp("step\\('" + name + "', captureExec\\("), name + ' must use the cwd-safe exec helper');
  }
  assert.doesNotMatch(source, /'capture-clear-original', \['exec', captureId/);
});
