"""Portable, checked warehouse snapshots. Uses only Python's standard library.

The archive is data, never an executable disk image. Extraction never trusts tar
paths, links, ownership or permissions. The live SQLite WAL is included through
SQLite's online backup API rather than by copying inventory.db.
"""
import datetime
import errno
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
import uuid

MAX_EXPANDED = 8 * 1024**3
MAX_CARD_FILE = 128 * 1024**2
MIN_CARD_FREE = 128 * 1024**2
PATTERN = re.compile(r'^LytGuide-\d{8}T\d{6}-[a-f0-9]{8}\.lytbackup$')


def checksum(path):
    value = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    except OSError as error:
        if error.errno not in (errno.EINVAL, errno.ENOTSUP):
            raise
    finally:
        os.close(fd)


def check_database(path):
    connection = sqlite3.connect(pathlib.Path(path).as_uri() + '?mode=ro', uri=True)
    try:
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('The backup database is damaged.')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'users', 'products', 'cells', 'inventory_balances', 'tasks', 'app_metadata', 'controllers'} <= tables:
            raise ValueError('This is not a supported LytGuide warehouse database.')
        if connection.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('The backup has broken database references.')
        return {name: connection.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0]
                for name in ('users', 'products', 'cells', 'tasks', 'controllers')}
    finally:
        connection.close()


def safe_name(name):
    return name in ('inventory.sqlite', 'pki/root.crt', 'pki/root.key', 'pki/intermediate.crt', 'pki/intermediate.key') or bool(re.fullmatch(r'archives/[A-Za-z0-9][A-Za-z0-9_.-]{0,220}\.json', name)) and '..' not in name


def create(data, destination, version, hints=None, pki=None):
    data, destination = pathlib.Path(data), pathlib.Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('That backup file already exists. Choose a new filename.')
    if not destination.parent.is_dir() or destination.parent.is_symlink():
        raise ValueError('Choose an existing backup folder without a symbolic link.')
    temporary = destination.with_name(destination.name + '.writing-' + uuid.uuid4().hex)
    try:
        with tempfile.TemporaryDirectory(prefix='snapshot-', dir=data.parent) as work:
            snapshot = pathlib.Path(work, 'inventory.sqlite')
            source = sqlite3.connect((data / 'inventory.db').as_uri() + '?mode=ro', uri=True, timeout=30)
            target = sqlite3.connect(snapshot)
            try:
                deadline = time.monotonic() + 90
                def progress(*_):
                    if time.monotonic() > deadline:
                        raise TimeoutError('Database snapshot took too long; the previous recovery copy was kept.')
                source.backup(target, pages=256, progress=progress)
            finally:
                target.close()
                source.close()
            counts = check_database(snapshot)
            entries = [('inventory.sqlite', snapshot)]
            if pki:
                for name in ('root.crt', 'root.key', 'intermediate.crt', 'intermediate.key'):
                    source_file = pathlib.Path(pki, name)
                    if source_file.is_symlink() or not source_file.is_file():
                        raise ValueError('The phone certificate identity is incomplete.')
                    copied = pathlib.Path(work, 'pki-' + name)
                    shutil.copyfile(source_file, copied)
                    entries.append(('pki/' + name, copied))
            archives = data / 'archives'
            if archives.is_symlink():
                raise ValueError('Archive storage cannot be a symbolic link.')
            if archives.exists():
                for item in sorted(archives.iterdir()):
                    name = 'archives/' + item.name
                    if not safe_name(name) or item.is_symlink() or not item.is_file():
                        raise ValueError('Unexpected file in warehouse archive storage: ' + item.name)
                    # Freeze archive bytes too: no changing file is hashed then read again.
                    copied = pathlib.Path(work, item.name)
                    shutil.copyfile(item, copied)
                    entries.append((name, copied))
            if len(entries) > 10000 or sum(path.stat().st_size for _, path in entries) > MAX_EXPANDED:
                raise ValueError('Warehouse data is too large for this recovery format.')
            manifest = {'format': 'lytguide-recovery', 'formatVersion': 1, 'packageVersion': version,
                        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        'counts': counts, 'hints': hints or {},
                        'files': [{'path': name, 'bytes': path.stat().st_size, 'sha256': checksum(path)} for name, path in entries]}
            metadata = json.dumps(manifest, sort_keys=True).encode()
            if len(metadata) > 1024**2:
                raise ValueError('Recovery manifest is too large.')
            with open(temporary, 'xb') as raw:
                os.chmod(temporary, 0o600)
                with tarfile.open(fileobj=raw, mode='w:gz', format=tarfile.USTAR_FORMAT) as archive:
                    info = tarfile.TarInfo('manifest.json')
                    info.size, info.mode = len(metadata), 0o600
                    archive.addfile(info, io.BytesIO(metadata))
                    for name, path in entries:
                        info = tarfile.TarInfo(name)
                        info.size, info.mode = path.stat().st_size, 0o600
                        with path.open('rb') as source_file:
                            archive.addfile(info, source_file)
                raw.flush()
                os.fsync(raw.fileno())
            os.rename(temporary, destination)
            sync_directory(destination.parent)
            return manifest
    finally:
        temporary.unlink(missing_ok=True)


