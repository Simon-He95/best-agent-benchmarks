import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRecordedStep, verifyTaskIdentity} from './swe-node-bundle-preflight.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateInventory(config, selection) {
  assert([30, 31, 32, 33].includes(config.taskIndex));
  assert.equal(selection.tasks[config.taskIndex].repo, 'matplotlib/matplotlib');
  const task = selection.tasks[config.taskIndex];
  assert.equal(task.instanceId, config.instanceId);
  assert.equal(task.baseCommit, config.baseCommit);
  verifyTaskIdentity({...config, pythonPrefix: '/opt/miniconda3/envs/testbed'}, task.instanceId);
  assert.equal(config.modelAttempt, false);
  assert.equal(config.diagnosticOnly, true);
  assert.equal(config.passAt1, null);
}

export const repositoryInventory = `set -eu
cd /testbed
git rev-parse HEAD HEAD^{tree} "$1^{tree}"
git show -s --format='%H %P' HEAD
git diff --no-ext-diff --no-textconv --name-status "$1"
git status --porcelain=v1 --untracked-files=all
git for-each-ref --format='%(refname) %(objectname)'
git rev-list --all --count
for item in build dist lib; do
  if [ -e "$item" ]; then find "$item" -maxdepth 2 -printf '%y %p\\n'; fi
done
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o -name .git -print -prune
`;

export const pythonInventory = `import importlib,json,sys,shutil,subprocess
facts = dict(python=sys.version, prefix=sys.prefix, modules={}, tools={})
for name in ['matplotlib','matplotlib._path','matplotlib.ft2font','matplotlib._image','matplotlib.backends._backend_agg','matplotlib._qhull','matplotlib._tri','numpy']:
    try:
        module=importlib.import_module(name)
        facts['modules'][name]=dict(source=module.__file__, version=getattr(module,'__version__',None))
    except Exception as error:
        facts['modules'][name]=dict(error=type(error).__name__, message=str(error))
for name in ['latex','dvipng','gs','ffmpeg','pkg-config']:
    executable=shutil.which(name)
    value=dict(path=executable)
    if executable:
        try:
            result=subprocess.run([executable,'--version'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,universal_newlines=True,timeout=10)
            value.update(status=result.returncode, version=result.stdout.splitlines()[:2])
        except subprocess.TimeoutExpired:
            value['timeout']=True
    facts['tools'][name]=value
print(json.dumps(facts,sort_keys=True))
`;

export async function inventory(evidenceDir) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  const config = JSON.parse(fs.readFileSync(path.join(repository, process.env.NODE_BUNDLE_INVENTORY_CONFIG ?? 'config/node-bundle-matplotlib-inventory.json')));
  validateInventory(config, JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-failed-tasks.json'))));
  fs.mkdirSync(evidenceDir);
  fs.writeFileSync(path.join(evidenceDir, 'inventory-config.json'), JSON.stringify(config, null, 2) + '\n');
  const names = [];
  const step = (name, args, timeout = 120_000) => {
    names.push(name);
    return runRecordedStep(evidenceDir, name, ['docker', ...args], timeout);
  };
  const container = 'matplotlib-inventory-' + randomUUID();
  const summary = {status: 'failed', modelAttempt: false, modelAdmission: false, diagnosticOnly: true, passAt1: null, runId: process.env.GITHUB_RUN_ID};
  let failure;
  let createAttempted = false;
  try {
    await step('image-pull', ['pull', '--platform', 'linux/amd64', config.imageRef], 900_000);
    const image = JSON.parse((await step('image-identity', ['image', 'inspect', '--format', '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"os":{{json .Os}},"arch":{{json .Architecture}}}', config.imageRef])).stdout);
    assert.equal(image.os, 'linux');
    assert.equal(image.arch, 'amd64');
    assert(image.digests.includes(config.imageRef));
    summary.image = image;
    createAttempted = true;
    await step('container-create', ['create', '--name', container, '--platform', 'linux/amd64', '--network', 'none', '--memory', '6g', '--cpus', '4', '--entrypoint', '/bin/sleep', image.id, 'infinity']);
    await step('container-start', ['start', container]);
    const boundary = JSON.parse((await step('container-boundary', ['inspect', '--format', '{"mounts":{{json .Mounts}},"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"image":{{json .Image}}}', container])).stdout);
    assert.deepEqual(boundary.mounts, []);
    assert.equal(boundary.network, 'none');
    assert.equal(boundary.privileged, false);
    assert.equal(boundary.pidMode, '');
    assert.equal(boundary.image, image.id);
    const cleanExec = ['exec', container, '/usr/bin/env', '-i', 'HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PYTHONDONTWRITEBYTECODE=1', '/bin/bash', '--noprofile', '--norc', '-c'];
    await step('as-shipped-repository', [...cleanExec, repositoryInventory, 'inventory', config.baseCommit]);
    const activate = 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed && export MPLCONFIGDIR=/tmp/matplotlib-inventory-cache MPLBACKEND=Agg && exec python -B -c "$1"';
    await step('python-and-tools', [...cleanExec, activate, 'inventory', pythonInventory]);
    summary.status = 'completed';
  } catch (error) {
    failure = error;
    summary.error = error.message;
  } finally {
    if (createAttempted) {
      try {
        await step('container-remove', ['rm', '-f', container]);
        const absence = await step('container-absence', ['ps', '-aq', '--filter', 'name=^/' + container + '$']);
        assert.equal(absence.stdout.trim(), '');
        summary.containerRemoved = true;
      } catch (error) {
        failure ??= error;
        summary.status = 'failed';
        summary.cleanupError = error.message;
      }
    }
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    const files = ['inventory-config.json', 'summary.json', ...names.flatMap(name => ['process.json', 'stdout.txt', 'stderr.txt'].map(suffix => name + '.' + suffix))].filter(name => fs.existsSync(path.join(evidenceDir, name)));
    assert.deepEqual(fs.readdirSync(evidenceDir).sort(), [...files].sort());
    fs.writeFileSync(path.join(evidenceDir, 'inventory-manifest.json'), JSON.stringify({modelAttempt: false, files: files.map(name => {
      const bytes = fs.readFileSync(path.join(evidenceDir, name));
      return {path: name, sizeBytes: bytes.length, sha256: hash(bytes)};
    })}, null, 2) + '\n');
  }
  if (failure) throw failure;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await inventory(path.resolve(process.argv[2]));
}
