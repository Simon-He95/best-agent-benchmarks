import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectAttemptEvidence, runCliProcess} from './swe-bench-harness.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyTaskIdentity(task, instanceId) {
  assert.equal(task.instanceId, instanceId);
  assert.equal(task.pythonPrefix, '/opt/miniconda3/envs/testbed');
  assert.match(task.baseCommit, /^[a-f0-9]{40}$/);
  const imagePattern = '^swebench/sweb\\.eval\\.x86_64\\.' + instanceId.replace('__', '_1776_') + '@sha256:[a-f0-9]{64}' + '$';
  assert.match(task.imageRef, new RegExp(imagePattern));
}

export function verifyCandidate(manifest, candidateDir, instanceId = 'django__django-10097') {
  assert.equal(manifest.node.version, '24.15.0');
  verifyTaskIdentity(manifest.task, instanceId);
  const files = [
    ['best-agent.cjs', manifest.bundle.sha256, manifest.bundle.bytes],
    ['node-v24.15.0-linux-x64.tar.xz', manifest.node.archiveSha256],
    ['node-v24.15.0-linux-x64/bin/node', manifest.node.binarySha256],
  ];
  return files.map(([name, expected, bytes]) => {
    assert.match(expected, /^[a-f0-9]{64}$/);
    const data = fs.readFileSync(path.join(candidateDir, name));
    assert.equal(sha256(data), expected, name + ' SHA256 mismatch');
    if (bytes !== undefined) assert.equal(data.length, bytes, name + ' size mismatch');
    return {name, bytes: data.length, sha256: expected};
  });
}

export async function runRecordedStep(directory, name, args, timeoutMs) {
  const stdoutPath = path.join(directory, name + '.stdout.txt');
  const stderrPath = path.join(directory, name + '.stderr.txt');
  const result = await runCliProcess({args, timeoutMs, stdoutPath, stderrPath});
  const {stdout, stderr, ...process} = result;
  fs.writeFileSync(path.join(directory, name + '.process.json'), JSON.stringify({
    args, timeoutMs, ...process,
    stdout: {bytes: fs.statSync(stdoutPath).size, sha256: sha256(fs.readFileSync(stdoutPath))},
    stderr: {bytes: fs.statSync(stderrPath).size, sha256: sha256(fs.readFileSync(stderrPath))},
  }, null, 2) + '\n', {flag: 'wx'});
  if (result.status !== 0 || result.signal !== null || result.timedOut || result.error) {
    throw new Error(`${name} failed: ${JSON.stringify(process)}; stdout=${stdoutPath}; stderr=${stderrPath}`);
  }
  return result;
}

export function verifyProbeTranscript(rows, wire) {
  const requests = rows.filter(row => row.type === 'model-request');
  const outcomes = rows.filter(row => row.type === 'model-outcome');
  const snapshot = rows.find(row => row.type === 'terminal-snapshot').snapshot;
  const results = snapshot.transcript.filter(entry => entry.kind === 'tool');
  const calls = outcomes.flatMap(row => (row.outcome.candidate?.toolCalls ?? []).map(call => ({call, sequence: row.sequence})));
  assert.equal(requests.length, wire.length);
  assert.equal(calls.length, results.length);
  assert(calls.length >= 10);
  assert.deepEqual(calls.slice(0, 9).map(item => item.call.name), ['write', 'exec', 'write', 'read', 'stat', 'list', 'search', 'edit', 'process-start']);
  const processRef = results.find(entry => entry.result.callId === calls[8].call.callId).result.closure.payload.processRef;
  for (const {call} of calls.slice(9)) {
    assert.equal(call.name, 'process-read');
    assert.deepEqual(call.input.processRef, processRef);
  }
  for (const {call, sequence} of calls) {
    const result = results.find(entry => entry.result.callId === call.callId);
    const next = requests.find(request => request.sequence > sequence);
    assert(result && next, 'Every probe call must reach a next request');
    assert.deepEqual(next.request.messages.find(message => message.kind === 'tool' && message.result.callId === call.callId), result);
    const message = wire[requests.indexOf(next)].messages.find(message => message.tool_call_id === call.callId);
    assert(message, 'Provider wire result missing');
    assert.deepEqual(JSON.parse(message.content), result.result.closure);
  }
  return {toolResults: calls.length, processReads: calls.length - 9, firstNextExact: calls.length, providerWireExact: calls.length};
}

