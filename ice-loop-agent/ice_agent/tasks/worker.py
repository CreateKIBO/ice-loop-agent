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
import copy
from contextlib import nullcontext
from typing import Any

from . import TaskQueue
from .lease import TaskLease
from ..domain.store import Store
from ..domain.types import now_iso

# 单次 drain 内对同一任务的引擎推进上限；到顶仍未结束不得标 succeeded。
MAX_ENGINE_STEPS_PER_DRAIN = 6
HEARTBEAT_POLL_SECONDS = 1.0


def drain(service: Any, *, max_tasks: int = 5,
          account_id: str | None = None,
          stop_event: threading.Event | None = None) -> dict[str, Any]:
    """认领并执行至多 max_tasks 个任务（可按账户过滤）。

    先对账 waiting_user 任务（人审已处理的重排回队列），再认领新任务。
    stop_event 由服务生命周期控制，置位后尽快返回。
    每个任务按其 spec 的 demo 标志构建对应引擎（mock/真实路由），
    store 共享同一 app.db（连接每任务独立，符合现有"每 worker 独立 Store"约束）。
    """
    # Idle queue polling needs metadata, not model routes, brand files or assets.
    store = Store(service.runtime/'app.db')
    queue = TaskQueue(store)
    executed: list[dict[str, Any]] = []
    try:
        with store.transaction():
            store.conn.execute(
                "UPDATE tasks SET state='failed',error_code='UNSUPPORTED_TASK_KIND',updated_at=?"
                " WHERE state='queued' AND kind!='production' AND (? IS NULL OR account_id=?)",
                (now_iso(),account_id,account_id))
        queue.requeue_expired(account_id=account_id,kind='production')
        _reconcile_waiting(store, queue, None, executed, account_id=account_id)
        for _ in range(max_tasks):
            if stop_event is not None and stop_event.is_set():
                break
            # Share the desktop's backup barrier: a claim is either visible as
            # running before the snapshot starts, or waits until it completes.
            with getattr(service, 'guard', nullcontext()):
                claimed = queue.claim(kinds=["production"], account_id=account_id)
            if claimed is None:
                break
            executed.append(_run_claimed(service, store, queue, claimed, stop_event))
    finally:
        store.close()
    return {"executed": executed}


def _reconcile_waiting(store, queue: TaskQueue, engine, executed: list, *, account_id: str | None = None) -> None:
    """Reflect persisted job decisions without retrying rejected or stopped work."""
    rows = store.conn.execute(
        "SELECT t.task_id,t.account_id,b.job_id FROM tasks t"
        " LEFT JOIN task_job_bindings b ON b.task_id = t.task_id"
        " WHERE t.kind='production' AND t.state IN ('waiting_user','paused') AND COALESCE(t.error_code,'')!='RESTORE_REVIEW'"
        " AND (? IS NULL OR t.account_id=?)",
        (account_id, account_id)).fetchall()
    for row in rows:
        with store.transaction():
            task = store.conn.execute("SELECT state,cancel_requested FROM tasks WHERE task_id=?",(row['task_id'],)).fetchone()
            if not task or task['state'] not in ('waiting_user','paused'):
                continue
            job = store.get_job(row['job_id']) if row['job_id'] else None
            pending = store.pending_approval(row['job_id']) if job else None
            error = None
            article = store.get_article(job['article_id']) if job else None
            if job and (not article or article['spec'].get('account_id','ice-loop') != row['account_id']):
                state,error = 'failed','ACCOUNT_CONFLICT'
            elif task['cancel_requested']:
                if job and job['state'] not in ('completed','cancelled'):
                    store.update_job(row['job_id'],state='paused',pause_reason='队列任务已取消',commit=False)
                state = 'cancelled'
            elif not job:
                # An unbound interrupted task stays visible for explicit recovery.
                if task['state'] == 'paused' and not row['job_id']:
                    continue
                state,error = 'failed','JOB_LOST'
            elif job['state'] in ('failed','cancelled'):
                state = job['state']
                error = 'ENGINE_FAILED' if state == 'failed' else None
            elif job['state'] == 'paused':
                state = 'paused'
            elif pending is None and job['state'] in ('queued','running','completed','awaiting_approval'):
                state = 'queued'
            else:
                continue
            if state == task['state']:
                continue
            store.conn.execute(
                "UPDATE tasks SET state=?, lease_token=NULL, lease_expires_at=NULL,"
                " error_code=?, updated_at=? WHERE task_id=? AND state=?",
                (state,error,now_iso(),row['task_id'],task['state']))
            executed.append({'task_id':row['task_id'],'job_id':row['job_id'],
                             'status':'requeued' if state=='queued' else state})


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
        with TaskLease(store.db_path,task_id,token,lease_seconds=queue.lease_seconds,
                       stop_event=stop_event,poll_seconds=HEARTBEAT_POLL_SECONDS) as lease:
            if lease.lost.is_set():
                queue.pause_bound_job(task_id,token,'租约监控不可用，请检查后继续')
                queue.finish_with_state(task_id,token,'paused',{'error_code':lease.error or 'LEASE_LOST'})
                return _outcome(queue,task_id,note='租约不可用，未启动引擎',error_code=lease.error)
            return _drive_production(service, store, queue, task_id, token,
                                     account_id, payload, stop_event,lease)
    except _OwnershipLost:
        current = queue.get(task_id)
        if current['lease_token'] == token and current['state'] == 'running':
            if current['cancel_requested']:
                queue.confirm_cancelled(task_id,token)
            elif stop_event is not None and stop_event.is_set():
                queue.release(task_id,token,requeue=True)
        return _outcome(queue,task_id,note='创建前已停止或失去租约，没有重复创建文章')
    except _NonRetryable as exc:
        queue.fail(task_id, token, exc.error_code, retryable=False)
        return _outcome(queue,task_id,error_code=exc.error_code,error=str(exc)[:300])
    except Exception as exc:  # 引擎/系统异常：按可重试处理（有上限）
        queue.fail(task_id, token, "CONSUMER_FAILED")
        return _outcome(queue,task_id,error_code='CONSUMER_FAILED',error=str(exc)[:300])