def extract(source, destination):
    destination = pathlib.Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        with tarfile.open(source, mode='r|gz') as archive:
            first = archive.next()
            if not first or first.name != 'manifest.json' or not first.isfile() or not 0 < first.size <= 1024**2:
                raise ValueError('Recovery manifest is missing or invalid.')
            manifest = json.load(archive.extractfile(first))
            if manifest.get('format') != 'lytguide-recovery' or manifest.get('formatVersion') != 1:
                raise ValueError('Unsupported recovery file format.')
            if not isinstance(manifest.get('createdAt'), str) or not re.fullmatch('[0-9T:+.Z-]{10,64}', manifest['createdAt']):
                raise ValueError('Invalid recovery snapshot date.')
            files = manifest.get('files')
            if not isinstance(files, list) or not 1 <= len(files) <= 10000:
                raise ValueError('Invalid recovery file list.')
            expected = {}
            for item in files:
                if (not isinstance(item, dict) or not safe_name(item.get('path', ''))
                        or item['path'] in expected or type(item.get('bytes')) is not int
                        or not 0 <= item['bytes'] <= MAX_EXPANDED
                        or not re.fullmatch('[a-f0-9]{64}', item.get('sha256', ''))):
                    raise ValueError('Invalid or unsafe recovery file entry.')
                expected[item['path']] = item
            if 'inventory.sqlite' not in expected or sum(item['bytes'] for item in files) > MAX_EXPANDED:
                raise ValueError('Recovery data is missing or too large.')
            if shutil.disk_usage(destination).free < sum(item['bytes'] for item in files) + 64 * 1024**2:
                raise ValueError('Not enough free space to check the recovery file.')
            seen = set()
            while True:
                member = archive.next()
                if member is None:
                    break
                item = expected.get(member.name)
                if not item or member.name in seen or not member.isfile() or member.size != item['bytes']:
                    raise ValueError('Unexpected, repeated or unsafe archive member.')
                seen.add(member.name)
                path = destination / member.name
                path.parent.mkdir(mode=0o700, exist_ok=True)
                with path.open('xb') as output:
                    os.chmod(path, 0o600)
                    shutil.copyfileobj(archive.extractfile(member), output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                if checksum(path) != item['sha256']:
                    raise ValueError('Recovery checksum failed: ' + member.name)
            if seen != set(expected):
                raise ValueError('The recovery file is incomplete.')
            if manifest.get('counts') != check_database(destination / 'inventory.sqlite'):
                raise ValueError('Recovery summary does not match the database.')
            return manifest
    except BaseException:
        shutil.rmtree(destination)
        raise


def publish(source, directory, min_free=MIN_CARD_FREE, max_file=MAX_CARD_FILE, retain_all=False, purpose=None):
    source, directory = pathlib.Path(source), pathlib.Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Recovery folder must be a real directory.')
    size = source.stat().st_size
    if size > max_file:
        raise ValueError('Recovery exceeds the SD-card copy size limit. Export to a USB drive instead; previous copies were kept.')
    previous = sorted((item for item in directory.iterdir() if PATTERN.fullmatch(item.name) and item.is_file() and not item.is_symlink()), key=lambda item: item.stat().st_mtime_ns, reverse=True)
    if shutil.disk_usage(directory).free < size + min_free:
        raise ValueError('Not enough safe space on the recovery volume. Previous copies were kept; use a USB/export copy or free space.')
    # Never delete an older copy to make room for an uncommitted write.
    name = ('LytGuide-Uninstall-' if purpose == 'uninstall' else 'LytGuide-') + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8] + '.lytbackup'
    temporary, target = directory / (name + '.writing'), directory / name
    try:
        with source.open('rb') as input_file, temporary.open('xb') as output:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        if checksum(temporary) != checksum(source):
            raise ValueError('Recovery copy verification failed; previous copies were kept.')
        os.rename(temporary, target)
        sync_directory(directory)
        if not retain_all:
            for old in previous[1:]:
                old.unlink()
        return {'filename': name, 'bytes': size, 'sha256': checksum(target)}
    finally:
        temporary.unlink(missing_ok=True)


def main():
    request = json.load(sys.stdin)
    action = request['action']
    if action == 'create':
        result = create(request['data'], request['destination'], request['version'], request.get('hints'), request.get('pki'))
    elif action == 'extract':
        result = extract(request['source'], request['destination'])
    elif action == 'publish':
        result = publish(request['source'], request['directory'], retain_all=request.get('retainAll') is True, purpose=request.get('purpose'))
    else:
        raise ValueError('Unknown recovery action.')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
