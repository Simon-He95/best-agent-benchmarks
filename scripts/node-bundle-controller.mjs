import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runRecordedStep, verifyCandidate} from './swe-node-bundle-preflight.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = read(path.join(repository, 'config/node-bundle-candidate.json'));
const generation = read(path.join(repository, 'config/node-bundle-generation.json'));
const singleTaskWorkflow = 'node-bundle-one.yml';
const batchWorkflow = 'node-bundle-batch.yml';

export function validateBatchConfig(batch, selectionBytes) {
  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.candidateId, candidate.candidateId);
  assert.equal(batch.selectionId, 'remaining63-node-bundle-20260909');
  assert.equal(hash(selectionBytes), batch.selectionSourceSha256, 'Frozen failed-task selection changed');
  assert.equal(batch.diagnosticOnly, true);
  assert.equal(batch.passAt1, null);
  assert(Array.isArray(batch.priorBatchRuns));
  assert.equal(batch.tasks.length, 5, 'Hosted generation batches stay at five tasks');
  const seen = new Set();
  for (const entry of batch.tasks) {
    assert(Number.isInteger(entry.taskIndex) && entry.taskIndex >= 1 && entry.taskIndex <= 62);
    assert(!seen.has(entry.instanceId), 'Duplicate batch task');
    seen.add(entry.instanceId);
    assert.equal(entry.pythonModule, 'astropy', 'Batch 1 is the astropy block of the frozen selection');
    assert.equal(entry.pythonSource, '/testbed/astropy/__init__.py');
    const plan = entry.sanitationPlan;
    assert(plan && plan.mode === 'as-shipped' && Array.isArray(plan.removals) && plan.removals.length > 0 && plan.removals.every(name => name && !name.includes('/') && !name.startsWith('.')) && (plan.installedEggPath === null || typeof plan.installedEggPath === 'string'), 'Batch tasks need a valid as-shipped sanitation plan');
  }
  const provenance = batch.firstTaskProvenance;
  assert.equal(provenance.instanceId, 'django__django-10097');
  assert.equal(provenance.verdict, 'test-failed');
  assert.equal(provenance.officialResolved, false);
  const modelPriors = batch.priorBatchRuns.filter(item => item.modelAttempt === true);
  assert(modelPriors.length <= 1, 'At most one consumed model attempt is admitted');
  for (const prior of modelPriors) {
    assert.equal(prior.predictionPresent, true, 'A consumed model attempt must have its frozen prediction');
    assert.equal(prior.officialEvaluation, 'not-evaluated');
    assert(batch.tasks.some(task => task.instanceId === prior.instanceId), 'A consumed model attempt must belong to a frozen batch task');
    assert.equal(prior.attemptId, `${prior.instanceId}-node-${prior.runId}-001`, 'Frozen attempt identity mismatch');
    assert.match(prior.predictionFileSha256, /^[a-f0-9]{64}$/);
    assert.match(prior.patchSha256, /^[a-f0-9]{64}$/);
    assert(Number.isInteger(prior.patchBytes) && prior.patchBytes > 0);
    assert(Number.isInteger(prior.artifactId) && prior.artifactId > 0);
    assert.equal(prior.artifactName, `node-bundle-batch1-${prior.instanceId}-${prior.runId}-1`);
    assert(Number.isInteger(prior.artifactManifestFiles) && prior.artifactManifestFiles > 0);
  }
  return batch;
}

export function frozenPredictionPrior(batch, entry) {
  const prior = (batch.priorBatchRuns ?? []).find(item => item.modelAttempt === true);
  if (!prior || prior.instanceId !== entry.instanceId) return null;
  return prior;
}

