import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitEnvironment = {PATH: '/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'};

export function sanitizeRepository(repo, base, mode) {
  assert.match(base, /^[a-f0-9]{40}$/);
  assert(mode === 'as-shipped' || mode === 'base-only', 'Unknown sanitation mode');
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd: repo, env: gitEnvironment, maxBuffer: 64 * 1024 ** 2});
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  let headCommit, installModifiedFiles;
  if (mode === 'base-only') {
    // Frozen recovery contract: the official setup tree must equal the base tree so the
    // one-commit base-only construction is object-identical with the original pre-model git.
    assert.equal(git(['rev-parse', 'HEAD^{tree}']).toString().trim(), git(['rev-parse', base + '^{tree}']).toString().trim(), 'Official setup tree differs from base');
    assert.equal(git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base]).length, 0, 'Official tracked source differs from base');
    headCommit = base;
  } else {
    // Official instance images end their setup with a single "SWE-bench" auto-commit on top of
    // the frozen base commit (git reset --hard base; git commit --allow-empty -am), capturing
    // tracked modifications made by the environment install. The model must work in exactly
    // that as-shipped state and the captured patch is relative to it, matching the official
    // evaluator that applies the model patch to the image worktree without checking out base.
    assert.equal(git(['rev-list', '--count', base + '..HEAD']).toString().trim(), '1', 'Official image HEAD must be exactly one commit above base');
    const headParents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).toString().trim().split(/\s+/);
    assert.equal(headParents.length, 2, 'Official image HEAD is not a child of the frozen base commit');
    assert.equal(headParents[1], base, 'Official image HEAD is not a child of the frozen base commit');
    headCommit = head;
    installModifiedFiles = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base, headCommit]).toString().trim().split('\n').filter(Boolean);
  }
  const temporary = fs.mkdtempSync(path.join(path.dirname(repo), '.base-git-'));
  try {
    execFileSync('/usr/bin/git', ['init', '--bare', '--template=', temporary], {env: gitEnvironment});
    execFileSync('/usr/bin/git', ['--git-dir=' + temporary, '-c', 'protocol.file.allow=always', 'fetch', '--depth=1', '--no-tags', 'file://' + repo, base], {env: gitEnvironment});
    if (headCommit !== base) {
      execFileSync('/usr/bin/git', ['--git-dir=' + temporary, '-c', 'protocol.file.allow=always', 'fetch', '--depth=2', '--no-tags', 'file://' + repo, headCommit], {env: gitEnvironment});
    }
    fs.writeFileSync(path.join(temporary, 'HEAD'), headCommit + '\n');
    fs.writeFileSync(path.join(temporary, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = false\n');
    for (const name of ['FETCH_HEAD', 'logs', 'hooks']) fs.rmSync(path.join(temporary, name), {recursive: true, force: true});
    fs.rmSync(path.join(repo, '.git'), {recursive: true});
    fs.renameSync(temporary, path.join(repo, '.git'));
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  git(['read-tree', headCommit]);
  const receipt = verifyBaseObjects(repo, base, headCommit);
  if (installModifiedFiles) receipt.installModifiedFiles = installModifiedFiles;
  assert.equal(git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', headCommit]).length, 0);
  return receipt;
}

export function verifyBaseObjects(repo, base, headCommit = base) {
  const git = args => execFileSync('/usr/bin/git', args, {cwd: repo, env: gitEnvironment, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2});
  assert.equal(git(['rev-parse', 'HEAD']).trim(), headCommit);
  assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), headCommit === base ? '1' : '2');
  assert.equal(git(['for-each-ref']).trim(), '');
  if (headCommit !== base) assert.equal(git(['rev-parse', 'HEAD^']).trim(), base);
  const all = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n');
  assert.equal(all.filter(line => line.endsWith(' commit')).length, headCommit === base ? 1 : 2);
  const stored = all.map(line => line.split(' ')[0]).sort();
  const reachable = git(['rev-list', '--objects', '--no-object-names', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(stored, reachable, 'Unreachable or future Git objects remain');
  for (const name of ['logs', 'objects/info/alternates', 'objects/info/http-alternates', 'worktrees', 'packed-refs', 'FETCH_HEAD']) assert(!fs.existsSync(path.join(repo, '.git', name)), 'Forbidden Git metadata: ' + name);
  assert.equal(fs.readFileSync(path.join(repo, '.git/shallow'), 'utf8').trim(), base);
  const receipt = {baseCommit: base, headCommit, commitObjects: headCommit === base ? 1 : 2, objects: stored.length, objectSetSha256: hash(stored.join('\n'))};
  if (headCommit === base) receipt.allObjectsReachableFromBase = true;
  else receipt.allObjectsReachableFromHead = true;
  return receipt;
}

export function verifyInstalledDjango(repo, installed) {
  const verified = [], removed = [];
  const tracked = new Set(execFileSync('/usr/bin/git', ['ls-files', '-z', '--', 'django'], {cwd: repo, env: gitEnvironment, encoding: 'utf8'}).split('\0'));
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        assert(entry.isFile(), 'Unexpected installed project link: ' + filename);
        if (/\.py[co]$/.test(filename)) { fs.unlinkSync(filename); removed.push(filename); continue; }
        const relative = path.relative(installed, filename);
        const source = path.join(repo, 'django', relative);
        assert(tracked.has('django/' + relative), 'Installed project file is not in base: ' + filename);
        assert(fs.existsSync(source) && fs.lstatSync(source).isFile(), 'Installed project file absent from base: ' + filename);
        const bytes = fs.readFileSync(filename);
        assert.equal(hash(bytes), hash(fs.readFileSync(source)), 'Installed project differs from base: ' + filename);
        verified.push({path: filename, sha256: hash(bytes)});
      }
    }
  };
  visit(installed);
  assert(verified.some(entry => entry.path.endsWith('/__init__.py')));
  return {files: verified.length, fileSetSha256: hash(JSON.stringify(verified)), removedBytecode: removed.length};
}

