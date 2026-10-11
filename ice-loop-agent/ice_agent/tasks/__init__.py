"""可靠任务队列：持久 tasks 表 + 单租约 + 幂等 + 取消（M1-06/M1-08，报告 §7.3）。

状态机：queued → running → succeeded/failed/cancelled；waiting_* 由任务负载
自行落账（本模块不解释）。归档/删除是可见性，不属于运行状态。

关键约束：
- 单有效租约：claim 是一条条件 UPDATE，双 worker 不可能同时持有。
- 幂等（R07）：域为 (account_id, kind, idempotency_key)；输入指纹用规范 JSON
  的 SHA256（跨进程稳定）。同键同输入幂等返回；同键异输入显式冲突。
- 取消：queued 立即取消；running 记 cancel_requested，由负载协作停止；
  晚到结果若租约/token 不匹配则拒写。
- 恢复：lease 过期的 running 任务由 requeue_expired 收回；重试不重放已
  sending 的外部付费请求（那是账本/对账的边界，本模块只保留 attempt 记录）。
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any, Callable

from ..domain.types import now_iso

TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})
ACTIVE_STATES = frozenset({"queued", "running", "waiting_user", "waiting_model", "waiting_resource"})
DEFAULT_LEASE_SECONDS = 120


def canonical_input_hash(payload: dict[str, Any]) -> str:
    """规范 JSON（键排序、紧凑分隔符）→ SHA256；跨进程稳定（R07）。"""
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class TaskInputConflict(ValueError):
    """同 (account,kind,key) 但输入不同：明确冲突，不静默复用。"""


class TaskNotFoundError(Exception):
    pass


class TaskQueue:
    def __init__(self, store, *, lease_seconds: int = DEFAULT_LEASE_SECONDS):
        self.store = store
        self.lease_seconds = lease_seconds

    # ---------------------------------------------------------------- 入队
    def enqueue(self, account_id: str, kind: str, payload: dict[str, Any], *,
                priority: int = 5, idempotency_key: str | None = None,
                max_attempts: int = 3, task_id: str | None = None) -> dict[str, Any]:
        now = now_iso()
        input_hash = canonical_input_hash(payload)
        with self.store.transaction():
            if idempotency_key:
                row = self.store.conn.execute(
                    "SELECT * FROM tasks WHERE account_id=? AND kind=? AND idempotency_key=?",
                    (account_id, kind, idempotency_key)).fetchone()
                if row:
                    existing = self._row(row)
                    if existing["input_hash"] != input_hash:
                        raise TaskInputConflict(
                            "相同幂等键但输入不同：请更换 key 或确认输入一致")
                    return existing
            task_id = task_id or f"task-{uuid.uuid4().hex[:20]}"
            self.store.conn.execute(
                "INSERT INTO tasks (task_id, account_id, kind, priority, state, input_hash,"
                " idempotency_key, payload, attempt, max_attempts, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (task_id, account_id, kind, priority, "queued", input_hash,
                 idempotency_key, json.dumps(payload, ensure_ascii=False),
                 0, max_attempts, now, now))
            row = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            return self._row(row)

    # ---------------------------------------------------------------- 认领
    def claim(self, kinds: list[str] | None = None,
              account_id: str | None = None) -> dict[str, Any] | None:
        """按优先级认领一个 queued 任务；单条 UPDATE 保证单租约。

        批次A：支持账户/kind 限制——消费者只处理其配置域内的任务，
        服务切号不改变任务持久化归属。
        """
        token = f"lease-{uuid.uuid4().hex[:20]}"
        expires = _iso_after(self.lease_seconds)
        with self.store.transaction():
            clauses = ["state='queued'", "cancel_requested=0"]
            params: list[Any] = []
            if kinds:
                clauses.append(f"kind IN ({','.join('?' * len(kinds))})")
                params.extend(kinds)
            if account_id:
                clauses.append("account_id=?")
                params.append(account_id)
            row = self.store.conn.execute(
                f"SELECT task_id FROM tasks WHERE {' AND '.join(clauses)}"
                " ORDER BY priority ASC, created_at ASC LIMIT 1",
                tuple(params)).fetchone()
            if not row:
                return None
            updated = self.store.conn.execute(
                "UPDATE tasks SET state='running', lease_token=?, lease_expires_at=?,"
                " attempt=attempt+1, updated_at=?"
                " WHERE task_id=? AND state='queued' AND cancel_requested=0",
                (token, expires, now_iso(), row["task_id"]))
            if updated.rowcount != 1:
                return None
            claimed = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=?", (row["task_id"],)).fetchone()
            return self._row(claimed)

    def heartbeat(self, task_id: str, token: str) -> bool:
        with self.store.transaction():
            updated = self.store.conn.execute(
                "UPDATE tasks SET lease_expires_at=?, updated_at=?"
                " WHERE task_id=? AND lease_token=? AND state='running'",
                (_iso_after(self.lease_seconds), now_iso(), task_id, token))
            return updated.rowcount == 1

    def release(self, task_id: str, token: str, *, requeue: bool = True) -> None:
        with self.store.transaction():
            if requeue:
                self.store.conn.execute(
                    "UPDATE tasks SET state='queued', lease_token=NULL, lease_expires_at=NULL,"
                    " updated_at=? WHERE task_id=? AND lease_token=? AND state='running'",
                    (now_iso(), task_id, token))
            else:
                self.store.conn.execute(
                    "UPDATE tasks SET lease_token=NULL, lease_expires_at=NULL, updated_at=?"
                    " WHERE task_id=? AND lease_token=?", (now_iso(), task_id, token))

    # ---------------------------------------------------------------- 完成/失败
    def complete(self, task_id: str, token: str, result: dict[str, Any]) -> bool:
        with self.store.transaction():
            updated = self.store.conn.execute(
                "UPDATE tasks SET state='succeeded', result=?, lease_token=NULL,"
                " lease_expires_at=NULL, cancel_requested=0, updated_at=?"
                " WHERE task_id=? AND lease_token=? AND state='running'",
                (json.dumps(result, ensure_ascii=False), now_iso(), task_id, token))
            return updated.rowcount == 1

    def finish_with_state(self, task_id: str, token: str, state: str,
                          result: dict[str, Any]) -> bool:
        """批次A：带 lease 的严格状态提交（waiting_user/paused 等中间态）。

        只允许从 running 转出；state 必须在 ACTIVE_STATES∪TERMINAL_STATES。
        result 持久化（job_id/等待门/可读错误），不只留瞬时 dict。
        """
        if state not in ACTIVE_STATES | TERMINAL_STATES:
            raise ValueError(f"未知任务状态：{state}")
        with self.store.transaction():
            # waiting_user 等中间态保留租约归零（不再倒计时），但不先释放再无条件 UPDATE。
            updated = self.store.conn.execute(
                "UPDATE tasks SET state=?, result=?, lease_token=NULL,"
                " lease_expires_at=NULL, updated_at=?"
                " WHERE task_id=? AND lease_token=? AND state='running'",
                (state, json.dumps(result, ensure_ascii=False), now_iso(),
                 task_id, token))
            return updated.rowcount == 1

    def bind_job(self, task_id: str, job_id: str, account_id: str) -> str:
        """批次A：首次认领时持久化 task↔job 绑定；并发竞争以先写入者为准。

        返回生效的 job_id（绑定已存在时返回既有绑定，不重建 job）。
        """
        with self.store.transaction():
            existing = self.store.conn.execute(
                "SELECT job_id FROM task_job_bindings WHERE task_id=?",
                (task_id,)).fetchone()
            if existing:
                if existing["job_id"] != job_id:
                    raise ValueError("任务已绑定其他 job，拒绝重复创建")
                return existing["job_id"]
            conflict = self.store.conn.execute(
                "SELECT task_id FROM task_job_bindings WHERE job_id=?",
                (job_id,)).fetchone()
            if conflict:
                return job_id  # 另一任务先绑定了此 job；调用方复用
            self.store.conn.execute(
                "INSERT INTO task_job_bindings (task_id, job_id, account_id, bound_at)"
                " VALUES (?,?,?,?)", (task_id, job_id, account_id, now_iso()))
            return job_id

    def bound_job(self, task_id: str) -> str | None:
        row = self.store.conn.execute(
            "SELECT job_id FROM task_job_bindings WHERE task_id=?", (task_id,)).fetchone()
        return row["job_id"] if row else None

    def fail(self, task_id: str, token: str, error_code: str,
             *, retryable: bool = True) -> dict[str, Any] | None:
        """失败按 attempt 上限决定重排或终态；返回更新后的任务。"""
        with self.store.transaction():
            row = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=? AND lease_token=?", (task_id, token)).fetchone()
            if not row:
                return None
            task = self._row(row)
            if task["attempt"] < task["max_attempts"] and retryable:
                self.store.conn.execute(
                    "UPDATE tasks SET state='queued', error_code=?, lease_token=NULL,"
                    " lease_expires_at=NULL, updated_at=? WHERE task_id=?",
                    (error_code, now_iso(), task_id))
            else:
                self.store.conn.execute(
                    "UPDATE tasks SET state='failed', error_code=?, lease_token=NULL,"
                    " lease_expires_at=NULL, updated_at=? WHERE task_id=?",
                    (error_code, now_iso(), task_id))
            refreshed = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            return self._row(refreshed)

    # ---------------------------------------------------------------- 取消
    def cancel(self, task_id: str) -> dict[str, Any]:
        with self.store.transaction():
            row = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            if not row:
                raise TaskNotFoundError(task_id)
            task = self._row(row)
            if task["state"] == "queued":
                self.store.conn.execute(
                    "UPDATE tasks SET state='cancelled', updated_at=? WHERE task_id=?",
                    (now_iso(), task_id))
            elif task["state"] in ACTIVE_STATES:
                # running/waiting_*：只记请求，负载协作停止；远端状态未知不假装完成。
                self.store.conn.execute(
                    "UPDATE tasks SET cancel_requested=1, updated_at=? WHERE task_id=?",
                    (now_iso(), task_id))
            refreshed = self.store.conn.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            return self._row(refreshed)

    def confirm_cancelled(self, task_id: str, token: str) -> bool:
        """负载确认已停止：仅持有有效租约时落终态。"""
        with self.store.transaction():
            updated = self.store.conn.execute(
                "UPDATE tasks SET state='cancelled', lease_token=NULL, lease_expires_at=NULL,"
                " updated_at=? WHERE task_id=? AND lease_token=? AND cancel_requested=1",
                (now_iso(), task_id, token))
            return updated.rowcount == 1

    # ---------------------------------------------------------------- 恢复
    def requeue_expired(self) -> list[str]:
        """重启/恢复：收回租约过期的 running 任务（不是重放外部付费请求）。"""
        now = now_iso()
        with self.store.transaction():
            rows = self.store.conn.execute(
                "SELECT task_id FROM tasks WHERE state='running' AND lease_expires_at IS NOT NULL"
                " AND lease_expires_at < ?", (now,)).fetchall()
            ids = [r["task_id"] for r in rows]
            if ids:
                marks = ",".join("?" * len(ids))
                self.store.conn.execute(
                    f"UPDATE tasks SET state='queued', lease_token=NULL, lease_expires_at=NULL,"
                    f" updated_at=? WHERE task_id IN ({marks})",
                    (now_iso(), *ids))
            return ids

    # ---------------------------------------------------------------- 查询
    def get(self, task_id: str) -> dict[str, Any]:
        row = self.store.conn.execute(
            "SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        if not row:
            raise TaskNotFoundError(task_id)
        return self._row(row)

    def list_for_account(self, account_id: str, *, include_terminal: bool = False,
                         limit: int = 100) -> list[dict[str, Any]]:
        state_filter = "" if include_terminal else \
            " AND state IN ('queued','running','waiting_user','waiting_model','waiting_resource')"
        rows = self.store.conn.execute(
            "SELECT * FROM tasks WHERE account_id=?"
            f"{state_filter} ORDER BY created_at DESC LIMIT ?",
            (account_id, limit)).fetchall()
        return [self._row(r) for r in rows]

    def _row(self, row) -> dict[str, Any]:
        data = dict(row)
        data["payload"] = json.loads(data.get("payload") or "{}")
        data["result"] = json.loads(data["result"]) if data.get("result") else None
        data["cancel_requested"] = bool(data.get("cancel_requested"))
        return data


def _iso_after(seconds: int) -> str:
    from datetime import datetime, timedelta, timezone
    # 与 domain.types.now_iso 同格式（本地时区偏移），保证字符串比较语义一致。
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)) \
        .astimezone().isoformat(timespec="seconds")
