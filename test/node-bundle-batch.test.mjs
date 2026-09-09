import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {admitBatchRun, admitFirstTaskProvenance, batchModeTask, copyFrozenEvidence, frozenPredictionPrior, validateBatchConfig, resolveBatchTask, verifyFrozenArtifact} from '../scripts/node-bundle-controller.mjs';
import {verifyCandidate, verifyTaskIdentity} from '../scripts/swe-node-bundle-preflight.mjs';
import {pythonEnvironmentExpectations} from '../scripts/generate-node-bundle-one.mjs';
import {selectFrozenTask} from '../scripts/node-bundle-task-selection.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const readJson = name => JSON.parse(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const selectionBytes = fs.readFileSync(new URL('../config/node-bundle-failed-tasks.json', import.meta.url));
const selection = JSON.parse(selectionBytes);
const batchBytes = fs.readFileSync(new URL('../config/node-bundle-batch-1.json', import.meta.url));
const batch = JSON.parse(batchBytes);

test('batch 1 config is frozen, diagnostic, and consistent with the failed-task selection', () => {
  validateBatchConfig(batch, selectionBytes);
  assert.equal(createHash('sha256').update(selectionBytes).digest('hex'), batch.selectionSourceSha256);
  assert.equal(batch.batchId, 'remaining63-node-batch1');
  assert.equal(batch.tasks.length, 5);
  assert.deepEqual(batch.tasks.map(task => task.taskIndex), [1, 2, 3, 4, 5]);
  assert.equal(batch.priorBatchRuns.length, 7);
  assert.deepEqual(batch.priorBatchRuns.map(run => run.runId), ['34396601488', '34396884605', '34398741179', '34399786029', '34404487703', '34407065559', '34408218858']);
  for (const prior of batch.priorBatchRuns) {
    if (prior.modelAttempt) {
      assert.equal(prior.predictionPresent, true, 'A model-attempt prior must have its frozen prediction');
      assert.equal(prior.instanceId, 'astropy__astropy-13033');
      assert.equal(prior.attemptId, `astropy__astropy-13033-node-${prior.runId}-001`);
      assert.match(prior.predictionFileSha256, /^[a-f0-9]{64}$/);
      assert.match(prior.patchSha256, /^[a-f0-9]{64}$/);
      assert(Number.isInteger(prior.patchBytes) && prior.patchBytes > 0);
      assert.equal(prior.artifactName, `node-bundle-batch1-astropy__astropy-13033-${prior.runId}-1`);
      assert(Number.isInteger(prior.artifactId) && prior.artifactId > 0);
      assert(Number.isInteger(prior.artifactManifestFiles) && prior.artifactManifestFiles > 0);
      if (prior.officialEvaluation === 'not-evaluated') {
        assert.equal(prior.runId, '34404487703', 'The predeclared attempt is the only one routed to evaluation-only recovery');
        assert.equal(prior.predictionFileSha256, '9896313bc698548b12a3a94a51c73ec731bb23fc8ccec9f99688f2d1024fbd58');
        assert.equal(prior.patchSha256, '260a27b0443323c2e885bfa86c6f70fd36aeb1af958248f3aa2c41c9ab8a29ca');
        assert.equal(prior.artifactId, 10125081716);
        assert.equal(prior.artifactManifestFiles, 260);
        assert(prior.forbiddenDuplicateAttempt !== true);
      } else {
        assert.equal(prior.runId, '34407065559', 'The only other model-attempt prior is the declared forbidden duplicate');
        assert.equal(prior.forbiddenDuplicateAttempt, true);
        assert.equal(prior.excludedFromTally, true);
        assert.equal(prior.officialEvaluation, 'test-failed');
        assert.equal(prior.patchSha256, 'addf5502dff82366c4237704694cae2ccee62e3da3c0fb4849be18f991868b6c');
        assert.equal(prior.succeededJobs.map(job => job.jobId).join(','), '102652479023');
        assert.equal(prior.jobId, 102655575298);
      }
    } else {
      assert.equal(prior.predictionPresent, false);
    }
    assert(prior.reason.length > 40);
  }
  for (const entry of batch.tasks) {
    const frozen = selection.tasks[entry.taskIndex];
    assert.equal(frozen.instanceId, entry.instanceId);
    assert.equal(frozen.baseCommit, entry.baseCommit);
    assert.equal(frozen.promptSha256, entry.promptSha256);
    assert.equal(entry.pythonVersion, null, 'Batch image Python versions are recorded as evidence, not invented');
    assert.equal(entry.sanitationPlan.installedEggPath, null, 'astropy dev-installs resolve to /testbed; the environment probe proves source identity');
    verifyTaskIdentity(entry, entry.instanceId);
  }
  assert.deepEqual(batch.tasks.map(task => task.instanceId), [
    'astropy__astropy-13033',
    'astropy__astropy-13398',
    'astropy__astropy-13977',
    'astropy__astropy-14365',
    'astropy__astropy-14598',
  ]);
});

