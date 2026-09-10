import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// No-model, no-test-material official-image environment diagnostic.
// It inspects only image/package/build/sys.path state and never runs tests,
// never reads /testbed/tests, never touches dataset or test-patch content.
// Its results are controller-side diagnostics only: never a verdict source,
// never model prompt material, and never a reason to alter any attempt.

const imageRefPattern = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;

export function validateHealthConfig(config) {
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.diagnosticOnly, true);
  assert.equal(config.passAt1, null);
  assert.ok(config.modelFree && config.testMaterialFree && config.neverVerdictSource, 'Guarantees must stay frozen');
  assert.ok(Array.isArray(config.images) && config.images.length >= 1 && config.images.length <= 10, 'One health batch stays within the hosted ceiling');
  const instanceIds = new Set();
  const digests = new Set();
  for (const entry of config.images) {
    assert.match(entry.instanceId, /^[a-z0-9_-]+__[a-z0-9_-]+-[0-9]+$/, 'instanceId must be an official instance identity');
    assert.ok(!instanceIds.has(entry.instanceId), 'Duplicate instanceId');
    instanceIds.add(entry.instanceId);
    assert.match(entry.imageRef, imageRefPattern, 'imageRef must be digest-pinned');
    const digest = entry.imageRef.split('@sha256:')[1];
    assert.ok(!digests.has(digest), 'Duplicate image digest');
    digests.add(digest);
    assert.match(entry.repo, /^[^/]+\/[^/]+$/);
    assert.match(entry.pythonModule, /^[a-z][a-z0-9_]*$/);
    assert.match(entry.sourcePackageDir, /^\/testbed\/[a-z0-9_.-]+$/);
    assert.match(entry.buildDir, /^\/testbed\/build\/lib\/[a-z0-9_.-]+$/);
    assert.equal(entry.workdir, '/testbed');
    assert.match(entry.envActivation, /^source \/opt\/miniconda3\/bin\/activate && conda activate testbed$/);
    assert.match(entry.installCommand, /^[a-z0-9 ./_-]+$/, 'Only the plain public setup.py install form is admitted');
    assert.ok(['known-bad-control', 'attribution-terminal', 'attribution-inflight', 'pre-dispatch-screen'].includes(entry.role));
    assert.match(entry.provenance, /^config\/node-bundle-(candidate|batch-[0-9]+)\.json:(task|tasks\[[0-9]+\])\.imageRef$/);
  }
  const controls = config.images.filter(entry => entry.role === 'known-bad-control');
  assert.equal(controls.length, 1, 'Exactly one known-bad control anchors the detection');
  assert.equal(controls[0].instanceId, config.knownBadControlInstanceId);
  return true;
}

// Verdict computation is environment-only: package-data presence in the importable
// install relative to the shipped source tree. It never inspects test outcomes.
export function computeHealthVerdict(pre, post, installStatus) {
  const record = {installStatus};
  if (pre) record.preImport = pre.import_error ? 'failed' : 'ok';
  if (installStatus !== 0) return {...record, status: 'install-failed'};
  if (!post || post.import_error) return {...record, status: 'post-import-failed'};
  if (!post.installed_files) return {...record, status: 'no-installed-package'};
  const missing = post.missing_from_installed ?? 0;
  const preMissing = pre?.missing_from_installed ?? 0;
  if (missing === 0) return {...record, status: preMissing > 0 ? 'repaired-by-install' : 'healthy'};
  const inBuild = post.missing_present_in_build ?? 0;
  const missingByExt = post.missing_by_ext ?? {};
  return {...record, status: inBuild > 0 ? 'degraded-install-data-in-build' : 'degraded-install', missing, missingPresentInBuild: inBuild, missingByExt};
}

export function dockerPullArgs(imageRef) {
  return ['pull', '--platform', 'linux/amd64', imageRef];
}

export function dockerCreateArgs(imageRef, name) {
  return ['create', '--name', name, '--platform', 'linux/amd64', '--network', 'none', '--memory', '4g', '--cpus', '2', imageRef, 'sleep', 'infinity'];
}

export function probeCommand(entry) {
  return `set -e; ${entry.envActivation}; cd ${entry.workdir} && python /probe.py ${entry.pythonModule} ${entry.sourcePackageDir} ${entry.buildDir}`;
}

