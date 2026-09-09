import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {sanitizeRepository, verifyBaseObjects, verifyInstalledDjango, inspectArchive} from '../scripts/node-bundle-sanitize.mjs';
import {capturePatch} from '../scripts/node-bundle-capture.mjs';
import {generationInputs, predictionEligible, recordGenerationProcess, generateNodeBundleTask, collectTerminalExports, modelRemovalSafe} from '../scripts/generate-node-bundle-one.mjs';
import {buildTaskPrompt} from '../scripts/swe-bench-harness.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-generation-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const repo = path.join(directory, 'testbed'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('/usr/bin/git', args, {cwd: repo, env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'}, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  git('init'); fs.mkdirSync(path.join(repo, 'django')); fs.writeFileSync(path.join(repo, 'django/__init__.py'), 'base = True\n'); fs.writeFileSync(path.join(repo, 'delete-me'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  return {directory, repo, git, base};
}

test('sanitation removes future refs and unreachable objects while retaining the base tree', t => {
  const {repo, git, base} = fixture(t);
  fs.writeFileSync(path.join(repo, 'solution'), 'future answer\n'); git('add', '.'); git('commit', '-m', 'future'); const future = git('rev-parse', 'HEAD'); git('tag', 'future');
  git('checkout', '--detach', base);
  const receipt = sanitizeRepository(repo, base);
  assert.equal(receipt.commitObjects, 1); assert.equal(receipt.allObjectsReachableFromBase, true);
  assert.throws(() => git('cat-file', '-e', future));
  const extra = execFileSync('/usr/bin/git', ['hash-object', '-w', '--stdin'], {cwd: repo, input: 'unreachable secret answer', encoding: 'utf8'}).trim();
  assert(extra); assert.throws(() => verifyBaseObjects(repo, base), /Unreachable or future/);
});

test('sanitation rejects unexplained setup source changes', t => {
  const {repo, base} = fixture(t);
  fs.writeFileSync(path.join(repo, 'django/__init__.py'), 'changed = True\n');
  assert.throws(() => sanitizeRepository(repo, base), /tracked source differs/);
});

test('installed project must match tracked base; project bytecode is removed', t => {
  const {directory, repo, base} = fixture(t); sanitizeRepository(repo, base);
  const installed = path.join(directory, 'installed'); fs.mkdirSync(installed);
  fs.copyFileSync(path.join(repo, 'django/__init__.py'), path.join(installed, '__init__.py'));
  fs.writeFileSync(path.join(installed, '__init__.pyc'), 'opaque bytecode');
  assert.equal(verifyInstalledDjango(repo, installed).removedBytecode, 1);
  fs.writeFileSync(path.join(installed, '__init__.py'), 'future source');
  assert.throws(() => verifyInstalledDjango(repo, installed), /differs from base/);
  fs.copyFileSync(path.join(repo, 'django/__init__.py'), path.join(installed, '__init__.py'));
  fs.writeFileSync(path.join(installed, 'untracked.py'), 'future source'); fs.writeFileSync(path.join(repo, 'django/untracked.py'), 'future source');
  assert.throws(() => verifyInstalledDjango(repo, installed), /not in base/);
});

test('capture uses a private index and trusted config, including deleted, executable and binary files', t => {
  const {directory, repo, git, base} = fixture(t); sanitizeRepository(repo, base);
  const gitDir = path.join(directory, 'trusted.git'); fs.cpSync(path.join(repo, '.git'), gitDir, {recursive: true});
  const baseline = capturePatch({repo, gitDir, base, outputDir: path.join(directory, 'baseline')}); assert.equal(baseline.bytes, 0);
  const marker = path.join(directory, 'FILTER-RAN');
  git('config', 'filter.evil.clean', 'touch ' + marker); git('config', 'core.fsmonitor', 'touch ' + marker);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
  fs.unlinkSync(path.join(repo, 'delete-me'));
  fs.writeFileSync(path.join(repo, 'script'), '#!/bin/sh\ntrue\n', {mode: 0o755});
  fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([0, 1, 255, 0]));
  const result = capturePatch({repo, gitDir, base, outputDir: path.join(directory, 'captured')});
  assert.equal(result.originalIndexUnchanged, true); assert(!fs.existsSync(marker));
  const patch = fs.readFileSync(path.join(directory, 'captured/diagnostic.patch'), 'utf8');
  assert.match(patch, /deleted file mode/); assert.match(patch, /new file mode 100755/); assert.match(patch, /GIT binary patch/);
});

