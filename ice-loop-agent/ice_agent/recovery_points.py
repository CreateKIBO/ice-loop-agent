"""Owned, complete workspace recovery archives. Never delete unknown files.

No Store/Engine is constructed here. Startup preparation precedes live database
migration and queue consumption; previews/migrations only touch disposable copies.
"""
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import tempfile
from uuid import uuid4
import zipfile

from . import __version__
from .backup import RECOVERY_LIMITS, clean_settings, create_backup, digest, inspect_backup, iter_backup_files, owned_recovery_root, restore_backup, RUNTIME_DIRS
from .domain.types import now_iso, sha256_json
from .paths import assert_not_c_drive, atomic_write_text, normalize

POINT_ID = re.compile(r'[0-9a-f]{32}')
MAX_META = 1024 * 1024
MAX_INDEX = 64 * 1024 * 1024
MAX_POINTS = 1000


def _read_json(file, maximum):
    if file.is_symlink() or file.is_junction() or not file.is_file() or file.stat().st_size > maximum:
        raise ValueError('恢复点元数据无效或路径已变化，原资料保留')
    value = json.loads(file.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('恢复点元数据无效')
    return value


def _regular(file):
    return file.is_file() and not file.is_symlink() and not file.is_junction()


class RecoveryPoints:
    def __init__(self, runtime):
        original = Path(runtime)
        if original.is_symlink() or original.is_junction():
            raise ValueError('恢复点工作区不能是符号链接或目录联接')
        self.runtime = normalize(runtime)
        assert_not_c_drive(self.runtime)
        self.root = self.runtime / 'recovery-points'
        self.runtime_id = hashlib.sha256(str(self.runtime).casefold().encode('utf-8')).hexdigest()

    def _owner(self, create=False):
        if not self.root.exists():
            if not create:
                return None
            self.root.mkdir()
        if self.root.is_symlink() or self.root.is_junction() or self.root.resolve() != self.root:
            raise ValueError('恢复点目录已变化，未进行读写')
        marker = self.root / '.owner.json'
        if not marker.exists() and create:
            if any(self.root.iterdir()):
                raise ValueError('恢复点目录含有未归属文件，程序将原样保留，请先检查目录')
            value = {'format':'ice-recovery-points', 'version':1, 'runtime_id':self.runtime_id,
                     'owner':uuid4().hex+uuid4().hex, 'created_at':now_iso()}
            # Exclusive publication: never adopt/replace an existing user file.
            with marker.open('x', encoding='utf-8') as stream:
                json.dump(value, stream, ensure_ascii=False)
        if owned_recovery_root(self.runtime) != self.root:
            raise ValueError('恢复点目录归属校验失败，未更改其中资料')
        return _read_json(marker, 4096)

    @contextmanager
    def _lock(self):
        self._owner(create=True)
        file = self.root / '.lock'
        if file.is_symlink() or file.is_junction():
            raise ValueError('恢复点锁路径已变化')
        with file.open('a+b') as stream:
            stream.seek(0)
            if file.stat().st_size == 0:
                stream.write(b'0'); stream.flush(); stream.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ValueError('恢复点正在处理，请等待当前操作结束') from error
            try:
                yield
            finally:
                stream.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def _point(self, point_id):
        owner = self._owner()
        if owner is None or not isinstance(point_id, str) or not POINT_ID.fullmatch(point_id):
            raise ValueError('恢复点不存在或标识无效')
        directory = self.root / point_id
        if (directory.is_symlink() or directory.is_junction() or not directory.is_dir()
                or directory.resolve() != directory or directory.parent != self.root):
            raise ValueError('恢复点目录已变化或不存在')
        record = _read_json(directory / 'point.json', MAX_META)
        if (record.get('format') != 'ice-recovery-point' or record.get('version') != 1
                or record.get('point_id') != point_id or record.get('owner') != owner['owner']
                or record.get('runtime_id') != self.runtime_id
                or record.get('state') not in ('creating','ready','failed')):
            raise ValueError('恢复点记录未归属当前工作区，原样保留')
        return directory, record

    def list(self):
        owner = self._owner()
        if owner is None:
            return {'directory':str(self.root), 'points':[], 'managed_bytes':0, 'unknown_count':0, 'truncated':False}
        points, unknown = [], 0
        entries = []
        for index, entry in enumerate(self.root.iterdir()):
            if index >= MAX_POINTS + 2:
                break
            entries.append(entry)
        truncated = len(entries) > MAX_POINTS
        for entry in entries:
            if entry.name in ('.owner.json','.lock'):
                continue
            if not POINT_ID.fullmatch(entry.name):
                unknown += 1; continue
            try:
                directory, record = self._point(entry.name)
                archive = directory / 'workspace.zip'
                size = archive.stat().st_size if _regular(archive) else 0
                known = {'point.json','workspace.zip','sources.json'} if record['state']=='ready' else {'point.json'}
                content_known = {file.name for file in directory.iterdir()} == known and all(_regular(directory/name) for name in known)
                points.append({'point_id':entry.name, 'record_hash':sha256_json(record),
                    'state':record['state'], 'reason':record.get('reason'), 'created_at':record.get('created_at'),
                    'source_schema':record.get('source_schema'), 'target_schema':record.get('target_schema'),
                    'files':record.get('files',0), 'archive_bytes':size,
                    'account_count':len(record.get('accounts',[])), 'error':record.get('error'),
                    'can_delete':content_known and record['state'] in ('ready','failed')})
            except (ValueError, OSError, json.JSONDecodeError):
                unknown += 1
        points.sort(key=lambda item:item.get('created_at') or '', reverse=True)
        return {'directory':str(self.root), 'points':points,
                'managed_bytes':sum(item['archive_bytes'] for item in points), 'unknown_count':unknown,
                'truncated':truncated}

    def create(self, settings, *, reason='manual', source_schema=None, progress=None):
        if reason not in ('manual','pre-migration'):
            raise ValueError('恢复点用途无效')
        with self._lock():
            point_id = uuid4().hex
            directory = self.root / point_id; directory.mkdir()
            owner = self._owner()
            record = {'format':'ice-recovery-point', 'version':1, 'point_id':point_id,
                'runtime_id':self.runtime_id, 'owner':owner['owner'], 'state':'creating',
                'reason':reason, 'created_at':now_iso(), 'source_schema':source_schema}
            from .migrations import MAX_KNOWN_VERSION
            record['target_schema'] = MAX_KNOWN_VERSION
            write = lambda:atomic_write_text(directory / 'point.json', json.dumps(record, ensure_ascii=False, indent=2))
            write()
            try:
                index = {}
                summary = create_backup(self.runtime, settings, directory / 'workspace.zip', limits=RECOVERY_LIMITS,
                    progress=progress, _for_recovery=True, _allow_inactive_leases=reason=='pre-migration', _source_index=index)
                with zipfile.ZipFile(directory / 'workspace.zip') as archive:
                    manifest = json.loads(archive.read('manifest.json'))
                index_text = json.dumps(index, ensure_ascii=False, sort_keys=True)
                if len(index_text.encode('utf-8')) > MAX_INDEX:
                    raise ValueError('恢复点来源索引超过容量上限')
                atomic_write_text(directory / 'sources.json', index_text)
                record.update(state='ready', package_hash=summary['package_hash'], files=summary['files'],
                    bytes=summary['bytes'], archive_bytes=(directory/'workspace.zip').stat().st_size,
                    source_schema=summary['database_schema'], target_schema=summary['database_target_schema'],
                    database_hash=manifest['files']['runtime/app.db']['sha256'], accounts=summary['accounts'],
                    settings_hash=sha256_json(clean_settings(settings)), sources_hash=digest(directory/'sources.json'))
                write()
                return {'point_id':point_id, 'record_hash':sha256_json(record), **summary}
            except BaseException as error:
                record.update(state='failed', error='恢复点创建未完成，原资料保留：'+str(error)[:500])
                try:
                    write()
                except OSError:
                    pass
                raise

    def inspect(self, point_id, *, progress=None):
        with self._lock():
            directory, record = self._point(point_id)
            if record['state'] != 'ready' or not _regular(directory/'workspace.zip'):
                raise ValueError('恢复点未完成，不能自动采用；请保留目录检查')
            summary = inspect_backup(directory/'workspace.zip', temporary_root=self.root,
                                     limits=RECOVERY_LIMITS, progress=progress)
            if summary['package_hash'] != record.get('package_hash'):
                raise ValueError('恢复点文件已变化，不能自动采用，原样保留')
            return {'point_id':point_id, 'record_hash':sha256_json(record), **summary}

    def restore(self, point_id, destination, package_hash, *, progress=None):
        with self._lock():
            directory, record = self._point(point_id)
            if record['state'] != 'ready' or record.get('package_hash') != package_hash or not _regular(directory/'workspace.zip'):
                raise ValueError('恢复点确认已失效，请重新校验')
            return restore_backup(directory/'workspace.zip', destination, package_hash,
                                  limits=RECOVERY_LIMITS, progress=progress)

    def delete(self, point_id, record_hash):
        with self._lock():
            directory, record = self._point(point_id)
            if record['state'] not in ('ready','failed') or sha256_json(record) != record_hash:
                raise ValueError('恢复点记录已变化，请刷新后再删除')
            expected = {'point.json'}
            if record['state'] == 'ready':
                expected |= {'workspace.zip','sources.json'}
            names = {file.name for file in directory.iterdir()}
            if names != expected or any(not _regular(directory/name) for name in names):
                raise ValueError('恢复点含有未识别或未完成的文件，程序不会删除，请手动检查目录')
            if record['state'] == 'ready':
                if digest(directory/'workspace.zip') != record.get('package_hash') or digest(directory/'sources.json') != record.get('sources_hash'):
                    raise ValueError('恢复点内容已变化，程序不会删除，请手动检查目录')
            stamps = {name:(file.stat().st_dev,file.stat().st_ino,file.stat().st_size,file.stat().st_mtime_ns)
                      for name in expected for file in [directory/name]}
            quarantine = self.root / ('.deleting-'+uuid4().hex)
            directory.rename(quarantine)
            try:
                if quarantine.is_symlink() or quarantine.is_junction() or quarantine.resolve() != quarantine:
                    raise ValueError('恢复点删除路径已变化')
                if {file.name for file in quarantine.iterdir()} != expected or any(not _regular(quarantine/name) for name in expected):
                    raise ValueError('恢复点内容在删除前已变化，原样保留')
                for name in expected:
                    stat = (quarantine/name).stat()
                    if (stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns) != stamps[name]:
                        raise ValueError('恢复点文件在删除前已变化，原样保留')
                moved = _read_json(quarantine/'point.json', MAX_META)
                if sha256_json(moved) != record_hash:
                    raise ValueError('恢复点记录在删除前已变化')
                for name in expected-{'point.json'}:
                    (quarantine/name).unlink()
                (quarantine/'point.json').unlink()
                quarantine.rmdir()  # Never a recursive delete of unknown content.
            except BaseException:
                if quarantine.exists() and not directory.exists():
                    quarantine.rename(directory)
                raise
            return {'deleted':point_id}

    def reusable(self, schema, settings, database_hash, *, progress=None):
        for row in self.list()['points']:
            if row['state'] != 'ready' or row.get('reason') != 'pre-migration' or row.get('source_schema') != schema:
                continue
            try:
                directory, record = self._point(row['point_id'])
                from .migrations import MAX_KNOWN_VERSION
                if (record.get('target_schema') != MAX_KNOWN_VERSION or record.get('database_hash') != database_hash
                        or record.get('settings_hash') != sha256_json(clean_settings(settings))
                        or digest(directory/'sources.json') != record.get('sources_hash')
                        or (directory/'workspace.zip').stat().st_size != record.get('archive_bytes')):
                    continue
                sources = _read_json(directory/'sources.json', MAX_INDEX)
                if len(sources) > RECOVERY_LIMITS.max_files:
                    continue
                fresh = True
                for item in sources.values():
                    path = Path(item['path'])
                    if path.is_symlink() or path.is_junction():
                        fresh = False; break
                    stat = path.stat()
                    if (stat.st_size,stat.st_mtime_ns,stat.st_ino,stat.st_dev) != (item['size'],item['mtime_ns'],item['inode'],item['device']):
                        fresh = False; break
                if fresh:
                    # A new file without a DB write still belongs to the full
                    # workspace. Never reuse an archive that predates it.
                    with zipfile.ZipFile(directory/'workspace.zip') as archive:
                        manifest = json.loads(archive.read('manifest.json'))
                    roots = [self.runtime/name for name in RUNTIME_DIRS]+[Path(item['source']) for item in manifest['article_roots']]
                    from .backup import _archive_digest
                    for name,item in sources.items():
                        with Path(item['path']).open('rb') as stream:
                            current_hash = _archive_digest(stream, limits=RECOVERY_LIMITS, progress=progress)
                        if current_hash != manifest['files'][name]['sha256']:
                            fresh = False; break
                    paths = set()
                    for root in roots:
                        assert_not_c_drive(root)
                        for file in iter_backup_files(root, excluded_root=self.root):
                            paths.add(str(file))
                            if len(paths) > RECOVERY_LIMITS.max_files:
                                fresh = False; break
                    if paths != {item['path'] for item in sources.values()}:
                        fresh = False
                if fresh:
                    # Reused archives must still have the bytes we approved.
                    from .backup import _archive_digest
                    with (directory/'workspace.zip').open('rb') as stream:
                        actual = _archive_digest(stream, limits=RECOVERY_LIMITS, progress=progress)
                    if actual != record.get('package_hash'):
                        continue
                    return {'point_id':row['point_id'], 'reused':True, 'package_hash':record['package_hash']}
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return None


def prepare_upgrade(runtime, settings, *, progress=None):
    runtime = normalize(runtime)
    file = runtime / 'app.db'
    if not file.exists():
        return None
    if file.stat().st_size == 0:
        raise ValueError('现有数据库为空，请使用工作区恢复入口，原目录已保留')
    from .migrations import MAX_KNOWN_VERSION, validate_migration_state
    with closing(sqlite3.connect(file.as_uri()+'?mode=ro', uri=True)) as source:
        source.execute('PRAGMA query_only=ON'); source.execute('PRAGMA trusted_schema=OFF')
        schema = source.execute('PRAGMA user_version').fetchone()[0]
        validate_migration_state(source)
        if schema >= MAX_KNOWN_VERSION:
            return None
        if schema < 9:
            raise ValueError('工作区版本早于受支持的完整备份基线，请先使用匹配旧版本整理或导出资料')
        db_bytes = source.execute('PRAGMA page_count').fetchone()[0] * source.execute('PRAGMA page_size').fetchone()[0]
        if db_bytes > RECOVERY_LIMITS.max_file:
            raise ValueError('数据库超过恢复点单文件4GB上限，原数据库未升级')
        if shutil.disk_usage(runtime).free < db_bytes*4+64*1024*1024:
            raise ValueError('升级前数据库快照空间不足，原数据库未升级，请先整理磁盘空间')
        manager = RecoveryPoints(runtime); manager._owner(create=True)
        with tempfile.TemporaryDirectory(prefix='.prepare-', dir=manager.root) as temporary:
            snapshot = Path(temporary)/'app.db'
            with closing(sqlite3.connect(snapshot)) as target:
                if progress is None:
                    source.backup(target)
                else:
                    source.backup(target,pages=256,progress=lambda status,left,total:progress('snapshot_database',pages_done=total-left,pages_total=total))
            reusable = manager.reusable(schema, settings, digest(snapshot), progress=progress)
            if reusable:
                return reusable
            return manager.create(settings, reason='pre-migration',source_schema=schema,progress=progress)
