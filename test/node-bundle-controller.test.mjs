import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {admitFirstRun, validateRun, auditEvidence, copyAuditedEvidence} from '../scripts/node-bundle-controller.mjs';

const secret = 'actual-provider-token-for-audit-tests';
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-controller-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('rejects rerun and another hosted attempt even if its workflow failed', () => {
  const environment = {GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'Simon-He95/best-agent-benchmarks', GITHUB_REF: 'refs/heads/master'};
  validateRun('123', environment);
  assert.throws(() => validateRun('123', {...environment, GITHUB_RUN_ATTEMPT: '2'}));
  assert.throws(() => validateRun('123', {...environment, GITHUB_RUN_ID: '124'}));
  admitFirstRun([{id: 123}], '123');
  assert.throws(() => admitFirstRun([{id: 122, conclusion: 'failure'}, {id: 123}], '123'));
  assert.throws(() => admitFirstRun([], '123'));
});

test('copies only audited byte-identical files and rejects a change before upload', t => {
  const root = directory(t), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, 'trajectory.bin'), Buffer.from([0, 1, 2, 255]));
  const audit = auditEvidence(evidence, secret);
  assert.equal(audit.files.length, 1);
  const upload = path.join(root, 'upload');
  copyAuditedEvidence(evidence, upload, audit);
  assert.deepEqual(fs.readFileSync(path.join(upload, 'trajectory.bin')), fs.readFileSync(path.join(evidence, 'trajectory.bin')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(upload, 'upload-manifest.json'))).safe, true);
  fs.appendFileSync(path.join(evidence, 'trajectory.bin'), 'changed');
  assert.throws(() => copyAuditedEvidence(evidence, path.join(root, 'changed-upload'), audit));
});

test('detects credential bytes spanning scanner chunks without printing them', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'raw.bin'), Buffer.concat([Buffer.alloc(1024 * 1024 - 7), Buffer.from(secret)]));
  assert.throws(() => auditEvidence(root, secret), error => {
    assert.equal(error.audit.reason, 'credential-bytes');
    assert.equal(error.audit.affectedFile.sha256, createHash('sha256').update(fs.readFileSync(path.join(root, 'raw.bin'))).digest('hex'));
    assert(!JSON.stringify(error.audit).includes(secret));
    return !error.message.includes(secret);
  });
});

test('rejects a symlink without reading its target and rejects a missing root', t => {
  const root = directory(t), outside = path.join(root, 'outside'), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  fs.writeFileSync(outside, secret);
  fs.symlinkSync(outside, path.join(evidence, 'link'));
  assert.throws(() => auditEvidence(evidence, secret));
  assert.throws(() => auditEvidence(path.join(root, 'missing'), secret));
});

test('scans compressed members inside a tar without extracting model paths', t => {
  const root = directory(t), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  const script = `import io,tarfile,zipfile,gzip,sys\nroot,secret=sys.argv[1:]\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('../../outside.txt',secret)\ndata=gzip.compress(b.getvalue())\nwith tarfile.open(root+'/workspace.tar','w') as t:\n i=tarfile.TarInfo('nested.gz');i.size=len(data);t.addfile(i,io.BytesIO(data))\n`;
  const made = spawnSync('python3', ['-c', script, evidence, secret], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  assert.throws(() => auditEvidence(evidence, secret));
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
});

test('accepts a safe archive and hashes its original compressed bytes', t => {
  const root = directory(t);
  const script = "import gzip,sys;open(sys.argv[1]+'/data.gz','wb').write(gzip.compress(b'safe raw evidence'))";
  assert.equal(spawnSync('python3', ['-c', script, root]).status, 0);
  const result = auditEvidence(root, secret);
  assert.equal(result.files[0].sha256, createHash('sha256').update(fs.readFileSync(path.join(root, 'data.gz'))).digest('hex'));
});

test('refuses compressed formats whose contents the scanner cannot prove safe', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'archive.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]));
  assert.throws(() => auditEvidence(root, secret));
});


