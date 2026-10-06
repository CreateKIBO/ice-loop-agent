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
        return hashlib.sha256(
            f"{self.version}|{self.description}|{self.apply.__code__.co_code}".encode()
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
    _ensure_tracking_table(conn)
    before = conn.execute("PRAGMA user_version").fetchone()[0]
    # 已记录的迁移视作已应用（user_version 可能被旧工具/测试手动降级）；
    # 结束时把 user_version 修复为已应用集合的最大版本。
    recorded = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
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
                    recorded.add(item.version)
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
            recorded.add(item.version)
            applied.append({"version": item.version, "description": item.description,
                            "checksum": item.checksum})
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    effective = max([before, *recorded]) if recorded else before
    if effective != conn.execute("PRAGMA user_version").fetchone()[0] and not dry_run:
        conn.execute("PRAGMA user_version=%d" % effective)
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
