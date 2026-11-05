"""Numbered schema migrations with checksum tracking (v2.0, M0-08).

Baseline is user_version=9 (v1.5.3). Every v2.0 schema change is a numbered,
append-only migration recorded in ``schema_migrations`` with a checksum of its
apply source. Rules:

- Same migration must not run twice; ``user_version`` is the fast guard and
  ``schema_migrations`` is the audit trail.
- A migration runs inside one transaction: failure rolls back both schema
  changes and the ``user_version`` bump, leaving the database openable by the
  previous engine.
- Databases with a version newer than this build refuses to open (kept from
  v1.5.3 ``Store``).
"""
from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass
from typing import Callable

from ..domain.types import now_iso

BASELINE_VERSION = 9


@dataclass(frozen=True)
class Migration:
    version: int
    description: str
    apply: Callable[[sqlite3.Connection], None]

    @property
    def checksum(self) -> str:
        """R15：校验和覆盖不可变声明内容（SQL 常量在 co_consts，字节码在 co_code）。
        不用 inspect.getsource——冻结引擎无源码；co_consts 保证不同 SQL 的
        同形函数得到不同 checksum。"""
        code = self.apply.__code__
        return hashlib.sha256(
            f"{self.version}|{self.description}|{code.co_code}|{repr(code.co_consts)}".encode()
        ).hexdigest()


MIGRATIONS: list[Migration] = []


def migration(version: int, description: str):
    def decorator(fn: Callable[[sqlite3.Connection], None]) -> Migration:
        item = Migration(version=version, description=description, apply=fn)
        MIGRATIONS.append(item)
        return item
    return decorator


def _ensure_tracking_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY,"
        " description TEXT NOT NULL,"
        " checksum TEXT NOT NULL,"
        " applied_at TEXT NOT NULL,"
        " app_version TEXT NOT NULL)"
    )


def pending_migrations(current: int) -> list[Migration]:
    return [m for m in sorted(MIGRATIONS, key=lambda m: m.version) if m.version > current]


# PRAGMA 语句不支持 ? 参数绑定（SQLite 语法限制），项目规则又要求 SQL 一律
# 字面量，因此按版本号手写字面量语句映射：每个版本一条 conn.execute("字面量")，
# 框架层按版本调度。新增迁移时必须同步补一行，缺失会在运行期显式报错。
# 注意：不能把这些语句写进各迁移的 apply 函数体——checksum 覆盖函数字节码，
# 改函数体会使存量库的 v18+ checksum 审计拒绝打开。
_PRAGMA_APPLY: dict[int, Callable[[sqlite3.Connection], None]] = {
    10: lambda conn: conn.execute("PRAGMA user_version=10"),
    11: lambda conn: conn.execute("PRAGMA user_version=11"),
    12: lambda conn: conn.execute("PRAGMA user_version=12"),
    13: lambda conn: conn.execute("PRAGMA user_version=13"),
    14: lambda conn: conn.execute("PRAGMA user_version=14"),
    15: lambda conn: conn.execute("PRAGMA user_version=15"),
    16: lambda conn: conn.execute("PRAGMA user_version=16"),
    17: lambda conn: conn.execute("PRAGMA user_version=17"),
    18: lambda conn: conn.execute("PRAGMA user_version=18"),
    19: lambda conn: conn.execute("PRAGMA user_version=19"),
    20: lambda conn: conn.execute("PRAGMA user_version=20"),
    21: lambda conn: conn.execute("PRAGMA user_version=21"),
    22: lambda conn: conn.execute("PRAGMA user_version=22"),
}


def _write_user_version(conn: sqlite3.Connection, version: int) -> None:
    apply_pragma = _PRAGMA_APPLY.get(version)
    if apply_pragma is None:
        raise ValueError(
            f"user_version={version} 缺少字面量 PRAGMA 语句；"
            "新增迁移时请同步更新 _PRAGMA_APPLY 映射")
    apply_pragma(conn)


