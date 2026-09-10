import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildTaskPrompt, inspectAttemptEvidence} from './swe-bench-harness.mjs';
import {verifyCandidate, verifyProbeTranscript} from './swe-node-bundle-preflight.mjs';
import {baseEraFileHashes, inspectArchive, treeGitlinks} from './node-bundle-sanitize.mjs';
import {selectFrozenTask} from './node-bundle-task-selection.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const node = '/opt/agent/node/bin/node';

function fileHash(filename) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(filename, 'r');
  try { let length; while ((length = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

export async function recordGenerationProcess(directory, name, args, {timeoutMs = 60_000, input, inputPath, stdoutPath = path.join(directory, name + '.stdout.txt')} = {}) {
  const stderrPath = path.join(directory, name + '.stderr.txt');
  const out = fs.openSync(stdoutPath, 'wx'), err = fs.openSync(stderrPath, 'wx');
  const inputFd = inputPath ? fs.openSync(inputPath, 'r') : undefined;
  const child = spawn(args[0], args.slice(1), {detached: true, stdio: [inputFd ?? (input === undefined ? 'ignore' : 'pipe'), out, err]});
  let timedOut = false, spawnError;
  if (input !== undefined) { child.stdin.on('error', error => { spawnError ??= error.code; }); child.stdin.end(input); }
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') spawnError ??= error.code; } }, timeoutMs);
  const result = await new Promise(resolve => {
    child.once('error', error => { spawnError = error.code; });
    child.once('close', (status, signal) => resolve({status, signal, timedOut, ...(spawnError ? {error: spawnError} : {})}));
  });
  clearTimeout(timer); fs.closeSync(out); fs.closeSync(err); if (inputFd !== undefined) fs.closeSync(inputFd);
  const receipt = {...result, args, timeoutMs, stdout: {bytes: fs.statSync(stdoutPath).size, sha256: fileHash(stdoutPath)}, stderr: {bytes: fs.statSync(stderrPath).size, sha256: fileHash(stderrPath)}};
  writeJson(path.join(directory, name + '.process.json'), receipt);
  return {...receipt, stdoutPath, stderrPath};
}

export function generationInputs({corpusPath, runId, providerPath}, candidate, selection, generation, corpusProfile, entry = null) {
  assert.match(runId, /^[1-9][0-9]*$/);
  assert.equal(candidate.candidateId, generation.candidateId);
  assert.equal(generation.maxModelCycles, 2251799813685247);
  assert.equal(generation.externalWatchdogMs, 3600000);
  const selected = selectFrozenTask(selection, entry);
  assert.equal(selected.instanceId, candidate.task.instanceId);
  assert.equal(selected.baseCommit, candidate.task.baseCommit);
  const bytes = fs.readFileSync(corpusPath);
  assert.equal(bytes.length, corpusProfile.jsonlBytes);
  assert.equal(hash(bytes), corpusProfile.jsonlSha256);
  const matches = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.instance_id === selected.instanceId);
  assert.equal(matches.length, 1);
  const task = matches[0];
  assert.equal(task.repo, selected.repo);
  assert.equal(task.base_commit, selected.baseCommit);
  const publicPrompt = buildTaskPrompt(task.problem_statement);
  assert.equal(hash(publicPrompt), selected.promptSha256);
  let provider, payload;
  try { provider = readJson(providerPath); }
  catch { throw new Error('Invalid provider JSON'); }
  if (!Object.entries(generation.provider).every(([key, value]) => provider[key] === value) || typeof provider.apiKey !== 'string' || !provider.apiKey) throw new Error('Provider does not match frozen profile');
  try { payload = JSON.parse(Buffer.from(provider.apiKey.split('.')[1] ?? '', 'base64url')); }
  catch { throw new Error('Invalid provider token payload'); }
  if (!Number.isInteger(payload.exp) || payload.exp * 1000 <= Date.now() + generation.externalWatchdogMs) throw new Error('Provider expires before the model watchdog');
  const prompt = publicPrompt + '\n\nExecution environment: the task uses its official SWE-bench Linux instance image. Repository root is /testbed. The existing conda testbed environment is active for Python commands. Agent runtime and evidence are stored outside the repository. Network access is enabled; no host directories are mounted.\n';
  // These values stay controller-side; neither the corpus nor scan inputs enter model files.
  const patches = [task.patch, task.test_patch].filter(value => typeof value === 'string' && value.length > 0);
  const additions = patches.flatMap(patch => {
    const blocks = []; let block = [];
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) block.push(line.slice(1));
      else if (block.length) { blocks.push(block.join('\n')); block = []; }
    }
    if (block.length) blocks.push(block.join('\n'));
    return blocks.filter(block => block.trim().length >= 80);
  });
  const needles = [...new Set([...patches, ...additions, '"FAIL_TO_PASS":', '"PASS_TO_PASS":', '"test_patch":'])];
  return {task: selected, prompt, publicPrompt, provider, needles, evaluationBatchId: 'remaining63-node-' + runId, attemptId: selected.instanceId + '-node-' + runId + '-001'};
}