export function installCommand(entry) {
  return `set -e; ${entry.envActivation}; cd ${entry.workdir} && ${entry.installCommand}`;
}

// Runs inside the pinned official image with the official testbed environment.
// Reports import resolution, sys.path, and source-vs-installed package file sets.
export const packageProbe = String.raw`
import importlib, json, os, sys
module, source_dir, build_dir = sys.argv[1], sys.argv[2], sys.argv[3]
result = {'module': module}
try:
    imported = importlib.import_module(module)
    result['module_file'] = getattr(imported, '__file__', None)
    result['package_dirs'] = list(getattr(imported, '__path__', []))
except Exception as error:
    result['import_error'] = repr(error)
result['sys_path'] = sys.path
def walk(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                out[os.path.relpath(full, root)] = os.path.getsize(full)
            except OSError:
                pass
    return out
source = walk(source_dir) if os.path.isdir(source_dir) else {}
result['source_files'] = len(source)
installed = {}
for directory in result.get('package_dirs', []):
    if os.path.isdir(directory):
        for relative, size in walk(directory).items():
            installed[relative] = size
result['installed_files'] = len(installed)
missing = sorted(set(source) - set(installed))
result['missing_from_installed'] = len(missing)
result['missing_sample'] = missing[:200]
by_extension = {}
for relative in missing:
    extension = os.path.splitext(relative)[1] or '(none)'
    by_extension[extension] = by_extension.get(extension, 0) + 1
result['missing_by_ext'] = by_extension
extra = sorted(set(installed) - set(source))
result['extra_in_installed'] = len(extra)
result['extra_sample'] = extra[:100]
if os.path.isdir(build_dir):
    build = walk(build_dir)
    result['build_files'] = len(build)
    present = [relative for relative in missing if relative in build]
    result['missing_present_in_build'] = len(present)
    result['missing_present_in_build_sample'] = present[:100]
else:
    result['build_dir_exists'] = False
entries = set()
for candidate in sys.path:
    if not candidate or not os.path.isdir(candidate):
        continue
    try:
        for name in os.listdir(candidate):
            if module.lower() in name.lower():
                entries.add(os.path.join(candidate, name))
    except OSError:
        pass
result['site_entries'] = sorted(entries)
print(json.dumps(result))
`;