function makeArchive(filename, members, zip = false) {
  execFileSync('python3', ['-c', `import json,sys,tarfile,zipfile,io,gzip\nr=json.load(sys.stdin)\nwith tarfile.open(r['path'],'w') as a:\n for m in r['members']:\n  b=m.get('data','').encode()\n  if r['zip']:\n   s=io.BytesIO()\n   with zipfile.ZipFile(s,'w') as z: z.writestr('answer.txt',b)\n   b=s.getvalue()\n   if r['zip']=='gzip': b=gzip.compress(b)\n  i=tarfile.TarInfo(m['name']);i.size=len(b)\n  if m.get('directory'): i.type=tarfile.DIRTYPE;i.size=0\n  if 'link' in m: i.type=tarfile.SYMTYPE;i.linkname=m['link'];i.size=0\n  a.addfile(i,io.BytesIO(b) if i.isfile() else None)`], {input: JSON.stringify({path: filename, members, zip})});
}

test('root scan detects archived answer bytes and extra Git without echoing private needles', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'root.tar');
  makeArchive(archive, [{name: 'root/cache.zip', data: 'private-answer-material-123'}], true);
  const receipt = inspectArchive(archive, ['private-answer-material-123']);
  assert.equal(receipt.passed, false); assert(receipt.archives.length > 0); assert(!JSON.stringify(receipt).includes('private-answer-material-123'));
  makeArchive(archive, [{name: 'root/cache.gz', data: 'private-answer-material-123'}], 'gzip');
  const compressed = inspectArchive(archive, ['private-answer-material-123']);
  assert.equal(compressed.passed, false); assert.equal(compressed.archives.length, 2);
  makeArchive(archive, [{name: 'hidden/repo/.git/config', data: 'git config'}]);
  assert.equal(inspectArchive(archive).passed, false);
  makeArchive(archive, [{name: 'testbed/.git/config', data: 'base metadata'}, {name: 'testbed/tests/public.py', data: 'public test'}]);
  assert.equal(inspectArchive(archive).passed, true);
});

test('workspace archive admits ordinary symlinks but rejects traversal and link ancestry', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'workspace.tar');
  makeArchive(archive, [{name: 'testbed', directory: true}, {name: 'testbed/a', data: 'terminal'}, {name: 'testbed/link', link: '/tmp/target'}]);
  assert.equal(inspectArchive(archive, [], 'workspace').passed, true);
  makeArchive(archive, [{name: '../capture/helper.mjs', data: 'bad'}]);
  assert.throws(() => inspectArchive(archive, [], 'workspace'), /without admission/);
  makeArchive(archive, [{name: 'testbed', directory: true}, {name: 'testbed/link', link: '/capture'}, {name: 'testbed/link/helper.mjs', data: 'bad'}]);
  assert.throws(() => inspectArchive(archive, [], 'workspace'), /without admission/);
  makeArchive(archive, [{name: 'testbed', link: '/capture'}]);
  assert.throws(() => inspectArchive(archive, [], 'workspace'), /without admission/);
});

test('input admission binds public prompt/corpus/provider/run and keeps private grading fields out of prompt', t => {
  const {directory} = fixture(t), corpusPath = path.join(directory, 'corpus.jsonl'), providerPath = path.join(directory, 'provider.json');
  const row = {instance_id: 'django__django-10097', base_commit: 'a'.repeat(40), repo: 'django/django', problem_statement: 'Public issue', patch: 'PRIVATE GOLD', test_patch: 'PRIVATE TEST'};
  const bytes = JSON.stringify(row) + '\n'; fs.writeFileSync(corpusPath, bytes);
  const provider = {model: 'deepseek-v4-flash', reasoningEffort: 'high'};
  fs.writeFileSync(providerPath, JSON.stringify({...provider, apiKey: 'a.' + Buffer.from(JSON.stringify({exp: Math.ceil(Date.now() / 1000) + 7200})).toString('base64url') + '.signature'}));
  const candidate = {candidateId: 'frozen', task: {instanceId: row.instance_id, baseCommit: row.base_commit}};
  const selection = {tasks: [{instanceId: row.instance_id, repo: row.repo, baseCommit: row.base_commit, promptSha256: hash(buildTaskPrompt(row.problem_statement))}]};
  const generation = {candidateId: 'frozen', maxModelCycles: 2251799813685247, externalWatchdogMs: 3600000, provider};
  const profile = {jsonlBytes: Buffer.byteLength(bytes), jsonlSha256: hash(bytes)};
  const input = {corpusPath, providerPath, runId: '123'};
  const result = generationInputs(input, candidate, selection, generation, profile);
  assert(!result.prompt.includes('PRIVATE')); assert(result.needles.includes('PRIVATE GOLD')); assert.equal(result.attemptId, 'django__django-10097-node-123-001');
  assert.throws(() => generationInputs({...input, runId: '1;bad'}, candidate, selection, generation, profile));
  fs.appendFileSync(corpusPath, 'changed'); assert.throws(() => generationInputs(input, candidate, selection, generation, profile));
});