// The downloaded frozen artifact is verified byte-for-byte against its own
// upload-manifest and against the frozen prior-run declaration before any file
// is admitted into the fresh evidence directory. Nothing here is trusted on
// presence alone; every check fails closed.
export function verifyFrozenArtifact(stagingDir, prior) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stagingDir, 'upload-manifest.json'), 'utf8'));
  assert.equal(manifest.safe, true, 'The frozen artifact manifest is not marked safe');
  assert(Array.isArray(manifest.files));
  assert.equal(manifest.files.length, prior.artifactManifestFiles, 'Frozen artifact file count changed');
  for (const entry of manifest.files) {
    assert.equal(typeof entry.path, 'string');
    assert(!path.isAbsolute(entry.path) && !entry.path.split('/').includes('..'), 'Frozen manifest path is not canonical: ' + entry.path);
    const file = path.join(stagingDir, entry.path);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Frozen artifact entry is not a regular file: ' + entry.path);
    assert.equal(stat.size, entry.sizeBytes, 'Frozen artifact size changed: ' + entry.path);
    assert.equal(fileHash(file), entry.sha256, 'Frozen artifact hash changed: ' + entry.path);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(stagingDir, 'terminal/summary.json'), 'utf8'));
  const predictionPath = path.join(stagingDir, 'terminal/prediction.json');
  const prediction = JSON.parse(fs.readFileSync(predictionPath, 'utf8'));
  const capture = JSON.parse(fs.readFileSync(path.join(stagingDir, 'terminal/captured/receipt.json'), 'utf8'));
  assert.equal(summary.instanceId, prior.instanceId);
  assert.equal(summary.attemptId, prior.attemptId);
  assert.equal(summary.evaluationBatchId, `remaining63-node-${prior.runId}`);
  assert.equal(summary.predictionPresent, true);
  assert.equal(prediction.instanceId, prior.instanceId);
  assert.equal(prediction.attemptId, prior.attemptId);
  assert.equal(prediction.evaluationBatchId, `remaining63-node-${prior.runId}`);
  assert.equal(fileHash(predictionPath), prior.predictionFileSha256, 'Frozen prediction file hash changed');
  assert.equal(capture.sha256, prior.patchSha256, 'Frozen patch hash changed');
  assert.equal(capture.bytes, prior.patchBytes, 'Frozen patch byte count changed');
  return {manifestFilesVerified: manifest.files.length};
}

// Fresh prepare already owns the current run's admission/preparation evidence;
// the frozen artifact's own copies of those files must not enter the merged
// evidence directory. Any collision fails closed instead of overwriting.
const frozenRootExclusions = ['run-claim.json', 'hosted-run-admission.json', 'single-task-run-history.json', 'controller-prepared.json', 'official-evaluator-manifest.json', 'download-receipt.json', 'credential-audit.json', 'upload-manifest.json'];
const frozenRootExcludedDirs = ['control-files'];
const frozenExcludedRootFile = relative => /^pre-model-run-\d+\.json$/.test(relative) || frozenRootExclusions.includes(relative);

export function copyFrozenEvidence(stagingDir, evidenceDir) {
  const files = [];
  const walk = dir => {
    for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
      const relative = path.relative(stagingDir, path.join(dir, item.name));
      assert(!relative.startsWith('..'), 'Frozen artifact traversal: ' + relative);
      if (item.isDirectory()) {
        if (frozenRootExcludedDirs.includes(item.name) && path.dirname(relative) === '.') continue;
        walk(path.join(dir, item.name));
        continue;
      }
      assert(item.isFile(), 'Frozen artifact contains a non-regular file: ' + relative);
      if (path.dirname(relative) === '.' && frozenExcludedRootFile(relative)) continue;
      files.push(relative);
    }
  };
  walk(stagingDir);
  let bytes = 0;
  for (const relative of files) {
    const destination = path.join(evidenceDir, relative);
    assert(!fs.existsSync(destination), 'Recovery would overwrite existing evidence: ' + relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(stagingDir, relative), destination, fs.constants.COPYFILE_EXCL);
    assert.equal(fileHash(destination), fileHash(path.join(stagingDir, relative)), 'Frozen evidence changed during recovery copy: ' + relative);
    bytes += fs.statSync(destination).size;
  }
  return {filesCopied: files.length, bytesCopied: bytes, excludedRootNames: frozenRootExclusions.concat(frozenRootExcludedDirs)};
}

