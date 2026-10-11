"""队列消费者（批次A）：tasks 表 → 现有引擎的真实生产接线。

严格语义（验收）：
- 引擎 completed 才能 task succeeded；failed 映射 failed；人工门 waiting_user；
  paused/cancelled 映射对应状态；单次推进到上限仍未结束不得标 succeeded。
- 任务与 engine job 的绑定持久化（task_job_bindings）：重启/失租/人工继续
  复用已有 job，不重建文章、不重复扣模型费用。
- 账户上下文只来自任务持久化 account_id；payload 中冲突账号直接拒绝。
- 所有状态提交携带有效 lease_token；未知 kind/payload 非重试错误直接终止。
"""
from __future__ import annotations

import threading
from typing import Any

from . import TaskQueue

# 单次 drain 内对同一任务的引擎推进上限；到顶仍未结束不得标 succeeded。
MAX_ENGINE_STEPS_PER_DRAIN = 6


def drain(service: Any, *, max_tasks: int = 5,
          account_id: str | None = None,
          stop_event: threading.Event | None = None) -> dict[str, Any]:
    """认领并执行至多 max_tasks 个任务（可按账户过滤）。

    先对账 waiting_user 任务（人审已处理的重排回队列），再认领新任务。
    stop_event 由服务生命周期控制，置位后尽快返回。
    每个任务按其 spec 的 demo 标志构建对应引擎（mock/真实路由），
    store 共享同一 app.db（连接每任务独立，符合现有"每 worker 独立 Store"约束）。
    """
    engine, _, store = service._app()
    queue = TaskQueue(store)
    executed: list[dict[str, Any]] = []
    try:
        _reconcile_waiting(store, queue, engine, executed)
        for _ in range(max_tasks):
            if stop_event is not None and stop_event.is_set():
                break
            claimed = queue.claim(kinds=["production"], account_id=account_id)
            if claimed is None:
                break
            executed.append(_run_claimed(service, store, queue, claimed, stop_event))
    finally:
        store.close()
    return {"executed": executed}


def _reconcile_waiting(store, queue: TaskQueue, engine, executed: list) -> None:
    """waiting_user 任务：若绑定 job 已过审批门（不再是等待审批态），重排回队列。"""
    rows = store.conn.execute(
        "SELECT t.task_id, b.job_id FROM tasks t"
        " JOIN task_job_bindings b ON b.task_id = t.task_id"
        " WHERE t.state='waiting_user'").fetchall()
    for row in rows:
        job = store.get_job(row["job_id"])
        if job is None:
            continue
        pending = store.pending_approval(row["job_id"])
        if pending is None and job["state"] in ("running", "completed"):
            store.conn.execute(
                "UPDATE tasks SET state='queued', lease_token=NULL,"
                " lease_expires_at=NULL, updated_at=? WHERE task_id=? AND state='waiting_user'",
                (now_iso(), row["task_id"]))
            store.conn.commit()
            executed.append({"task_id": row["task_id"], "status": "requeued",
                             "note": "审批已处理，任务重排继续"})


def _run_claimed(service, store, queue: TaskQueue, claimed: dict[str, Any],
                 stop_event: threading.Event | None) -> dict[str, Any]:
    task_id = claimed["task_id"]
    token = claimed["lease_token"]
    account_id = claimed["account_id"]
    payload = claimed.get("payload") or {}
    # 账户上下文只来自任务持久化归属；payload 冲突账号直接拒绝（非重试）。
    payload_account = payload.get("account_id")
    if payload_account and payload_account != account_id:
        queue.fail(task_id, token, "ACCOUNT_CONFLICT", retryable=False)
        return {"task_id": task_id, "status": "failed",
                "error_code": "ACCOUNT_CONFLICT",
                "error": "payload 账号与任务归属不一致"}
    try:
        return _drive_production(service, store, queue, task_id, token,
                                 account_id, payload, stop_event)
    except _NonRetryable as exc:
        queue.fail(task_id, token, exc.error_code, retryable=False)
        return {"task_id": task_id, "status": "failed",
                "error_code": exc.error_code, "error": str(exc)[:300]}
    except Exception as exc:  # 引擎/系统异常：按可重试处理（有上限）
        outcome = queue.fail(task_id, token, "CONSUMER_FAILED")
        return {"task_id": task_id, "status": (outcome or {}).get("state", "failed"),
                "error_code": "CONSUMER_FAILED", "error": str(exc)[:300]}


