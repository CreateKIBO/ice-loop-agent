"""Offline recovery commands: no DesktopService, engine, workers or model routes."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

from . import __version__
from .backup import inspect_backup, restore_backup, MAX_SETTINGS_BYTES
from .paths import assert_not_c_drive, normalize


def inspect_workspace(runtime, scratch):
    runtime, scratch = normalize(runtime), normalize(scratch)
    assert_not_c_drive(runtime)
    assert_not_c_drive(scratch)
    settings_file = runtime / 'settings.json'
    database = runtime / 'app.db'
    if not settings_file.is_file() or not database.is_file():
        raise ValueError('工作区缺少 app.db 或 settings.json')
    if settings_file.stat().st_size > MAX_SETTINGS_BYTES:
        raise ValueError('工作区配置文件过大')
    settings = json.loads(settings_file.read_text(encoding='utf-8'))
    accounts = settings.get('accounts') if isinstance(settings, dict) else None
    if (not isinstance(accounts, dict) or not accounts or len(accounts) > 1000
            or settings.get('active_account_id') not in accounts):
        raise ValueError('工作区公众号配置不完整')
    from .accounts import normalize_account, profile_from_account
    for aid, account in accounts.items():
        if not isinstance(account, dict) or account.get('id') != aid:
            raise ValueError('工作区公众号配置无效')
        normalize_account(account, runtime, account_id=aid)
        profile_from_account(account)
    from .domain.types import ModelProfile
    from .llm.router import RouteConfig
    if not all(isinstance(settings.get(key), dict) for key in ('profiles', 'routes', 'vision')):
        raise ValueError('工作区模型配置不完整')
    for profile in settings['profiles'].values():
        if not isinstance(profile, dict):
            raise ValueError('工作区模型配置无效')
        ModelProfile(**profile)
    for route in settings['routes'].values():
        if not isinstance(route, dict):
            raise ValueError('工作区模型路由无效')
        RouteConfig(**route)
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ice-startup-check-', dir=scratch) as folder:
        snapshot = Path(folder) / 'check.db'
        # A consistent read-only source snapshot includes committed WAL rows.
        # Only the disposable destination can be migrated or written.
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)) as source:
            source.execute('PRAGMA query_only=ON')
            source.execute('PRAGMA trusted_schema=OFF')
            with closing(sqlite3.connect(snapshot)) as target:
                source.backup(target)
                target.execute('PRAGMA trusted_schema=OFF')
                if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('工作区数据库校验失败')
                tables = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {'articles', 'jobs', 'checkpoints', 'artifacts'} <= tables:
                    raise ValueError('工作区缺少必需的数据表')
                before = target.execute('PRAGMA user_version').fetchone()[0]
                if before < 9:
                    raise ValueError('工作区版本过旧，请使用原版本导出备份')
                from .migrations import run_migrations, verify_migrations
                result = run_migrations(target, app_version=__version__)
                audit = verify_migrations(target)
    return {'accounts': [{'id': a['id'], 'name': a['name']} for a in accounts.values()],
            'database_schema': before, 'database_target_schema': result['after'],
            'legacy_unverified': audit['legacy_unverified']}


def execute(operation, params, scratch):
    scratch = normalize(scratch)
    assert_not_c_drive(scratch)
    if not isinstance(params, dict):
        raise ValueError('恢复参数格式无效')
    if operation.startswith('recovery.'):
        from .recovery_points import RecoveryPoints
        manager = RecoveryPoints(params['runtime_root'])
        if operation == 'recovery.list':
            return manager.list()
        if operation == 'recovery.inspect':
            return manager.inspect(params['point_id'])
        if operation == 'recovery.restore':
            return manager.restore(params['point_id'], params['destination'], params['package_hash'])
    if operation == 'workspace.inspect':
        return inspect_workspace(params['runtime_root'], scratch)
    if operation == 'backup.inspect':
        return inspect_backup(params['file_path'], temporary_root=scratch)
    if operation == 'backup.restore':
        return restore_backup(params['file_path'], params['destination'], params['package_hash'])
    raise ValueError('未授权的恢复操作')


def _reply(value):
    # Frozen Python can ignore PYTHONIOENCODING and keep the Windows ACP.
    # The desktop JSON protocol always consumes UTF-8, including error replies.
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode('utf-8') + b'\n')
    sys.stdout.buffer.flush()


def main(operation, scratch):
    try:
        raw = sys.stdin.buffer.readline(65537)
        if len(raw) > 65536:
            raise ValueError('恢复参数过大')
        result = execute(operation, json.loads(raw), scratch)
        _reply({'result': result})
        return 0
    except Exception as error:
        # Paths/error reasons are useful; no traceback or settings content.
        text = str(error) if isinstance(error, (ValueError, OSError, sqlite3.Error)) else '恢复资料无法读取，请选择有效的工作区或备份'
        _reply({'error': text[:2000]})
        return 1