test('first-task provenance freezes the completed django__django-10097 verdict', () => {
  const provenance = batch.firstTaskProvenance;
  assert.equal(provenance.instanceId, 'django__django-10097');
  assert.equal(provenance.recoveryRunId, '34388930674');
  assert.equal(provenance.recoveryHeadSha, 'f2849a50a324a4a84426437ddd43f0bf667362f5');
  assert.equal(provenance.attemptId, 'django__django-10097-node-34376814789-001');
  assert.equal(provenance.patchSha256, 'd6b8b6bbc9b0edce8f84ee4c39352bc253df9ec0a9f44c41383137bdbbca3dc5');
  assert.equal(provenance.verdict, 'test-failed');
  assert.equal(provenance.officialResolved, false);
  assert.match(provenance.imageDigest, /^sha256:[a-f0-9]{64}$/);
});

test('admitFirstTaskProvenance verifies the live recovery and generation runs before a batch is admitted', () => {
  const recovery = {id: 34388930674, head_sha: batch.firstTaskProvenance.recoveryHeadSha, status: 'completed', conclusion: 'success', run_attempt: 1};
  const generation = {id: 34376814789, head_sha: 'acdd275fc67e4ab707ce07c93bb0ad8129e5d9b6', status: 'completed', conclusion: 'failure', run_attempt: 1};
  admitFirstTaskProvenance([recovery], [generation], batch);
  assert.throws(() => admitFirstTaskProvenance([], [generation], batch));
  assert.throws(() => admitFirstTaskProvenance([recovery], [], batch));
  assert.throws(() => admitFirstTaskProvenance([{...recovery, head_sha: '0'.repeat(40)}], [generation], batch));
  assert.throws(() => admitFirstTaskProvenance([{...recovery, conclusion: 'failure'}], [generation], batch));
  assert.throws(() => admitFirstTaskProvenance([{...recovery, run_attempt: 2}], [generation], batch));
});

test('controller batchModeTask reads the real frozen selection bytes for its hash gate', t => {
  // Regression for batch run 34398741179: the controller passed its own batch
  // config bytes where the failed-task selection bytes are required, so the
  // frozen selection-hash gate threw before any admission or model call. This
  // test exercises the controller's real batch entry path, not a re-implementation.
  process.env.NODE_BUNDLE_TASK = 'astropy__astropy-13033';
  t.after(() => { delete process.env.NODE_BUNDLE_TASK; });
  const resolved = batchModeTask();
  assert.equal(resolved.batch.batchId, 'remaining63-node-batch1');
  assert.equal(resolved.batch.selectionSourceSha256, createHash('sha256').update(selectionBytes).digest('hex'));
  assert.equal(resolved.entry.instanceId, 'astropy__astropy-13033');
  assert.equal(resolved.entry.taskIndex, 1);
  assert.deepEqual(resolved.entry.baseCommit, selection.tasks[1].baseCommit);
  process.env.NODE_BUNDLE_TASK = 'astropy__astropy-14598';
  assert.equal(batchModeTask().entry.taskIndex, 5);
  delete process.env.NODE_BUNDLE_TASK;
  assert.equal(batchModeTask(), null, 'No NODE_BUNDLE_TASK means the single-task controller path');
});