export function resolveBatchTask(batch, selection, instanceId) {
  const entry = batch.tasks.find(item => item.instanceId === instanceId);
  assert(entry, 'Selected task is not part of the frozen batch');
  const frozen = selection.tasks[entry.taskIndex];
  assert.equal(frozen.instanceId, entry.instanceId, 'Batch task left the frozen selection order');
  assert.equal(frozen.baseCommit, entry.baseCommit);
  assert.equal(frozen.promptSha256, entry.promptSha256);
  assert.equal(frozen.priorDisposition, entry.priorDisposition);
  return entry;
}

export function admitBatchRun(runs, runId, batch, jobsByRun = {}) {
  assert(runs.some(run => String(run.id) === String(runId)), 'Current hosted run must be visible');
  const declarations = batch.priorBatchRuns ?? [];
  const declared = new Set(declarations.map(item => String(item.runId)));
  for (const previous of runs.filter(run => String(run.id) !== String(runId))) {
    assert.notEqual(previous.conclusion, 'success', 'A completed successful batch run forbids any further dispatch');
    const declaration = declarations.find(item => item.runId === String(previous.id));
    assert(declaration, 'A prior batch run is not declared; no new batch dispatch');
    assert.equal(previous.head_sha, declaration.headSha);
    assert.equal(previous.status, 'completed');
    assert.equal(previous.conclusion, 'failure');
    assert.equal(previous.run_attempt, 1);
    const jobs = jobsByRun[declaration.runId]?.jobs;
    assert(Array.isArray(jobs) && jobs.length === 5, 'The declared batch run must show all five jobs');
    for (const job of jobs) {
      if (job.id !== declaration.jobId) {
        assert.equal(job.conclusion, 'skipped', 'A non-declared job of a prior batch run executed');
        continue;
      }
      assert.equal(job.conclusion, 'failure');
      const required = [[declaration.failedStep, 'failure'], ...declaration.skippedSteps.map(name => [name, 'skipped'])];
      for (const [name, conclusion] of required) {
        const matches = job.steps.filter(step => step.name === name);
        assert.equal(matches.length, 1, 'Declared step not found exactly once: ' + name);
        assert.equal(matches[0].conclusion, conclusion, 'Declared step changed conclusion: ' + name);
      }
    }
  }
}

export function admitFirstTaskProvenance(recoveryRuns, generationRuns, batch) {
  const provenance = batch.firstTaskProvenance;
  const recovery = recoveryRuns.find(run => String(run.id) === provenance.recoveryRunId);
  assert(recovery, 'The frozen first-task recovery run is not visible; batch is not admitted');
  assert.equal(recovery.head_sha, provenance.recoveryHeadSha);
  assert.equal(recovery.status, 'completed');
  assert.equal(recovery.conclusion, 'success');
  assert.equal(recovery.run_attempt, 1);
  const generation = generationRuns.find(run => String(run.id) === provenance.generationRunId);
  assert(generation, 'The frozen first-task generation run is not visible; batch is not admitted');
  assert.equal(generation.status, 'completed');
  assert.equal(generation.run_attempt, 1);
}


export function validateRun(runId, environment = process.env) {
  assert.match(runId, /^[1-9][0-9]*$/);
  assert.equal(environment.GITHUB_RUN_ID, runId);
  assert.equal(environment.GITHUB_RUN_ATTEMPT, '1', 'Workflow reruns are not model retries');
  assert.equal(environment.GITHUB_REPOSITORY, 'Simon-He95/best-agent-benchmarks');
  assert.equal(environment.GITHUB_REF, 'refs/heads/master');
}

