import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectFrozenTask} from './node-bundle-task-selection.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const evaluatorPath = fileURLToPath(new URL('./swe-bench-official-evaluator.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});

export async function evaluateNodeBundleTask({evidenceDir, manifestPath, runId, entry = null}) {
  assert.match(runId, /^\d+$/);
  evidenceDir = fs.realpathSync(evidenceDir);
  const candidatePath = path.join(repository, 'config/node-bundle-candidate.json');
  const selectionPath = path.join(repository, 'config/node-bundle-failed-tasks.json');
  const generationPath = path.join(repository, 'config/node-bundle-generation.json');
  const generation = read(generationPath);
  const evaluatorSha256 = generation.officialEvaluatorSha256;
  const baseCandidate = read(candidatePath), selection = read(selectionPath);
  const candidate = entry ? {...baseCandidate, task: entry} : baseCandidate;
  const task = selectFrozenTask(selection, entry), id = task.instanceId;
  assert.equal(candidate.task.instanceId, id);
  assert.equal(candidate.task.baseCommit, task.baseCommit);
  assert.equal(generation.candidateId, candidate.candidateId);
  assert.equal(candidate.diagnosticOnly, true);
  assert.equal(candidate.passAt1, null);
  assert.equal(selection.diagnosticOnly, true);
  assert.equal(selection.passAt1, null);
  assert.equal(candidate.node.version, '24.15.0');
  const claimPath = path.join(evidenceDir, 'evaluation-claim.json');
  const recordPath = path.join(evidenceDir, 'official-record.json');
  const outputDir = path.join(evidenceDir, 'official');
  for (const file of [claimPath, recordPath, outputDir, ...['image-manifest.json', 'evaluation-admission.json', 'evaluation-closure.json', 'evaluation-disposition.json'].map(name => path.join(evidenceDir, name))]) assert(!fs.existsSync(file), 'Existing evaluation evidence prevents rerun');

  const auditPath = path.join(evidenceDir, 'credential-audit.json');
  const audit = read(auditPath);
  assert.equal(audit.safe, true, 'Credential audit must admit the evidence');
  assert(Array.isArray(audit.files));
  const audited = new Map();
  for (const entry of audit.files) {
    assert.equal(typeof entry.path, 'string');
    const file = path.resolve(evidenceDir, entry.path);
    assert.equal(path.relative(evidenceDir, file), entry.path, 'Audit paths must be canonical relative paths');
    assert(!entry.path.startsWith('../') && entry.path !== '..');
    assert(!audited.has(entry.path), 'Duplicate audited file');
    assert.equal(fs.realpathSync(file), file, 'Symlinks are not admitted');
    const stat = fs.lstatSync(file);
    assert(stat.isFile(), 'Audited input must be a regular file');
    assert.equal(stat.size, entry.sizeBytes, 'Audited file size changed: ' + entry.path);
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    assert.equal(digest.digest('hex'), entry.sha256, 'Audited file hash changed: ' + entry.path);
    audited.set(entry.path, entry);
  }
  const auditedRead = relative => {
    assert(audited.has(relative), 'Required input is not credential-audited: ' + relative);
    return read(path.join(evidenceDir, relative));
  };
  const manifestRelative = path.relative(evidenceDir, path.resolve(manifestPath));
  assert(audited.has(manifestRelative), 'Evaluator manifest must be credential-audited');
  assert.equal(hash(fs.readFileSync(manifestPath)), audited.get(manifestRelative).sha256, 'Evaluator manifest changed after audit');
  const summary = auditedRead('terminal/summary.json');
  assert.equal(summary.instanceId, id);
  assert.equal(summary.evaluationBatchId, `remaining63-node-${runId}`);
  assert.equal(summary.attemptId, `${id}-node-${runId}-001`);
  const predictionPath = path.join(evidenceDir, 'terminal/prediction.json');
  assert.equal(summary.predictionPresent, fs.existsSync(predictionPath));
  if (!summary.predictionPresent) {
    const disposition = {instanceId: id, diagnosticOnly: true, passAt1: null, disposition: 'not-evaluated', reason: 'no-prediction'};
    write(path.join(evidenceDir, 'evaluation-disposition.json'), disposition);
    return disposition;
  }
  assert.equal(summary.status, 'completed');
  assert.equal(summary.containerClosed, true);
  assert.equal(summary.containerRemoved, true);
  assert.equal(summary.captureContainerRemoved, true);
  assert.equal(summary.predictionEligible, true);
  assert.equal(summary.process.status, 0);
  const processReceipt = auditedRead('process-receipt.json');
  assert.deepEqual(summary.process, processReceipt);
  assert.equal(processReceipt.status, 0);
  assert.equal(processReceipt.signal, null);
  assert.equal(processReceipt.timedOut, false);
  assert(!processReceipt.error);
  assert.equal(processReceipt.containerClosed, true);
  for (const stream of ['stdout', 'stderr']) {
    assert(audited.has(stream + '.txt'));
    assert.equal(processReceipt[stream + 'Sha256'], audited.get(stream + '.txt').sha256);
  }
  const evidence = auditedRead('terminal/evidence-admission.json');
  for (const record of [summary.evidence, evidence]) {
    assert.equal(record.complete, true);
    assert.equal(record.prefixValid, true);
    assert.equal(record.rootStatus, 'completed');
  }
  const capture = auditedRead('terminal/captured/receipt.json');
  assert(audited.has('terminal/captured/diagnostic.patch'));
  const patch = fs.readFileSync(path.join(evidenceDir, 'terminal/captured/diagnostic.patch'));
  assert.equal(capture.status, 'captured');
  assert.equal(capture.baseCommit, task.baseCommit);
  assert.equal(capture.bytes, patch.length);
  assert.equal(capture.sha256, hash(patch));
  assert(patch.length > 0);
  assert.equal(capture.originalIndexUnchanged, true);
  assert.deepEqual(summary.capture, capture);
  const exports = auditedRead('terminal/exports.json');
  assert.deepEqual(summary.exports, exports);
  assert.deepEqual(exports.map(entry => entry.target).sort(), ['artifacts.tar', 'attempt.jsonl', 'runtime.tar', 'workspace.tar']);
  for (const entry of exports) {
    assert.equal(entry.status, 0);
    assert.equal(entry.signal, null);
    assert.equal(entry.timedOut, false);
    assert(!entry.error);
    assert(audited.has('terminal/' + entry.target));
    assert.equal(entry.sha256, audited.get('terminal/' + entry.target).sha256);
  }
  assert.equal(auditedRead('terminal/workspace-admission.json').passed, true);
  assert(audited.has('terminal/prediction.json'));
  assert.equal(hash(fs.readFileSync(evaluatorPath)), evaluatorSha256, 'Official adapter changed');
  const evaluator = await import('./swe-bench-official-evaluator.mjs');
  const manifest = evaluator.loadOfficialEvaluatorManifest(manifestPath);
  assert.equal(manifest.evaluatorCommit, generation.officialEvaluatorCommit);
  assert.equal(manifest.evaluatorVersion, generation.officialEvaluatorVersion);
  const profile = read(path.join(repository, 'config/swe-bench-verified.json'));
  assert.equal(manifest.dataset.localDatasetJsonlSha256, profile.jsonlSha256);
  assert.equal(manifest.dataset.localDatasetJsonlBytes, profile.jsonlBytes);
  assert.equal(manifest.dataset.selectedInstanceIds.length, profile.taskCount);
  assert(manifest.dataset.selectedInstanceIds.includes(id));
  const prediction = evaluator.readFrozenPrediction(predictionPath);
  assert.equal(prediction.instanceId, id);
  assert.equal(prediction.evaluationBatchId, `remaining63-node-${runId}`);
  assert.equal(prediction.attemptId, `${id}-node-${runId}-001`);
  assert.equal(prediction.modelPatchSha256, capture.sha256);
  assert(Buffer.from(prediction.modelPatch, 'utf8').equals(patch));
  const prepared = auditedRead('official-environment.json');
  assert.equal(prepared.instanceId, id);
  assert.equal(prepared.baseCommit, task.baseCommit);
  assert.equal(prepared.platform, 'linux/amd64');
  assert.match(prepared.imageId, /^sha256:[a-f0-9]{64}$/);
  const [imageRepository, imageDigest] = candidate.task.imageRef.split('@');
  assert.equal(prepared.imageDigest, imageDigest);
  assert.equal(prepared.imageRef, candidate.task.imageRef);
  assert.equal(prepared.bundleSha256, candidate.bundle.sha256);
  assert.equal(summary.containerId, prepared.containerId);
  const admission = auditedRead('model-admission.json');
  const modelClaim = auditedRead('model-claim.json');
  assert.equal(admission.stage, 'model');
  assert.equal(admission.instanceId, id);
  assert.equal(admission.baseCommit, task.baseCommit);
  assert.equal(admission.imageId, prepared.imageId);
  assert.equal(admission.imageRef, prepared.imageRef);
  assert.equal(admission.officialEnvironmentSha256, audited.get('official-environment.json').sha256);
  for (const [key, relative] of [['sanitationSha256', 'sanitation.json'], ['preflightSha256', 'preflight-verification.json'], ['promptSha256', 'launch-prompt.txt']]) {
    assert(audited.has(relative));
    assert.equal(admission[key], audited.get(relative).sha256);
  }
  assert.equal(admission.candidateManifestSha256, hash(fs.readFileSync(candidatePath)));
  assert.equal(admission.generationManifestSha256, hash(fs.readFileSync(generationPath)));
  for (const [key, value] of Object.entries(admission)) assert.deepEqual(modelClaim[key], value);
  assert.equal(modelClaim.runId, runId);
  assert.equal(modelClaim.evaluationBatchId, prediction.evaluationBatchId);
  assert.equal(modelClaim.attemptId, prediction.attemptId);
  assert.equal(modelClaim.attempt, 1);
  assert.equal(modelClaim.diagnosticOnly, true);
  assert.equal(modelClaim.passAt1, null);
  for (const [role, containerId] of [['model', prepared.containerId], ['capture', summary.captureContainerId]]) {
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const prefix = summary[role + 'Absence'];
    assert.equal(prefix, role + '-absence');
    const receipt = auditedRead(prefix + '.process.json');
    assert.deepEqual(receipt.args, ['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + containerId]);
    assert.equal(receipt.status, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.timedOut, false);
    assert(!receipt.error);
    for (const stream of ['stdout', 'stderr']) {
      const relative = prefix + '.' + stream + '.txt';
      assert(audited.has(relative));
      assert.equal(receipt[stream].bytes, audited.get(relative).sizeBytes);
      assert.equal(receipt[stream].sha256, audited.get(relative).sha256);
    }
    assert.equal(receipt.stdout.bytes, 0);
    assert.equal(receipt.stdout.sha256, hash(''));
  }

  const imageManifest = {schemaVersion: 1, evaluationBatchId: prediction.evaluationBatchId, platform: 'linux/amd64', entries: [{instanceId: id, imageRef: imageRepository + ':latest', imageDigest}]};
  const imageManifestPath = path.join(evidenceDir, 'image-manifest.json');
  const grantPath = path.join(evidenceDir, 'evaluation-admission.json');
  const grant = {stage: 'evaluation', instanceId: id, predictionSha256: hash(fs.readFileSync(predictionPath)), imageManifestSha256: hash(JSON.stringify(imageManifest, null, 2) + '\n'), evaluatorModuleSha256: evaluatorSha256, officialEvaluatorManifestSha256: hash(fs.readFileSync(manifestPath)), credentialAuditSha256: hash(fs.readFileSync(auditPath)), candidateManifestSha256: hash(fs.readFileSync(candidatePath)), selectionManifestSha256: hash(fs.readFileSync(selectionPath)), generationConfigSha256: hash(fs.readFileSync(generationPath))};
  const lockPath = path.join(evidenceDir, 'active-operation.lock');
  const claim = {...grant, runId, pid: process.pid, startedAt: new Date().toISOString(), diagnosticOnly: true, passAt1: null};
  write(lockPath, claim);
  let officialEvaluation;
  try {
    write(claimPath, claim);
    write(imageManifestPath, imageManifest);
    write(grantPath, grant);
    fs.mkdirSync(outputDir);
    const options = {predictionPath, manifestPath, imageManifestPath, outputDir};
    try {
      officialEvaluation = await evaluator.evaluateFrozenPrediction(options);
    } catch (error) {
      write(path.join(outputDir, 'evaluation-error.json'), {error: String(error), stack: error.stack});
      officialEvaluation = evaluator.createInfrastructureInconclusive(options);
    }
    evaluator.admitOfficialEvaluationRecord(officialEvaluation);
    write(recordPath, officialEvaluation);
  } finally {
    const officialRunId = evaluator.officialRunIdFor(prediction);
    const containerName = `sweb.eval.${id.toLowerCase()}.${officialRunId}`;
    const exactName = containerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closure = {instanceId: id, officialRunId, containerName, expectedImageId: prepared.imageId, checkedAt: new Date().toISOString(), closed: false, commands: []};
    try {
      const args = ['ps', '-aq', '--no-trunc', '--filter', `name=^/${exactName}$`];
      const listed = spawnSync(manifest.dockerExecutable, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 65536});
      closure.commands.push({executable: manifest.dockerExecutable, args, status: listed.status, signal: listed.signal, stdout: listed.stdout, stderr: listed.stderr, error: listed.error ? String(listed.error) : null});
      assert.equal(listed.error, undefined);
      assert.equal(listed.status, 0);
      const ids = listed.stdout.trim().split('\n').filter(Boolean);
      if (ids.length === 0) {
        closure.closed = true;
        closure.state = 'absent';
      } else {
        assert.equal(ids.length, 1);
        assert.match(ids[0], /^[a-f0-9]{64}$/);
        const args = ['inspect', '--type', 'container', '--format', '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"State":{{json .State}}}', ids[0]];
        const inspected = spawnSync(manifest.dockerExecutable, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 65536});
        closure.commands.push({executable: manifest.dockerExecutable, args, status: inspected.status, signal: inspected.signal, stdout: inspected.stdout, stderr: inspected.stderr, error: inspected.error ? String(inspected.error) : null});
        assert.equal(inspected.error, undefined);
        assert.equal(inspected.status, 0);
        const container = JSON.parse(inspected.stdout);
        assert.equal(container.Id, ids[0]);
        assert.equal(container.Name, '/' + containerName);
        assert.equal(container.Image, prepared.imageId);
        closure.state = container.State;
        closure.closed = container.State.Running === false && container.State.Restarting === false && ['created', 'exited'].includes(container.State.Status);
      }
    } catch (error) {
      closure.error = String(error);
    }
    write(path.join(evidenceDir, 'evaluation-closure.json'), closure);
    assert(closure.closed, 'Official container closure unconfirmed; shared lock and claim retained');
    fs.unlinkSync(lockPath);
  }
  return {instanceId: id, diagnosticOnly: true, passAt1: null, disposition: officialEvaluation.verdict, officialEvaluation};
}