export function pythonEnvironmentExpectations(task) {
  return {
    module: task.pythonModule ?? 'django',
    source: task.pythonSource ?? '/testbed/django/__init__.py',
    version: task.pythonVersion === undefined ? '3.5.6' : (typeof task.pythonVersion === 'string' ? task.pythonVersion : null),
  };
}

export function predictionEligible(summary) {
  return summary.process?.status === 0 && summary.process.signal === null && !summary.process.timedOut && !summary.process.error && summary.containerClosed === true && summary.containerRemoved === true && summary.captureContainerRemoved === true && summary.evidence?.complete === true && summary.evidence.rootStatus === 'completed' && summary.exports?.length === 4 && summary.exports.every(item => item.status === 0 && item.signal === null && !item.timedOut && !item.error && item.sha256) && summary.capture?.status === 'captured' && summary.capture.bytes > 0;
}

export async function collectTerminalExports(containerId, evidenceDir, processRunner = recordGenerationProcess) {
  const exports = [];
  for (const [source, target, tar] of [['/work/attempt.jsonl', 'attempt.jsonl', false], ['/work/artifacts', 'artifacts.tar', true], ['/work/runtime', 'runtime.tar', true], ['/testbed', 'workspace.tar', true]]) {
    const destination = path.join(evidenceDir, 'terminal', target);
    try {
      const result = await processRunner(evidenceDir, 'export-' + target, ['docker', 'cp', containerId + ':' + source, tar ? '-' : destination], {timeoutMs: 180_000, ...(tar ? {stdoutPath: destination} : {})});
      const regular = fs.existsSync(destination) && fs.lstatSync(destination).isFile();
      exports.push({source, target, status: result.status, signal: result.signal, timedOut: result.timedOut, error: result.error, sha256: regular ? fileHash(destination) : null});
    } catch {
      exports.push({source, target, status: null, signal: null, error: 'export-process-or-evidence-write-failed', sha256: null});
    }
  }
  writeJson(path.join(evidenceDir, 'terminal/exports.json'), exports);
  return exports;
}

export const captureExec = (captureId, ...args) => ['exec', '-w', '/', captureId, ...args];

export function modelRemovalSafe(summary) {
  return summary.containerClosed === true && (!summary.modelAttempt || (summary.exports?.length === 4 && summary.exports.every(entry => entry.status === 0 && entry.signal === null && !entry.timedOut && !entry.error && entry.sha256)));
}