class _NonRetryable(Exception):
    def __init__(self, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code


class _OwnershipLost(Exception):
    pass


def _outcome(queue, task_id, job_id=None, **detail):
    """A failed CAS must never be reported as a successful state change."""
    result = {'task_id':task_id,'status':queue.get(task_id)['state'],**detail}
    if job_id: result['job_id'] = job_id
    return result


def _drive_production(service, store, queue: TaskQueue, task_id: str,
                      token: str, account_id: str, payload: dict[str, Any],
                      stop_event: threading.Event | None, lease: TaskLease) -> dict[str, Any]:
    def stop_engine(job: str) -> None:
        """与 jobs.stop 相同的取消边界，但以任务持久化账户为上下文
        （消费者跨账户工作，不能借用当前选中公众号）。"""
        queue.pause_bound_job(task_id,token,'队列停止/取消，任务已让出')

    spec = payload.get("spec")
    if not isinstance(spec, dict) or not spec:
        raise _NonRetryable("INVALID_PAYLOAD", "production 任务缺少 spec")
    spec_account = spec.get("account_id", account_id)
    if spec_account not in (None,account_id) or payload.get('account_id') not in (None,account_id):
        raise _NonRetryable("ACCOUNT_CONFLICT", "任务需求的公众号标识与队列归属不一致")
    # 绑定：首次创建 job 并持久化；重启/重排复用已有 job（不重建、不重复扣费）。
    bound = queue.bound_job(task_id)
    if bound:
        job = bound
        job_row = store.get_job(job)
        if job_row is None:
            raise _NonRetryable("JOB_LOST", "绑定的引擎 job 已不存在")
        article = store.get_article(job_row['article_id'])
        if article['spec'].get('account_id') not in (None,account_id):
            raise _NonRetryable('ACCOUNT_CONFLICT', '绑定文章与任务归属不一致')
        spec = article['spec']
    else:
        if stop_event is not None and stop_event.is_set():
            queue.release(task_id, token, requeue=True)
            return {"task_id": task_id, "status": "queued", "note": "消费者停止前让出"}
        from ..application.task_specs import production_spec
        try:
            # A persisted unbound payload may predate the Agent ingress fix.
            # No generated code exists yet, so its broad approval cannot be valid.
            original_spec = spec
            spec = production_spec(service,store,account_id,spec,preserve_demo=True)
            normalized = sorted(key for key in set(original_spec)|set(spec)
                                if original_spec.get(key) != spec.get(key))
        except ValueError as error:
            raise _NonRetryable('INVALID_PAYLOAD',str(error)) from None
        # 按任务的 demo 标志构建引擎（mock/真实路由）；store 共享同一 app.db。
        task_engine, _, task_store = service._app(demo=bool(spec.get("demo")), account_id=account_id)
        try:
            bound_queue = TaskQueue(task_store)
            def bind_created(created_job):
                current = bound_queue.get(task_id)
                if (current['lease_token'] != token or current['state'] != 'running'
                        or current['cancel_requested'] or stop_event is not None and stop_event.is_set()):
                    raise _OwnershipLost()
                bound_queue.bind_job(task_id,created_job,account_id)
                from ..application.job_context import record_context
                record_context(task_store,created_job,account_id,task_engine.cfg.article_root,
                               source='production_queue')
                if normalized:
                    task_store.append_event(created_job,'task.spec_normalized',{'fields':normalized,'source':'unbound_queue'})
            job, _article = task_engine.create_job(spec,on_created=bind_created,
                limits={'max_model_calls':service.settings['max_model_calls']})
        finally:
            task_store.close()
    # 推进引擎，严格映射状态；每步心跳，取消/失租即通知实际 job。
    for _ in range(MAX_ENGINE_STEPS_PER_DRAIN):
        if not queue.heartbeat(task_id, token):
            return _outcome(queue,task_id,job,note='租约已失效，未修改新持有者的任务')
        if stop_event is not None and stop_event.is_set():
            stop_engine(job)
            queue.finish_with_state(task_id,token,'paused',{'job_id':job,'note':'消费者已停止'})
            return _outcome(queue,task_id,job)
        if store.conn.execute(
                "SELECT cancel_requested FROM tasks WHERE task_id=?",
                (task_id,)).fetchone()[0]:
            stop_engine(job)
            queue.confirm_cancelled(task_id, token)
            return {"task_id": task_id, "status": "cancelled", "job_id": job}
        # 按同一 demo 标志构建推进引擎（与 create_job 一致的路由域）。
        task_engine, task_cfg, task_store = service._job_app(job,background=True,expected_owner=account_id)
        try:
            task_engine.should_stop = lease.should_stop
            if task_store.get_job(job).get('lease'):
                queue.release(task_id,token,requeue=True)
                return _outcome(queue,task_id,job,note='等待原执行者释放引擎锁，没有重复运行')
            snapshot = task_engine._load_state(job).get('rules_profile_snapshot')
            if snapshot:
                task_cfg.profile = copy.deepcopy(snapshot)
            result = task_engine.run(job)
        finally:
            task_store.close()
        current = queue.get(task_id)
        if current['lease_token'] != token or current['state'] != 'running':
            return _outcome(queue,task_id,job,note='晚到结果未覆盖新的队列状态')
        if current['cancel_requested']:
            stop_engine(job)
            queue.confirm_cancelled(task_id,token)
            return _outcome(queue,task_id,job)
        state = result.get("state") or store.get_job(job)["state"]
        if lease.lost.is_set():
            # The engine has cooperatively returned. Never leave our queue lease
            # renewing if its monitor failed; this work is visibly paused.
            stop_engine(job)
            queue.finish_with_state(task_id,token,'paused',{'job_id':job,'note':'租约监控中断，请检查后继续'})
            return _outcome(queue,task_id,job,error_code=lease.error or 'LEASE_LOST')
        if stop_event is not None and stop_event.is_set() and state != 'completed':
            stop_engine(job)
            queue.finish_with_state(task_id,token,'paused',{'job_id':job,'note':'消费者已停止'})
            return _outcome(queue,task_id,job)
        if state == "completed":
            if not queue.complete(task_id, token, {"job_id": job, "engine_state": state}):
                current = queue.get(task_id)
                if current['lease_token'] == token and current['cancel_requested']:
                    queue.confirm_cancelled(task_id,token)
            return _outcome(queue,task_id,job)
        if state == "failed":
            queue.fail(task_id, token, "ENGINE_FAILED", retryable=False)
            return _outcome(queue,task_id,job,error_code='ENGINE_FAILED')
        if state == "cancelled":
            queue.finish_with_state(task_id,token,'cancelled',{'job_id':job,'engine_state':state})
            return _outcome(queue,task_id,job)
        if state in ("paused", "awaiting_approval", "awaiting_user"):
            approval = store.pending_approval(job)
            if state in ('awaiting_approval','awaiting_user'):
                # 人工审批门：waiting_user 持久化 job_id 与等待门；不代批。
                queue.finish_with_state(task_id, token, "waiting_user",
                                        {"job_id": job, "waiting": 'approval' if approval else 'user_action',
                                         "approval_id": approval["approval_id"] if approval else "",
                                         "engine_state": state})
                return _outcome(queue,task_id,job,waiting='approval' if approval else 'user_action')
            # 无审批的暂停（用户手动暂停）：映射 paused 终态，等待用户续跑。
            queue.finish_with_state(task_id, token, "paused",
                                    {"job_id": job, "note": "引擎已暂停"})
            return _outcome(queue,task_id,job)
        # running/queued 等继续下一轮推进
    # 推进到上限仍未结束：不得标 succeeded；按可重试重排。
    queue.fail(task_id, token, "STEP_LIMIT", retryable=True)
    return _outcome(queue,task_id,job,note='单次推进到上限，按队列重试策略处理')