// Runs on the controller. Private comparison strings arrive on stdin, never argv or the image.
const archiveScanner = String.raw`
import sys, json, tarfile, zipfile, io, hashlib, gzip, bz2, lzma, posixpath, traceback
request = json.load(sys.stdin)
needles = [s.encode() for s in request.get('needles', []) if s]
findings, archives, files = [], [], []
limit = 512 * 1024 * 1024
def inspect(name, data, depth=0):
    digest = hashlib.sha256(data).hexdigest()
    files.append({'path': name, 'bytes': len(data), 'sha256': digest})
    if any(n in data for n in needles):
        findings.append({'path': name, 'sha256': digest, 'reason': 'prohibited-content'})
    if depth > 5: raise ValueError('archive nesting limit')
    stream = io.BytesIO(data)
    archive = None
    if zipfile.is_zipfile(stream):
        try:
            archive = zipfile.ZipFile(stream)
            for member in archive.infolist():
                with archive.open(member):
                    pass
        except zipfile.BadZipFile:
            if archive is not None:
                archive.close()
                archive = None
            # Signature constants also occur in ordinary compiled Python modules.
            if data.startswith(b'PK') or name.lower().endswith(('.zip', '.whl', '.egg', '.conda', '.jar')):
                raise
    if archive is not None:
        archives.append(name)
        with archive:
            for member in archive.infolist():
                if not member.is_dir():
                    if member.file_size > limit: raise ValueError('archive member size limit')
                    check_path(name + '!' + member.filename, False)
                    inspect(name + '!' + member.filename, archive.read(member), depth + 1)
    stream.seek(0)
    if data.startswith((b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00')):
        opener = gzip.GzipFile if data.startswith(b'\x1f\x8b') else bz2.BZ2File if data.startswith(b'BZh') else lzma.LZMAFile
        with (opener(fileobj=stream) if opener is gzip.GzipFile else opener(stream)) as compressed:
            expanded = compressed.read(limit + 1)
        if len(expanded) > limit: raise ValueError('archive expansion limit')
        archives.append(name)
        inspect(name + '!expanded', expanded, depth + 1)
        return
    if len(data) > 262 and data[257:262] == b'ustar':
        archives.append(name)
        with tarfile.open(fileobj=stream, mode='r:') as archive:
            for member in archive:
                check_path(name + '!' + member.name, False)
                if member.isfile():
                    if member.size > limit: raise ValueError('archive member size limit')
                    inspect(name + '!' + member.name, archive.extractfile(member).read(), depth + 1)
def check_path(name, root):
    parts = name.replace('!', '/').split('/')
    approved = root and (name == 'testbed/.git' or name.startswith('testbed/.git/'))
    if ('.git' in parts or name.endswith(('.pack', '.bundle'))) and not approved:
        findings.append({'path': '/' + name, 'reason': 'additional-git-material'})
    leaf = parts[-1].lower()
    if leaf in ['eval.sh', 'setup_repo.sh', 'setup_env.sh', 'test_patch.diff', 'gold.patch', 'prediction.json', 'predictions.jsonl']:
        findings.append({'path': '/' + name, 'reason': 'benchmark-material'})
with tarfile.open(request['archive'], mode='r|') as archive:
    members = []
    root_directory = False
    for member in archive:
        name = member.name.removeprefix('./')
        if request['mode'] == 'workspace':
            if name.startswith('/') or '..' in name.split('/') or not (name == 'testbed' or name.startswith('testbed/')):
                raise ValueError('workspace archive path escapes testbed')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('unsupported workspace archive member')
            if name.rstrip('/') == 'testbed':
                if not member.isdir(): raise ValueError('workspace root is not a directory')
                root_directory = True
            if member.islnk() and (member.linkname.startswith('/') or '..' in member.linkname.split('/') or not member.linkname.startswith('testbed/')):
                raise ValueError('workspace hardlink escapes testbed')
            members.append((name.rstrip('/'), member.issym() or member.islnk()))
        else:
            check_path(name, True)
            if member.isfile():
                if member.size > limit: raise ValueError('root file size limit')
                try:
                    inspect('/' + name, archive.extractfile(member).read())
                except Exception as error:
                    findings.append({'path': '/' + name, 'reason': 'archive-decoder-error', 'traceback': traceback.format_exc()})
    if request['mode'] == 'workspace':
        if not root_directory: raise ValueError('workspace archive has no root directory')
        links = {name for name, linked in members if linked}
        seen = set()
        for name, linked in members:
            if name in seen: raise ValueError('duplicate workspace archive member')
            seen.add(name)
            parent = posixpath.dirname(name)
            while parent:
                if parent in links: raise ValueError('workspace member traverses link')
                parent = posixpath.dirname(parent)
print(json.dumps({'passed': not findings, 'scope': request['mode'], 'regularFiles': len(files), 'fileSetSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(), 'archives': archives, 'findings': findings, 'excludes': ['kernel proc/sys/dev virtual filesystems'], 'contentScan': 'exact private patch/metadata bytes; recursively decoded zip, tar, gzip, bzip2, xz'}))
`;