test('rejects a valid prefixed ZIP inside TAR before safe upload admission', t => {
  const root = directory(t), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  const script = `import io,tarfile,zipfile,sys
root,token=sys.argv[1:]
b=io.BytesIO(b'ordinary archive prefix\\n');b.seek(0,2)
with zipfile.ZipFile(b,'a',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('credential.txt',token)
data=b.getvalue()
assert token.encode() not in data and zipfile.is_zipfile(io.BytesIO(data))
with tarfile.open(root+'/workspace.tar','w') as t:
 d=tarfile.TarInfo('testbed');d.type=tarfile.DIRTYPE;t.addfile(d)
 m=tarfile.TarInfo('testbed/debug.zip');m.size=len(data);t.addfile(m,io.BytesIO(data))
`;
  const made = spawnSync('python3', ['-c', script, evidence, secret], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  const upload = path.join(root, 'upload');
  assert.throws(() => {
    const audit = auditEvidence(evidence, secret);
    copyAuditedEvidence(evidence, upload, audit);
  }, error => error.audit?.reason === 'credential-bytes');
  assert.equal(fs.existsSync(upload), false);
});

test('accepts safe ZIP structure with and without a prefix', t => {
  const root = directory(t);
  const script = `import io,zipfile,sys
for name,prefix in [('ordinary.zip',b''),('prefixed.zip',b'prefix')]:
 b=io.BytesIO(prefix);b.seek(0,2)
 with zipfile.ZipFile(b,'a',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('safe.txt','public evidence')
 open(sys.argv[1]+'/'+name,'wb').write(b.getvalue())
`;
  const made = spawnSync('python3', ['-c', script, root], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  assert.equal(auditEvidence(root, secret).files.length, 2);
});


test('a trailing safe ZIP cannot hide another compressed TAR member', t => {
  const root = directory(t);
  const script = `import io,tarfile,zipfile,sys
root,token=sys.argv[1:]
with tarfile.open(root+'/workspace.tar','w') as t:
 for name,value in [('first.zip',token),('last.zip','safe')]:
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('data',value)
  data=b.getvalue();m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
`;
  const made = spawnSync('python3', ['-c', script, root, secret], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  assert.throws(() => auditEvidence(root, secret), error => error.audit?.reason === 'credential-bytes');
});

test('admits only the frozen pre-model failure and rejects any model execution or changed identity', () => {
  const declaration = {runId: '122', headSha: 'frozen-head', jobId: 44, failedStep: 'tests', skippedSteps: ['prepare', 'model', 'evaluate']};
  const previous = {id: 122, head_sha: 'frozen-head', status: 'completed', conclusion: 'failure', run_attempt: 1};
  const runs = [previous, {id: 123}];
  const jobs = {'122': {jobs: [{id: 44, status: 'completed', conclusion: 'failure', steps: [
    {name: 'tests', status: 'completed', conclusion: 'failure'},
    ...['prepare', 'model', 'evaluate'].map(name => ({name, status: 'completed', conclusion: 'skipped'})),
  ]}]}};
  admitFirstRun(runs, '123', [declaration], jobs);
  for (const field of ['head_sha', 'run_attempt', 'conclusion']) {
    assert.throws(() => admitFirstRun([{...previous, [field]: 'changed'}, {id: 123}], '123', [declaration], jobs));
  }
  const executed = structuredClone(jobs);
  executed['122'].jobs[0].steps.find(step => step.name === 'model').conclusion = 'success';
  assert.throws(() => admitFirstRun(runs, '123', [declaration], executed));
  assert.throws(() => admitFirstRun(runs, '123', [declaration], {}));
  assert.throws(() => admitFirstRun([...runs, {id: 124}], '123', [declaration], jobs));
});

const {prepareWithTransportRetry, PREPARE_TRANSPORT_POLICY, validateBatchConfig: validateBatchConfigForRetry} = await import('../scripts/node-bundle-controller.mjs');

function retryFixture(t, runner, options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-retry-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const manifestPath = path.join(dir, 'official-evaluator-manifest.json');
  const calls = {sleeps: [], timeouts: [], attempts: []};
  return {
    dir,
    manifestPath,
    calls,
    run: () => prepareWithTransportRetry({
      runId: '34432740844',
      evidenceDir: dir,
      manifestPath,
      sleep: ms => calls.sleeps.push(ms),
      run: async (timeout, attempt) => { calls.attempts.push(attempt); calls.timeouts.push(timeout); return runner(timeout, attempt, calls); },
      ...options,
    }),
  };
}

test('evaluator-prepare is transport-retried while a clean first attempt keeps the historical evidence shape', async t => {
  const fixture = retryFixture(t, () => {});
  const attempts = await fixture.run();
  assert.deepEqual(attempts, [{attempt: 1, status: 'succeeded', clearedManifest: false}]);
  assert.deepEqual(fixture.calls.attempts, [1]);
  assert.deepEqual(fixture.calls.sleeps, []);
  assert.equal(fixture.calls.timeouts[0], PREPARE_TRANSPORT_POLICY.perAttemptTimeoutMs);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'prepare-transport-retry.json')), false, 'A first-attempt success adds no new evidence file');
});

