"""Read-only credential audit; archives are read without filesystem extraction."""
import bz2
import gzip
import lzma
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import zipfile

CHUNK = 1024 * 1024
MAX_EXPANDED = 32 * 1024 ** 3


def audit(root, secrets):
    needles = [value.encode() for value in secrets if isinstance(value, str) and value]
    if not needles:
        raise ValueError('Actual credential bytes are required')
    overlap = max(map(len, needles)) - 1
    expanded = 0
    files = []

    def check(data):
        if any(needle in data for needle in needles):
            raise ValueError('Credential bytes found; raw evidence withheld')

    def inspect(stream, depth=0):
        nonlocal expanded
        if depth > 8:
            raise ValueError('Archive nesting exceeds audit limit')
        stream.seek(0)
        header = stream.read(512)
        stream.seek(0)
        digest = hashlib.sha256()
        length = 0
        tail = b''
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            length += len(chunk)
            expanded += len(chunk)
            if expanded > MAX_EXPANDED:
                raise ValueError('Expanded evidence exceeds audit limit')
            digest.update(chunk)
            check(tail + chunk)
            tail = (tail + chunk)[-overlap:] if overlap else b''
        stream.seek(0)
        if header.startswith(b'PK\x03\x04') or header.startswith(b'PK\x05\x06'):
            with zipfile.ZipFile(stream) as archive:
                for member in archive.infolist():
                    check(member.filename.encode())
                    if member.is_dir():
                        continue
                    with archive.open(member) as source, tempfile.TemporaryFile() as temporary:
                        copy_archive(source, temporary)
                        inspect(temporary, depth + 1)
        elif header.startswith((b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00')):
            opener = gzip.GzipFile if header.startswith(b'\x1f\x8b') else bz2.BZ2File if header.startswith(b'BZh') else lzma.LZMAFile
            with (gzip.GzipFile(fileobj=stream) if opener is gzip.GzipFile else opener(stream)) as source, tempfile.TemporaryFile() as temporary:
                copy_archive(source, temporary)
                inspect(temporary, depth + 1)
        elif header.startswith((b'\x28\xb5\x2f\xfd', b'7z\xbc\xaf\x27\x1c', b'Rar!')):
            raise ValueError('Unsupported compressed evidence format')
        elif len(header) >= 265 and header[257:262] == b'ustar':
            with tarfile.open(fileobj=stream, mode='r:') as archive:
                for member in archive:
                    check(member.name.encode())
                    check(member.linkname.encode())
                    if member.isfile():
                        with archive.extractfile(member) as source, tempfile.TemporaryFile() as temporary:
                            copy_archive(source, temporary)
                            inspect(temporary, depth + 1)
                    elif not (member.isdir() or member.issym() or member.islnk()):
                        raise ValueError('Unsupported archive member type')
        return length, digest.hexdigest()

    def copy_archive(source, target):
        size = 0
        while True:
            chunk = source.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size + expanded > MAX_EXPANDED:
                raise ValueError('Expanded evidence exceeds audit limit')
            target.write(chunk)
        target.seek(0)

    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Evidence directory is missing or a symlink')
    root = root.resolve()
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            filename = Path(directory) / name
            relative = filename.relative_to(root).as_posix()
            info = filename.lstat()
            try:
                check(relative.encode())
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError('Evidence filesystem symlink rejected')
                if stat.S_ISDIR(info.st_mode):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Non-regular evidence file rejected')
                with filename.open('rb') as stream:
                    size, digest = inspect(stream)
            except Exception as error:
                digest = None
                if stat.S_ISREG(info.st_mode):
                    with filename.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                reason = 'credential-bytes' if type(error) is ValueError and str(error) == 'Credential bytes found; raw evidence withheld' else 'unverifiable-evidence'
                return {'safe': False, 'reason': reason, 'files': [], 'affectedFile': {'pathSha256': hashlib.sha256(relative.encode()).hexdigest(), 'sha256': digest}}
            files.append({'path': relative, 'sizeBytes': size, 'sha256': digest})
    return {'safe': True, 'files': sorted(files, key=lambda item: item['path']), 'expandedBytesScanned': expanded}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        result = audit(sys.argv[1], request['secrets'])
    except Exception:
        # Never print model-controlled paths, decoder errors, archive data or secrets.
        result = {'safe': False, 'reason': 'credential-or-unverifiable-evidence', 'files': []}
    print(json.dumps(result))
    sys.exit(0 if result['safe'] else 1)