class _NonRetryable(Exception):
    def __init__(self, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code


def _drive_production(service, store, queue: TaskQueue, task_id: str,
                      token: str, account_id: str, payload: dict[str, Any],
                      stop_event: threading.Event | None) -> dict[str, Any]:
    from ..domain.types import now_iso

    def stop_engine(job: str) -> None:
        """与 jobs.stop 相同的取消边界，但以任务持久化账户为上下文
        （消费者跨账户工作，不能借用当前选中公众号）。"""
        job_row = store.get_job(job)
        if job_row is None or job_row["state"] in ("completed", "cancelled"):
            return
        store.update_job(job, state="paused",
                         pause_reason="队列租约失效/取消，任务已让出")
        store.append_event(job, "job.paused", {"state": "paused"})

    spec = payload.get("spec")
    if not isinstance(spec, dict) or not spec:
        raise _NonRetryable("INVALID_PAYLOAD", "production 任务缺少 spec")
    spec_account = spec.get("account_id", "ice-loop")
    if spec_account != account_id:
        raise _NonRetryable("ACCOUNT_CONFLICT",
                            f"spec.account_id={spec_account} 与任务归属 {account_id} 不一致")
    # 绑定：首次创建 job 并持久化；重启/重排复用已有 job（不重建、不重复扣费）。
    bound = queue.bound_job(task_id)
    if bound:
        job = bound
        job_row = store.get_job(job)
        if job_row is None:
            raise _NonRetryable("JOB_LOST", "绑定的引擎 job 已不存在")
    else:
        if stop_event is not None and stop_event.is_set():
            queue.release(task_id, token, requeue=True)
            return {"task_id": task_id, "status": "queued", "note": "消费者停止前让出"}
        # 按任务的 demo 标志构建引擎（mock/真实路由）；store 共享同一 app.db。
        task_engine, _, task_store = service._app(demo=bool(spec.get("demo")))
        try:
            job, _article = task_engine.create_job(spec)
        finally:
            task_store.close()
        queue.bind_job(task_id, job, account_id)
    # 推进引擎，严格映射状态；每步心跳，取消/失租即通知实际 job。
    for _ in range(MAX_ENGINE_STEPS_PER_DRAIN):
        if not queue.heartbeat(task_id, token):
            stop_engine(job)
            queue.release(task_id, token, requeue=True)
            return {"task_id": task_id, "status": "queued", "job_id": job,
                    "note": "租约失效，已停止引擎并重排"}
        if stop_event is not None and stop_event.is_set():
            stop_engine(job)
            queue.release(task_id, token, requeue=True)
            return {"task_id": task_id, "status": "queued", "job_id": job,
                    "note": "消费者停止，已停止引擎并重排"}
        if store.conn.execute(
                "SELECT cancel_requested FROM tasks WHERE task_id=?",
                (task_id,)).fetchone()[0]:
            stop_engine(job)
            queue.confirm_cancelled(task_id, token)
            return {"task_id": task_id, "status": "cancelled", "job_id": job}
        # 按同一 demo 标志构建推进引擎（与 create_job 一致的路由域）。
        task_engine, _, task_store = service._app(demo=bool(spec.get("demo")))
        try:
            result = task_engine.run(job)
        finally:
            task_store.close()
        state = result.get("state") or store.get_job(job)["state"]
        if state == "completed":
            queue.complete(task_id, token, {"job_id": job, "engine_state": state})
            return {"task_id": task_id, "status": "succeeded", "job_id": job}
        if state == "failed":
            queue.fail(task_id, token, "ENGINE_FAILED", retryable=False)
            return {"task_id": task_id, "status": "failed", "job_id": job,
                    "error_code": "ENGINE_FAILED"}
        if state == "cancelled":
            queue.confirm_cancelled(task_id, token)
            return {"task_id": task_id, "status": "cancelled", "job_id": job}
        if state in ("paused", "awaiting_approval"):
            approval = store.pending_approval(job)
            if approval is not None or state == "awaiting_approval":
                # 人工审批门：waiting_user 持久化 job_id 与等待门；不代批。
                queue.finish_with_state(task_id, token, "waiting_user",
                                        {"job_id": job, "waiting": "approval",
                                         "approval_id": approval["approval_id"] if approval else "",
                                         "engine_state": state})
                return {"task_id": task_id, "status": "waiting_user", "job_id": job,
                        "waiting": "approval"}
            # 无审批的暂停（用户手动暂停）：映射 paused 终态，等待用户续跑。
            queue.finish_with_state(task_id, token, "paused",
                                    {"job_id": job, "note": "引擎已暂停"})
            return {"task_id": task_id, "status": "paused", "job_id": job}
        # running/queued 等继续下一轮推进
    # 推进到上限仍未结束：不得标 succeeded；按可重试重排。
    outcome = queue.fail(task_id, token, "STEP_LIMIT", retryable=True)
    return {"task_id": task_id, "status": (outcome or {}).get("state", "queued"),
            "job_id": job, "note": "单次推进到上限，已重排继续"}
