"""v2.0 numbered migrations. Each entry appends to ice_agent.migrations registry."""
from __future__ import annotations

import sqlite3

from . import migration


@migration(10, "持久事件流表：stream_events 供 v2 协议游标回放")
def _stream_events(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stream_events ("
        " stream_id TEXT NOT NULL,"
        " sequence INTEGER NOT NULL,"
        " event_id TEXT NOT NULL UNIQUE,"
        " account_id TEXT NOT NULL DEFAULT '',"
        " event_type TEXT NOT NULL,"
        " payload TEXT NOT NULL,"
        " created_at TEXT NOT NULL,"
        " PRIMARY KEY (stream_id, sequence))"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_stream_events_account"
        " ON stream_events(account_id, created_at)"
    )


@migration(11, "持久任务队列表：tasks 供可靠队列/租约/取消/幂等（M1-06）")
def _task_queue(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks ("
        " task_id TEXT PRIMARY KEY,"
        " account_id TEXT NOT NULL,"
        " kind TEXT NOT NULL,"
        " priority INTEGER NOT NULL DEFAULT 5,"
        " state TEXT NOT NULL DEFAULT 'queued',"
        " input_hash TEXT NOT NULL DEFAULT '',"
        " idempotency_key TEXT UNIQUE,"
        " payload TEXT NOT NULL DEFAULT '{}',"
        " result TEXT,"
        " error_code TEXT,"
        " attempt INTEGER NOT NULL DEFAULT 0,"
        " max_attempts INTEGER NOT NULL DEFAULT 3,"
        " lease_token TEXT,"
        " lease_expires_at TEXT,"
        " cancel_requested INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_ready"
        " ON tasks(state, priority, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_account"
        " ON tasks(account_id, state, created_at)"
    )