export async function generateNodeBundleTask({candidateDir, evidenceDir, corpusPath, providerPath, runId, task = null}) {
  evidenceDir = path.resolve(evidenceDir); candidateDir = path.resolve(candidateDir); providerPath = path.resolve(providerPath);
  assert(!providerPath.startsWith(evidenceDir + path.sep), 'Provider must stay outside evidence directory');
  fs.mkdirSync(evidenceDir, {recursive: true});
  assert(!fs.existsSync(path.join(evidenceDir, 'model-claim.json')), 'A model claim already exists; no retry');
  writeJson(path.join(evidenceDir, 'generation-claim.json'), {runId, startedAt: new Date().toISOString(), diagnosticOnly: true, passAt1: null});
  const terminal = path.join(evidenceDir, 'terminal'); fs.mkdirSync(terminal);
  const privateDir = fs.mkdtempSync(path.join(path.dirname(providerPath), 'generation-private-'));
  const baseCandidate = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json')));
  const effectiveCandidate = task ? {...baseCandidate, task} : baseCandidate;
  const summary = {instanceId: effectiveCandidate.task.instanceId, evaluationBatchId: 'remaining63-node-' + runId, attemptId: effectiveCandidate.task.instanceId + '-node-' + runId + '-001', status: 'failed', stage: 'input', diagnosticOnly: true, passAt1: null, modelAttempt: false, predictionEligible: false, predictionPresent: false, containerClosed: false, containerRemoved: false, captureContainerRemoved: true};
  let containerId, captureId, frozen, candidate, generation, ownsLock = false;
  const lockPath = path.join(evidenceDir, 'active-operation.lock');
  let serial = 0;
  const step = async (name, args, options = {}) => {
    const result = await recordGenerationProcess(evidenceDir, String(++serial).padStart(3, '0') + '-' + name, ['docker', ...args], options);
    if (result.status !== 0 || result.signal || result.timedOut || result.error) throw new Error(name + ' failed; see preserved process receipt');
    return result;
  };
  const output = result => fs.readFileSync(result.stdoutPath, 'utf8');
  const jsonOutput = result => JSON.parse(output(result));
  const remove = async (id, role) => {
    await step(role + '-remove', ['rm', '--force', id]);
    const proof = await recordGenerationProcess(evidenceDir, role + '-absence', ['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + id]);
    assert.equal(proof.status, 0); assert.equal(proof.signal, null); assert.equal(proof.timedOut, false); assert(!proof.error); assert.equal(proof.stdout.bytes, 0);
    summary[role === 'capture' ? 'captureAbsence' : role === 'model' ? 'modelAbsence' : role + 'Absence'] = role + '-absence';
  };
  const closeModel = async () => {
    const before = jsonOutput(await step('model-state-before-stop', ['inspect', containerId]))[0];
    assert.equal(before.Id, containerId);
    if (before.State.Running) await step('model-stop', ['kill', containerId]);
    const after = jsonOutput(await step('model-state-after-stop', ['inspect', containerId]))[0];
    assert.equal(after.Id, containerId);
    assert.equal(after.State.Running, false); assert.equal(after.State.Pid, 0);
    summary.containerClosed = true;
    return after.State;
  };
  try {
    const candidateBytes = fs.readFileSync(path.join(repository, 'config/node-bundle-candidate.json'));
    const generationBytes = fs.readFileSync(path.join(repository, 'config/node-bundle-generation.json'));
    generation = JSON.parse(generationBytes);
    candidate = task ? {...JSON.parse(candidateBytes), task} : baseCandidate;
    frozen = generationInputs({corpusPath, runId, providerPath}, candidate, readJson(path.join(repository, 'config/node-bundle-failed-tasks.json')), generation, readJson(path.join(repository, 'config/swe-bench-verified.json')), task);
    summary.candidate = verifyCandidate(candidate, candidateDir, effectiveCandidate.task);
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    writeJson(lockPath, {stage: 'generation', runId, instanceId: summary.instanceId, startedAt: new Date().toISOString()}); ownsLock = true;
    const disk = fs.statfsSync(evidenceDir); assert(disk.bavail * disk.bsize >= 12 * 1024 ** 3, 'Insufficient disk for image and root/terminal exports');
    fs.writeFileSync(path.join(evidenceDir, 'prompt.txt'), frozen.publicPrompt, {flag: 'wx'});
    fs.writeFileSync(path.join(evidenceDir, 'launch-prompt.txt'), frozen.prompt, {flag: 'wx'});
    summary.stage = 'image';
    await step('image-pull', ['pull', '--platform', 'linux/amd64', candidate.task.imageRef], {timeoutMs: 900_000});
    const image = jsonOutput(await step('image-inspect', ['image', 'inspect', candidate.task.imageRef]))[0];
    assert.equal(image.Architecture, 'amd64'); assert.equal(image.Os, 'linux'); assert(image.RepoDigests.includes(candidate.task.imageRef));
    assert.equal(image.Config.Entrypoint, null); assert.equal(image.Config.Volumes, null);
    containerId = output(await step('model-create', ['create', '--name', 'remaining63-node-' + runId + '-' + candidate.task.instanceId + '-model', '--platform', 'linux/amd64', '--network', 'bridge', '--memory', '6g', '--cpus', '4', image.Id, 'sleep', 'infinity'])).trim();
    assert.match(containerId, /^[a-f0-9]{64}$/); summary.containerId = containerId;
    await step('model-start', ['start', containerId]);
    const inspection = jsonOutput(await step('model-boundary', ['inspect', containerId]))[0];
    assert.equal(inspection.Id, containerId); assert.equal(inspection.Image, image.Id); assert.equal(inspection.Mounts.length, 0);
    assert.equal(inspection.HostConfig.Privileged, false); assert.equal(inspection.HostConfig.NetworkMode, 'bridge'); assert.notEqual(inspection.HostConfig.PidMode, 'host');
    assert.equal(inspection.HostConfig.Memory, 6 * 1024 ** 3); assert.equal(inspection.HostConfig.NanoCpus, 4_000_000_000);
    await step('directories', ['exec', containerId, 'mkdir', '-p', '/opt/agent', '/work']);
    await step('copy-node', ['cp', path.join(candidateDir, 'node-v24.15.0-linux-x64'), containerId + ':/opt/agent/node']);
    await step('copy-bundle', ['cp', path.join(candidateDir, 'best-agent.cjs'), containerId + ':/opt/agent/best-agent.cjs']);
    summary.stage = 'sanitation';
    await step('inventory-before', ['exec', containerId, '/usr/bin/find', '/', '-xdev', '-printf', '%y %s %p\n']);
    await step('copy-sanitizer', ['cp', path.join(repository, 'scripts/node-bundle-sanitize.mjs'), containerId + ':/work/sanitize.mjs']);
    const sanitationPlan = candidate.task.sanitationPlan ?? {mode: 'as-shipped', removals: ['build', 'dist', 'Django.egg-info'], installedEggPath: '/opt/miniconda3/envs/testbed/lib/python3.5/site-packages/Django-2.2.dev20180625180104-py3.5.egg/django'};
    assert(sanitationPlan.mode === 'as-shipped' && Array.isArray(sanitationPlan.removals) && sanitationPlan.removals.length > 0 && (sanitationPlan.installedEggPath === null || typeof sanitationPlan.installedEggPath === 'string'), 'Invalid sanitation plan');
    const sanitation = jsonOutput(await step('sanitize-base', ['exec', containerId, node, '/work/sanitize.mjs', candidate.task.baseCommit, JSON.stringify(sanitationPlan)], {timeoutMs: 300_000}));
    assert.equal(sanitation.git.baseCommit, candidate.task.baseCommit);
    assert.match(sanitation.git.headCommit, /^[a-f0-9]{40}$/);
    const headCommit = sanitation.git.headCommit;
    await step('remove-sanitizer', ['exec', containerId, 'rm', '/work/sanitize.mjs']);
    await step('freeze-base-git', ['cp', containerId + ':/testbed/.git', path.join(privateDir, 'base.git')]);
    const rootTar = path.join(privateDir, 'root.tar');
    await step('root-export', ['export', containerId], {timeoutMs: 300_000, stdoutPath: rootTar});
    // The root scan flags needle matches as prohibited-content. A match inside a /testbed
    // file that is byte-identical to the frozen base tree is base-era content the official
    // image legitimately ships (the model sees it either way); it is recorded but does not
    // fail sanitation. Everything else — untracked files, modified files, anything outside
    // /testbed — remains a hard failure. The map is built from the frozen base commit only.
    const baseEra = baseEraFileHashes(path.join(privateDir, 'base.git'), candidate.task.baseCommit);
    const baseGitlinks = treeGitlinks(path.join(privateDir, 'base.git'), candidate.task.baseCommit);
    writeJson(path.join(evidenceDir, 'base-era-files.json'), {files: baseEra, gitlinks: baseGitlinks});
    sanitation.content = inspectArchive(rootTar, frozen.needles, 'root', path.join(evidenceDir, 'root-archive-scan'), baseEra);
    sanitation.baseEraFiles = {count: Object.keys(baseEra).length, fileSetSha256: hash(JSON.stringify(Object.entries(baseEra).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))), gitlinkCount: baseGitlinks.length};
    sanitation.rootExportSha256 = fileHash(rootTar);
    writeJson(path.join(evidenceDir, 'sanitation.json'), sanitation);
    assert.equal(sanitation.content.passed, true, 'Root content sanitation failed');
    fs.unlinkSync(rootTar);
    await step('inventory-after', ['exec', containerId, '/usr/bin/find', '/', '-xdev', '-printf', '%y %s %p\n']);
    summary.stage = 'preflight';
    const pyEnv = pythonEnvironmentExpectations(candidate.task);
    const pyModule = pyEnv.module;
    const collect = `const fs=require('fs'),crypto=require('crypto'),{spawnSync}=require('child_process'),{DatabaseSync}=require('node:sqlite');const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const env={};for(const k of ['PATH','HOME','CONDA_PREFIX','CONDA_DEFAULT_ENV','CONDA_SHLVL','LANG','LC_ALL','LANGUAGE','PYTHONIOENCODING','LD_LIBRARY_PATH'])if(process.env[k]!==undefined)env[k]=process.env[k];env.PATH=process.env.CONDA_PREFIX+'/bin:/opt/agent/node/bin:'+env.PATH;env.PYTHONDONTWRITEBYTECODE='1';const p=spawnSync(process.env.CONDA_PREFIX+'/bin/python',['-B','-c','import sys,${pyModule},json; print(json.dumps(dict(version=sys.version.split()[0],prefix=sys.prefix,source=${pyModule}.__file__)))'],{cwd:'/testbed',env,encoding:'utf8'});if(p.status!==0){process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.status||1)}const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE probe(value); INSERT INTO probe VALUES (42)');const sqliteValue=db.prepare('SELECT value FROM probe').get().value;db.close();console.log(JSON.stringify({repoDir:'/testbed',pythonPrefix:process.env.CONDA_PREFIX,python:JSON.parse(p.stdout),node:{path:process.execPath,version:process.version,arch:process.arch,platform:process.platform,sha256:hash(process.execPath)},bundleSha256:hash('/opt/agent/best-agent.cjs'),sqliteValue,env}));`;
    const environment = jsonOutput(await step('environment', ['exec', containerId, '/usr/bin/env', '-i', 'HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/bin/bash', '--noprofile', '--norc', '-c', 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed && exec /opt/agent/node/bin/node -e "$1"', 'environment', collect]));
    assert.equal(environment.pythonPrefix, candidate.task.pythonPrefix); assert.equal(environment.python.prefix, candidate.task.pythonPrefix);
    if (pyEnv.version === null) assert.match(environment.python.version, /^\d+\.\d+\.\d+$/, 'Official image Python version is recorded as evidence');
    else assert.equal(environment.python.version, pyEnv.version);
    assert.equal(environment.python.source, pyEnv.source);
    assert.equal(environment.node.version, 'v24.15.0'); assert.equal(environment.node.sha256, candidate.node.binarySha256); assert.equal(environment.node.arch, 'x64'); assert.equal(environment.node.platform, 'linux'); assert.equal(environment.bundleSha256, candidate.bundle.sha256); assert.equal(environment.sqliteValue, 42);
    Object.assign(environment, {instanceId: frozen.task.instanceId, baseCommit: frozen.task.baseCommit, imageId: image.Id, imageRef: candidate.task.imageRef, imageDigest: candidate.task.imageRef.split('@')[1], containerId, platform: 'linux/amd64'});
    writeJson(path.join(evidenceDir, 'official-environment.json'), environment);
    await step('copy-environment', ['cp', path.join(evidenceDir, 'official-environment.json'), containerId + ':/work/environment.json']);
    await step('copy-probe', ['cp', path.join(repository, 'scripts/node-bundle-probe.mjs'), containerId + ':/work/probe.mjs']);
    await step('probe', ['exec', containerId, node, '/work/probe.mjs', '/work/probe', '/work/environment.json'], {timeoutMs: 120_000});
    fs.mkdirSync(path.join(evidenceDir, 'probe'));
    for (const name of ['stdout.txt', 'stderr.txt', 'result.json', 'requests.json', 'evidence.jsonl']) await step('probe-export-' + name, ['cp', containerId + ':/work/probe/' + name, path.join(evidenceDir, 'probe', name)]);
    const probe = readJson(path.join(evidenceDir, 'probe/result.json'));
    assert.equal(probe.status, 0); assert.equal(probe.timedOut, false); assert.equal(probe.realProvider, false); assert.equal(probe.proof, true); assert(probe.sqliteFiles.length > 0);
    const proof = inspectAttemptEvidence(path.join(evidenceDir, 'probe/evidence.jsonl')); assert(proof.complete && proof.rootStatus === 'completed');
    const fidelity = verifyProbeTranscript(fs.readFileSync(path.join(evidenceDir, 'probe/evidence.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), readJson(path.join(evidenceDir, 'probe/requests.json')));
    await step('copy-baseline-helper', ['cp', path.join(repository, 'scripts/node-bundle-capture.mjs'), containerId + ':/work/capture.mjs']);
    const baselineCode = "import {capturePatch} from '/work/capture.mjs'; console.log(JSON.stringify(capturePatch({repo:'/testbed',gitDir:'/testbed/.git',base:process.argv[1],headCommit:process.argv[2],outputDir:'/work/baseline'})));";
    const baseline = jsonOutput(await step('baseline', ['exec', containerId, node, '--input-type=module', '-e', baselineCode, frozen.task.baseCommit, headCommit]));
    assert.equal(baseline.bytes, 0); assert.equal(baseline.originalIndexUnchanged, true);
    await step('export-baseline', ['cp', containerId + ':/work/baseline', path.join(evidenceDir, 'baseline-capture')]);
    writeJson(path.join(evidenceDir, 'preflight-verification.json'), {probe, proof, fidelity, baseline, modelAttempt: false});
    await step('remove-preflight', ['exec', containerId, 'rm', '-rf', '/work/probe', '/work/probe.mjs', '/work/capture.mjs', '/work/baseline']);
    const admission = {stage: 'model', instanceId: frozen.task.instanceId, officialEnvironmentSha256: fileHash(path.join(evidenceDir, 'official-environment.json')), sanitationSha256: fileHash(path.join(evidenceDir, 'sanitation.json')), preflightSha256: fileHash(path.join(evidenceDir, 'preflight-verification.json')), promptSha256: hash(frozen.prompt), candidateManifestSha256: hash(candidateBytes), generationManifestSha256: hash(generationBytes), baseCommit: frozen.task.baseCommit, imageId: image.Id, imageRef: candidate.task.imageRef};
    writeJson(path.join(evidenceDir, 'model-admission.json'), admission);
    summary.stage = 'credential-injection';
    const providerRoot = path.dirname(providerPath);
    for (const [source, destination] of [[providerPath, '/work/credentials/provider.json'], [path.join(providerRoot, 'dimcode-home/config.json'), '/work/credentials/dimcode-home/config.json'], [path.join(providerRoot, 'dimcode-home/dimcode/auth.json'), '/work/credentials/dimcode-home/dimcode/auth.json']]) {
      await step('credential-inject', ['exec', '-i', containerId, node, '-e', "const f=require('fs'),p=process.argv[1];f.mkdirSync(require('path').dirname(p),{recursive:true,mode:0o700});f.writeFileSync(p,f.readFileSync(0),{flag:'wx',mode:0o600});", destination], {input: fs.readFileSync(source)});
    }
    await step('model-output-directories', ['exec', containerId, 'mkdir', '-p', '/work/artifacts', '/work/runtime']);
    const env = {...environment.env, BEST_AGENT_PROVIDER_CONFIG: '/work/credentials/provider.json', DIMCODE_HOME: '/work/credentials/dimcode-home', BEST_AGENT_STORAGE_ROOT: '/work/runtime'};
    const args = ['docker', 'exec', '-w', '/testbed', ...Object.entries(env).flatMap(([key, value]) => ['-e', key + '=' + value]), containerId, node, '/opt/agent/best-agent.cjs', 'run', '--no-base-instructions', '--workspace', '/testbed', '--workspace-backend', 'plain', '--workspace-authorization', 'unrestricted', '--command-policy', 'path', '--process-isolation', 'host', '--workspace-grant', 'read', '--workspace-grant', 'write', '--workspace-grant', 'exec', '--max-model-cycles', String(generation.maxModelCycles), '--model', generation.provider.model, '--artifact-dir', '/work/artifacts', '--attempt-evidence', '/work/attempt.jsonl', frozen.prompt];
    if (JSON.parse(Buffer.from(frozen.provider.apiKey.split('.')[1], 'base64url')).exp * 1000 <= Date.now() + generation.externalWatchdogMs) throw new Error('Provider expires before the model watchdog');
    summary.stage = 'model';
    writeJson(path.join(evidenceDir, 'model-claim.json'), {...admission, runId, evaluationBatchId: frozen.evaluationBatchId, attemptId: frozen.attemptId, startedAt: new Date().toISOString(), attempt: 1, diagnosticOnly: true, passAt1: null, externalWatchdogMs: generation.externalWatchdogMs, args});
    summary.modelAttempt = true;
    const processResult = await recordGenerationProcess(evidenceDir, 'model', args, {timeoutMs: generation.externalWatchdogMs, stdoutPath: path.join(evidenceDir, 'stdout.txt')});
    fs.renameSync(path.join(evidenceDir, 'model.stderr.txt'), path.join(evidenceDir, 'stderr.txt'));
    summary.process = {status: processResult.status, signal: processResult.signal, timedOut: processResult.timedOut, ...(processResult.error ? {error: processResult.error} : {}), stdoutSha256: processResult.stdout.sha256, stderrSha256: processResult.stderr.sha256};
    summary.stage = 'closure';
    summary.process.containerState = await closeModel(); summary.process.containerClosed = true;
    writeJson(path.join(evidenceDir, 'process-receipt.json'), summary.process);
    summary.stage = 'export';
    summary.exports = await collectTerminalExports(containerId, evidenceDir);
    assert(modelRemovalSafe(summary), 'Terminal exports incomplete; retain stopped model container and operation lock');
    await remove(containerId, 'model'); summary.containerRemoved = true;
    summary.evidence = inspectAttemptEvidence(path.join(terminal, 'attempt.jsonl'));
    writeJson(path.join(terminal, 'evidence-admission.json'), summary.evidence);
    summary.stage = 'capture';
    const archiveAdmission = inspectArchive(path.join(terminal, 'workspace.tar'), [], 'workspace', path.join(evidenceDir, 'workspace-archive-scan'));
    assert(archiveAdmission.passed); writeJson(path.join(terminal, 'workspace-admission.json'), archiveAdmission);
    captureId = output(await step('capture-create', ['create', '--name', 'remaining63-node-' + runId + '-' + candidate.task.instanceId + '-capture', '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g', image.Id, 'sleep', 'infinity'])).trim();
    assert.match(captureId, /^[a-f0-9]{64}$/); summary.captureContainerId = captureId; summary.captureContainerRemoved = false;
    await step('capture-start', ['start', captureId]);
    const boundary = jsonOutput(await step('capture-boundary', ['inspect', captureId]))[0];
    assert.equal(boundary.Id, captureId); assert.equal(boundary.Image, image.Id); assert.equal(boundary.Mounts.length, 0); assert.equal(boundary.HostConfig.NetworkMode, 'none'); assert.equal(boundary.HostConfig.Privileged, false); assert.notEqual(boundary.HostConfig.PidMode, 'host');
    await step('capture-clear-original', captureExec(captureId, 'rm', '-rf', '/testbed'));
    await step('capture-directories', captureExec(captureId, 'mkdir', '-p', '/restore', '/capture', '/opt/agent'));
    await step('capture-restore', ['cp', '-', captureId + ':/restore/'], {inputPath: path.join(terminal, 'workspace.tar'), timeoutMs: 180_000});
    await step('capture-place-worktree', captureExec(captureId, 'mv', '/restore/testbed', '/testbed'));
    await step('capture-remove-untrusted-git', ['exec', captureId, 'rm', '-rf', '/testbed/.git']);
    await step('capture-trusted-git', ['cp', path.join(privateDir, 'base.git'), captureId + ':/capture/base.git']);
    await step('capture-node', ['cp', path.join(candidateDir, 'node-v24.15.0-linux-x64'), captureId + ':/opt/agent/node']);
    await step('capture-helper', ['cp', path.join(repository, 'scripts/node-bundle-capture.mjs'), captureId + ':/capture/helper.mjs']);
    await step('capture-patch', ['exec', captureId, node, '/capture/helper.mjs', frozen.task.baseCommit, headCommit], {timeoutMs: 200_000});
    await step('capture-export', ['cp', captureId + ':/capture/output', path.join(terminal, 'captured')]);
    summary.capture = readJson(path.join(terminal, 'captured/receipt.json'));
    assert.equal(fileHash(path.join(terminal, 'captured/diagnostic.patch')), summary.capture.sha256);
    await remove(captureId, 'capture'); summary.captureContainerRemoved = true;
    summary.predictionEligible = predictionEligible(summary);
    if (summary.predictionEligible) {
      const patch = fs.readFileSync(path.join(terminal, 'captured/diagnostic.patch'), 'utf8');
      assert.equal(hash(patch), summary.capture.sha256, 'Patch UTF-8 roundtrip changed bytes');
      writeJson(path.join(terminal, 'prediction.json'), {schemaVersion: 1, evaluationBatchId: frozen.evaluationBatchId, attemptId: frozen.attemptId, instanceId: frozen.task.instanceId, modelNameOrPath: candidate.candidateId + '-' + generation.provider.model, modelPatch: patch, modelPatchSha256: summary.capture.sha256});
      summary.predictionPresent = true;
    }
    summary.status = 'completed'; summary.stage = 'terminal';
  } catch (error) { summary.error = String(error); }
  finally {
    if (containerId && !summary.modelAttempt && !summary.containerRemoved && summary.stage === 'preflight') {
      fs.mkdirSync(path.join(evidenceDir, 'probe'), {recursive: true});
      for (const name of ['stdout.txt', 'stderr.txt', 'result.json', 'requests.json', 'evidence.jsonl']) {
        const destination = path.join(evidenceDir, 'probe', name);
        if (!fs.existsSync(destination)) await recordGenerationProcess(evidenceDir, 'partial-probe-' + name, ['docker', 'cp', containerId + ':/work/probe/' + name, destination]);
      }
    }
    if (containerId && !summary.containerRemoved) {
      try {
        if (!summary.containerClosed) await closeModel();
        if (summary.modelAttempt && !summary.exports) summary.exports = await collectTerminalExports(containerId, evidenceDir);
        if (modelRemovalSafe(summary)) { await remove(containerId, 'model-final'); summary.containerRemoved = true; }
        else summary.cleanupError = 'Stopped model container retained because terminal exports are incomplete';
      }
      catch (error) { summary.cleanupError = String(error); }
    }
    if (captureId && !summary.captureContainerRemoved) {
      if (!fs.existsSync(path.join(terminal, 'captured'))) await recordGenerationProcess(evidenceDir, 'partial-capture-export', ['docker', 'cp', captureId + ':/capture/output', path.join(terminal, 'captured')]);
      try { await remove(captureId, 'capture-final'); summary.captureContainerRemoved = true; }
      catch (error) { summary.captureCleanupError = String(error); }
    }
    if (summary.process && !fs.existsSync(path.join(evidenceDir, 'process-receipt.json'))) writeJson(path.join(evidenceDir, 'process-receipt.json'), {...summary.process, containerClosed: summary.containerClosed});
    fs.rmSync(privateDir, {recursive: true, force: true});
    if (ownsLock && (!containerId || summary.containerRemoved) && (!captureId || summary.captureContainerRemoved)) fs.unlinkSync(lockPath);
    summary.finishedAt = new Date().toISOString();
    writeJson(path.join(terminal, 'summary.json'), summary);
  }
  return summary;
}
