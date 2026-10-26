"""Consistent local bundles and verified restore into a fresh data directory.

Only managed data are collected. Login profiles, OS-encrypted keys and logs are
excluded; historical article bodies are kept verbatim. No code runs on restore.
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from contextlib import closing
from pathlib import Path, PurePosixPath

from . import __version__
from .domain.types import now_iso, sha256_text
from .paths import assert_not_c_drive, assert_within, atomic_write_text, is_within, normalize

MAX_BYTES = 1024 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_FILES = 10000
BLOCK_BYTES = 1024 * 1024

MAX_SETTINGS_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True)
class BackupLimits:
    max_bytes: int
    max_file: int
    max_files: int
    max_manifest: int = 1024 * 1024


# Larger limits are only chosen by the owned recovery-point API, never by a
# renderer-supplied limits object or by values inside an untrusted archive.
RECOVERY_LIMITS = BackupLimits(32 * 1024**3, 4 * 1024**3, 100000, 32 * 1024**2)


def _limits(value=None):
    return value or BackupLimits(MAX_BYTES, MAX_FILE, MAX_FILES)


def _kwargs(limits=None, progress=None):
    result = {}
    if limits is not None:
        result['limits'] = limits
    if progress is not None:
        result['progress'] = progress
    return result


def _notify(progress, phase, **values):
    if progress is not None:
        progress(phase, **values)


def owned_recovery_root(runtime):
    root = normalize(runtime) / 'recovery-points'
    marker = root / '.owner.json'
    if root.is_symlink() or root.is_junction() or marker.is_symlink():
        return None
    try:
        if marker.stat().st_size > 4096:
            return None
        value = json.loads(marker.read_text(encoding='utf-8'))
        identity = hashlib.sha256(str(normalize(runtime)).casefold().encode('utf-8')).hexdigest()
        if (value.get('format') == 'ice-recovery-points' and value.get('version') == 1
                and value.get('runtime_id') == identity and re.fullmatch('[0-9a-f]{64}', value.get('owner', ''))):
            return root
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return None
RUNTIME_DIRS = ('jobs', 'assets', 'resources', 'staging', 'screenshots','captures','image-variants','run-evidence')
EXCLUDED = {'credentials.json', 'keys.json', '.env', 'electron', 'sessions', 'browser', 'logs', '__pycache__'}
SECRET_KEYS = {'api_key', 'apikey', 'access_token', 'refresh_token', 'password', 'secret', 'authorization'}


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def clean_settings(value):
    if isinstance(value, dict):
        return {key:clean_settings(item) for key,item in value.items() if key.lower() not in SECRET_KEYS}
    if isinstance(value, list):
        return [clean_settings(item) for item in value]
    return value


def safe_name(name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith('/') or '\\' in name or any(
            part in ('.', '..') or part.rstrip(' .') != part or
            re.search(r'[:<>"|?*\x00-\x1f]', part) or
            re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I)
            for part in parts):
        raise ValueError('备份包含不安全的文件路径')
    if str(PurePosixPath(name)) != name:
        raise ValueError('备份路径不是规范相对路径')
    if parts[0] not in ('runtime', 'articles', 'manifest.json'):
        raise ValueError('备份包含未识别的数据目录')
    return name


def iter_backup_files(root, *, excluded_root=None):
    root = Path(root)
    if root.is_symlink() or root.is_junction():
        raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
    if not root.exists():
        return
    for directory, dirs, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        dirs[:] = [name for name in dirs if name.lower() not in EXCLUDED and (excluded_root is None or parent/name != excluded_root)]
        for name in dirs+files:
            item = parent/name
            if item.is_symlink() or item.is_junction():
                raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
            assert_within(item, root)
        for name in files:
            if name.lower() not in EXCLUDED and not name.lower().endswith(('.tmp','-wal','-shm')):
                yield parent/name


def create_backup(runtime, settings, target, *, limits=None, progress=None, _for_recovery=False, _allow_inactive_leases=False, _source_index=None):
    runtime, target = normalize(runtime), normalize(target)
    policy = _limits(limits)
    recovery_root = owned_recovery_root(runtime)
    if _for_recovery and (recovery_root is None or target.parent.parent != recovery_root
            or not re.fullmatch('[0-9a-f]{32}', target.parent.name) or target.name != 'workspace.zip'):
        raise ValueError('自动恢复点目标未归属当前工作区')
    if _allow_inactive_leases and not _for_recovery:
        raise ValueError('仅升级前恢复点可以保留旧执行租约')
    assert_not_c_drive(target)
    def managed_root(value):
        original = Path(value)
        if original.is_symlink() or original.is_junction():
            raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
        return str(normalize(original))
    roots = sorted({managed_root(account['article_root']) for account in settings['accounts'].values()}
                   | {managed_root(settings['article_root'])})
    # Include frozen roots of older jobs after an account output path changed.
    with closing(sqlite3.connect((runtime / 'app.db').as_uri() + '?mode=ro', uri=True)) as source:
        source.execute('PRAGMA query_only=ON')
        source.execute('PRAGMA trusted_schema=OFF')
        if not _allow_inactive_leases and source.execute("SELECT COUNT(*) FROM jobs WHERE lease IS NOT NULL OR state='running'").fetchone()[0]:
            raise ValueError('任务正在运行，请暂停后再备份')
        roots = sorted(set(roots) | {managed_root(json.loads(row[0])['article_root'])
            for row in source.execute('SELECT spec_json FROM articles') if json.loads(row[0]).get('article_root')})
        for root in [runtime, *map(Path, roots)]:
            assert_not_c_drive(root)
            if is_within(target, root) and not _for_recovery:
                raise ValueError('请把备份文件保存在工作数据目录之外')
        if recovery_root is not None and any(is_within(root, recovery_root) for root in map(Path, roots)):
            raise ValueError('文章目录不能位于内部恢复点目录中')
        target.parent.mkdir(parents=True, exist_ok=True)
        # Reserve for worst-case compression, source snapshot, validation copy
        # and migration scratch. Scan only the same managed roots we will copy.
        file_count = 0
        estimated = 0
        for root in [*(runtime/name for name in RUNTIME_DIRS), *map(Path, roots)]:
            for file in iter_backup_files(root, excluded_root=recovery_root):
                size = file.stat().st_size
                estimated += size
                if size > policy.max_file or estimated > policy.max_bytes or file_count >= policy.max_files-2:
                    raise ValueError('工作数据超过备份容量上限，原资料保留')
                file_count += 1
                _notify(progress, 'scan_files', files_done=file_count, bytes_done=estimated)
        db_bytes = source.execute('PRAGMA page_count').fetchone()[0] * source.execute('PRAGMA page_size').fetchone()[0]
        required = int(estimated*1.02) + db_bytes*4 + 64*1024*1024
        if shutil.disk_usage(target.parent).free < required:
            raise ValueError('备份所在磁盘空间不足，至少需额外约 '+str((required+1024**2-1)//1024**2)+' MB；原数据库未升级')
        with tempfile.TemporaryDirectory(prefix='ice-backup-', dir=target.parent) as temp:
            staging = Path(temp)
            snapshot = staging / 'app.db'
            with closing(sqlite3.connect(snapshot)) as dest:
                _notify(progress, 'snapshot_database')
                if progress is None:
                    source.backup(dest)
                else:
                    source.backup(dest, pages=256, progress=lambda status, remaining, total:
                                  _notify(progress, 'snapshot_database', pages_done=total-remaining, pages_total=total))
                if progress:
                    dest.set_progress_handler(lambda: (_notify(progress,'verify_database') or 0),10000)
                if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('数据库校验失败，备份未保存')
                bindings = list(dest.execute('SELECT path,sha256 FROM artifacts')) + list(dest.execute('SELECT file_path,sha256 FROM asset_candidates'))
                for metadata, in dest.execute('SELECT metadata_json FROM publication_resources'):
                    resource = json.loads(metadata)
                    bindings.append((resource['file_path'],resource['sha256']))
            manifest = {'format':'ice-workspace', 'schema':1, 'app_version':__version__,
                'created_at':now_iso(), 'runtime_source':str(runtime),
                'article_roots': [{'source':root, 'relative':f'articles/root-{index}'} for index,root in enumerate(roots)],
                'accounts':[{'id':a['id'], 'name':a['name']} for a in settings['accounts'].values()],
                'excluded':['API Key 与登录会话', '日志与浏览器缓存', '外部只读存稿目录（历史正文快照保留在数据库）', *(['自动恢复点及其内部索引'] if recovery_root else [])],
                'files':{}}
            sanitized = staging / 'settings.json'
            atomic_write_text(sanitized, json.dumps(clean_settings(settings), ensure_ascii=False, indent=2))
            temporary = staging / 'bundle.zip'
            total = 0
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as bundle:
                def add(file, name, *, record_source=True):
                    nonlocal total
                    safe_name(name)
                    initial_stat = file.stat()
                    size = initial_stat.st_size
                    total += size
                    if size > policy.max_file or total > policy.max_bytes or len(manifest['files']) >= policy.max_files:
                        raise ValueError('工作数据超过备份上限（单文件 128MB、总量 1GB、10000 文件）' if limits is None else '恢复点超过容量上限（单文件4GB、总量32GB、100000文件）')
                    total -= size
                    written = 0
                    hasher = hashlib.sha256()
                    with file.open('rb') as source_file, bundle.open(name, 'w', force_zip64=size >= zipfile.ZIP64_LIMIT) as member:
                        for block in iter(lambda: source_file.read(BLOCK_BYTES), b''):
                            written += len(block)
                            total += len(block)
                            if written > policy.max_file or total > policy.max_bytes:
                                raise ValueError('备份读取期间文件超过大小上限，未保存')
                            member.write(block)
                            hasher.update(block)
                            _notify(progress, 'copy_files', files_done=len(manifest['files']), bytes_done=total)
                    final_stat = file.stat()
                    if (initial_stat.st_dev, initial_stat.st_ino, initial_stat.st_size, initial_stat.st_mtime_ns) != (final_stat.st_dev, final_stat.st_ino, final_stat.st_size, final_stat.st_mtime_ns):
                        raise ValueError('备份读取期间源文件已变化，原资料保留')
                    if _source_index is not None and record_source:
                        _source_index[name] = {'path':str(file), 'size':final_stat.st_size, 'mtime_ns':final_stat.st_mtime_ns, 'inode':final_stat.st_ino, 'device':final_stat.st_dev}
                    manifest['files'][name] = {'size':written, 'sha256':hasher.hexdigest()}
                def collect(root, prefix):
                    for file in iter_backup_files(root, excluded_root=recovery_root):
                        add(file, prefix+'/'+file.relative_to(root).as_posix())
                add(snapshot, 'runtime/app.db', record_source=False)
                add(sanitized, 'runtime/settings.json', record_source=False)
                for directory in RUNTIME_DIRS:
                    collect(runtime / directory, 'runtime/' + directory)
                for root in manifest['article_roots']:
                    collect(Path(root['source']), root['relative'])
                # Check references against the bytes in the bundle, not a later reread
                # of source files. Missing or concurrently changed evidence is fatal.
                for reference, expected in bindings:
                    if not reference:
                        continue
                    names = []
                    for directory, prefix in [(runtime,'runtime')] + [(Path(root['source']),root['relative']) for root in manifest['article_roots']]:
                        try:
                            names.append(prefix + '/' + Path(reference).relative_to(directory).as_posix())
                        except ValueError:
                            pass
                    if not any(manifest['files'].get(name,{}).get('sha256') == expected for name in names):
                        raise ValueError('托管图片或运行证据缺失/变化，备份未保存：' + Path(reference).name)
                manifest_text = json.dumps(manifest, ensure_ascii=False)
                if len(manifest_text.encode('utf-8')) > policy.max_manifest:
                    raise ValueError('备份清单超过容量上限，原资料保留')
                bundle.writestr('manifest.json', manifest_text)
            summary = inspect_backup(temporary, temporary_root=staging, **_kwargs(limits, progress))
            _notify(progress, 'save_recovery_point')
            os.replace(temporary, target)
    return {**summary, 'file_path':str(target)}


def _validate(bundle, *, limits=None, progress=None):
    policy = _limits(limits)
    entries = bundle.infolist()
    if len(entries) > policy.max_files + 1 or sum(entry.file_size for entry in entries) > policy.max_bytes + policy.max_manifest:
        raise ValueError('备份超出读取上限')
    names = []
    for entry in entries:
        safe_name(entry.filename)
        if entry.file_size > policy.max_file or entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('备份包含不支持的文件类型或超大文件')
        names.append(entry.filename)
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('备份包含重名文件')
    if 'manifest.json' not in names or bundle.getinfo('manifest.json').file_size > policy.max_manifest:
        raise ValueError('缺少有效的备份清单')
    if 'runtime/settings.json' in names and bundle.getinfo('runtime/settings.json').file_size > MAX_SETTINGS_BYTES:
        raise ValueError('备份配置超过读取上限')
    manifest = json.loads(bundle.read('manifest.json'))
    if not isinstance(manifest, dict) or manifest.get('format') != 'ice-workspace' or type(manifest.get('schema')) is not int or manifest['schema'] != 1:
        raise ValueError('不支持此备份格式或版本')
    files = manifest.get('files', {})
    if not isinstance(files, dict):
        raise ValueError('备份文件清单无效')
    if set(names) != set(files) | {'manifest.json'} or not {'runtime/app.db', 'runtime/settings.json'} <= set(files):
        raise ValueError('备份内容与清单不一致')
    roots = manifest.get('article_roots', [])
    if not isinstance(roots, list) or len(roots) > 1000:
        raise ValueError('文章目录清单无效')
    for index, root in enumerate(roots):
        if not isinstance(root, dict) or root.get('relative') != f'articles/root-{index}' or not isinstance(root.get('source'), str) or not Path(root['source']).is_absolute():
            raise ValueError('文章目录映射无效')
    if not isinstance(manifest.get('runtime_source'), str) or not Path(manifest['runtime_source']).is_absolute():
        raise ValueError('工作目录映射无效')
    for key in ('created_at', 'app_version'):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise ValueError('备份版本或日期信息无效')
    if not isinstance(manifest.get('accounts'), list) or not isinstance(manifest.get('excluded'), list):
        raise ValueError('备份摘要无效')
    for name, meta in files.items():
        parts = PurePosixPath(name).parts
        if (not isinstance(meta, dict) or type(meta.get('size')) is not int or not 0 <= meta['size'] <= policy.max_file
                or not isinstance(meta.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', meta['sha256'])):
            raise ValueError('备份文件校验信息无效')
        if parts[0] == 'runtime' and not (name in ('runtime/app.db', 'runtime/settings.json') or len(parts) >= 3 and parts[1] in RUNTIME_DIRS):
            raise ValueError('备份包含非托管运行数据')
        if parts[0] == 'articles' and not any(name.startswith(root['relative'] + '/') for root in roots):
            raise ValueError('备份文章文件未归属有效目录')
        if parts[0] == 'manifest.json':
            raise ValueError('备份清单不能充当数据目录')
        _notify(progress, 'verify_files')
        size, checksum = _hash_member(bundle, name, **_kwargs(limits, progress))
        if size != meta['size'] or checksum != meta['sha256']:
            raise ValueError('备份文件损坏或校验失败：' + name)
    return manifest


def _hash_member(bundle, name, *, limits=None, progress=None):
    policy = _limits(limits)
    size, hasher = 0, hashlib.sha256()
    with bundle.open(name) as member:
        for block in iter(lambda: member.read(BLOCK_BYTES), b''):
            size += len(block)
            if size > policy.max_file:
                raise ValueError('备份文件超过大小上限')
            hasher.update(block)
            _notify(progress, 'verify_files')
    return size, hasher.hexdigest()


def _extract_member(bundle, name, target, expected, *, limits=None, progress=None):
    policy = _limits(limits)
    size, hasher = 0, hashlib.sha256()
    with bundle.open(name) as source, target.open('wb') as destination:
        for block in iter(lambda: source.read(BLOCK_BYTES), b''):
            size += len(block)
            if size > policy.max_file:
                raise ValueError('备份文件在读取期间超过大小上限')
            hasher.update(block)
            destination.write(block)
            _notify(progress, 'restore_files')
    if size != expected['size'] or hasher.hexdigest() != expected['sha256']:
        raise ValueError('备份文件在读取期间已变化或校验失败：' + name)


def _check_workspace(bundle, manifest, staging, *, limits=None, progress=None):
    """Open/migrate a disposable database, never a live workspace or the ZIP."""
    try:
        settings_bytes = bundle.read('runtime/settings.json')
        expected_settings = manifest['files']['runtime/settings.json']
        if len(settings_bytes) != expected_settings['size'] or hashlib.sha256(settings_bytes).hexdigest() != expected_settings['sha256']:
            raise ValueError('备份配置在读取期间已变化或校验失败')
        settings = json.loads(settings_bytes)
        roots = {root['source'] for root in manifest['article_roots']}
        accounts = settings.get('accounts') if isinstance(settings, dict) else None
        if (not isinstance(accounts, dict) or not accounts or len(accounts) > 1000
                or settings.get('active_account_id') not in accounts or settings.get('article_root') not in roots
                or not isinstance(settings.get('vision'), dict) or not isinstance(settings.get('profiles'), dict)
                or not isinstance(settings.get('routes'), dict)):
            raise ValueError('备份配置不完整或当前公众号无效')
        for aid, account in accounts.items():
            if (not isinstance(account, dict) or account.get('id') != aid
                    or not isinstance(account.get('name'), str) or not account['name']
                    or account.get('article_root') not in roots or not isinstance(account.get('columns'), list)):
                raise ValueError('备份公众号配置或目录映射无效')
            from .accounts import normalize_account, profile_from_account
            normalize_account(account, Path(manifest['runtime_source']), account_id=aid)
            profile_from_account(account)  # same required fields as the desktop engine
        if manifest['accounts'] != [{'id': a['id'], 'name': a['name']} for a in accounts.values()]:
            raise ValueError('备份公众号摘要与实际配置不一致')
        if any(not isinstance(p, dict) for p in settings['profiles'].values()):
            raise ValueError('备份模型配置无效')
        from .domain.types import ModelProfile
        from .llm.router import RouteConfig
        for profile in settings['profiles'].values():
            ModelProfile(**profile)
        for route in settings['routes'].values():
            if not isinstance(route, dict):
                raise ValueError('备份模型路由配置无效')
            RouteConfig(**route)
        database = staging / 'checked.db'
        _extract_member(bundle, 'runtime/app.db', database, manifest['files']['runtime/app.db'], **_kwargs(limits, progress))
        with closing(sqlite3.connect(database)) as db:
            db.execute('PRAGMA trusted_schema=OFF')
            if progress is not None:
                db.set_progress_handler(lambda: (_notify(progress, 'verify_database') or 0), 10000)
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('备份数据库已损坏')
            schema = db.execute('PRAGMA user_version').fetchone()[0]
            required = {'articles', 'jobs', 'checkpoints', 'artifacts', 'asset_candidates', 'publication_resources', 'asset_slots'}
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required <= tables:
                raise ValueError('备份数据库缺少工作台数据表')
            from .migrations import MAX_KNOWN_VERSION, run_migrations, verify_migrations
            if not 9 <= schema <= MAX_KNOWN_VERSION:
                raise ValueError('备份数据库来自不支持的版本，请使用对应版本的程序恢复')
            migration = run_migrations(db, app_version=__version__)  # this file is already a disposable copy
            audit = verify_migrations(db)
            for text, expected in db.execute('SELECT state_json,content_hash FROM checkpoints'):
                if sha256_text(text) != expected or not isinstance(json.loads(text), dict):
                    raise ValueError('备份任务检查点校验失败')
        return {'database_schema': schema, 'database_target_schema': migration['after'],
                'migration_versions': [item['version'] for item in migration['applied']],
                'legacy_unverified': audit['legacy_unverified']}
    except (sqlite3.Error, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError('备份数据库或配置无法读取，请选择有效的工作台备份') from error


def _archive_digest(stream, *, limits=None, progress=None):
    # One descriptor is authoritative for preview and extraction.
    policy = _limits(limits)
    if os.fstat(stream.fileno()).st_size > policy.max_bytes:
        raise ValueError('备份包超过 1GB' if limits is None else '恢复点备份包超过32GB')
    stream.seek(0)
    checksum = hashlib.sha256()
    size = 0
    for block in iter(lambda: stream.read(BLOCK_BYTES), b''):
        size += len(block)
        if size > policy.max_bytes:
            raise ValueError('备份包在读取期间超过大小上限')
        checksum.update(block)
        _notify(progress, 'verify_archive')
    stream.seek(0)
    return checksum.hexdigest()


def inspect_backup(file, *, temporary_root=None, limits=None, progress=None):
    file = Path(file)
    with file.open('rb') as stream:
        checksum = _archive_digest(stream, **_kwargs(limits, progress))
        with zipfile.ZipFile(stream) as bundle:
            manifest = _validate(bundle, **_kwargs(limits, progress))
            parent = normalize(temporary_root or file.parent)
            assert_not_c_drive(parent)
            parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='ice-backup-check-', dir=parent) as temp:
                checked = _check_workspace(bundle, manifest, Path(temp), **_kwargs(limits, progress))
        if _archive_digest(stream, **_kwargs(limits, progress)) != checksum:
            raise ValueError('备份包在校验期间已变化，请重新选择并预览')
    return {'package_hash':checksum, 'created_at':manifest['created_at'],
        'app_version':manifest['app_version'], 'accounts':manifest['accounts'],
        'files':len(manifest['files']), 'bytes':sum(meta['size'] for meta in manifest['files'].values()),
        'excluded':manifest['excluded'], 'database_checked':True, **checked}


PATH_KEYS = {'path', 'file_path', 'folder', 'article_root', 'runtime_root', 'library_root',
             'profile_path', 'source_path', 'source_key', 'capture_path'}


def relocate(value, mappings, key=''):
    if isinstance(value, dict):
        return {name:relocate(item, mappings, name) for name,item in value.items()}
    if isinstance(value, list):
        return [relocate(item, mappings, key) for item in value]
    if isinstance(value, str) and key in PATH_KEYS:
        for source, destination in sorted(mappings, key=lambda pair:len(str(pair[0])), reverse=True):
            try:
                return str(destination / Path(value).relative_to(source))
            except ValueError:
                pass
    return value


def migrate_database(file, mappings, runtime):
    with closing(sqlite3.connect(file)) as db:
        db.execute('PRAGMA trusted_schema=OFF')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('备份数据库已损坏')
        from .migrations import run_migrations
        migration = run_migrations(db, app_version=__version__)
        # SQL 一律字面量（项目规则）：逐表展开迁移语句，值走 ? 绑定。
        for identifier, text in db.execute(
                'SELECT article_id, spec_json FROM articles').fetchall():
            data = relocate(json.loads(text), mappings)
            db.execute('UPDATE articles SET spec_json=? WHERE article_id=?',
                       (json.dumps(data, ensure_ascii=False), identifier))
        for identifier, text in db.execute(
                'SELECT slot_id, slot_json FROM asset_slots').fetchall():
            data = relocate(json.loads(text), mappings)
            db.execute('UPDATE asset_slots SET slot_json=? WHERE slot_id=?',
                       (json.dumps(data, ensure_ascii=False), identifier))
        for identifier, text in db.execute(
                'SELECT resource_id, metadata_json FROM publication_resources').fetchall():
            data = relocate(json.loads(text), mappings)
            db.execute('UPDATE publication_resources SET metadata_json=? WHERE resource_id=?',
                       (json.dumps(data, ensure_ascii=False), identifier))
        for job_id, text, expected in db.execute('SELECT * FROM checkpoints').fetchall():
            if sha256_text(text) != expected:
                raise ValueError('备份任务检查点校验失败')
            data = relocate(json.loads(text), mappings)
            text = json.dumps(data, ensure_ascii=False)
            db.execute('UPDATE checkpoints SET state_json=?,content_hash=? WHERE job_id=?', (text,sha256_text(text),job_id))
        for identifier, value in db.execute(
                'SELECT artifact_id, path FROM artifacts').fetchall():
            db.execute('UPDATE artifacts SET path=? WHERE artifact_id=?',
                       (relocate(value, mappings, 'path'), identifier))
        for identifier, value in db.execute(
                'SELECT candidate_id, file_path FROM asset_candidates').fetchall():
            db.execute('UPDATE asset_candidates SET file_path=? WHERE candidate_id=?',
                       (relocate(value, mappings, 'path'), identifier))
        # A frozen server-owned context takes precedence over the article spec.
        # Preserve its historical event and append the relocated context, rather
        # than letting the first desktop read redirect a restored job backwards.
        from .application.job_context import EVENT, RELOCATION_EVENT
        latest = {}
        for job_id, sequence, payload in db.execute(
                'SELECT job_id,sequence,payload FROM events WHERE event_type IN (?,?) ORDER BY sequence',
                (EVENT, RELOCATION_EVENT)).fetchall():
            latest[job_id] = (sequence, json.loads(payload))
        for job_id, (sequence, context) in latest.items():
            if (not isinstance(context, dict) or context.get('version') != 1
                    or not isinstance(context.get('article_root'), str)
                    or not Path(context['article_root']).is_absolute()
                    or not isinstance(context.get('account_id'), str)
                    or type(context.get('allow_demo_exec')) is not bool):
                raise ValueError('备份任务运行上下文无效')
            changed = relocate(context, mappings)
            # Output roots must be an admitted article root, not merely some
            # arbitrary file path below the old runtime directory.
            article_roots = {str(new) for old, new in mappings if normalize(new) != normalize(runtime)}
            if changed['article_root'] not in article_roots:
                raise ValueError('备份任务输出目录无法迁移')
            owner = db.execute(
                'SELECT articles.spec_json FROM articles JOIN jobs ON jobs.article_id=articles.article_id WHERE jobs.job_id=?',
                (job_id,)).fetchone()
            if owner is None or json.loads(owner[0]).get('account_id','ice-loop') != context['account_id']:
                raise ValueError('备份任务运行上下文与公众号归属不一致')
            if changed != context:
                changed.update(source='backup_restore', previous_context_sequence=sequence)
                next_sequence = db.execute(
                    'SELECT COALESCE(MAX(sequence),0)+1 FROM events WHERE job_id=?', (job_id,)).fetchone()[0]
                db.execute(
                    'INSERT INTO events(job_id,sequence,event_type,payload,occurred_at) VALUES(?,?,?,?,?)',
                    (job_id,next_sequence,RELOCATION_EVENT,json.dumps(changed,ensure_ascii=False),now_iso()))
        # Old checkpoints remain paused; operation states and paid request ledger are preserved.
        db.execute("UPDATE jobs SET lease=NULL,state='paused',pause_reason='从备份恢复，请检查后继续' WHERE state IN ('running','queued') OR lease IS NOT NULL")
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='tasks' AND type='table'").fetchone():
            from .tasks import canonical_input_hash
            for task_id, payload in db.execute('SELECT task_id,payload FROM tasks').fetchall():
                before = json.loads(payload)
                changed = relocate(before, mappings)
                if changed != before:
                    db.execute('UPDATE tasks SET payload=?,input_hash=? WHERE task_id=?',
                               (json.dumps(changed, ensure_ascii=False), canonical_input_hash(changed), task_id))
            # Restoring a snapshot must not silently restart paid work. Preserve
            # pending jobs and queue identities for explicit user continuation.
            db.execute("UPDATE tasks SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE cancel_requested=1 AND state IN ('queued','running','paused','waiting_user','waiting_model','waiting_resource')", (now_iso(),))
            db.execute("UPDATE tasks SET state='paused',lease_token=NULL,lease_expires_at=NULL,error_code='RESTORE_REVIEW',updated_at=? WHERE state IN ('queued','running','paused','waiting_user','waiting_model','waiting_resource')", (now_iso(),))
        db.commit()
    return {'source_schema': migration['before'], 'database_schema': migration['after'],
            'migration_versions': [item['version'] for item in migration['applied']]}


def restore_backup(file, destination, expected_hash, *, limits=None, progress=None):
    file, destination = normalize(file), normalize(destination)
    assert_not_c_drive(destination)
    if destination.exists():
        raise ValueError('恢复目标必须是尚不存在的新目录，当前工作数据不会被覆盖')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Hash and extraction use one open archive; detect replacement after the review.
    with file.open('rb') as stream:
        if _archive_digest(stream, **_kwargs(limits, progress)) != expected_hash:
            raise ValueError('备份包已变化，请重新预览')
        stream.seek(0)
        with zipfile.ZipFile(stream) as bundle:
            manifest = _validate(bundle, **_kwargs(limits, progress))
            staging = Path(tempfile.mkdtemp(prefix='ice-restore-', dir=destination.parent))
            try:
                for name in manifest['files']:
                    target = staging / name
                    assert_within(target, staging)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _extract_member(bundle, name, target, manifest['files'][name], **_kwargs(limits, progress))
                with tempfile.TemporaryDirectory(prefix='workspace-check-', dir=staging) as check_dir:
                    _check_workspace(bundle, manifest, Path(check_dir), **_kwargs(limits, progress))
                new_runtime = destination / 'runtime'
                mappings = [(Path(manifest['runtime_source']), new_runtime)] + [
                    (Path(root['source']), destination / root['relative']) for root in manifest['article_roots']]
                settings_file = staging / 'runtime/settings.json'
                settings = relocate(clean_settings(json.loads(settings_file.read_text(encoding='utf-8'))), mappings)
                allowed_roots = {str(destination / root['relative']) for root in manifest['article_roots']}
                for account in settings['accounts'].values():
                    if account['article_root'] not in allowed_roots:
                        raise ValueError('公众号输出目录无法迁移')
                    account['library_root'] = ''  # External read-only libraries are not in the bundle.
                settings['vision']['status'] = 'requires_probe'
                for profile in settings['profiles'].values():
                    profile['status'] = 'requires_probe'
                atomic_write_text(settings_file, json.dumps(settings, ensure_ascii=False, indent=2))
                migrated = migrate_database(staging / 'runtime/app.db', mappings, new_runtime)
                with closing(sqlite3.connect(staging / 'runtime/app.db')) as db:
                    allowed_roots = {str(destination / root['relative']) for root in manifest['article_roots']}
                    for spec, in db.execute('SELECT spec_json FROM articles'):
                        article_root = json.loads(spec).get('article_root')
                        if article_root and article_root not in allowed_roots:
                            raise ValueError('备份存在无法迁移的文章输出目录')
                    for job_id, text in db.execute('SELECT job_id,state_json FROM checkpoints'):
                        if not re.fullmatch(r'[A-Za-z0-9_-]+', job_id):
                            raise ValueError('备份任务标识无效')
                        atomic_write_text(staging / 'runtime/jobs' / job_id / 'state.json', text)
                    bindings = list(db.execute('SELECT path,sha256 FROM artifacts')) + list(db.execute('SELECT file_path,sha256 FROM asset_candidates'))
                    for metadata, in db.execute('SELECT metadata_json FROM publication_resources'):
                        resource = json.loads(metadata)
                        bindings.append((resource['file_path'],resource['sha256']))
                    for reference, expected in bindings:
                        if not reference:
                            continue
                        try:
                            relative = Path(reference).relative_to(destination)
                        except ValueError:
                            raise ValueError('备份存在外部文件引用，无法完整恢复') from None
                        file_to_check = staging / relative
                        assert_within(file_to_check, staging)
                        if not file_to_check.is_file() or digest(file_to_check) != expected:
                            raise ValueError('备份的资产或运行证据缺失、损坏：' + str(relative))
                # Bind the published data to the exact package the user reviewed,
                # including changes made after the first validation pass.
                if _archive_digest(stream, **_kwargs(limits, progress)) != expected_hash:
                    raise ValueError('备份包在恢复期间已变化，请重新选择并预览')
                # Publish only after every file, checkpoint and migration succeeded.
                if destination.exists():
                    raise ValueError('恢复目录已被其他程序创建，请选择新目录')
                staging.rename(destination)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
    return {'runtime_root':str(destination / 'runtime'), 'destination':str(destination),
            'accounts':manifest['accounts'], 'reconnect_required':True, **migrated}
