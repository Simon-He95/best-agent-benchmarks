import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {computeHealthVerdict, dockerCreateArgs, dockerPullArgs, installCommand, packageProbe, probeCommand, validateHealthConfig} from '../scripts/node-bundle-image-health.mjs';

const readJson = name => JSON.parse(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const health = readJson('config/node-bundle-image-health.json');
const candidate = readJson('config/node-bundle-candidate.json');
const batch3 = readJson('config/node-bundle-batch-3.json');

test('image health config is frozen, diagnostic-only, and structurally valid', () => {
  assert.equal(validateHealthConfig(health), true);
  assert.equal(health.diagnosticOnly, true);
  assert.equal(health.passAt1, null);
  assert.ok(health.modelFree && health.testMaterialFree && health.neverVerdictSource);
  assert.equal(health.images.length, 5);
  assert.equal(health.knownBadControlInstanceId, 'django__django-10097');
  const roles = health.images.map(entry => entry.role);
  assert.deepEqual(roles.sort(), ['attribution-inflight', 'attribution-inflight', 'attribution-inflight', 'attribution-inflight', 'known-bad-control']);
});

test('every health imageRef matches its declared frozen provenance source', () => {
  for (const entry of health.images) {
    let declared;
    if (entry.provenance === 'config/node-bundle-candidate.json:task.imageRef') {
      declared = candidate.task.imageRef;
    } else {
      const match = /^config\/node-bundle-batch-3\.json:tasks\[(\d+)\]\.imageRef$/.exec(entry.provenance);
      assert(match, `Unexpected provenance ${entry.provenance}`);
      declared = batch3.tasks[Number(match[1])].imageRef;
    }
    assert.equal(entry.imageRef, declared, `${entry.instanceId} must check the exact digest its batch pinned`);
    assert.equal(entry.repo, batch3.tasks.find(task => task.instanceId === entry.instanceId)?.repo ?? 'django/django');
  }
});

test('known-bad control is the diagnostically proven degraded image, not an in-flight task', () => {
  const control = health.images.find(entry => entry.role === 'known-bad-control');
  assert.equal(control.instanceId, 'django__django-10097');
  assert.equal(control.imageRef, 'swebench/sweb.eval.x86_64.django_1776_django-10097@sha256:faf07f1d70370e9a4f76dac2cab0758300018f0eb4346b28aa55ac13630b873a');
  for (const entry of health.images.filter(item => item.role === 'attribution-inflight')) {
    assert.match(entry.instanceId, /django__django-(10554|10999|11141|11400)/);
  }
});

test('computeHealthVerdict classifies the observed defect signatures', () => {
  const healthyPre = {import_error: null, missing_from_installed: 0};
  const healthyPost = {import_error: null, installed_files: 5800, missing_from_installed: 0};
  assert.equal(computeHealthVerdict(healthyPre, healthyPost, 0).status, 'healthy');
  const degradedPost = {import_error: null, installed_files: 5800, missing_from_installed: 46, missing_by_ext: {'.html': 46}, missing_present_in_build: 46};
  assert.equal(computeHealthVerdict(healthyPre, degradedPost, 0).status, 'degraded-install-data-in-build');
  assert.equal(computeHealthVerdict(healthyPre, degradedPost, 0).missing, 46);
  const degradedNoBuild = {import_error: null, installed_files: 5800, missing_from_installed: 7, missing_by_ext: {'.html': 7}, missing_present_in_build: 0};
  assert.equal(computeHealthVerdict(healthyPre, degradedNoBuild, 0).status, 'degraded-install');
  assert.equal(computeHealthVerdict(healthyPre, null, 0).status, 'post-import-failed');
  assert.equal(computeHealthVerdict(healthyPre, {import_error: 'x', installed_files: 5, missing_from_installed: 0}, 0).status, 'post-import-failed');
  assert.equal(computeHealthVerdict(healthyPre, {import_error: null, installed_files: 0}, 0).status, 'no-installed-package');
  assert.equal(computeHealthVerdict(healthyPre, healthyPost, 1).status, 'install-failed');
  const preBad = {import_error: null, missing_from_installed: 9};
  assert.equal(computeHealthVerdict(preBad, healthyPost, 0).status, 'repaired-by-install');
});

test('docker step argv shapes keep the no-network bounded-resource boundary', () => {
  assert.deepEqual(dockerPullArgs('ref@sha256:' + 'a'.repeat(64)), ['pull', '--platform', 'linux/amd64', 'ref@sha256:' + 'a'.repeat(64)]);
  const create = dockerCreateArgs('ref@sha256:' + 'a'.repeat(64), 'image-health-123-0');
  assert.equal(create[0], 'create');
  assert.ok(create.includes('--network') && create[create.indexOf('--network') + 1] === 'none');
  assert.ok(create.includes('--memory'));
  assert.ok(create.includes('sleep'));
});

test('probe and install commands stay inside the official environment', () => {
  const entry = health.images[0];
  const probe = probeCommand(entry);
  assert.ok(probe.includes('conda activate testbed'));
  assert.ok(probe.includes('python /probe.py django /testbed/django /testbed/build/lib/django'));
  assert.ok(!probe.includes('tests/'), 'The probe must never touch test material');
  const install = installCommand(entry);
  assert.equal(install, 'set -e; source /opt/miniconda3/bin/activate && conda activate testbed; cd /testbed && python setup.py install');
  assert.ok(!install.includes('tests/'));
});

test('embedded package probe is valid python and never reads test paths', () => {
  execFileSync('python3', ['-c', `import ast; ast.parse(${JSON.stringify(packageProbe)}); print('ok')`]);
  assert.ok(!packageProbe.includes('/testbed/tests'));
  assert.ok(packageProbe.includes('missing_present_in_build'));
  assert.ok(packageProbe.includes('site_entries'));
});

test('image health workflow is a single no-model dispatch with audited upload', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/node-bundle-image-health.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|pull_request:|push:/);
  assert.doesNotMatch(workflow, /inputs:/);
  assert.match(workflow, /group: frozen-node-failed-tasks/);
  assert.match(workflow, /timeout-minutes: 90/);
  assert.match(workflow, /node-bundle-image-health\.mjs/);
  assert.match(workflow, /name: image-health-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /BENCHMARK_PROVIDER_API_KEY/, 'No provider credential may enter a diagnostic');
  assert.doesNotMatch(workflow, /node-bundle-one|node-bundle-batch/, 'A diagnostic never invokes generation workflows');
});