export function admitFirstRun(runs, runId, preModelRuns = [], jobsByRun = {}) {
  assert(runs.some(run => String(run.id) === runId), 'Current hosted run must be visible');
  for (const previous of runs.filter(run => String(run.id) !== runId)) {
    const declaration = preModelRuns.find(item => item.runId === String(previous.id));
    assert(declaration, 'A prior workflow run has no frozen pre-model evidence; no new attempt');
    assert.equal(previous.head_sha, declaration.headSha);
    assert.equal(previous.status, 'completed');
    assert.equal(previous.conclusion, 'failure');
    assert.equal(previous.run_attempt, 1);
    const jobs = jobsByRun[declaration.runId]?.jobs;
    assert.equal(jobs?.length, 1);
    assert.equal(jobs[0].id, declaration.jobId);
    assert.equal(jobs[0].status, 'completed');
    assert.equal(jobs[0].conclusion, 'failure');
    for (const [name, conclusion] of [[declaration.failedStep, 'failure'], ...declaration.skippedSteps.map(name => [name, 'skipped'])]) {
      const matches = jobs[0].steps.filter(step => step.name === name);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].status, 'completed');
      assert.equal(matches[0].conclusion, conclusion, 'Prior model/evaluator execution prevents recovery');
    }
  }
}

