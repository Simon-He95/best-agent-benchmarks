import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {admitBatchRun, admitFirstTaskProvenance, batchModeTask, validateBatchConfig, resolveBatchTask} from '../scripts/node-bundle-controller.mjs';
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
  assert.equal(batch.priorBatchRuns.length, 5);
  assert.deepEqual(batch.priorBatchRuns.map(run => run.runId), ['34396601488', '34396884605', '34398741179', '34399786029', '34404487703']);
  for (const prior of batch.priorBatchRuns) {
    if (prior.modelAttempt) {
      assert.equal(prior.predictionPresent, true, 'A model-attempt prior must have its frozen prediction');
      assert.equal(prior.officialEvaluation, 'not-evaluated');
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

test('the controller evaluate call passes the batch entry under the evaluation module parameter name', () => {
  // Regression for batch run 34404487703: the evaluation module reads 'entry'; passing
  // 'task' silently fell back to the single-task django identity and the official
  // evaluation rejected the astropy attempt at its first summary assertion.
  const source = fs.readFileSync(path.join(repository, 'scripts/node-bundle-controller.mjs'), 'utf8');
  assert.match(source, /evaluateNodeBundleTask\(\{evidenceDir, manifestPath: path\.join\(evidenceDir, 'official-evaluator-manifest\.json'\), runId, entry: batchTask \? batchTask\.entry : null\}\)/);
  assert.doesNotMatch(source, /evaluateNodeBundleTask\([^)]*\btask: batchTask/);
  const evaluate = fs.readFileSync(path.join(repository, 'scripts/evaluate-node-bundle-one.mjs'), 'utf8');
  assert.match(evaluate, /entry = null/);
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