test('one-attempt claim refuses reruns before reaching Docker', async t => {
  const {directory} = fixture(t), evidenceDir = path.join(directory, 'evidence'); fs.mkdirSync(evidenceDir); fs.writeFileSync(path.join(evidenceDir, 'model-claim.json'), '{}');
  await assert.rejects(generateNodeBundleTask({candidateDir: directory, evidenceDir, corpusPath: 'unused', providerPath: path.join(directory, 'provider.json'), runId: '123'}), /claim already exists/);
});

test('recorded process preserves full stdout/stderr and timeout without recording stdin', async t => {
  const {directory} = fixture(t);
  const result = await recordGenerationProcess(directory, 'failure', [process.execPath, '-e', "process.stdout.write('x'.repeat(9*1024*1024));process.stderr.write('raw failure');process.exitCode=23"], {input: 'private-stdin'});
  assert.equal(result.status, 23); assert.equal(result.stdout.bytes, 9 * 1024 ** 2); assert.equal(fs.readFileSync(result.stderrPath, 'utf8'), 'raw failure');
  assert(!fs.readFileSync(path.join(directory, 'failure.process.json'), 'utf8').includes('private-stdin'));
  const timeout = await recordGenerationProcess(directory, 'timeout', [process.execPath, '-e', 'setInterval(()=>{},1000)'], {timeoutMs: 100});
  assert.equal(timeout.timedOut, true); assert.equal(timeout.signal, 'SIGKILL');
});

test('prediction requires complete evidence, normal model exit, nonempty patch and both exact closures', () => {
  const good = {process: {status: 0, signal: null, timedOut: false}, containerClosed: true, containerRemoved: true, captureContainerRemoved: true, evidence: {complete: true, rootStatus: 'completed'}, exports: Array.from({length: 4}, () => ({status: 0, signal: null, timedOut: false, sha256: 'a'.repeat(64)})), capture: {status: 'captured', bytes: 1}};
  assert.equal(predictionEligible(good), true);
  for (const replacement of [{containerClosed: false}, {containerRemoved: false}, {captureContainerRemoved: false}, {process: {status: 0, signal: null, timedOut: true}}, {evidence: {complete: false}}, {capture: {status: 'captured', bytes: 0}}, {exports: []}]) assert.equal(predictionEligible({...good, ...replacement}), false);
});

test('post-model export failure preserves partial bytes, attempts remaining exports and blocks container removal', async t => {
  const {directory} = fixture(t); fs.mkdirSync(path.join(directory, 'terminal'));
  const calls = [];
  const exports = await collectTerminalExports('f'.repeat(64), directory, async (dir, name, args, options) => {
    calls.push(name);
    const destination = options.stdoutPath ?? args.at(-1);
    fs.writeFileSync(destination, name === 'export-attempt.jsonl' ? 'partial raw trajectory\n' : 'complete terminal bytes\n', {flag: 'wx'});
    return {status: name === 'export-attempt.jsonl' ? 23 : 0, signal: null, timedOut: false};
  });
  assert.equal(calls.length, 4);
  assert.equal(fs.readFileSync(path.join(directory, 'terminal/attempt.jsonl'), 'utf8'), 'partial raw trajectory\n');
  assert.equal(exports[0].status, 23); assert(exports.every(entry => entry.sha256));
  assert.equal(modelRemovalSafe({modelAttempt: true, containerClosed: true, exports}), false);
  assert.equal(modelRemovalSafe({modelAttempt: true, containerClosed: false, exports: exports.map(entry => ({...entry, status: 0}))}), false);
  assert.equal(modelRemovalSafe({modelAttempt: true, containerClosed: true, exports: exports.map(entry => ({...entry, status: 0}))}), true);
  assert.equal(modelRemovalSafe({modelAttempt: true, containerClosed: true}), false);
});