function fileHash(filename) {
  const fd = fs.openSync(filename, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

export function auditEvidence(evidenceDir, secret) {
  assert(secret, 'Actual provider credential is required for evidence audit');
  const result = spawnSync('python3', [path.join(repository, 'scripts/audit-node-bundle-evidence.py'), evidenceDir], {
    input: JSON.stringify({secrets: [secret]}), encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8'},
  });
  assert.equal(result.error, undefined, 'Evidence audit process did not close');
  assert.equal(result.signal, null, 'Evidence audit was interrupted');
  const record = JSON.parse(result.stdout);
  if (result.status !== 0 || record.safe !== true) {
    const error = new Error('Raw evidence is unsafe or unverifiable; upload withheld');
    error.audit = record;
    throw error;
  }
  return {...record, checkedAt: new Date().toISOString(), scannerSha256: fileHash(path.join(repository, 'scripts/audit-node-bundle-evidence.py'))};
}

export function copyAuditedEvidence(evidenceDir, uploadDir, audit) {
  assert.equal(audit.safe, true);
  fs.mkdirSync(uploadDir);
  for (const entry of audit.files) {
    assert(!path.isAbsolute(entry.path) && !entry.path.split('/').includes('..'));
    const source = path.join(evidenceDir, entry.path);
    const info = fs.lstatSync(source);
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, entry.sizeBytes);
    assert.equal(fileHash(source), entry.sha256, 'Audited evidence changed before upload');
    const destination = path.join(uploadDir, entry.path);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    assert.equal(fileHash(destination), entry.sha256);
  }
  write(path.join(uploadDir, 'upload-manifest.json'), audit);
}

async function prepare(candidateDir, evidenceDir, runId, batchTask = null) {
  fs.mkdirSync(evidenceDir);
  write(path.join(evidenceDir, 'run-claim.json'), {runId, runAttempt: 1, candidateId: candidate.candidateId, instanceId: batchTask ? batchTask.entry.instanceId : candidate.task.instanceId, modelAttempt: false, diagnosticOnly: true, passAt1: null, at: new Date().toISOString()});
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.15.0');
  verifyCandidate(candidate, candidateDir, batchTask ? batchTask.entry : candidate.task);
  assert.equal(fileHash(process.execPath), candidate.node.binarySha256);
  const workflowName = batchTask ? batchWorkflow : singleTaskWorkflow;
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${workflowName}/runs?per_page=100`, {
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Unable to verify previous hosted runs');
  const runs = (await response.json()).workflow_runs;
  write(path.join(evidenceDir, 'hosted-run-admission.json'), {runId, workflow: workflowName, runs: runs.map(run => ({id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion}))});
  if (batchTask) {
    const recoveryResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/node-bundle-capture-recovery.yml/runs?per_page=100`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
    });
    assert(recoveryResponse.ok, 'Unable to verify the frozen first-task recovery run');
    const recoveryRuns = (await recoveryResponse.json()).workflow_runs;
    const singleResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${singleTaskWorkflow}/runs?per_page=100`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
    });
    assert(singleResponse.ok, 'Unable to verify the frozen single-task history');
    const singleRuns = (await singleResponse.json()).workflow_runs;
    write(path.join(evidenceDir, 'single-task-run-history.json'), {recoveryRuns: recoveryRuns.map(run => ({id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion})), generationRuns: singleRuns.map(run => ({id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion}))});
    admitFirstTaskProvenance(recoveryRuns, singleRuns, batchTask.batch);
  }
  const jobsByRun = {};
  const priorDeclarations = batchTask ? batchTask.batch.priorBatchRuns ?? [] : generation.preModelRuns ?? [];
  for (const previous of runs.filter(run => String(run.id) !== runId)) {
    if (!priorDeclarations.some(item => item.runId === String(previous.id))) continue;
    const jobResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${previous.id}/jobs?per_page=100`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
    });
    assert(jobResponse.ok, 'Cannot verify the frozen prior pre-model failure');
    jobsByRun[String(previous.id)] = await jobResponse.json();
    write(path.join(evidenceDir, 'pre-model-run-' + previous.id + '.json'), {run: previous, jobs: jobsByRun[String(previous.id)]});
  }
  if (batchTask) admitBatchRun(runs, runId, batchTask.batch, jobsByRun);
  else admitFirstRun(runs, runId, generation.preModelRuns, jobsByRun);
  const step = (name, args, timeout = 60_000) => runRecordedStep(evidenceDir, name, args, timeout);
  const controls = ['config/node-bundle-candidate.json', 'config/node-bundle-generation.json', 'config/node-bundle-failed-tasks.json', 'config/swe-bench-verified.json', '.github/workflows/node-bundle-one.yml', 'scripts/node-bundle-controller.mjs', 'scripts/audit-node-bundle-evidence.py', 'scripts/generate-node-bundle-one.mjs', 'scripts/node-bundle-sanitize.mjs', 'scripts/node-bundle-capture.mjs', 'scripts/evaluate-node-bundle-one.mjs', 'scripts/node-bundle-probe.mjs', 'scripts/swe-bench-harness.mjs', 'scripts/swe-bench-official-evaluator.mjs', 'scripts/prepare-swe-bench.mjs', 'scripts/materialize-ci-provider.mjs'];
  if (batchTask) controls.push('config/node-bundle-batch-1.json', '.github/workflows/node-bundle-batch.yml');
  const controlFiles = controls.map(name => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const output = path.join(evidenceDir, 'control-files', name);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, bytes, {flag: 'wx'});
    return {path: name, sha256: hash(bytes), sizeBytes: bytes.length};
  });
  fs.copyFileSync(path.join(candidateDir, 'download-receipt.json'), path.join(evidenceDir, 'download-receipt.json'), fs.constants.COPYFILE_EXCL);
  write(path.join(evidenceDir, 'execution-control.json'), {runId, workflowHead: process.env.GITHUB_SHA, candidateId: candidate.candidateId, ...(batchTask ? {batchId: batchTask.batch.batchId, taskIndex: batchTask.entry.taskIndex, instanceId: batchTask.entry.instanceId} : {instanceId: candidate.task.instanceId}), controlFiles, provider: generation.provider, modelWatchdogMs: generation.externalWatchdogMs, diagnosticOnly: true, passAt1: null, closedBook: false});

  const source = path.join(repository, 'tools/swe-bench-source');
  assert.equal((await step('evaluator-source-head', ['git', '-C', source, 'rev-parse', 'HEAD'])).stdout.trim(), generation.officialEvaluatorCommit);
  assert.equal((await step('evaluator-source-clean', ['git', '-C', source, 'status', '--porcelain'])).stdout.trim(), '');
  assert.equal((await step('host-python-version', ['python3', '-c', 'import platform; print(platform.python_version())'])).stdout.trim(), generation.hostPythonVersion);
  const privateRoot = path.join(path.dirname(evidenceDir), 'node-bundle-private-' + runId);
  fs.mkdirSync(privateRoot, {mode: 0o700});
  const venv = path.join(privateRoot, 'evaluator-venv');
  await step('evaluator-venv', ['python3', '-m', 'venv', venv]);
  const python = path.join(venv, 'bin/python');
  await step('evaluator-install', [python, '-m', 'pip', 'install', '--disable-pip-version-check', '--retries', '0', source], 900_000);
  await step('evaluator-freeze', [python, '-m', 'pip', 'freeze']);
  const check = 'import sys; sys.path.insert(0,sys.argv[1]); import swebench,docker,datasets,json; print(json.dumps(dict(version=swebench.__version__,source=swebench.__file__)))';
  const imports = JSON.parse((await step('evaluator-imports', [python, '-s', '-c', check, source])).stdout);
  assert.equal(imports.version, generation.officialEvaluatorVersion);
  assert(imports.source.startsWith(source + '/'));
  await step('evaluator-prepare', [process.execPath, path.join(repository, 'scripts/prepare-swe-bench.mjs'), '--evaluator-source', source, '--evaluator-python', python, '--corpus', path.join(privateRoot, 'corpus.jsonl'), '--manifest', path.join(evidenceDir, 'official-evaluator-manifest.json')], 900_000);
  write(path.join(evidenceDir, 'controller-prepared.json'), {runId, privateRoot, corpusPath: path.join(privateRoot, 'corpus.jsonl'), providerPath: path.join(privateRoot, 'provider/provider.json'), manifestPath: path.join(evidenceDir, 'official-evaluator-manifest.json'), modelAttempt: false});
}