export function inspectArchive(archive, needles = [], mode = 'root', receiptPrefix) {
  const result = spawnSync('python3', ['-c', archiveScanner], {input: JSON.stringify({archive, needles, mode}), encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, timeout: 600_000});
  if (receiptPrefix) {
    const outputs = {};
    for (const stream of ['stdout', 'stderr']) {
      const bytes = Buffer.from(result[stream] ?? '');
      const filename = receiptPrefix + '.' + stream + '.txt';
      fs.writeFileSync(filename, bytes, {flag: 'wx'});
      outputs[stream] = {path: path.basename(filename), sizeBytes: bytes.length, sha256: hash(bytes)};
    }
    fs.writeFileSync(receiptPrefix + '.process.json', JSON.stringify({status: result.status, signal: result.signal, errorCode: result.error?.code ?? null, timedOut: result.error?.code === 'ETIMEDOUT', ...outputs}) + '\n', {flag: 'wx'});
  }
  if (result.status !== 0 || result.signal || result.error) throw new Error('Archive inspection failed without admission (' + (result.status ?? result.signal ?? 'spawn') + ')');
  return JSON.parse(result.stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  const plan = JSON.parse(process.argv[3]);
  assert(plan.mode === 'as-shipped');
  assert(Array.isArray(plan.removals) && plan.removals.every(name => name && !name.includes('/') && !name.startsWith('.')), 'Sanitation removals must be simple top-level names');
  const git = sanitizeRepository('/testbed', base, plan.mode);
  const removed = [];
  for (const name of plan.removals) {
    assert.equal(execFileSync('/usr/bin/git', ['ls-files', '--', name], {cwd: '/testbed', env: gitEnvironment}).length, 0);
    fs.rmSync('/testbed/' + name, {recursive: true, force: true}); removed.push('/testbed/' + name);
  }
  fs.rmSync('/root/.gitconfig', {force: true}); removed.push('/root/.gitconfig');
  let installed = null;
  if (plan.installedEggPath) installed = verifyInstalledDjango('/testbed', plan.installedEggPath);
  console.log(JSON.stringify({git, installed, removed}));
}