test('admitBatchRun admits declared failed priors with five-job shape and rejects the rest', () => {
  const current = {id: 500, head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null, run_attempt: 1};
  const fiveJobs = jobId => [jobId, 21, 22, 23, 24].map((id, index) => ({id, status: 'completed', conclusion: index === 0 ? 'failure' : 'skipped', steps: index === 0 ? [
    {name: 'Verify controller and official evaluator environment before model admission', status: 'completed', conclusion: 'failure'},
    {name: 'Run the sole frozen model attempt and audit terminal evidence', status: 'completed', conclusion: 'skipped'},
    {name: 'Evaluate frozen prediction in fresh official Docker container', status: 'completed', conclusion: 'skipped'},
  ] : []}));
  admitBatchRun([current], '500', batch);
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', batch), /not declared/);
  const declared = {...batch, priorBatchRuns: [{runId: '499', headSha: 'b'.repeat(40), jobId: 9, failedStep: 'Verify controller and official evaluator environment before model admission', skippedSteps: ['Run the sole frozen model attempt and audit terminal evidence', 'Evaluate frozen prediction in fresh official Docker container']}]};
  admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: fiveJobs(9)}});
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'c'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: fiveJobs(9)}}));
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: fiveJobs(9).slice(0, 1)}}), /five jobs/);
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: fiveJobs(9).map(job => ({...job, conclusion: job.id === 9 ? 'failure' : 'success'}))}}), /non-declared job/);
  const successful = {...batch, priorBatchRuns: [{runId: '499', headSha: 'b'.repeat(40), jobId: 9, failedStep: 'anything', skippedSteps: []}]};
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success', run_attempt: 1}], '500', successful, {499: {jobs: fiveJobs(9)}}), /forbids any further dispatch/);
});