export async function preflight(candidateDir, evidenceDir) {
  candidateDir = path.resolve(candidateDir);
  evidenceDir = path.resolve(evidenceDir);
  fs.mkdirSync(evidenceDir, {recursive: true});
  const manifestPath = path.join(repository, 'config/node-bundle-candidate.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  fs.writeFileSync(path.join(evidenceDir, 'preflight-claim.json'), JSON.stringify({
    at: new Date().toISOString(), instanceId: manifest.task.instanceId,
    manifestSha256: sha256(manifestBytes), modelAttempt: false,
  }, null, 2) + '\n', {flag: 'wx'});
  let containerId;
  let failure;
  const summary = {status: 'failed', modelAttempt: false, modelAdmission: false, sanitationReviewed: false, diagnosticOnly: true, passAt1: null};
  const step = (name, args, timeout = 60_000) => runRecordedStep(evidenceDir, name, ['docker', ...args], timeout);
  try {
    summary.candidate = verifyCandidate(manifest, candidateDir);
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const before = fs.statfsSync(evidenceDir);
    summary.diskBeforePull = {availableBytes: before.bavail * before.bsize};
    assert(summary.diskBeforePull.availableBytes >= 8 * 1024 ** 3, 'Less than 8 GiB available before preflight pull');
    await step('image-pull', ['pull', '--platform', 'linux/amd64', manifest.task.imageRef], 900_000);
    const image = JSON.parse((await step('image-inspect', ['image', 'inspect', manifest.task.imageRef])).stdout)[0];
    assert.equal(image.Architecture, 'amd64');
    assert.equal(image.Os, 'linux');
    assert(image.RepoDigests.includes(manifest.task.imageRef));
    summary.image = {id: image.Id, ref: manifest.task.imageRef, bytes: image.Size, architecture: image.Architecture};
    const after = fs.statfsSync(evidenceDir);
    summary.diskAfterPull = {availableBytes: after.bavail * after.bsize};
    assert(summary.diskAfterPull.availableBytes >= 1024 ** 3, 'Less than 1 GiB remains for preflight evidence');
    const name = 'node-bundle-preflight-' + randomUUID();
    containerId = (await step('container-create', ['create', '--name', name, '--platform', 'linux/amd64', '--network', 'bridge', '--memory', '6g', '--cpus', '4', image.Id, 'sleep', 'infinity'])).stdout.trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    await step('container-start', ['start', containerId]);
    const inspection = JSON.parse((await step('container-inspect', ['inspect', containerId])).stdout)[0];
    assert.equal(inspection.Id, containerId);
    assert.equal(inspection.Image, image.Id);
    assert.equal(inspection.Mounts.length, 0);
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.equal(inspection.HostConfig.NetworkMode, 'bridge');
    assert.notEqual(inspection.HostConfig.PidMode, 'host');
    assert.equal(inspection.HostConfig.Memory, 6 * 1024 ** 3);
    assert.equal(inspection.HostConfig.NanoCpus, 4_000_000_000);
    summary.containerId = containerId;
    await step('directories', ['exec', containerId, 'mkdir', '-p', '/opt/agent', '/work']);
    await step('copy-node', ['cp', path.join(candidateDir, 'node-v24.15.0-linux-x64'), containerId + ':/opt/agent/node']);
    await step('copy-bundle', ['cp', path.join(candidateDir, 'best-agent.cjs'), containerId + ':/opt/agent/best-agent.cjs']);
    await step('copy-probe', ['cp', path.join(repository, 'scripts/node-bundle-probe.mjs'), containerId + ':/work/probe.mjs']);
    const collect = `
const fs=require('fs'),crypto=require('crypto'),{spawnSync}=require('child_process'),{DatabaseSync}=require('node:sqlite');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const env={};for(const key of ['PATH','HOME','CONDA_PREFIX','CONDA_DEFAULT_ENV','CONDA_SHLVL','LANG','LC_ALL','LANGUAGE','PYTHONIOENCODING','LD_LIBRARY_PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
env.PATH=process.env.CONDA_PREFIX+'/bin:/opt/agent/node/bin:'+env.PATH;env.PYTHONDONTWRITEBYTECODE='1';
const python=spawnSync(process.env.CONDA_PREFIX+'/bin/python',['-B','-c','import sys,django,json; print(json.dumps(dict(version=sys.version.split()[0],prefix=sys.prefix,source=django.__file__)))'],{cwd:'/testbed',env,encoding:'utf8'});
if(python.status!==0){process.stderr.write(python.stderr);process.stdout.write(python.stdout);process.exit(python.status||1);}
const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE probe(value); INSERT INTO probe VALUES (42)');const value=database.prepare('SELECT value FROM probe').get().value;database.close();
const facts={repoDir:'/testbed',pythonPrefix:process.env.CONDA_PREFIX,python:JSON.parse(python.stdout),node:{path:process.execPath,version:process.version,arch:process.arch,platform:process.platform,sha256:hash(process.execPath)},bundleSha256:hash('/opt/agent/best-agent.cjs'),sqliteValue:value,env};
fs.writeFileSync('/work/environment.json',JSON.stringify(facts,null,2),{flag:'wx'});console.log(JSON.stringify(facts));`;
    const activate = 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed && exec /opt/agent/node/bin/node -e "$1"';
    const environment = JSON.parse((await step('environment', ['exec', containerId, '/usr/bin/env', '-i', 'HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/bin/bash', '--noprofile', '--norc', '-c', activate, 'preflight', collect])).stdout);
    assert.equal(environment.pythonPrefix, manifest.task.pythonPrefix);
    assert.equal(environment.python.prefix, manifest.task.pythonPrefix);
    assert.match(environment.python.version, /^3\.5\./);
    assert.equal(environment.python.source, '/testbed/django/__init__.py');
    assert.equal(environment.node.version, 'v' + manifest.node.version);
    assert.equal(environment.node.arch, 'x64');
    assert.equal(environment.node.platform, 'linux');
    assert.equal(environment.node.sha256, manifest.node.binarySha256);
    assert.equal(environment.bundleSha256, manifest.bundle.sha256);
    assert.equal(environment.sqliteValue, 42);
    summary.environment = environment;
    await step('root-inventory', ['exec', containerId, '/usr/bin/find', '/', '-xdev', '-printf', '%y %s %p\n']);
    await step('workspace-size', ['exec', containerId, 'du', '-sk', '/testbed']);
    const base = await step('base-identity', ['exec', '-w', '/testbed', containerId, '/usr/bin/git', 'rev-parse', manifest.task.baseCommit + '^{commit}']);
    assert.equal(base.stdout.trim(), manifest.task.baseCommit);
    await step('probe', ['exec', containerId, '/opt/agent/node/bin/node', '/work/probe.mjs', '/work/probe', '/work/environment.json'], 120_000);
    fs.mkdirSync(path.join(evidenceDir, 'probe'));
    for (const name of ['stdout.txt', 'stderr.txt', 'result.json', 'requests.json', 'evidence.jsonl']) {
      await step('export-probe-' + name, ['cp', containerId + ':/work/probe/' + name, path.join(evidenceDir, 'probe', name)]);
    }
    const probe = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'probe/result.json')));
    assert.equal(probe.status, 0);
    assert.equal(probe.timedOut, false);
    assert.equal(probe.realProvider, false);
    assert.equal(probe.proof, true);
    assert(probe.sqliteFiles.length > 0);
    const admission = inspectAttemptEvidence(path.join(evidenceDir, 'probe/evidence.jsonl'));
    assert.equal(admission.complete, true);
    assert.equal(admission.rootStatus, 'completed');
    const rows = fs.readFileSync(path.join(evidenceDir, 'probe/evidence.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const wire = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'probe/requests.json')));
    summary.probe = probe;
    summary.evidence = admission;
    summary.fidelity = verifyProbeTranscript(rows, wire);
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.error = String(error);
  } finally {
    if (containerId) {
      fs.mkdirSync(path.join(evidenceDir, 'probe'), {recursive: true});
      for (const [name, args] of [
        ['container-stop', ['stop', '--time', '5', containerId]],
        ...['stdout.txt', 'stderr.txt', 'result.json', 'requests.json', 'evidence.jsonl'].filter(name => !fs.existsSync(path.join(evidenceDir, 'probe', name))).map(name => ['export-partial-probe-' + name, ['cp', containerId + ':/work/probe/' + name, path.join(evidenceDir, 'probe', name)]]),
        ['container-remove', ['rm', containerId]],
      ]) {
        try { await step(name, args); }
        catch (error) {
          summary.cleanupErrors ??= [];
          summary.cleanupErrors.push(String(error));
          if (!name.startsWith('export-partial-probe-')) { failure ??= error; summary.status = 'failed'; }
        }
      }
      try { const remaining = await step('container-absence', ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + containerId]); assert.equal(remaining.stdout.trim(), ''); summary.containerRemoved = true; }
      catch (error) { failure ??= error; summary.status = 'failed'; summary.cleanupErrors ??= []; summary.cleanupErrors.push(String(error)); }
    }
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidenceDir, 'preflight-summary.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  }
  if (failure) throw failure;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: swe-node-bundle-preflight.mjs <candidate-dir> <evidence-dir>');
  preflight(process.argv[2], process.argv[3]).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
