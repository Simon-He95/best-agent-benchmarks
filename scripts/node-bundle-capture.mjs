import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function capturePatch({repo, gitDir, base, outputDir}) {
  fs.mkdirSync(outputDir);
  const index = path.join(outputDir, 'private-index');
  const env = {PATH: '/usr/bin:/bin', HOME: outputDir, GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: index, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1'};
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], {cwd: repo, env, timeout: 60_000, maxBuffer: 32 * 1024 ** 2});
  try {
    assert.match(base, /^[a-f0-9]{40}$/);
    assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), base);
    // This directory was copied before the model ran; never read terminal .git/config.
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = false\n');
    const originalIndex = fs.readFileSync(path.join(gitDir, 'index'));
    git(['read-tree', base]);
    git(['add', '-A', '--', '.']);
    const patch = git(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', base, '--', '.']);
    assert(patch.length <= 16 * 1024 ** 2, 'Patch exceeds frozen capture limit');
    assert.deepEqual(fs.readFileSync(path.join(gitDir, 'index')), originalIndex);
    fs.writeFileSync(path.join(outputDir, 'diagnostic.patch'), patch, {flag: 'wx'});
    const receipt = {status: 'captured', baseCommit: base, bytes: patch.length, sha256: createHash('sha256').update(patch).digest('hex'), method: 'trusted-base-git-private-index-to-terminal-worktree', originalIndexUnchanged: true};
    fs.writeFileSync(path.join(outputDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
    return receipt;
  } catch (error) {
    fs.writeFileSync(path.join(outputDir, 'failure.json'), JSON.stringify({status: 'capture-failed', message: String(error), statusCode: error.status, signal: error.signal}, null, 2) + '\n', {flag: 'wx'});
    for (const stream of ['stdout', 'stderr']) if (error[stream]) fs.writeFileSync(path.join(outputDir, stream + '.txt'), error[stream], {flag: 'wx'});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  capturePatch({repo: '/testbed', gitDir: '/capture/base.git', base: process.argv[2], outputDir: '/capture/output'});
}