test('admitBatchRun admits a declared prior with one succeeded and one failed job and rejects the rest', () => {
  const current = {id: 500, head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null, run_attempt: 1};
  const mixedJobs = failedJobId => [9, failedJobId, 22, 23, 24].map((id, index) => ({id, status: 'completed', conclusion: index === 0 ? 'success' : index === 1 ? 'failure' : 'skipped', steps: index === 1 ? [
    {name: 'Verify controller and official evaluator environment before model admission', status: 'completed', conclusion: 'success'},
    {name: 'Run the sole frozen model attempt and audit terminal evidence', status: 'completed', conclusion: 'failure'},
    {name: 'Evaluate frozen prediction in fresh official Docker container', status: 'completed', conclusion: 'skipped'},
  ] : []}));
  const declared = {...batch, priorBatchRuns: [{runId: '499', headSha: 'b'.repeat(40), jobId: 21, failedStep: 'Run the sole frozen model attempt and audit terminal evidence', skippedSteps: ['Evaluate frozen prediction in fresh official Docker container'], succeededJobs: [{jobId: 9}]}]};
  admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: mixedJobs(21)}});
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: mixedJobs(21).map(job => job.id === 9 ? {...job, conclusion: 'failure'} : job)}}), /declared succeeded job/);
  assert.throws(() => admitBatchRun([current, {id: 499, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', run_attempt: 1}], '500', declared, {499: {jobs: mixedJobs(21).map(job => job.id === 22 ? {...job, conclusion: 'success'} : job)}}), /non-declared job/);
});

test('the controller evaluate call passes the batch entry under the evaluation module parameter name and binds a frozen attempt to its generation run', () => {
  // Regression for batch run 34404487703: the evaluation module reads 'entry'; passing
  // 'task' silently fell back to the single-task django identity and the official
  // evaluation rejected the astropy attempt at its first summary assertion. The
  // evaluation-only recovery additionally binds the evaluation to the frozen
  // generation run, because every identity assertion in the evaluation module
  // (summary attemptId, model-claim runId, prediction batch) checks that run.
  const source = fs.readFileSync(path.join(repository, 'scripts/node-bundle-controller.mjs'), 'utf8');
  assert.match(source, /evaluateNodeBundleTask\(\{evidenceDir, manifestPath: path\.join\(evidenceDir, 'official-evaluator-manifest\.json'\), runId: prior \? prior\.runId : runId, entry: batchTask \? batchTask\.entry : null\}\)/);
  assert.doesNotMatch(source, /evaluateNodeBundleTask\([^)]*\btask: batchTask/);
  const evaluate = fs.readFileSync(path.join(repository, 'scripts/evaluate-node-bundle-one.mjs'), 'utf8');
  assert.match(evaluate, /entry = null/);
});

test('frozenPredictionPrior routes only the predeclared attempt to evaluation-only recovery', () => {
  const prior = frozenPredictionPrior(batch, batch.tasks[0]);
  assert.equal(prior.runId, '34404487703', 'The forbidden duplicate must never route a task');
  assert.equal(prior.instanceId, 'astropy__astropy-13033');
  for (const entry of batch.tasks.slice(1)) {
    assert.equal(frozenPredictionPrior(batch, entry), null, entry.instanceId + ' must keep its full first-attempt pipeline');
  }
  assert.equal(frozenPredictionPrior({...batch, priorBatchRuns: batch.priorBatchRuns.filter(run => run.runId !== '34404487703')}, batch.tasks[0]), null, 'With only the duplicate present, 13033 has no eval-only route');
  assert.equal(frozenPredictionPrior({...batch, priorBatchRuns: batch.priorBatchRuns.filter(run => !run.modelAttempt)}, batch.tasks[0]), null);
});

test('validateBatchConfig admits the declared forbidden duplicate and rejects undeclared or second predeclared attempts', () => {
  const secondPredeclared = {...batch, priorBatchRuns: [...batch.priorBatchRuns, {...batch.priorBatchRuns[4], runId: '34409999999', artifactId: 999, artifactName: 'node-bundle-batch1-astropy__astropy-13033-34409999999-1', reason: 'A second predeclared pending attempt for the same task is never admitted.'}]};
  assert.throws(() => validateBatchConfig(secondPredeclared, selectionBytes), /At most one predeclared model attempt/);
  const undeclaredDuplicate = {...batch, priorBatchRuns: batch.priorBatchRuns.map(run => run.runId === '34407065559' ? {...run, forbiddenDuplicateAttempt: false} : run)};
  assert.throws(() => validateBatchConfig(undeclaredDuplicate, selectionBytes), /must be declared a forbidden duplicate/);
  const unexcludedDuplicate = {...batch, priorBatchRuns: batch.priorBatchRuns.map(run => run.runId === '34407065559' ? {...run, excludedFromTally: false} : run)};
  assert.throws(() => validateBatchConfig(unexcludedDuplicate, selectionBytes), /excluded from the diagnostic tally/);
  const wrongAttempt = {...batch, priorBatchRuns: batch.priorBatchRuns.map(run => run.modelAttempt && run.officialEvaluation === 'not-evaluated' ? {...run, attemptId: 'astropy__astropy-13033-node-34404487703-002'} : run)};
  assert.throws(() => validateBatchConfig(wrongAttempt, selectionBytes), /attempt identity mismatch/);
  const missingArtifact = {...batch, priorBatchRuns: batch.priorBatchRuns.map(run => run.modelAttempt && run.officialEvaluation === 'not-evaluated' ? {...run, artifactName: 'some-other-artifact'} : run)};
  assert.throws(() => validateBatchConfig(missingArtifact, selectionBytes), /node-bundle-batch1-/);
  validateBatchConfig(batch, selectionBytes);
});

function buildFrozenFixture(directory, prior) {
  const patchBytes = Buffer.from('frozen diagnostic patch bytes\n');
  const prediction = {instanceId: prior.instanceId, attemptId: prior.attemptId, evaluationBatchId: `remaining63-node-${prior.runId}`, modelPatch: patchBytes.toString('utf8'), modelPatchSha256: createHash('sha256').update(patchBytes).digest('hex')};
  const summary = {instanceId: prior.instanceId, attemptId: prior.attemptId, evaluationBatchId: `remaining63-node-${prior.runId}`, predictionPresent: true};
  const capture = {status: 'captured', sha256: createHash('sha256').update(patchBytes).digest('hex'), bytes: patchBytes.length};
  fs.mkdirSync(path.join(directory, 'terminal/captured'), {recursive: true});
  fs.mkdirSync(path.join(directory, 'control-files/config'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'terminal/summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'terminal/prediction.json'), JSON.stringify(prediction, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'terminal/captured/receipt.json'), JSON.stringify(capture, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'terminal/captured/diagnostic.patch'), patchBytes);
  fs.writeFileSync(path.join(directory, 'control-files/config/node-bundle-candidate.json'), '{}\n');
  fs.writeFileSync(path.join(directory, 'run-claim.json'), '{"frozen":true}\n');
  fs.writeFileSync(path.join(directory, 'pre-model-run-34399786029.json'), '{"frozen":true}\n');
  const fileRecord = relative => {
    const bytes = fs.readFileSync(path.join(directory, relative));
    return {path: relative, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  };
  const files = ['run-claim.json', 'pre-model-run-34399786029.json', 'control-files/config/node-bundle-candidate.json', 'terminal/summary.json', 'terminal/prediction.json', 'terminal/captured/receipt.json', 'terminal/captured/diagnostic.patch'].map(fileRecord);
  fs.writeFileSync(path.join(directory, 'upload-manifest.json'), JSON.stringify({safe: true, files}, null, 2) + '\n');
  return {patchSha256: capture.sha256, patchBytes: patchBytes.length};
}

test('verifyFrozenArtifact checks every manifest entry and the frozen identity, failing closed on change', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-batch-frozen-'));
  t.after(() => fs.rmSync(fixture, {recursive: true, force: true}));
  const prior = {...frozenPredictionPrior(batch, batch.tasks[0])};
  const built = buildFrozenFixture(fixture, prior);
  prior.artifactManifestFiles = 7;
  prior.patchSha256 = built.patchSha256;
  prior.patchBytes = built.patchBytes;
  prior.predictionFileSha256 = createHash('sha256').update(fs.readFileSync(path.join(fixture, 'terminal/prediction.json'))).digest('hex');
  verifyFrozenArtifact(fixture, prior);
  const changed = fs.readFileSync(path.join(fixture, 'terminal/captured/diagnostic.patch'));
  assert.throws(() => verifyFrozenArtifact(fixture, {...prior, artifactManifestFiles: 8}), /file count changed/);
  assert.throws(() => verifyFrozenArtifact(fixture, {...prior, predictionFileSha256: 'b'.repeat(64)}), /prediction file hash changed/);
  assert.throws(() => verifyFrozenArtifact(fixture, {...prior, patchBytes: built.patchBytes + 1}), /byte count changed/);
  fs.writeFileSync(path.join(fixture, 'terminal/captured/diagnostic.patch'), changed.toString('utf8').replace('frozen', 'frozeN'));
  assert.throws(() => verifyFrozenArtifact(fixture, prior), /hash changed: terminal\/captured\/diagnostic\.patch/);
});

test('copyFrozenEvidence copies frozen evidence without the fresh prepare-owned files and refuses overwrites', t => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'node-batch-copy-src-'));
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'node-batch-copy-dst-'));
  t.after(() => { fs.rmSync(staging, {recursive: true, force: true}); fs.rmSync(evidence, {recursive: true, force: true}); });
  const prior = {...frozenPredictionPrior(batch, batch.tasks[0])};
  const built = buildFrozenFixture(staging, prior);
  prior.artifactManifestFiles = 7;
  prior.patchSha256 = built.patchSha256;
  prior.patchBytes = built.patchBytes;
  prior.predictionFileSha256 = createHash('sha256').update(fs.readFileSync(path.join(staging, 'terminal/prediction.json'))).digest('hex');
  verifyFrozenArtifact(staging, prior);
  // The fresh prepare-owned files the recovery must not clobber.
  fs.writeFileSync(path.join(evidence, 'run-claim.json'), '{"fresh":true}\n');
  fs.mkdirSync(path.join(evidence, 'control-files/config'), {recursive: true});
  fs.writeFileSync(path.join(evidence, 'control-files/config/node-bundle-candidate.json'), '{"fresh":true}\n');
  const copied = copyFrozenEvidence(staging, evidence);
  assert.equal(copied.filesCopied, 4, 'run-claim, pre-model-run-*, control-files stay excluded');
  assert.equal(fs.readFileSync(path.join(evidence, 'run-claim.json'), 'utf8'), '{"fresh":true}\n');
  assert.equal(fs.readFileSync(path.join(evidence, 'control-files/config/node-bundle-candidate.json'), 'utf8'), '{"fresh":true}\n');
  assert.ok(fs.existsSync(path.join(evidence, 'terminal/prediction.json')));
  assert.equal(fs.existsSync(path.join(evidence, 'pre-model-run-34399786029.json')), false, 'pre-model-run receipts stay fresh-prepare-owned');
  assert.throws(() => copyFrozenEvidence(staging, evidence), /Recovery would overwrite existing evidence/, 'A second copy can never overwrite merged evidence');
});

