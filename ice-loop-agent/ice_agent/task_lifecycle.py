"""Reversible, account-scoped task archive and recycle bin.

Lifecycle changes retain articles, approvals, assets and execution evidence.
The task's worker observes the same SQLite marker before advancing again.
"""
from __future__ import annotations

from typing import Any

from .domain.types import now_iso


def initialize_tasks(store: Any) -> None:
    store.conn.execute("""CREATE TABLE IF NOT EXISTS task_lifecycle (
        job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'active',
        archived_at TEXT, deleted_at TEXT, updated_at TEXT NOT NULL
    )""")
    store.conn.commit()


def task_visibility(store: Any, job_id: str) -> dict[str, Any]:
    # Standalone/CLI stores may predate the desktop lifecycle table.
    exists = store.conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_lifecycle'"
    ).fetchone()
    row = store.conn.execute("SELECT * FROM task_lifecycle WHERE job_id=?", (job_id,)).fetchone() if exists else None
    return dict(row) if row else {'job_id': job_id, 'visibility': 'active',
                                 'archived_at': None, 'deleted_at': None}


def task_is_hidden(store: Any, job_id: str) -> bool:
    return task_visibility(store, job_id)['visibility'] != 'active'


class TaskLifecycle:
    METHODS = {'jobs.archive', 'jobs.delete', 'jobs.restore'}

    def __init__(self, service: Any):
        self.service = service

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        account = self.service._account(params.get('account_id'))
        if account['id'] != self.service._account()['id']:
            raise ValueError('公众号已切换，请刷新任务列表')
        job_id = params.get('job_id')
        if not isinstance(job_id, str) or not job_id:
            raise ValueError('请选择有效任务')
        _, _, store = self.service._app()
        try:
            with self.service.guard:
                with store.transaction():
                    job = store.get_job(job_id)
                    if not job or store.get_article(job['article_id'])['spec'].get('account_id', 'ice-loop') != account['id']:
                        raise ValueError('当前公众号没有该任务')
                    previous = task_visibility(store, job_id)
                    future = self.service.running.get(job_id)
                    working = bool(future and not future.done())
                    target = {'jobs.archive': 'archived', 'jobs.delete': 'deleted',
                              'jobs.restore': 'active'}[method]
                    if method == 'jobs.restore' and (working or job['lease']):
                        raise ValueError('任务仍在停止中，请稍后再恢复')
                    if method == 'jobs.archive' and previous['visibility'] == 'deleted':
                        raise ValueError('已删除任务请先从回收站恢复')
                    if previous['visibility'] != target:
                        stamp = now_iso()
                        archived = stamp if target == 'archived' else previous['archived_at']
                        deleted = stamp if target == 'deleted' else None
                        if target == 'active':
                            archived = None
                        store.conn.execute(
                            "INSERT INTO task_lifecycle(job_id,account_id,visibility,archived_at,deleted_at,updated_at)"
                            " VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET visibility=excluded.visibility,"
                            " archived_at=excluded.archived_at,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at",
                            (job_id, account['id'], target, archived, deleted, stamp))
                        # Completed/cancelled evidence remains unchanged while hidden.
                        # Restoring always waits for an explicit resume click.
                        should_pause = target == 'active' or job['state'] not in ('completed', 'cancelled') or working or job['lease']
                        if should_pause:
                            reason = '任务已恢复，请选择继续任务' if target == 'active' else ('任务已归档' if target == 'archived' else '任务已移入回收站')
                            store.conn.execute("UPDATE jobs SET state='paused',pause_reason=?,updated_at=? WHERE job_id=?",
                                               (reason, stamp, job_id))
                        store.append_event(job_id, 'job.' + method.split('.')[1],
                                           {'visibility': target, 'retained_article': True,
                                            'previous_visibility': previous['visibility']})
                if target != 'active' and future and not future.done():
                    future.cancel()  # Only this job; running work stops cooperatively.
                job = store.get_job(job_id)
                stopping = bool(job['lease'] or (future and not future.done()))
                return {'ok': True, 'job_id': job_id, **task_visibility(store, job_id),
                        'state': job['state'], 'stopping': stopping}
        finally:
            store.close()
