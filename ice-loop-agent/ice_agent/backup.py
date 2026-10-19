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
from contextlib import closing
from pathlib import Path, PurePosixPath

from . import __version__
from .domain.types import now_iso, sha256_text
from .paths import assert_not_c_drive, assert_within, atomic_write_text, is_within, normalize

MAX_BYTES = 1024 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_FILES = 10000
BLOCK_BYTES = 1024 * 1024
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


def create_backup(runtime, settings, target):
    runtime, target = normalize(runtime), normalize(target)
    assert_not_c_drive(target)
    def managed_root(value):
        original = Path(value)
        if original.is_symlink() or original.is_junction():
            raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
        return str(normalize(original))
    roots = sorted({managed_root(account['article_root']) for account in settings['accounts'].values()}
                   | {managed_root(settings['article_root'])})
    # Include frozen roots of older jobs after an account output path changed.
    with closing(sqlite3.connect(runtime / 'app.db')) as source:
        if source.execute("SELECT COUNT(*) FROM jobs WHERE lease IS NOT NULL OR state='running'").fetchone()[0]:
            raise ValueError('任务正在运行，请暂停后再备份')
        roots = sorted(set(roots) | {managed_root(json.loads(row[0])['article_root'])
            for row in source.execute('SELECT spec_json FROM articles') if json.loads(row[0]).get('article_root')})
        for root in [runtime, *map(Path, roots)]:
            assert_not_c_drive(root)
            if is_within(target, root):
                raise ValueError('请把备份文件保存在工作数据目录之外')
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ice-backup-', dir=target.parent) as temp:
            staging = Path(temp)
            snapshot = staging / 'app.db'
            with closing(sqlite3.connect(snapshot)) as dest:
                source.backup(dest)
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
                'excluded':['API Key 与登录会话', '日志与浏览器缓存', '外部只读存稿目录（历史正文快照保留在数据库）'],
                'files':{}}
            sanitized = staging / 'settings.json'
            atomic_write_text(sanitized, json.dumps(clean_settings(settings), ensure_ascii=False, indent=2))
            temporary = staging / 'bundle.zip'
            total = 0
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as bundle:
                def add(file, name):
                    nonlocal total
                    safe_name(name)
                    size = file.stat().st_size
                    total += size
                    if size > MAX_FILE or total > MAX_BYTES or len(manifest['files']) >= MAX_FILES:
                        raise ValueError('工作数据超过备份上限（单文件 128MB、总量 1GB、10000 文件）')
                    total -= size
                    written = 0
                    hasher = hashlib.sha256()
                    with file.open('rb') as source_file, bundle.open(name, 'w') as member:
                        for block in iter(lambda: source_file.read(BLOCK_BYTES), b''):
                            written += len(block)
                            total += len(block)
                            if written > MAX_FILE or total > MAX_BYTES:
                                raise ValueError('备份读取期间文件超过大小上限，未保存')
                            member.write(block)
                            hasher.update(block)
                    manifest['files'][name] = {'size':written, 'sha256':hasher.hexdigest()}
                def collect(root, prefix):
                    if root.is_symlink() or root.is_junction():
                        raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
                    if not root.exists():
                        return
                    for directory, dirs, files in os.walk(root, followlinks=False):
                        parent = Path(directory)
                        dirs[:] = [name for name in dirs if name.lower() not in EXCLUDED]
                        for name in dirs + files:
                            item = parent / name
                            if item.is_symlink() or item.is_junction():
                                raise ValueError('备份不接受符号链接或目录联接，请先整理数据')
                            assert_within(item, root)
                        for name in files:
                            if name.lower() in EXCLUDED or name.lower().endswith(('.tmp', '-wal', '-shm')):
                                continue
                            add(parent / name, prefix + '/' + (parent / name).relative_to(root).as_posix())
                add(snapshot, 'runtime/app.db')
                add(sanitized, 'runtime/settings.json')
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
                bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
            summary = inspect_backup(temporary, temporary_root=staging)
            os.replace(temporary, target)
    return {**summary, 'file_path':str(target)}


