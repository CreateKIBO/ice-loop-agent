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


def run_migrations(conn: sqlite3.Connection, *, dry_run: bool = False,
                   app_version: str = "", stop_after: int | None = None) -> dict:
    """Apply pending migrations in one transaction per migration.

    Returns a report: applied versions, dry-run flag and pre/post user_version.
    With ``dry_run`` every change (including the tracking rows) is rolled back
    so callers can validate a copy without touching a real database.
    ``stop_after`` injects a failure after the given migration for fault-injection
    tests; the database must stay at the previous version afterwards.
    """
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
    # R15：dry-run 结束后原库必须完全未变——若本调用新建了跟踪表，结束时删掉。
    tracking_existed = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone() is not None
    _ensure_tracking_table(conn)
    before = conn.execute("PRAGMA user_version").fetchone()[0]
    # 已记录的迁移视作已应用（user_version 可能被旧工具/测试手动降级）；
    # 结束时把 user_version 修复为已应用集合的最大版本。
    # R15：已记录行的 checksum 必须与当前构建一致，漂移即拒绝执行。
    # 算法过渡：v18、v19 使用 co_code+co_consts 算法，之前的 co_code-only checksum
    # 属于已知历史构建（不是未知漂移），只审计 v18+。
    CHECKSUM_ALGORITHM_TRANSITION = 18
    recorded: dict[int, str] = {row[0]: row[1] for row in conn.execute(
        "SELECT version, checksum FROM schema_migrations")}
    for version, checksum in recorded.items():
        item = next((m for m in MIGRATIONS if m.version == version), None)
        if item is None:
            continue  # 未知版本（可能来自其他构建），不误报
        if version >= CHECKSUM_ALGORITHM_TRANSITION and item.checksum != checksum:
            raise ValueError(
                f"迁移 {version} 的记录 checksum 与当前构建不一致（数据库可能被其他版本写入）")
    applied: list[dict] = []
    rolled_back: list[int] = []
    for item in pending_migrations(before):
        try:
            conn.execute("BEGIN IMMEDIATE")
            # Re-read inside the write lock: another process may have advanced.
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            tracked = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
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
            conn.execute("PRAGMA user_version=%d" % item.version)
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
    if effective != conn.execute("PRAGMA user_version").fetchone()[0] and not dry_run:
        conn.execute("PRAGMA user_version=%d" % effective)
        conn.commit()
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
    """Audit trail check: recorded rows must match the registry checksums."""
    _ensure_tracking_table(conn)
    rows = conn.execute(
        "SELECT version, description, checksum FROM schema_migrations ORDER BY version").fetchall()
    registry = {m.version: m for m in MIGRATIONS}
    problems = []
    for version, _description, checksum in rows:
        item = registry.get(version)
        if item is None:
            problems.append(f"version {version} 来自未知构建")
        elif item.checksum != checksum:
            problems.append(f"version {version} checksum 不匹配")
    return {"recorded": [row[0] for row in rows], "problems": problems}