test('failed archive inspection preserves hashed diagnostics without recording private stdin', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'broken.tar');
  fs.writeFileSync(archive, 'not a tar archive');
  const prefix = path.join(directory, 'scan');
  assert.throws(() => inspectArchive(archive, ['private-comparison-value'], 'root', prefix), /without admission/);
  const receipt = JSON.parse(fs.readFileSync(prefix + '.process.json', 'utf8'));
  assert.equal(receipt.status, 1);
  assert.equal(receipt.timedOut, false);
  for (const stream of ['stdout', 'stderr']) {
    const bytes = fs.readFileSync(prefix + '.' + stream + '.txt');
    assert.equal(receipt[stream].sha256, hash(bytes));
    assert.equal(receipt[stream].sizeBytes, bytes.length);
    assert(!bytes.includes('private-comparison-value'));
  }
  assert.match(fs.readFileSync(prefix + '.stderr.txt', 'utf8'), /ReadError/);
});


test('ZIP signature constants in ordinary binary data are not an archive or a content-scan bypass', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'root.tar');
  const bytes = Buffer.concat([Buffer.from('compiled-module-private-marker'), Buffer.from('504b0506000000000100010001000000ffffffff0000', 'hex')]);
  execFileSync('python3', ['-c', `import tarfile,io,sys
b=bytes.fromhex(sys.argv[2])
with tarfile.open(sys.argv[1],'w') as t:
 m=tarfile.TarInfo('lib/zipfile.pyc');m.size=len(b);t.addfile(m,io.BytesIO(b))`, archive, bytes.toString('hex')]);
  assert.equal(inspectArchive(archive).passed, true);
  assert.equal(inspectArchive(archive, ['private-marker']).passed, false);
  execFileSync('python3', ['-c', `import tarfile,io,sys,zipfile
b=bytes.fromhex(sys.argv[2]);assert zipfile.is_zipfile(io.BytesIO(b))
try: zipfile.ZipFile(io.BytesIO(b))
except zipfile.BadZipFile: pass
else: raise AssertionError('fixture is not the observed false positive')
with tarfile.open(sys.argv[1],'w') as t:
 m=tarfile.TarInfo('broken.zip');m.size=len(b);t.addfile(m,io.BytesIO(b))`, archive, bytes.toString('hex')]);
  assert.equal(inspectArchive(archive).passed, false);
  assert.equal(inspectArchive(archive).findings[0].reason, 'archive-decoder-error');
  execFileSync('python3', ['-c', `import tarfile,io,sys,zipfile
b=io.BytesIO(b'ordinary-prefix');b.seek(0,2)
with zipfile.ZipFile(b,'a',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('hidden','private-marker')
with tarfile.open(sys.argv[1],'w') as t:
 data=b.getvalue();m=tarfile.TarInfo('lib/binary.pyc');m.size=len(data);t.addfile(m,io.BytesIO(data))`, archive]);
  assert.equal(inspectArchive(archive, ['private-marker']).passed, false);
});


test('central-directory signatures embedded in non-ZIP bytes require matching local headers', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'root.tar');
  execFileSync('python3', ['-c', `import tarfile,io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:z.writestr('entry','private-marker')
data=b'JUNK'+b.getvalue()[4:]
assert zipfile.is_zipfile(io.BytesIO(data))
with zipfile.ZipFile(io.BytesIO(data)) as z:
 try: z.open('entry')
 except zipfile.BadZipFile: pass
 else: raise AssertionError('not the observed local-header mismatch')
with tarfile.open(sys.argv[1],'w') as t:
 m=tarfile.TarInfo('package.tar.zst');m.size=len(data);t.addfile(m,io.BytesIO(data))`, archive]);
  assert.equal(inspectArchive(archive).passed, true);
  assert.equal(inspectArchive(archive, ['private-marker']).passed, false);
});


test('root scanner records every decoder failure while keeping admission closed', t => {
  const {directory} = fixture(t), archive = path.join(directory, 'root.tar');
  execFileSync('python3', ['-c', `import tarfile,io,sys
with tarfile.open(sys.argv[1],'w') as t:
 for name in ['first.gz','second.gz']:
  b=bytes([31,139,0]);m=tarfile.TarInfo(name);m.size=len(b);t.addfile(m,io.BytesIO(b))`, archive]);
  const result = inspectArchive(archive);
  assert.equal(result.passed, false);
  assert.deepEqual(result.findings.map(f => f.path), ['/first.gz', '/second.gz']);
  assert(result.findings.every(f => f.reason === 'archive-decoder-error' && f.traceback.includes('Error')));
});