def _validate(bundle):
    entries = bundle.infolist()
    if len(entries) > MAX_FILES + 1 or sum(entry.file_size for entry in entries) > MAX_BYTES + 1024 * 1024:
        raise ValueError('备份超出读取上限')
    names = []
    for entry in entries:
        safe_name(entry.filename)
        if entry.file_size > MAX_FILE or entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('备份包含不支持的文件类型或超大文件')
        names.append(entry.filename)
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('备份包含重名文件')
    if 'manifest.json' not in names or bundle.getinfo('manifest.json').file_size > 1024 * 1024:
        raise ValueError('缺少有效的备份清单')
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
        if (not isinstance(meta, dict) or type(meta.get('size')) is not int or not 0 <= meta['size'] <= MAX_FILE
                or not isinstance(meta.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', meta['sha256'])):
            raise ValueError('备份文件校验信息无效')
        if parts[0] == 'runtime' and not (name in ('runtime/app.db', 'runtime/settings.json') or len(parts) >= 3 and parts[1] in RUNTIME_DIRS):
            raise ValueError('备份包含非托管运行数据')
        if parts[0] == 'articles' and not any(name.startswith(root['relative'] + '/') for root in roots):
            raise ValueError('备份文章文件未归属有效目录')
        if parts[0] == 'manifest.json':
            raise ValueError('备份清单不能充当数据目录')
        size, checksum = _hash_member(bundle, name)
        if size != meta['size'] or checksum != meta['sha256']:
            raise ValueError('备份文件损坏或校验失败：' + name)
    return manifest


def _hash_member(bundle, name):
    size, hasher = 0, hashlib.sha256()
    with bundle.open(name) as member:
        for block in iter(lambda: member.read(BLOCK_BYTES), b''):
            size += len(block)
            if size > MAX_FILE:
                raise ValueError('备份文件超过大小上限')
            hasher.update(block)
    return size, hasher.hexdigest()


def _extract_member(bundle, name, target):
    with bundle.open(name) as source, target.open('wb') as destination:
        shutil.copyfileobj(source, destination, length=BLOCK_BYTES)


def _check_workspace(bundle, manifest, staging):
    """Open/migrate a disposable database, never a live workspace or the ZIP."""
    try:
        settings = json.loads(bundle.read('runtime/settings.json'))
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
        _extract_member(bundle, 'runtime/app.db', database)
        with closing(sqlite3.connect(database)) as db:
            db.execute('PRAGMA trusted_schema=OFF')
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('备份数据库已损坏')
            schema = db.execute('PRAGMA user_version').fetchone()[0]
            required = {'articles', 'jobs', 'checkpoints', 'artifacts', 'asset_candidates', 'publication_resources', 'asset_slots'}
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required <= tables:
                raise ValueError('备份数据库缺少工作台数据表')
            from .migrations import MAX_KNOWN_VERSION, run_migrations
            if not 9 <= schema <= MAX_KNOWN_VERSION:
                raise ValueError('备份数据库来自不支持的版本，请使用对应版本的程序恢复')
            run_migrations(db)  # this file is already a disposable copy
            for text, expected in db.execute('SELECT state_json,content_hash FROM checkpoints'):
                if sha256_text(text) != expected or not isinstance(json.loads(text), dict):
                    raise ValueError('备份任务检查点校验失败')
        return schema
    except (sqlite3.Error, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError('备份数据库或配置无法读取，请选择有效的工作台备份') from error


def inspect_backup(file, *, temporary_root=None):
    if file.stat().st_size > MAX_BYTES:
        raise ValueError('备份包超过 1GB')
    with zipfile.ZipFile(file) as bundle:
        manifest = _validate(bundle)
        parent = normalize(temporary_root or file.parent)
        assert_not_c_drive(parent)
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ice-backup-check-', dir=parent) as temp:
            schema = _check_workspace(bundle, manifest, Path(temp))
    return {'package_hash':digest(file), 'created_at':manifest['created_at'],
        'app_version':manifest['app_version'], 'accounts':manifest['accounts'],
        'files':len(manifest['files']), 'bytes':sum(meta['size'] for meta in manifest['files'].values()),
        'excluded':manifest['excluded'], 'database_checked':True, 'database_schema':schema}


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
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('备份数据库已损坏')
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


def restore_backup(file, destination, expected_hash):
    file, destination = normalize(file), normalize(destination)
    assert_not_c_drive(destination)
    if destination.exists():
        raise ValueError('恢复目标必须是尚不存在的新目录，当前工作数据不会被覆盖')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Hash and extraction use one open archive; detect replacement after the review.
    with file.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != expected_hash:
            raise ValueError('备份包已变化，请重新预览')
        stream.seek(0)
        with zipfile.ZipFile(stream) as bundle:
            manifest = _validate(bundle)
            staging = Path(tempfile.mkdtemp(prefix='ice-restore-', dir=destination.parent))
            try:
                for name in manifest['files']:
                    target = staging / name
                    assert_within(target, staging)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _extract_member(bundle, name, target)
                with tempfile.TemporaryDirectory(prefix='workspace-check-', dir=staging) as check_dir:
                    _check_workspace(bundle, manifest, Path(check_dir))
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
                migrate_database(staging / 'runtime/app.db', mappings, new_runtime)
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
                # Publish only after every file, checkpoint and migration succeeded.
                if destination.exists():
                    raise ValueError('恢复目录已被其他程序创建，请选择新目录')
                staging.rename(destination)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
    return {'runtime_root':str(destination / 'runtime'), 'destination':str(destination),
            'accounts':manifest['accounts'], 'reconnect_required':True}