def run_migrations(conn: sqlite3.Connection, *, dry_run: bool = False,
                   app_version: str = "", stop_after: int | None = None) -> dict:
    """Apply pending migrations in one transaction per migration.

    Returns a report: applied versions, dry-run flag and pre/post user_version.
    With ``dry_run`` every change (including the tracking rows) is rolled back
    so callers can validate a copy without touching a real database.
    ``stop_after`` injects a failure after the given migration for fault-injection
    tests; the database must stay at the previous version afterwards.
    """
    if conn.in_transaction:
        raise ValueError("请先完成当前事务，再执行数据库迁移")
    if dry_run:
        # Rolling back each migration separately erases tables required by the
        # next one. Run the whole chain on a memory snapshot instead. Exceptions
        # and tracking-table creation never mutate the source connection.
        if conn.in_transaction:
            raise ValueError("请先完成当前事务，再执行迁移 dry-run")
        before = conn.execute("PRAGMA user_version").fetchone()[0]
        snapshot = sqlite3.connect(":memory:")
        try:
            conn.backup(snapshot)
            result = run_migrations(snapshot, app_version=app_version, stop_after=stop_after)
            return {"before": before, "after": before, "applied": [], "dry_run": True,
                    "dry_run_rolled_back": [item["version"] for item in result["applied"]]}
        finally:
            snapshot.close()
    # Admission is read-only and runs before even creating the tracking table.
    # Unknown histories must not partly migrate and only fail at the final PRAGMA.
    validate_migration_state(conn)
    tracking_existed = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone() is not None
    _ensure_tracking_table(conn)
    before = conn.execute("PRAGMA user_version").fetchone()[0]
    recorded: dict[int, str] = {row[0]: row[1] for row in conn.execute(
        "SELECT version, checksum FROM schema_migrations")}
    applied: list[dict] = []
    rolled_back: list[int] = []
    for item in pending_migrations(before):
        try:
            conn.execute("BEGIN IMMEDIATE")
            # Re-read inside the write lock: another process may have advanced.
            state = validate_migration_state(conn)
            current = state['current_version']
            tracked = set(state['recorded'])
            if item.version <= current or item.version in tracked:
                conn.execute("ROLLBACK")
                if item.version in tracked:
                    recorded[item.version] = item.checksum
                    continue
                continue
            item.apply(conn)
            conn.execute(
                "INSERT INTO schema_migrations(version, description, checksum, applied_at, app_version)"
                " VALUES (?,?,?,?,?)",
                (item.version, item.description, item.checksum, now_iso(), app_version))
            _write_user_version(conn, item.version)
            if dry_run:
                conn.execute("ROLLBACK")
                rolled_back.append(item.version)
                continue
            if stop_after is not None and item.version >= stop_after:
                raise RuntimeError(f"fault injection: abort after migration {item.version}")
            conn.execute("COMMIT")
            recorded[item.version] = item.checksum
            applied.append({"version": item.version, "description": item.description,
                            "checksum": item.checksum})
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    effective = max([before, *recorded]) if recorded else before
    if effective > conn.execute("PRAGMA user_version").fetchone()[0]:
        # A historical tool may have lowered the version while leaving the full
        # audited history intact. Repair only forward, under the write lock.
        conn.execute("BEGIN IMMEDIATE")
        try:
            state = validate_migration_state(conn)
            effective = max([state['current_version'], *state['recorded']])
            if effective > state['current_version']:
                _write_user_version(conn, effective)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    if dry_run and not tracking_existed:
        # dry-run 不留任何痕迹：本调用新建的跟踪表一并移除。
        conn.execute("DROP TABLE schema_migrations")
        conn.commit()
    after = conn.execute("PRAGMA user_version").fetchone()[0]
    return {"before": before, "after": after, "applied": applied,
            "dry_run": dry_run, "dry_run_rolled_back": rolled_back}


# v2.0 numbered migrations are defined in v2_schema and self-register on import.
# Placed last so `from . import migration` inside v2_schema resolves cleanly.
from . import v2_schema as _v2_schema  # noqa: E402,F401

# Max schema version this build understands; Store refuses newer databases.
MAX_KNOWN_VERSION = max([BASELINE_VERSION] + [m.version for m in MIGRATIONS])


def verify_migrations(conn: sqlite3.Connection) -> dict:
    """Read-only admission/audit; never create or rewrite migration history.

    Versions 10–17 retain the existing legacy checksum policy, but differences
    are explicitly reported as unverified instead of being called verified.
    """
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    registry = {item.version: item for item in MIGRATIONS}
    latest = max([BASELINE_VERSION, *registry])
    tracking_object = conn.execute(
        "SELECT type FROM sqlite_master WHERE name='schema_migrations'").fetchone()
    tracking = tracking_object is not None and tracking_object[0] == 'table'
    problems, legacy_unverified, rows = [], [], []
    if tracking_object is not None and not tracking:
        problems.append('迁移历史不是有效的数据表，请使用对应版本程序或从备份恢复')
    if current < 0 or current > latest:
        problems.append('数据库来自较新或不支持的版本，请使用对应版本程序打开')
    if tracking:
        try:
            rows = conn.execute(
                "SELECT version, description, checksum FROM schema_migrations ORDER BY version").fetchall()
        except sqlite3.Error:
            problems.append('迁移历史无法读取，请使用对应版本程序或从备份恢复')
    elif current > BASELINE_VERSION:
        problems.append('数据库缺少迁移历史记录，当前资料已保留，请使用对应版本程序或从备份恢复')
    known = set()
    for version, description, checksum in rows:
        item = registry.get(version) if type(version) is int else None
        if item is None:
            problems.append(f'迁移历史包含未知版本 {str(version)[:32]}，请使用对应版本程序打开')
            continue
        known.add(version)
        if version >= 18:
            if item.checksum != checksum:
                problems.append(f'迁移 {version} 的记录 checksum 与当前构建不一致（数据库可能被其他版本写入）')
            if item.description != description:
                problems.append(f'迁移 {version} 的说明与当前构建不一致')
        elif item.checksum != checksum:
            legacy_unverified.append(version)
    # Lowered user_version is recoverable only when an unbroken, known history
    # remains. A higher version without its receipts must never be re-certified.
    upper = max([current, *known])
    missing = sorted(version for version in registry if version <= upper and version not in known)
    if tracking and missing:
        problems.append('迁移历史缺少记录：' + '、'.join(map(str, missing)))
    return {'recorded': [row[0] for row in rows], 'problems': problems,
            'current_version': current, 'legacy_unverified': legacy_unverified}


def validate_migration_state(conn: sqlite3.Connection) -> dict:
    state = verify_migrations(conn)
    if state['problems']:
        raise ValueError('；'.join(state['problems']))
    return state
