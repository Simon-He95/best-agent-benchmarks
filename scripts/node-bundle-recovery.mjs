import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runRecordedStep} from './swe-node-bundle-preflight.mjs';
import {auditEvidence, copyAuditedEvidence, validateRun} from './node-bundle-controller.mjs';
import {recordGenerationProcess, captureExec, modelRemovalSafe, predictionEligible} from './generate-node-bundle-one.mjs';
import {inspectAttemptEvidence} from './swe-bench-harness.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidate = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json')));
const generation = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-generation.json')));
const node = '/opt/agent/node/bin/node';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fileHash(filename) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(filename, 'r');
  try { let length; while ((length = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

export function readRecoveryConfig(candidateManifest = candidate, generationManifest = generation) {
  const recovery = readJson(path.join(repository, 'config/node-bundle-recovery.json'));
  assert.equal(recovery.schemaVersion, 1);
  assert.equal(recovery.diagnosticOnly, true);
  assert.equal(recovery.passAt1, null);
  assert.equal(recovery.candidateId, candidateManifest.candidateId);
  assert.equal(recovery.candidateId, generationManifest.candidateId);
  assert.equal(recovery.attempt.instanceId, candidateManifest.task.instanceId);
  assert.equal(recovery.attempt.baseCommit, candidateManifest.task.baseCommit);
  assert.equal(recovery.attempt.imageRef, candidateManifest.task.imageRef);
  assert.equal(recovery.attempt.attemptId, candidateManifest.task.instanceId + '-node-' + recovery.source.runId + '-001');
  assert.equal(recovery.attempt.evaluationBatchId, 'remaining63-node-' + recovery.source.runId);
  assert.equal(recovery.source.modelAttempt, true, 'Recovery only applies to a run whose single model attempt executed');
  assert.equal(recovery.source.predictionPresent, false, 'A frozen prediction already exists; recovery is not admission');
  assert.equal(recovery.source.officialEvaluation, 'not-evaluated');
  assert.equal(recovery.expected.candidateConfigSha256, hash(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json'))), 'The candidate manifest changed since the frozen recovery declaration');
  for (const [relative, entry] of Object.entries(recovery.evidence)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Recovery evidence paths must be relative');
    assert.equal(typeof entry.sizeBytes, 'number');
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  return recovery;
}

// The frozen source attempt plus the two preserved pre-model failures must be the
// complete population of node-bundle-one.yml runs, and recovery is single-dispatch.
export function admitRecoveryRun(oneRuns, recoveryRuns, runId, preModelRuns, source, jobsByRun) {
  assert(recoveryRuns.every(run => String(run.id) === String(runId)), 'A prior recovery run already exists; recovery is single-dispatch');
  assert(Array.isArray(oneRuns) && oneRuns.length === preModelRuns.length + 1, 'node-bundle-one.yml has runs beyond the frozen declarations; no recovery admission');
  const declarations = [...preModelRuns, source];
  for (const run of oneRuns) {
    const declaration = declarations.find(item => item.runId === String(run.id));
    assert(declaration, 'node-bundle-one.yml run ' + run.id + ' is not declared; no recovery admission');
    assert.equal(run.head_sha, declaration.headSha);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'failure');
    assert.equal(run.run_attempt, 1);
    const jobs = jobsByRun[declaration.runId]?.jobs;
    assert.equal(jobs?.length, 1, 'The declared run must have exactly one job');
    assert.equal(jobs[0].id, declaration.jobId);
    assert.equal(jobs[0].status, 'completed');
    assert.equal(jobs[0].conclusion, 'failure');
    const required = [[declaration.failedStep, 'failure'], ...declaration.skippedSteps.map(name => [name, 'skipped']), ...(declaration.succeededSteps ?? []).map(name => [name, 'success'])];
    for (const [name, conclusion] of required) {
      const matches = jobs[0].steps.filter(step => step.name === name);
      assert.equal(matches.length, 1, 'Declared step not found exactly once: ' + name);
      assert.equal(matches[0].conclusion, conclusion, 'Declared step changed conclusion: ' + name);
    }
  }
  assert.equal(source.modelAttempt, true, 'Recovery admission requires the executed model attempt');
  assert.equal(source.predictionPresent, false, 'A frozen prediction already exists; recovery is not admission');
  return declarations.map(item => item.runId);
}

export function verifyFrozenSource(sourceDir, recovery, inspectAttempt = inspectAttemptEvidence) {
  for (const [relative, expected] of Object.entries(recovery.evidence)) {
    const file = path.join(sourceDir, relative);
    const info = fs.lstatSync(file);
    assert(info.isFile() && !info.isSymbolicLink(), 'Source evidence must be a regular file: ' + relative);
    assert.equal(info.size, expected.sizeBytes, 'Source size changed: ' + relative);
    assert.equal(fileHash(file), expected.sha256, 'Source hash changed: ' + relative);
  }
  const source = relative => readJson(path.join(sourceDir, relative));
  const summary = source('terminal/summary.json');
  assert.equal(summary.instanceId, recovery.attempt.instanceId);
  assert.equal(summary.attemptId, recovery.attempt.attemptId);
  assert.equal(summary.evaluationBatchId, recovery.attempt.evaluationBatchId);
  assert.equal(summary.stage, 'capture');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.modelAttempt, true);
  assert.equal(summary.predictionPresent, false);
  assert.equal(summary.predictionEligible, false);
  assert.equal(summary.containerClosed, true);
  assert.equal(summary.containerRemoved, true);
  assert.equal(summary.captureContainerRemoved, true);
  assert.equal(summary.containerId, recovery.attempt.containerId);
  assert.match(summary.captureContainerId, /^[a-f0-9]{64}$/);
  assert.equal(summary.modelAbsence, 'model-absence');
  assert.equal(summary.process.status, 0);
  assert.equal(summary.process.signal, null);
  assert.equal(summary.process.timedOut, false);
  assert.deepEqual(summary.evidence, {prefixValid: true, complete: true, reason: 'complete', rootStatus: 'completed', rootTerminalCause: 'completed'});
  assert.equal(summary.exports.length, 4);
  for (const entry of summary.exports) {
    assert.equal(entry.status, 0); assert.equal(entry.signal, null); assert.equal(entry.timedOut, false);
    assert.equal(entry.sha256, fileHash(path.join(sourceDir, 'terminal', entry.target)), 'Terminal export hash changed: ' + entry.target);
  }
  const attempt = inspectAttempt(path.join(sourceDir, 'terminal/attempt.jsonl'));
  assert.equal(attempt.prefixValid, true, 'Frozen attempt evidence prefix is not intact');
  assert.equal(attempt.complete, true, 'Frozen attempt evidence is not complete');
  assert.equal(attempt.rootStatus, 'completed', 'Frozen attempt did not complete');
  const generationClaim = source('generation-claim.json');
  assert.equal(generationClaim.runId, recovery.source.runId);
  assert.equal(generationClaim.diagnosticOnly, true);
  assert.equal(generationClaim.passAt1, null);
  const runClaim = source('run-claim.json');
  assert.equal(runClaim.runId, recovery.source.runId);
  assert.equal(runClaim.runAttempt, 1);
  assert.equal(runClaim.candidateId, recovery.candidateId);
  const modelClaim = source('model-claim.json');
  assert.equal(modelClaim.runId, recovery.source.runId);
  assert.equal(modelClaim.attemptId, recovery.attempt.attemptId);
  assert.equal(modelClaim.evaluationBatchId, recovery.attempt.evaluationBatchId);
  assert.equal(modelClaim.attempt, 1);
  assert.equal(modelClaim.diagnosticOnly, true);
  assert.equal(modelClaim.passAt1, null);
  const admission = source('model-admission.json');
  assert.equal(admission.stage, 'model');
  assert.equal(admission.instanceId, recovery.attempt.instanceId);
  assert.equal(admission.baseCommit, recovery.attempt.baseCommit);
  assert.equal(admission.imageId, recovery.attempt.imageId);
  assert.equal(admission.imageRef, recovery.attempt.imageRef);
  assert.equal(admission.officialEnvironmentSha256, recovery.evidence['official-environment.json'].sha256);
  assert.equal(admission.sanitationSha256, recovery.evidence['sanitation.json'].sha256);
  assert.equal(admission.preflightSha256, recovery.evidence['preflight-verification.json'].sha256);
  assert.equal(admission.promptSha256, recovery.evidence['launch-prompt.txt'].sha256);
  assert.equal(admission.candidateManifestSha256, recovery.expected.candidateConfigSha256);
  for (const [key, value] of Object.entries(admission)) assert.deepEqual(modelClaim[key], value);
  const modelProcess = source('model.process.json');
  assert.equal(modelProcess.status, 0);
  assert.equal(modelProcess.signal, null);
  assert.equal(modelProcess.timedOut, false);
  const disposition = source('evaluation-disposition.json');
  assert.equal(disposition.disposition, 'not-evaluated');
  assert.equal(disposition.reason, 'generation-incomplete');
  assert.equal(disposition.diagnosticOnly, true);
  assert.equal(disposition.passAt1, null);
  assert.equal(source('controller-generate-failure.json').stage, 'generate');
  const sanitation = source('sanitation.json');
  assert.equal(sanitation.content.passed, true);
  assert.equal(sanitation.git.baseCommit, recovery.attempt.baseCommit);
  assert.equal(sanitation.git.commitObjects, 1);
  assert.equal(sanitation.git.objects, recovery.expected.baseGit.objects);
  assert.equal(sanitation.git.objectSetSha256, recovery.expected.baseGit.objectSetSha256);
  assert.equal(sanitation.git.allObjectsReachableFromBase, true);
  const baseline = source('baseline-capture/receipt.json');
  assert.equal(baseline.status, 'captured');
  assert.equal(baseline.bytes, 0);
  const environment = source('official-environment.json');
  assert.equal(environment.instanceId, recovery.attempt.instanceId);
  assert.equal(environment.baseCommit, recovery.attempt.baseCommit);
  assert.equal(environment.containerId, recovery.attempt.containerId);
  assert.equal(environment.imageId, recovery.attempt.imageId);
  assert.equal(environment.imageRef, recovery.attempt.imageRef);
  assert.equal(environment.bundleSha256, candidate.bundle.sha256);
  return {instanceId: recovery.attempt.instanceId, sourceRunId: recovery.source.runId, attemptId: recovery.attempt.attemptId, verifiedFiles: Object.keys(recovery.evidence).length, attemptEvidence: attempt, verifiedAt: new Date().toISOString()};
}

// The failed source summary stays verbatim under recovery/source; the recovery
// summary records the same attempt identity with the recovered capture state.
export function buildRecoverySummary(sourceSummary, captureReceipt, captureContainerId, recoveredFrom) {
  return {
    instanceId: sourceSummary.instanceId,
    evaluationBatchId: sourceSummary.evaluationBatchId,
    attemptId: sourceSummary.attemptId,
    status: 'completed',
    stage: 'recovery-capture',
    diagnosticOnly: true,
    passAt1: null,
    modelAttempt: sourceSummary.modelAttempt,
    predictionEligible: true,
    predictionPresent: true,
    containerClosed: sourceSummary.containerClosed,
    containerRemoved: sourceSummary.containerRemoved,
    captureContainerRemoved: true,
    candidate: sourceSummary.candidate,
    containerId: sourceSummary.containerId,
    process: sourceSummary.process,
    exports: sourceSummary.exports,
    evidence: sourceSummary.evidence,
    modelAbsence: sourceSummary.modelAbsence,
    captureAbsence: 'capture-absence',
    captureContainerId,
    capture: captureReceipt,
    recoveredFrom,
  };
}

export function recoveryPrediction(patch, patchSha256, recovery, generationManifest = generation, candidateManifest = candidate) {
  return {
    schemaVersion: 1,
    evaluationBatchId: recovery.attempt.evaluationBatchId,
    attemptId: recovery.attempt.attemptId,
    instanceId: recovery.attempt.instanceId,
    modelNameOrPath: candidateManifest.candidateId + '-' + generationManifest.provider.model,
    modelPatch: patch,
    modelPatchSha256: patchSha256,
  };
}

function assertPinnedNode() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.15.0');
  assert.equal(fileHash(process.execPath), candidate.node.binarySha256);
}

function assertNoSecrets() {
  assert(!process.env.BENCHMARK_PROVIDER_API_KEY && !process.env.BEST_AGENT_SOURCE_TOKEN, 'Recovery must not hold provider or source credentials');
}

function recoveryConfigConsistency(recovery) {
  assert.equal(recovery.attempt.instanceId, candidate.task.instanceId);
  assert.equal(recovery.attempt.baseCommit, candidate.task.baseCommit);
  assert.equal(recovery.attempt.imageRef, candidate.task.imageRef);
  assert.equal(recovery.attempt.imageId, recovery.attempt.imageRef.split('@')[1]);
  assert.equal(recovery.expected.candidateConfigSha256, hash(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json'))));
}

async function apiJson(pathname) {
  const response = await fetch('https://api.github.com' + pathname, {
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `GitHub API ${pathname} HTTP ${response.status}`);
  return response.json();
}

async function prepare(nodeRoot, evidenceDir, runId) {
  validateRun(runId);
  assertPinnedNode();
  const recovery = readRecoveryConfig();
  recoveryConfigConsistency(recovery);
  fs.mkdirSync(evidenceDir);
  const privateStage = path.join(evidenceDir, 'recovery');
  fs.mkdirSync(privateStage);
  const oneRuns = (await apiJson(`/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/node-bundle-one.yml/runs?per_page=100`)).workflow_runs;
  const recoveryRuns = (await apiJson(`/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/node-bundle-capture-recovery.yml/runs?per_page=100`)).workflow_runs;
  const declared = [...generation.preModelRuns, recovery.source];
  const jobsByRun = {};
  for (const declaration of declared) {
    jobsByRun[declaration.runId] = await apiJson(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${declaration.runId}/jobs?per_page=100`);
  }
  const mapRun = run => ({id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion, runAttempt: run.run_attempt});
  write(path.join(privateStage, 'hosted-run-admission.json'), {runId, oneRuns: oneRuns.map(mapRun), recoveryRuns: recoveryRuns.map(mapRun), declared});
  admitRecoveryRun(oneRuns, recoveryRuns, runId, generation.preModelRuns, recovery.source, jobsByRun);
  for (const declaration of generation.preModelRuns) {
    write(path.join(privateStage, 'pre-model-run-' + declaration.runId + '.json'), jobsByRun[declaration.runId]);
  }
  write(path.join(privateStage, 'source-run-jobs.json'), jobsByRun[recovery.source.runId]);
  const sourceDir = path.join(path.dirname(evidenceDir), 'node-bundle-recovery-source-' + runId);
  fs.mkdirSync(sourceDir);
  const zipPath = path.join(sourceDir, recovery.source.artifact.name + '.zip');
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${recovery.source.artifact.id}/zip`, {
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(300_000),
  });
  assert(response.ok, `Artifact download HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.length, recovery.source.artifact.sizeInBytes, 'Artifact archive size changed');
  fs.writeFileSync(zipPath, archive, {flag: 'wx'});
  const extracted = spawnSync('unzip', ['-q', zipPath, '-d', sourceDir], {encoding: 'utf8', timeout: 120_000});
  assert.equal(extracted.status, 0, 'Artifact extraction failed: ' + extracted.stderr);
  fs.unlinkSync(zipPath);
  const verification = verifyFrozenSource(sourceDir, recovery);
  write(path.join(privateStage, 'source-verification.json'), verification);
  const sourceStage = path.join(privateStage, 'source');
  fs.mkdirSync(path.join(sourceStage, 'terminal'), {recursive: true});
  for (const relative of Object.keys(recovery.evidence)) {
    const destination = relative === 'terminal/summary.json' || relative === 'evaluation-disposition.json'
      ? path.join(sourceStage, relative.replaceAll('/', '-'))
      : path.join(evidenceDir, relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(sourceDir, relative), destination, fs.constants.COPYFILE_EXCL);
    assert.equal(fileHash(destination), recovery.evidence[relative].sha256, 'Copied evidence changed: ' + relative);
  }
  fs.copyFileSync(path.join(sourceDir, 'upload-manifest.json'), path.join(sourceStage, 'upload-manifest.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(repository, 'config/node-bundle-recovery.json'), path.join(privateStage, 'recovery-manifest.json'), fs.constants.COPYFILE_EXCL);
  write(path.join(privateStage, 'prepare.json'), {runId, sourceRunId: recovery.source.runId, sourceDir, artifactId: recovery.source.artifact.id, verifiedFiles: verification.verifiedFiles, at: new Date().toISOString()});
  write(path.join(privateStage, 'recovery-claim.json'), {stage: 'prepared', runId, sourceRunId: recovery.source.runId, runAttempt: 1, candidateId: recovery.candidateId, diagnosticOnly: true, passAt1: null, at: new Date().toISOString()});
  const step = (name, args, timeout = 60_000) => runRecordedStep(evidenceDir, name, args, timeout);
  const evaluatorSource = path.join(repository, 'tools/swe-bench-source');
  assert.equal((await step('evaluator-source-head', ['git', '-C', evaluatorSource, 'rev-parse', 'HEAD'])).stdout.trim(), generation.officialEvaluatorCommit);
  assert.equal((await step('evaluator-source-clean', ['git', '-C', evaluatorSource, 'status', '--porcelain'])).stdout.trim(), '');
  assert.equal((await step('host-python-version', ['python3', '-c', 'import platform; print(platform.python_version())'])).stdout.trim(), generation.hostPythonVersion);
  const privateRoot = path.join(path.dirname(evidenceDir), 'node-bundle-recovery-private-' + runId);
  fs.mkdirSync(privateRoot, {mode: 0o700});
  const venv = path.join(privateRoot, 'evaluator-venv');
  await step('evaluator-venv', ['python3', '-m', 'venv', venv]);
  const python = path.join(venv, 'bin/python');
  await step('evaluator-install', [python, '-m', 'pip', 'install', '--disable-pip-version-check', '--retries', '0', evaluatorSource], 900_000);
  await step('evaluator-freeze', [python, '-m', 'pip', 'freeze']);
  const check = 'import sys; sys.path.insert(0,sys.argv[1]); import swebench,docker,datasets,json; print(json.dumps(dict(version=swebench.__version__,source=swebench.__file__)))';
  const imports = JSON.parse((await step('evaluator-imports', [python, '-s', '-c', check, evaluatorSource])).stdout);
  assert.equal(imports.version, generation.officialEvaluatorVersion);
  assert(imports.source.startsWith(evaluatorSource + '/'));
  await step('evaluator-prepare', [process.execPath, path.join(repository, 'scripts/prepare-swe-bench.mjs'), '--evaluator-source', evaluatorSource, '--evaluator-python', python, '--corpus', path.join(privateRoot, 'corpus.jsonl'), '--manifest', path.join(evidenceDir, 'official-evaluator-manifest.json')], 900_000);
  write(path.join(privateStage, 'evaluator.json'), {privateRoot, corpusPath: path.join(privateRoot, 'corpus.jsonl'), manifestPath: path.join(evidenceDir, 'official-evaluator-manifest.json'), at: new Date().toISOString()});
}

const baseGitConstructionRunner = "import {sanitizeRepository} from '/capture/sanitize.mjs';\nimport fs from 'node:fs';\nconst expected = JSON.parse(fs.readFileSync('/capture/expected.json', 'utf8'));\nconsole.log(JSON.stringify(sanitizeRepository('/testbed', expected.baseCommit)));\n";

async function capture(nodeRoot, evidenceDir, runId) {
  assertNoSecrets();
  validateRun(runId);
  assertPinnedNode();
  const recovery = readRecoveryConfig();
  recoveryConfigConsistency(recovery);
  const prepareReceipt = readJson(path.join(evidenceDir, 'recovery/prepare.json'));
  assert.equal(prepareReceipt.runId, runId, 'Recovery capture requires the prepare receipt of the same run');
  assert.equal(prepareReceipt.sourceRunId, recovery.source.runId);
  const sourceDir = prepareReceipt.sourceDir;
  const workspaceTar = path.join(sourceDir, 'terminal/workspace.tar');
  let serial = 0;
  const step = async (name, args, options = {}) => {
    const result = await recordGenerationProcess(evidenceDir, String(++serial).padStart(3, '0') + '-' + name, args, options);
    if (result.status !== 0 || result.signal || result.timedOut || result.error) throw new Error(name + ' failed; see preserved process receipt');
    return result;
  };
  const output = result => fs.readFileSync(result.stdoutPath, 'utf8');
  await step('image-pull', ['docker', 'pull', '--platform', 'linux/amd64', recovery.attempt.imageRef], {timeoutMs: 900_000});
  const image = JSON.parse(output(await step('image-inspect', ['docker', 'image', 'inspect', recovery.attempt.imageRef])))[0];
  assert.equal(image.Id, recovery.attempt.imageId);
  assert.equal(image.Architecture, 'amd64');
  assert.equal(image.Os, 'linux');
  assert(image.RepoDigests.includes(recovery.attempt.imageRef));
  assert.equal(image.Config.Entrypoint, null);
  assert.equal(image.Config.Volumes, null);
  const captureId = output(await step('capture-create', ['docker', 'create', '--name', 'remaining63-node-' + recovery.source.runId + '-recovery-capture', '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g', image.Id, 'sleep', 'infinity'])).trim();
  assert.match(captureId, /^[a-f0-9]{64}$/);
  let captureRemoved = false;
  try {
    await step('capture-start', ['docker', 'start', captureId]);
    const boundary = JSON.parse(output(await step('capture-boundary', ['docker', 'inspect', captureId])))[0];
    assert.equal(boundary.Id, captureId);
    assert.equal(boundary.Image, image.Id);
    assert.equal(boundary.Mounts.length, 0);
    assert.equal(boundary.HostConfig.NetworkMode, 'none');
    assert.equal(boundary.HostConfig.Privileged, false);
    assert.notEqual(boundary.HostConfig.PidMode, 'host');
    // Setup happens before any /testbed removal: the image WorkingDir is /testbed and
    // docker exec cannot start once that directory is gone (the defect that stopped run 34376814789).
    await step('capture-directories', ['docker', ...captureExec(captureId, 'mkdir', '-p', '/restore', '/capture', '/opt/agent')]);
    await step('capture-node', ['docker', 'cp', path.join(nodeRoot, 'node-v24.15.0-linux-x64'), captureId + ':/opt/agent/node']);
    await step('capture-copy-sanitizer', ['docker', 'cp', path.join(repository, 'scripts/node-bundle-sanitize.mjs'), captureId + ':/capture/sanitize.mjs']);
    const baseGitExpectation = {baseCommit: recovery.attempt.baseCommit, objects: recovery.expected.baseGit.objects, objectSetSha256: recovery.expected.baseGit.objectSetSha256};
    fs.writeFileSync(path.join(evidenceDir, 'recovery/base-git-expected.json'), JSON.stringify(baseGitExpectation, null, 2) + '\n', {flag: 'wx'});
    await step('capture-copy-expected', ['docker', 'cp', path.join(evidenceDir, 'recovery/base-git-expected.json'), captureId + ':/capture/expected.json']);
    fs.writeFileSync(path.join(evidenceDir, 'recovery/base-git-runner.mjs'), baseGitConstructionRunner, {flag: 'wx'});
    await step('capture-copy-runner', ['docker', 'cp', path.join(evidenceDir, 'recovery/base-git-runner.mjs'), captureId + ':/capture/build-base-git.mjs']);
    // Construct the trusted base-only git from the pinned image's own checkout with the
    // reviewed sanitizer construction — independent of anything the model could touch —
    // and require its object set to equal the frozen pre-model sanitation receipt.
    const baseGit = JSON.parse(output(await step('base-git-construction', ['docker', 'exec', captureId, node, '/capture/build-base-git.mjs'], {timeoutMs: 300_000})));
    assert.equal(baseGit.baseCommit, recovery.expected.baseGit.headSha);
    assert.equal(baseGit.objects, recovery.expected.baseGit.objects);
    assert.equal(baseGit.objectSetSha256, recovery.expected.baseGit.objectSetSha256);
    assert.equal(baseGit.allObjectsReachableFromBase, true);
    await step('capture-trusted-git', ['docker', ...captureExec(captureId, 'cp', '-a', '/testbed/.git', '/capture/base.git')]);
    await step('capture-clear-original', ['docker', ...captureExec(captureId, 'rm', '-rf', '/testbed')]);
    await step('capture-restore', ['docker', 'cp', '-', captureId + ':/restore/'], {inputPath: workspaceTar, timeoutMs: 180_000});
    await step('capture-place-worktree', ['docker', ...captureExec(captureId, 'mv', '/restore/testbed', '/testbed')]);
    await step('capture-remove-untrusted-git', ['docker', ...captureExec(captureId, 'rm', '-rf', '/testbed/.git')]);
    await step('capture-helper', ['docker', 'cp', path.join(repository, 'scripts/node-bundle-capture.mjs'), captureId + ':/capture/helper.mjs']);
    await step('capture-patch', ['docker', ...captureExec(captureId, node, '/capture/helper.mjs', recovery.attempt.baseCommit)], {timeoutMs: 200_000});
    await step('capture-export', ['docker', 'cp', captureId + ':/capture/output', path.join(evidenceDir, 'terminal/captured')]);
  } finally {
    if (!captureRemoved) {
      try {
        const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', captureId], {encoding: 'utf8', timeout: 30_000});
        if (state.status === 0 && state.stdout.trim() === 'true') await step('capture-stop', ['docker', 'kill', captureId]);
        await step('capture-remove', ['docker', 'rm', '--force', captureId]);
        captureRemoved = true;
        const absence = await recordGenerationProcess(evidenceDir, 'capture-absence', ['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + captureId]);
        assert.equal(absence.status, 0); assert.equal(absence.signal, null); assert.equal(absence.timedOut, false); assert(!absence.error);
        assert.equal(absence.stdout.bytes, 0);
      } catch (cleanupError) {
        write(path.join(evidenceDir, 'recovery/capture-cleanup-error.json'), {captureId, error: String(cleanupError), at: new Date().toISOString()});
      }
    }
  }
  const receipt = readJson(path.join(evidenceDir, 'terminal/captured/receipt.json'));
  assert.equal(receipt.status, 'captured');
  assert.equal(receipt.baseCommit, recovery.attempt.baseCommit);
  assert(receipt.bytes > 0, 'Recovered capture produced an empty patch');
  assert.equal(receipt.originalIndexUnchanged, true);
  const patch = fs.readFileSync(path.join(evidenceDir, 'terminal/captured/diagnostic.patch'));
  assert.equal(hash(patch), receipt.sha256);
  assert.equal(hash(Buffer.from(patch.toString('utf8'), 'utf8')), receipt.sha256, 'Patch UTF-8 roundtrip changed bytes');
  write(path.join(evidenceDir, 'terminal/prediction.json'), recoveryPrediction(patch.toString('utf8'), receipt.sha256, recovery));
  const sourceSummary = readJson(path.join(sourceDir, 'terminal/summary.json'));
  const recoveredFrom = {sourceRunId: recovery.source.runId, sourceAttemptId: recovery.attempt.attemptId, sourceArtifactId: recovery.source.artifact.id, sourceFailureStage: recovery.source.failure.stage, sourceSummarySha256: recovery.evidence['terminal/summary.json'].sha256, recoveryRunId: runId, workspaceTarSha256: fileHash(workspaceTar), baseGitVerification: baseGit, at: new Date().toISOString()};
  const summary = buildRecoverySummary(sourceSummary, receipt, captureId, recoveredFrom);
  assert.equal(modelRemovalSafe(summary), true, 'Recovered summary fails the model-removal safety contract');
  assert.equal(predictionEligible(summary), true, 'Recovered summary is not prediction-eligible');
  write(path.join(evidenceDir, 'terminal/summary.json'), summary);
  write(path.join(evidenceDir, 'recovery/capture.json'), {runId, sourceRunId: recovery.source.runId, captureContainerId: captureId, patchSha256: receipt.sha256, patchBytes: receipt.bytes, predictionSha256: hash(fs.readFileSync(path.join(evidenceDir, 'terminal/prediction.json'))), at: new Date().toISOString()});
}

async function audit(evidenceDir, runId) {
  validateRun(runId);
  const secret = process.env.BENCHMARK_PROVIDER_API_KEY;
  assert(secret, 'The provider credential is required only to scan evidence for leaks');
  const record = auditEvidence(evidenceDir, secret);
  write(path.join(evidenceDir, 'credential-audit.json'), record);
  write(path.join(evidenceDir, 'recovery/audit.json'), {runId, safe: true, files: record.files.length, at: new Date().toISOString()});
}

async function evaluate(nodeRoot, evidenceDir, runId) {
  assertNoSecrets();
  validateRun(runId);
  assertPinnedNode();
  const recovery = readRecoveryConfig();
  const captureReceipt = readJson(path.join(evidenceDir, 'recovery/capture.json'));
  assert.equal(captureReceipt.runId, runId, 'Recovery evaluation requires the capture receipt of the same run');
  assert.equal(captureReceipt.sourceRunId, recovery.source.runId);
  const {evaluateNodeBundleTask} = await import('./evaluate-node-bundle-one.mjs');
  // The evaluation identity is the frozen generation run: every canonical assertion
  // inside the evaluator module checks the original attempt, not the recovery run.
  const result = await evaluateNodeBundleTask({evidenceDir, manifestPath: path.join(evidenceDir, 'official-evaluator-manifest.json'), runId: recovery.source.runId});
  write(path.join(evidenceDir, 'recovery/evaluate.json'), {recoveryRunId: runId, attemptRunId: recovery.source.runId, attemptId: recovery.attempt.attemptId, disposition: result.disposition, diagnosticOnly: true, passAt1: null, at: new Date().toISOString()});
  return result;
}

export async function recovery(mode, nodeRoot, evidenceDir, runId) {
  assert.equal(candidate.candidateId, generation.candidateId);
  assert.equal(generation.diagnosticOnly, true);
  assert.equal(generation.passAt1, null);
  if (mode === 'prepare') return prepare(nodeRoot, evidenceDir, runId);
  if (mode === 'capture') return capture(nodeRoot, evidenceDir, runId);
  if (mode === 'audit') return audit(evidenceDir, runId);
  if (mode === 'evaluate') return evaluate(nodeRoot, evidenceDir, runId);
  if (mode === 'publish') {
    // Identical audited-upload semantics to the first-task controller; the provider
    // credential is only ever a scan needle and never enters any container.
    const {controller} = await import('./node-bundle-controller.mjs');
    return controller('publish', nodeRoot, evidenceDir, runId);
  }
  throw new Error('Unknown recovery mode');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, nodeRoot, evidenceDir, runId] = process.argv.slice(2);
  recovery(mode, nodeRoot, evidenceDir, runId).catch(error => {
    if (evidenceDir && fs.existsSync(evidenceDir) && mode !== 'publish') {
      write(path.join(evidenceDir, 'controller-recovery-' + mode + '-failure.json'), {stage: mode, error: String(error), stack: error.stack});
    }
    console.error(`Node bundle recovery ${mode} did not complete; inspect audited evidence for the stage.`);
    process.exitCode = 1;
  });
}
