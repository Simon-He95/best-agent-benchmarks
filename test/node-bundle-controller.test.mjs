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
