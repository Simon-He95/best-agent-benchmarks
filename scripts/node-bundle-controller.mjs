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

async function prepare(candidateDir, evidenceDir, runId) {
  fs.mkdirSync(evidenceDir);
  write(path.join(evidenceDir, 'run-claim.json'), {runId, runAttempt: 1, candidateId: candidate.candidateId, modelAttempt: false, diagnosticOnly: true, passAt1: null, at: new Date().toISOString()});
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.15.0');
  verifyCandidate(candidate, candidateDir);
  assert.equal(fileHash(process.execPath), candidate.node.binarySha256);
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/node-bundle-one.yml/runs?per_page=100`, {
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Unable to verify previous hosted runs');
  const runs = (await response.json()).workflow_runs;
  write(path.join(evidenceDir, 'hosted-run-admission.json'), {runId, runs: runs.map(run => ({id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion}))});
  const jobsByRun = {};
  for (const previous of runs.filter(run => String(run.id) !== runId)) {
    if (!generation.preModelRuns?.some(item => item.runId === String(previous.id))) continue;
    const jobResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${previous.id}/jobs?per_page=100`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
    });
    assert(jobResponse.ok, 'Cannot verify the frozen prior pre-model failure');
    jobsByRun[String(previous.id)] = await jobResponse.json();
    write(path.join(evidenceDir, 'pre-model-run-' + previous.id + '.json'), {run: previous, jobs: jobsByRun[String(previous.id)]});
  }
  admitFirstRun(runs, runId, generation.preModelRuns, jobsByRun);
  const step = (name, args, timeout = 60_000) => runRecordedStep(evidenceDir, name, args, timeout);
  const controls = ['config/node-bundle-candidate.json', 'config/node-bundle-generation.json', 'config/node-bundle-failed-tasks.json', 'config/swe-bench-verified.json', '.github/workflows/node-bundle-one.yml', 'scripts/node-bundle-controller.mjs', 'scripts/audit-node-bundle-evidence.py', 'scripts/generate-node-bundle-one.mjs', 'scripts/node-bundle-sanitize.mjs', 'scripts/node-bundle-capture.mjs', 'scripts/evaluate-node-bundle-one.mjs', 'scripts/node-bundle-probe.mjs', 'scripts/swe-bench-harness.mjs', 'scripts/swe-bench-official-evaluator.mjs', 'scripts/prepare-swe-bench.mjs', 'scripts/materialize-ci-provider.mjs'];
  const controlFiles = controls.map(name => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const output = path.join(evidenceDir, 'control-files', name);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, bytes, {flag: 'wx'});
    return {path: name, sha256: hash(bytes), sizeBytes: bytes.length};
  });
  fs.copyFileSync(path.join(candidateDir, 'download-receipt.json'), path.join(evidenceDir, 'download-receipt.json'), fs.constants.COPYFILE_EXCL);
  write(path.join(evidenceDir, 'execution-control.json'), {runId, workflowHead: process.env.GITHUB_SHA, candidateId: candidate.candidateId, controlFiles, provider: generation.provider, modelWatchdogMs: generation.externalWatchdogMs, diagnosticOnly: true, passAt1: null, closedBook: false});
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

async function generate(candidateDir, evidenceDir, runId) {
  const prepared = read(path.join(evidenceDir, 'controller-prepared.json'));
  assert.equal(prepared.runId, runId);
  const secret = process.env.BENCHMARK_PROVIDER_API_KEY;
  assert(secret, 'BENCHMARK_PROVIDER_API_KEY is required');
  const providerRoot = path.dirname(prepared.providerPath);
  let failure;
  try {
    await runRecordedStep(evidenceDir, 'provider-materialize', [process.execPath, path.join(repository, 'scripts/materialize-ci-provider.mjs'), providerRoot, path.join(prepared.privateRoot, 'provider-env.txt'), path.join(repository, 'config/node-bundle-generation.json')], 60_000);
    delete process.env.BENCHMARK_PROVIDER_API_KEY;
    const {generateNodeBundleTask} = await import('./generate-node-bundle-one.mjs');
    const summary = await generateNodeBundleTask({candidateDir, evidenceDir, corpusPath: prepared.corpusPath, providerPath: prepared.providerPath, runId});
    if (summary.status !== 'completed' || !summary.containerClosed || !summary.containerRemoved || !summary.captureContainerRemoved || summary.process?.status !== 0 || summary.process?.timedOut || !summary.evidence?.complete) {
      write(path.join(evidenceDir, 'evaluation-disposition.json'), {instanceId: candidate.task.instanceId, diagnosticOnly: true, passAt1: null, disposition: 'not-evaluated', reason: 'generation-incomplete'});
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

export async function controller(mode, candidateDir, evidenceDir, runId) {
  validateRun(runId);
  candidateDir = path.resolve(candidateDir);
  evidenceDir = path.resolve(evidenceDir);
  assert.equal(candidate.candidateId, generation.candidateId);
  assert.equal(generation.diagnosticOnly, true);
  assert.equal(generation.passAt1, null);
  assert.equal(process.version, 'v24.15.0');
  assert.equal(fileHash(process.execPath), candidate.node.binarySha256);
  if (mode === 'prepare') return prepare(candidateDir, evidenceDir, runId);
  if (mode === 'generate') return generate(candidateDir, evidenceDir, runId);
  if (mode === 'evaluate') {
    assert(!process.env.BENCHMARK_PROVIDER_API_KEY && !process.env.BEST_AGENT_SOURCE_TOKEN);
    const {evaluateNodeBundleTask} = await import('./evaluate-node-bundle-one.mjs');
    return evaluateNodeBundleTask({evidenceDir, manifestPath: path.join(evidenceDir, 'official-evaluator-manifest.json'), runId});
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
    // Detailed process evidence stays in the audit-gated directory, never in the CI console.
    console.error(`Node bundle ${mode} did not complete; inspect audited evidence for the stage.`);
    process.exitCode = 1;
  });
}