async function main() {
  const evidenceDir = process.argv[2];
  assert(evidenceDir, 'Evidence directory argument is required');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.15.0');
  const config = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-image-health.json', import.meta.url)));
  validateHealthConfig(config);
  const configBytes = fs.readFileSync(new URL('../config/node-bundle-image-health.json', import.meta.url));
  fs.mkdirSync(evidenceDir, {recursive: true});
  fs.writeFileSync(path.join(evidenceDir, 'config.json'), JSON.stringify({...config, configSha256: createHash('sha256').update(configBytes).digest('hex')}, null, 2) + '\n');
  const runLabel = process.env.GITHUB_RUN_ID || 'adhoc';
  const summary = {diagnosticOnly: true, passAt1: null, modelFree: true, runLabel, images: []};
  for (const [index, entry] of config.images.entries()) {
    const imageEvidence = path.join(evidenceDir, entry.instanceId);
    fs.mkdirSync(imageEvidence);
    const sequence = {value: 0};
    const run = (name, args, {timeoutMs = 60_000, okToFail = false} = {}) => {
      const prefix = path.join(imageEvidence, String(++sequence.value).padStart(2, '0') + '-' + name);
      const out = fs.openSync(prefix + '.stdout.txt', 'wx');
      const err = fs.openSync(prefix + '.stderr.txt', 'wx');
      let status, signal, error;
      try {
        const result = spawnSync('docker', args, {stdio: ['ignore', out, err], timeout: timeoutMs});
        ({status, signal, error} = result);
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
        fs.writeFileSync(prefix + '.process.json', JSON.stringify({status: status ?? null, signal: signal ?? null, timedOut: signal === 'SIGTERM', error: error ? String(error) : null, args}, null, 2) + '\n');
      }
      const stdout = fs.readFileSync(prefix + '.stdout.txt', 'utf8').trim();
      if (!okToFail && (status !== 0 || error)) throw new Error(`Docker step ${name} failed with status ${status}`);
      return {status: status ?? null, stdout};
    };
    let containerId;
    try {
      run('pull', dockerPullArgs(entry.imageRef), {timeoutMs: 900_000});
      const inspect = JSON.parse(run('image-inspect', ['image', 'inspect', entry.imageRef]).stdout);
      const imageId = inspect[0].Id;
      const repoDigests = inspect[0].RepoDigests ?? [];
      const containerName = `image-health-${runLabel}-${index}`;
      containerId = run('create', dockerCreateArgs(entry.imageRef, containerName)).stdout;
      assert.match(containerId, /^[a-f0-9]{64}$/);
      run('start', ['start', containerId]);
      const boundary = JSON.parse(run('boundary', ['inspect', containerId]).stdout)[0];
      assert.equal(boundary.Id, containerId);
      assert.equal(boundary.Image, imageId);
      assert.equal(boundary.Mounts.length, 0);
      assert.equal(boundary.HostConfig.NetworkMode, 'none');
      assert.equal(boundary.HostConfig.Privileged, false);
      const probePath = path.join(os.tmpdir(), `image-health-probe-${index}.py`);
      fs.writeFileSync(probePath, packageProbe);
      try {
        run('copy-probe', ['cp', probePath, containerId + ':/probe.py']);
      } finally {
        fs.rmSync(probePath, {force: true});
      }
      const preRaw = run('probe-pre', ['exec', containerId, 'bash', '-lc', probeCommand(entry)], {timeoutMs: 300_000}).stdout;
      const pre = JSON.parse(preRaw);
      fs.writeFileSync(path.join(imageEvidence, 'pre-install.json'), JSON.stringify(pre, null, 2) + '\n');
      const installStatus = run('install', ['exec', containerId, 'bash', '-lc', installCommand(entry)], {timeoutMs: 900_000, okToFail: true}).status ?? 1;
      const postRaw = run('probe-post', ['exec', containerId, 'bash', '-lc', probeCommand(entry)], {timeoutMs: 300_000}).stdout;
      const post = JSON.parse(postRaw);
      fs.writeFileSync(path.join(imageEvidence, 'post-install.json'), JSON.stringify(post, null, 2) + '\n');
      const verdict = computeHealthVerdict(pre, post, installStatus);
      const record = {instanceId: entry.instanceId, role: entry.role, imageRef: entry.imageRef, imageId, repoDigests, verdict, pre: {moduleFile: pre.module_file, packageDirs: pre.package_dirs, sourceFiles: pre.source_files, installedFiles: pre.installed_files, missingFromInstalled: pre.missing_from_installed, siteEntries: pre.site_entries}, post: {moduleFile: post.module_file, packageDirs: post.package_dirs, sourceFiles: post.source_files, installedFiles: post.installed_files, missingFromInstalled: post.missing_from_installed, missingByExt: post.missing_by_ext, buildDirExists: post.build_dir_exists !== false, buildFiles: post.build_files ?? null, missingPresentInBuild: post.missing_present_in_build ?? null, siteEntries: post.site_entries}};
      fs.writeFileSync(path.join(imageEvidence, 'verdict.json'), JSON.stringify(record, null, 2) + '\n');
      summary.images.push({instanceId: entry.instanceId, role: entry.role, imageRef: entry.imageRef, imageId, status: verdict.status, missingFromInstalled: post.missing_from_installed ?? null, missingPresentInBuild: post.missing_present_in_build ?? null, installStatus});
      console.log(`${entry.instanceId} [${entry.role}]: ${verdict.status}${post.missing_from_installed ? ` (missing ${post.missing_from_installed}, in build ${post.missing_present_in_build ?? 0})` : ''}`);
    } finally {
      if (containerId) {
        run('remove', ['rm', '-f', containerId]);
        const absenceStatus = run('absence', ['inspect', containerId], {okToFail: true}).status;
        assert(absenceStatus !== 0, 'Container absence could not be proven');
      }
    }
  }
  fs.writeFileSync(path.join(evidenceDir, 'health.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Image health diagnostic complete: ${summary.images.length} image(s) checked`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Image health diagnostic did not complete: ${String(error)}`);
    process.exitCode = 1;
  });
}