test('batch task resolution is pinned to the frozen selection order', () => {
  const entry = resolveBatchTask(batch, selection, 'astropy__astropy-13398');
  assert.equal(entry.taskIndex, 2);
  assert.throws(() => resolveBatchTask(batch, selection, 'django__django-10097'), /not part of the frozen batch/);
  assert.throws(() => resolveBatchTask(batch, selection, 'astropy__astropy-12907'), /not part of the frozen batch/);
  const drifted = {tasks: selection.tasks.map((task, index) => index === 2 ? {...task, baseCommit: 'f'.repeat(40)} : task)};
  assert.throws(() => resolveBatchTask(batch, drifted, 'astropy__astropy-13398'));
});

test('selectFrozenTask keeps the single-task path and adds the batch path', () => {
  assert.equal(selectFrozenTask(selection).instanceId, 'django__django-10097');
  const entry = batch.tasks[0];
  assert.equal(selectFrozenTask(selection, entry).instanceId, 'astropy__astropy-13033');
  assert.throws(() => selectFrozenTask(selection, {...entry, instanceId: 'astropy__astropy-99999'}));
});

test('verifyTaskIdentity enforces per-instance official image refs and prefixes', () => {
  const entry = batch.tasks[3];
  verifyTaskIdentity(entry, 'astropy__astropy-14365');
  assert.throws(() => verifyTaskIdentity(entry, 'astropy__astropy-13033'));
  assert.throws(() => verifyTaskIdentity({...entry, imageRef: 'swebench/sweb.eval.x86_64.astropy_1776_astropy-14365:latest'}, 'astropy__astropy-14365'));
  assert.throws(() => verifyTaskIdentity({...entry, imageRef: 'swebench/sweb.eval.x86_64.astropy_1776_astropy-14365@sha256:nothex'}, 'astropy__astropy-14365'));
  assert.throws(() => verifyTaskIdentity({...entry, imageRef: 'swebench/sweb.eval.x86_64.django_1776_django-10097@sha256:' + 'a'.repeat(64)}, 'astropy__astropy-14365'));
  assert.throws(() => verifyTaskIdentity({...entry, pythonPrefix: '/usr/local'}, 'astropy__astropy-14365'));
});

