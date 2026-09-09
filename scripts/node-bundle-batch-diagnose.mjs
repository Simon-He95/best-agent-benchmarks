import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordGenerationProcess} from './generate-node-bundle-one.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read-only git probes recorded against a task's pinned official image. Every probe
// must survive a nonzero exit (a missing base object is itself diagnostic fact), so
// probe failures are recorded, never fatal; only container lifecycle steps are fatal.
export function gitProbes(entry) {
  const git = args => ['git', '-C', '/testbed', ...args];
  return [
    ['head-sha', git(['rev-parse', 'HEAD'])],
    ['head-tree', git(['rev-parse', 'HEAD^{tree}'])],
    ['base-tree', git(['rev-parse', entry.baseCommit + '^{tree}'])],
    ['base-present', git(['cat-file', '-t', entry.baseCommit])],
    ['head-log', git(['log', '--oneline', '-5'])],
    ['commit-count', git(['rev-list', '--count', 'HEAD'])],
    ['refs', git(['for-each-ref'])],
    ['diff-name-only', git(['diff', '--name-only', entry.baseCommit])],
    ['status-porcelain', git(['status', '--porcelain'])],
    ['ls-files', git(['ls-files'])],
  ];
}

const FORBIDDEN = /\b(add|commit|reset|checkout|clean|rm|mv|merge|rebase|revert|stash|apply|fetch|pull|push|init|clone)\b/;

export function assertReadOnly(probes) {
  for (const [name, argv] of probes) {
    assert.equal(argv[0], 'git');
    assert.equal(argv[1], '-C');
    assert.equal(argv[2], '/testbed');
    assert.doesNotMatch(argv.join(' '), FORBIDDEN, 'Probe must not mutate the repository: ' + name);
  }
}

// Summarize recorded probe outputs into one diagnosis record; absent probes are
// recorded as null instead of being guessed.
export function parseDiagnosis(entry, outputs) {
  const lines = name => (outputs[name] === undefined ? null : outputs[name].replace(/\n+$/, '').split('\n'));
  const diffFiles = lines('diff-name-only') ?? [];
  const status = lines('status-porcelain') ?? [];
  return {
    instanceId: entry.instanceId,
    baseCommit: entry.baseCommit,
    imageRef: entry.imageRef,
    headSha: (outputs['head-sha'] ?? '').trim() || null,
    headTree: (outputs['head-tree'] ?? '').trim() || null,
    baseTree: (outputs['base-tree'] ?? '').trim() || null,
    baseObjectPresent: (outputs['base-present'] ?? '').trim() || null,
    headLog: lines('head-log'),
    commitCount: (outputs['commit-count'] ?? '').trim() || null,
    refs: lines('refs'),
    diffFileCount: outputs['diff-name-only'] === undefined ? null : diffFiles.length,
    diffFiles: diffFiles.slice(0, 200),
    diffFileSampleComplete: diffFiles.length <= 200,
    statusEntryCount: outputs['status-porcelain'] === undefined ? null : status.length,
    statusSample: status.slice(0, 30),
    trackedFileCount: outputs['ls-files'] === undefined ? null : (outputs['ls-files'].replace(/\n+$/, '').split('\n').length),
  };
}

export async function diagnoseBatch({evidenceDir, imageRefs}) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  fs.mkdirSync(evidenceDir, {recursive: true});
  let serial = 0;
  const step = async (taskDir, name, args, options = {}) => {
    const result = await recordGenerationProcess(taskDir, String(++serial).padStart(3, '0') + '-' + name, args, options);
    if (result.status !== 0 || result.signal || result.timedOut || result.error) throw new Error(name + ' failed; see preserved process receipt');
    return result;
  };
  const output = result => fs.readFileSync(result.stdoutPath, 'utf8');
  const diagnoses = [];
  for (const entry of imageRefs) {
    const taskDir = path.join(evidenceDir, entry.instanceId);
    fs.mkdirSync(taskDir, {recursive: true});
    await step(taskDir, 'image-pull', ['docker', 'pull', '--platform', 'linux/amd64', entry.imageRef], {timeoutMs: 900_000});
    const image = JSON.parse(output(await step(taskDir, 'image-inspect', ['docker', 'image', 'inspect', entry.imageRef])))[0];
    assert.equal(image.Architecture, 'amd64');
    assert.equal(image.Os, 'linux');
    assert(image.RepoDigests.includes(entry.imageRef), 'Pinned digest missing from RepoDigests');
    const containerId = output(await step(taskDir, 'container-create', ['docker', 'create', '--name', 'remaining63-node-diag-' + entry.instanceId, '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g', image.Id, 'sleep', 'infinity'])).trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    let removed = false;
    try {
      await step(taskDir, 'container-start', ['docker', 'start', containerId]);
      const boundary = JSON.parse(output(await step(taskDir, 'container-boundary', ['docker', 'inspect', containerId])))[0];
      assert.equal(boundary.Id, containerId);
      assert.equal(boundary.Mounts.length, 0);
      assert.equal(boundary.HostConfig.NetworkMode, 'none');
      const outputs = {};
      for (const [name, argv] of gitProbes(entry)) {
        const result = await recordGenerationProcess(taskDir, name, ['docker', 'exec', containerId, ...argv], {timeoutMs: 120_000});
        outputs[name] = result.status === 0 ? output(result) : '';
        fs.writeFileSync(path.join(taskDir, name + '.status.txt'), String(result.status) + '\n', {flag: 'wx'});
      }
      diagnoses.push(parseDiagnosis(entry, outputs));
    } finally {
      if (!removed) {
        await step(taskDir, 'container-remove', ['docker', 'rm', '--force', containerId]);
        removed = true;
        await recordGenerationProcess(taskDir, 'container-absence', ['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + containerId]);
        await step(taskDir, 'image-remove', ['docker', 'rmi', entry.imageRef], {timeoutMs: 300_000});
      }
    }
  }
  fs.writeFileSync(path.join(evidenceDir, 'diagnosis.json'), JSON.stringify(diagnoses, null, 2) + '\n', {flag: 'wx'});
  return diagnoses;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [evidenceDir] = process.argv.slice(2);
  assert.equal(process.argv.length, 3, 'Usage: node node-bundle-batch-diagnose.mjs <new-evidence-directory>');
  const batch = JSON.parse(fs.readFileSync(path.join(repository, 'config/node-bundle-batch-1.json')));
  diagnoseBatch({evidenceDir, imageRefs: batch.tasks}).then(list => {
    console.log('diagnosed', list.length, 'tasks');
  }, () => {
    console.error('Batch diagnosis did not complete; inspect the evidence directory.');
    process.exitCode = 1;
  });
}