test('transport retry recovers a pre-model environment failure and records every attempt', async t => {
  const fixture = retryFixture(t, async (timeout, attempt, calls) => {
    if (attempt === 1) {
      fs.writeFileSync(fixture.manifestPath, '{"partial":true}\n');
      throw new Error('evaluator-prepare failed: HTTP Error 502: Bad Gateway');
    }
    assert.equal(fs.existsSync(fixture.manifestPath), false, 'A failed attempt must not leave the write-once manifest behind');
    fs.writeFileSync(fixture.manifestPath, '{"manifest":true}\n');
  });
  const attempts = await fixture.run();
  assert.deepEqual(attempts.map(item => item.status), ['failed', 'succeeded']);
  assert.deepEqual(attempts.map(item => item.clearedManifest), [false, true]);
  assert.match(attempts[0].error, /502/);
  assert.deepEqual(fixture.calls.sleeps, [PREPARE_TRANSPORT_POLICY.backoffMs[0]]);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'prepare-transport-retry.json')));
  assert.equal(receipt.exhausted, false);
  assert.deepEqual(receipt.attempts.map(item => item.attempt), [1, 2]);
  assert.equal(receipt.policy.attempts, PREPARE_TRANSPORT_POLICY.attempts);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), '{"manifest":true}\n');
});

test('exhausted transport retries fail closed and never leave a false success', async t => {
  const fixture = retryFixture(t, () => { throw new Error('evaluator-prepare failed: HTTP Error 503: Service Unavailable'); });
  await assert.rejects(fixture.run, /after 3 attempt\(s\)/);
  assert.deepEqual(fixture.calls.attempts, [1, 2, 3], 'Every admitted attempt is exercised before failing');
  assert.deepEqual(fixture.calls.sleeps, PREPARE_TRANSPORT_POLICY.backoffMs);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'prepare-transport-retry.json')));
  assert.equal(receipt.exhausted, true);
  assert.deepEqual(receipt.attempts.map(item => item.status), ['failed', 'failed', 'failed']);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
});

test('the transport deadline stops retrying instead of overrunning the eval-prepare step timeout', async t => {
  let clock = 0;
  const fixture = retryFixture(t, async () => { clock += 400_000; throw new Error('evaluator-prepare failed: HTTP Error 502: Bad Gateway'); }, {now: () => clock});
  await assert.rejects(fixture.run, /after 2 attempt\(s\)/);
  assert.deepEqual(fixture.calls.attempts, [1, 2], 'Two 400s attempts exhaust the 780s budget');
  assert.deepEqual(fixture.calls.sleeps, [PREPARE_TRANSPORT_POLICY.backoffMs[0]]);
});

test('the retry policy stays inside the workflow step timeout and never retries a model or evaluator', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/node-bundle-batch4.yml', import.meta.url), 'utf8');
  assert.ok(PREPARE_TRANSPORT_POLICY.totalDeadlineMs < 900_000, 'The transport budget stays inside the recorded 900s prepare-step timeout');
  assert.equal(PREPARE_TRANSPORT_POLICY.attempts, 3);
  const controller = fs.readFileSync(new URL('../scripts/node-bundle-controller.mjs', import.meta.url), 'utf8');
  // Only the environment preparation step is wrapped; the model and evaluator steps stay single-shot.
  assert.equal((controller.match(/prepareWithTransportRetry\(/g) ?? []).length, 2, 'One definition plus exactly one call site');
  assert.equal((controller.match(/generateNodeBundleTask\(\{/g) ?? []).length, 1, 'Exactly one model-generation call site');
  assert.equal((controller.match(/generate-node-bundle-one\.mjs/g) ?? []).length, 2, 'The generation module appears only as a control file and one import');
  // The three batch-4 jobs share one anchored step list, so the single-shot model and evaluation
  // steps are declared exactly once and can never multiply per job.
  assert.equal((workflow.match(/Run the sole frozen model attempt/g) ?? []).length, 1, 'The model attempt step is declared once in the shared step list');
  assert.equal((workflow.match(/Evaluate frozen prediction in fresh official Docker container/g) ?? []).length, 1, 'The official evaluation step is declared once in the shared step list');
  assert.equal((workflow.match(/steps: \*job-steps/g) ?? []).length, 2, 'Both remaining batch-4 jobs reuse that exact step list');
});