test('verifyCandidate admits per-task identities against the frozen candidate files', t => {
  const entry = batch.tasks[0];
  const djangoManifest = readJson('config/node-bundle-candidate.json');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-batch-candidate-'));
  t.after(() => fs.rmSync(fixture, {recursive: true, force: true}));
  for (const name of ['best-agent.cjs', 'node-v24.15.0-linux-x64.tar.xz', 'node-v24.15.0-linux-x64/bin/node']) {
    const file = path.join(fixture, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'fixture-bytes');
  }
  // Regression for batch run 34396601488: the batch prepare path must verify the
  // batch entry identity, not the django task frozen in the candidate manifest.
  assert.throws(() => verifyCandidate(djangoManifest, fixture, entry), /SHA256 mismatch/, 'Astropy entry identity passes and file verification is reached');
  assert.throws(() => verifyCandidate(djangoManifest, fixture), /SHA256 mismatch/, 'Default still verifies the manifest own frozen task identity');
  assert.throws(() => verifyCandidate(djangoManifest, fixture, {...entry, instanceId: 'django__django-10097'}), /regular expression/, 'Cross-instance image refs fail closed');
});

test('python environment expectations keep django defaults and parameterize astropy', () => {
  assert.deepEqual(pythonEnvironmentExpectations({}), {module: 'django', source: '/testbed/django/__init__.py', version: '3.5.6'});
  const expected = pythonEnvironmentExpectations(batch.tasks[1]);
  assert.equal(expected.module, 'astropy');
  assert.equal(expected.source, '/testbed/astropy/__init__.py');
  assert.equal(expected.version, null);
  assert.deepEqual(pythonEnvironmentExpectations({pythonModule: 'astropy', pythonSource: '/testbed/astropy/__init__.py', pythonVersion: '3.9.19'}), {module: 'astropy', source: '/testbed/astropy/__init__.py', version: '3.9.19'});
});