async function generateEvalOnlyRecovery(evidenceDir, runId, prior, secret) {
  // Exactly one model attempt for this task already exists in the frozen prior
  // run and its prediction is frozen. This run must not invoke the model again;
  // it recovers the frozen prediction evidence and completes the interrupted
  // official evaluation of the same attempt.
  assert.equal(prior.predictionPresent, true);
  assert.equal(prior.officialEvaluation, 'not-evaluated');
  for (const name of ['evaluation-claim.json', 'official-record.json', 'image-manifest.json', 'evaluation-admission.json', 'evaluation-closure.json', 'evaluation-disposition.json']) {
    assert(!fs.existsSync(path.join(evidenceDir, name)), 'Existing evaluation evidence prevents recovery: ' + name);
  }
  assert(!fs.existsSync(path.join(evidenceDir, 'official')), 'Existing official output prevents recovery');
  assert(!fs.existsSync(path.join(evidenceDir, 'terminal')), 'Frozen terminal evidence is already present; recovery would overwrite');
  const staging = evidenceDir + '-frozen-artifact';
  fs.rmSync(staging, {recursive: true, force: true});
  const step = (name, args, timeout = 60_000) => runRecordedStep(evidenceDir, name, args, timeout);
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${prior.artifactId}`, {
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Unable to verify the frozen artifact metadata');
  const metadata = await response.json();
  assert.equal(metadata.id, prior.artifactId);
  assert.equal(metadata.name, prior.artifactName);
  assert.equal(metadata.expired, false, 'The frozen artifact expired; prediction evidence cannot be recovered');
  assert.equal(metadata.workflow_run?.id, Number(prior.runId));
  assert.equal(metadata.workflow_run?.head_sha, prior.headSha);
  write(path.join(evidenceDir, 'frozen-artifact-metadata.json'), {runId, frozenRunId: prior.runId, artifactId: metadata.id, name: metadata.name, sizeBytes: metadata.size_in_bytes, expired: metadata.expired, createdAt: metadata.created_at, workflowRunId: metadata.workflow_run?.id, headSha: metadata.workflow_run?.head_sha});
  await step('frozen-artifact-download', ['gh', 'run', 'download', String(prior.runId), '--repo', process.env.GITHUB_REPOSITORY, '--name', prior.artifactName, '--dir', staging], 600_000);
  const verification = verifyFrozenArtifact(staging, prior);
  const copied = copyFrozenEvidence(staging, evidenceDir);
  write(path.join(evidenceDir, 'frozen-recovery.json'), {runId, frozenRunId: prior.runId, instanceId: prior.instanceId, attemptId: prior.attemptId, patchSha256: prior.patchSha256, predictionFileSha256: prior.predictionFileSha256, artifactId: prior.artifactId, artifactName: prior.artifactName, manifestFilesVerified: verification.manifestFilesVerified, filesCopied: copied.filesCopied, bytesCopied: copied.bytesCopied, excludedRootNames: copied.excludedRootNames, modelAttempt: false, diagnosticOnly: true, passAt1: null, at: new Date().toISOString()});
  const audit = auditEvidence(evidenceDir, secret);
  assert.equal(audit.safe, true);
  write(path.join(evidenceDir, 'credential-audit.json'), audit);
}

async function generate(candidateDir, evidenceDir, runId, batchTask = null) {
  const prepared = read(path.join(evidenceDir, 'controller-prepared.json'));
  assert.equal(prepared.runId, runId);
  const secret = process.env.BENCHMARK_PROVIDER_API_KEY;
  assert(secret, 'BENCHMARK_PROVIDER_API_KEY is required');
  const prior = batchTask ? frozenPredictionPrior(batchTask.batch, batchTask.entry) : null;
  if (prior) {
    await generateEvalOnlyRecovery(evidenceDir, runId, prior, secret);
    return;
  }
  const providerRoot = path.dirname(prepared.providerPath);
  let failure;
  try {
    await runRecordedStep(evidenceDir, 'provider-materialize', [process.execPath, path.join(repository, 'scripts/materialize-ci-provider.mjs'), providerRoot, path.join(prepared.privateRoot, 'provider-env.txt'), path.join(repository, 'config/node-bundle-generation.json')], 60_000);
    delete process.env.BENCHMARK_PROVIDER_API_KEY;
    const {generateNodeBundleTask} = await import('./generate-node-bundle-one.mjs');
    const summary = await generateNodeBundleTask({candidateDir, evidenceDir, corpusPath: prepared.corpusPath, providerPath: prepared.providerPath, runId, task: batchTask ? batchTask.entry : null});
    if (summary.status !== 'completed' || !summary.containerClosed || !summary.containerRemoved || !summary.captureContainerRemoved || summary.process?.status !== 0 || summary.process?.timedOut || !summary.evidence?.complete) {
      write(path.join(evidenceDir, 'evaluation-disposition.json'), {instanceId: batchTask ? batchTask.entry.instanceId : candidate.task.instanceId, diagnosticOnly: true, passAt1: null, disposition: 'not-evaluated', reason: 'generation-incomplete'});
      throw new Error('Generation did not complete; official evaluation is not admitted');
    }
  } catch (error) { failure = error; }
  finally {
    fs.rmSync(providerRoot, {recursive: true, force: true});
    fs.rmSync(path.join(prepared.privateRoot, 'provider-env.txt'), {force: true});
    const audit = auditEvidence(evidenceDir, secret);
    write(path.join(evidenceDir, 'credential-audit.json'), audit);
  }
  if (failure) throw failure;
}

export function batchModeTask() {
  const instanceId = process.env.NODE_BUNDLE_TASK;
  if (!instanceId) return null;
  const batchBytes = fs.readFileSync(path.join(repository, 'config/node-bundle-batch-1.json'));
  const selectionBytes = fs.readFileSync(path.join(repository, 'config/node-bundle-failed-tasks.json'));
  const batch = validateBatchConfig(JSON.parse(batchBytes), selectionBytes);
  const selection = JSON.parse(selectionBytes);
  return {batch, entry: resolveBatchTask(batch, selection, instanceId)};
}

export async function controller(mode, candidateDir, evidenceDir, runId) {
  validateRun(runId);
  candidateDir = path.resolve(candidateDir);
  evidenceDir = path.resolve(evidenceDir);
  assert.equal(candidate.candidateId, generation.candidateId);
  assert.equal(generation.diagnosticOnly, true);
  assert.equal(generation.passAt1, null);
  assert.equal(process.version, 'v24.15.0');
  assert.equal(fileHash(process.execPath), candidate.node.binarySha256);
  const batchTask = batchModeTask();
  if (mode === 'prepare') return prepare(candidateDir, evidenceDir, runId, batchTask);
  if (mode === 'generate') return generate(candidateDir, evidenceDir, runId, batchTask);
  if (mode === 'evaluate') {
    assert(!process.env.BENCHMARK_PROVIDER_API_KEY && !process.env.BEST_AGENT_SOURCE_TOKEN);
    const {evaluateNodeBundleTask} = await import('./evaluate-node-bundle-one.mjs');
    // For a task whose single model attempt is frozen in a prior run, every
    // evaluation identity assertion (summary attemptId, model-claim runId,
    // prediction batch) binds to that frozen generation run, not to the
    // infrastructure-only recovery run executing the evaluation.
    const prior = batchTask ? frozenPredictionPrior(batchTask.batch, batchTask.entry) : null;
    return evaluateNodeBundleTask({evidenceDir, manifestPath: path.join(evidenceDir, 'official-evaluator-manifest.json'), runId: prior ? prior.runId : runId, entry: batchTask ? batchTask.entry : null});
  }
  if (mode === 'publish') {
    const uploadDir = evidenceDir + '-upload';
    try {
      const audit = auditEvidence(evidenceDir, process.env.BENCHMARK_PROVIDER_API_KEY);
      copyAuditedEvidence(evidenceDir, uploadDir, audit);
    } catch (error) {
      // Withhold the entire raw upload if it cannot be proven safe, including partial copies.
      fs.rmSync(uploadDir, {recursive: true, force: true});
      fs.mkdirSync(uploadDir);
      write(path.join(uploadDir, 'upload-blocked.json'), {runId, safe: false, rawEvidenceUploaded: false, reason: 'credential-or-unverifiable-evidence', audit: error.audit ?? null});
      throw new Error('Raw upload withheld; only credential-free failure receipt is publishable');
    }
    return;
  }
  throw new Error('Unknown controller mode');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, candidateDir, evidenceDir, runId] = process.argv.slice(2);
  controller(mode, candidateDir, evidenceDir, runId).catch(error => {
    if (evidenceDir && fs.existsSync(evidenceDir) && mode !== 'publish') {
      write(path.join(evidenceDir, 'controller-' + mode + '-failure.json'), {stage: mode, error: String(error), stack: error.stack});
    }
    if (mode === 'publish' && evidenceDir) {
      // Even an entry-level failure must leave a credential-free upload receipt,
      // otherwise the failed stage is undiagnosable after the runner is reclaimed.
      try {
        const uploadDir = evidenceDir + '-upload';
        const receipt = path.join(uploadDir, 'upload-blocked.json');
        if (!fs.existsSync(receipt)) {
          fs.rmSync(uploadDir, {recursive: true, force: true});
          fs.mkdirSync(uploadDir);
          fs.writeFileSync(receipt, JSON.stringify({runId, safe: false, rawEvidenceUploaded: false, reason: 'controller-entry-failure', error: String(error), audit: error.audit ?? null}, null, 2) + '\n');
        }
      } catch {}
    }
    // Detailed process evidence stays in the audit-gated directory, never in the CI console.
    console.error(`Node bundle ${mode} did not complete; inspect audited evidence for the stage.`);
    process.exitCode = 1;
  });
}