test('batch workflow serializes five single-task jobs with isolated evidence and artifacts', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/node-bundle-batch.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /inputs:/, 'The batch has no task or batch input');
  assert.match(workflow, /group: frozen-node-failed-tasks/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /secrets\.BEST_AGENT_SOURCE_TOKEN/u);
  assert.match(workflow, /secrets\.BENCHMARK_PROVIDER_API_KEY/u);
  const jobNames = ['astropy-13033', 'astropy-13398', 'astropy-13977', 'astropy-14365', 'astropy-14598'];
  const positions = jobNames.map(job => workflow.indexOf('\n  ' + job + ':\n'));
  assert.ok(positions.every(position => position > 0), 'All five jobs exist at top level');
  assert.equal((workflow.match(/steps: &job-steps/g) ?? []).length, 1, 'Exactly one shared step anchor');
  assert.equal((workflow.match(/steps: \*job-steps/g) ?? []).length, 4, 'Four jobs reuse the audited step list');
  for (const [index, job] of jobNames.entries()) {
    const section = workflow.slice(positions[index], index + 1 < positions.length ? positions[index + 1] : workflow.length);
    const instanceId = 'astropy__astropy-' + job.slice('astropy-'.length);
    assert.match(section, new RegExp('NODE_BUNDLE_TASK: ' + instanceId), job + ' pins its task');
    if (index > 0) assert.match(section, new RegExp('needs: ' + jobNames[index - 1]), job + ' waits for the previous task');
    assert.match(section, /steps: (&job-steps|\*job-steps)/);
    assert.match(section, /timeout-minutes: 180/);
    if (index > 0) continue;
    assert.match(section, /node-bundle-controller\.mjs prepare/);
    assert.match(section, /node-bundle-controller\.mjs generate/);
    assert.match(section, /node-bundle-controller\.mjs evaluate/);
    assert.match(section, /node-bundle-controller\.mjs publish/);
    assert.match(section, /node-bundle-batch1-\$\{\{ env\.NODE_BUNDLE_TASK \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(section, /include-hidden-files: true/);
    assert.match(section, /test\/node-bundle-batch\.test\.mjs/);
  }
});
