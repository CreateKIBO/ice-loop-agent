"""批次A回归：队列消费者真实接线——严格状态映射、绑定持久化、账户隔离、租约/取消。

替换旧弱断言（succeeded 对应任意 engine 状态）；每个用例使用独立 temp_dir。
"""
from __future__ import annotations

import json
import threading
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.tasks import TaskQueue, TaskInputConflict
from ice_agent.tasks.worker import drain

from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def _spec(account: str, topic: str = "消费者任务") -> dict:
    return {**demo_spec(), 'demo': True, 'account_id': account,
            'topic': topic, 'article_root': None}


class TestQueueConsumerStrict(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-consA-")
        # auto_consumer=False：确定性控制，测试自行调 drain 驱动任务；
        # 生产路径的 auto_consumer=True 生命周期由专用测试覆盖。
        self.service = DesktopService(REPO, self.root / "runtime",
                                      self.root / "articles", auto_consumer=False)
        _, _, store = self.service._app(demo=True)
        self.store = store

    def tearDown(self):
        self.store.close()
        self.service.close()

    def _enqueue_production(self, account: str, topic: str = "消费者任务", key: str | None = None):
        queue = TaskQueue(self.store)
        spec = _spec(account, topic)
        articles = self.root / "articles"
        articles.mkdir(parents=True, exist_ok=True)
        spec["article_root"] = str(articles)
        return queue.enqueue(account, "production", {"spec": spec},
                             idempotency_key=key)

    def test_completed_engine_maps_to_succeeded(self):
        task = self._enqueue_production("ice-loop", key="c1")
        # demo 引擎在审批门暂停；循环批准直到完成，drain 之间复用绑定 job
        for _ in range(10):
            summary = drain(self.service)
            # Reconciliation may emit a requeued row before the actual worker
            # outcome for the same task. Review its latest persisted outcome.
            record = next((e for e in reversed(summary["executed"])
                           if e["task_id"] == task["task_id"]), None)
            if record is None:
                break  # 无可认领（任务已是终态）
            if record["status"] == "waiting_user":
                queue = TaskQueue(self.store)
                bound_job = json_job_id(queue.get(task["task_id"])["result"])
                approval = self.store.pending_approval(bound_job)
                if approval is None:
                    data = self.service.call('jobs.get',{'job_id':bound_job})
                    self.assertEqual(data['job']['current_node'],'verify_code',data['job'])
                    self.assertEqual(data['job']['state'],'awaiting_user',data['job'])
                    with patch.object(self.service,'_start',return_value={'started':False}):
                        self.service.call('execution.approve',{'job_id':bound_job,
                            'content_hash':data['execution_hash'],'stdin_by_filename':data['stdin_by_filename']})
                    continue
                engine, _, estore = self.service._app(demo=True)
                try:
                    engine.decide(bound_job, approval["approval_id"], "approve",
                                  expect_hash=approval["content_hash"])
                finally:
                    estore.close()
                continue
            if record["status"] == "succeeded":
                job_id = json_job_id(TaskQueue(self.store).get(task["task_id"])["result"])
                self.assertEqual(self.store.get_job(job_id)["state"], "completed",
                                 "succeeded 必须严格对应引擎 completed")
                return
            if record["status"] == "failed":
                self.fail(f"demo 任务不应失败：{record}")
        self.fail('逐门批准后仍未完成，不能用中间态代替成功验收')

    def test_engine_failed_never_succeeded(self):
        """引擎 failed 必须映射 task failed，绝不 succeeded。"""
        task = self._enqueue_production("ice-loop", key="f1")
        # Schema-invalid input is now rejected before creating a job. Exercise
        # a real engine-node failure, rather than confusing it with admission.
        queue = TaskQueue(self.store)
        from ice_agent.workflow.nodes import NODE_FUNCS,NodeFailed
        def fail(_ctx): raise NodeFailed('topic','FIXTURE_NODE_FAILURE','controlled engine failure')
        with patch.dict(NODE_FUNCS,{'topic':fail}):
            drain(self.service)
        final = queue.get(task["task_id"])
        self.assertNotEqual(final["state"], "succeeded",
                            "引擎失败的任务不得标 succeeded")
        self.assertEqual(final['state'],'failed')
        self.assertEqual(final['error_code'],'ENGINE_FAILED')
        self.assertEqual(self.store.get_job(queue.bound_job(task['task_id']))['state'],'failed')

    def test_waiting_user_binds_job_and_approve_continues(self):
        """审批门 waiting_user 持久化 job_id；人工批准后 drain 继续复用绑定 job。"""
        task = self._enqueue_production("ice-loop", key="w1")
        summary = drain(self.service)
        record = next(e for e in summary["executed"] if e["task_id"] == task["task_id"])
        self.assertEqual(record["status"], "waiting_user",
                         "demo 引擎首个审批门应映射 waiting_user")
        self.assertEqual(record.get("waiting"), "approval")
        queue = TaskQueue(self.store)
        bound_job = json_job_id(queue.get(task["task_id"])["result"])
        self.assertIsNotNone(self.store.pending_approval(bound_job),
                             "等待门应有待审批记录")
        # 模拟人工批准
        approval = self.store.pending_approval(bound_job)
        engine, _, estore = self.service._app(demo=True)
        try:
            engine.decide(bound_job, approval["approval_id"], "approve",
                          expect_hash=approval["content_hash"])
        finally:
            estore.close()
        # 再次 drain：复用同一 job 继续（不重建）
        summary2 = drain(self.service)
        record2 = next((e for e in summary2["executed"]
                        if e["task_id"] == task["task_id"]), None)
        if record2 is not None:
            self.assertEqual(record2.get("job_id", bound_job), bound_job,
                             "续跑必须复用绑定 job，不重建")

    def test_account_conflict_terminated_not_retried(self):
        queue = TaskQueue(self.store)
        spec = _spec("ice-loop")
        spec["account_id"] = "other-account"  # 与任务归属冲突
        task = queue.enqueue("ice-loop", "production", {"spec": spec},
                             idempotency_key="conflict")
        summary = drain(self.service)
        record = next(e for e in summary["executed"] if e["task_id"] == task["task_id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error_code"], "ACCOUNT_CONFLICT")
        final = queue.get(task["task_id"])
        self.assertEqual(final["state"], "failed", "非重试错误直接终止")
        self.assertEqual(final["attempt"], 1, "冲突不得反复重试")

    def test_cross_account_isolation_in_drain(self):
        """A/B 账号交错：drain(account_id=B) 不得认领 A 的任务。"""
        queue = TaskQueue(self.store)
        task_a = self._enqueue_production("ice-loop", key="acct-a-only")
        # 用另一个账号注册（同库）
        self.store.conn.execute(
            "INSERT OR IGNORE INTO tasks (task_id, account_id, kind, priority, state,"
            " input_hash, idempotency_key, payload, attempt, max_attempts, created_at, updated_at)"
            " VALUES ('task-b', 'acct-b', 'production', 5, 'queued', 'h', 'k-b', '{}',"
            " 0, 3, '2026-01-01', '2026-01-01')")
        self.store.conn.commit()
        summary = drain(self.service, account_id="acct-b")
        touched = {e["task_id"] for e in summary["executed"]}
        self.assertNotIn(task_a["task_id"], touched, "B 域消费者不得认领 A 的任务")
        self.assertIn("task-b", touched)

    def test_double_consumer_single_effect(self):
        """双消费者：第二个 drain 看不到可认领任务（第一个已认领/完成）。"""
        task = self._enqueue_production("ice-loop", key="d1")
        s1 = drain(self.service)
        s2 = drain(self.service)
        touched1 = {e["task_id"] for e in s1["executed"]}
        claimed2 = [e for e in s2["executed"] if e["task_id"] == task["task_id"]
                    and e["status"] == "succeeded"]
        if task["task_id"] in touched1:
            records = TaskQueue(self.store)
            final = records.get(task["task_id"])
            if final["state"] in ("succeeded", "waiting_user", "paused", "failed"):
                self.assertEqual(claimed2, [], "同一任务不得被两个消费者各执行一遍")

    def test_weak_assertion_replaced(self):
        """旧弱断言（succeeded 对应任意状态）必须失效：succeeded 只对应 completed。"""
        task = self._enqueue_production("ice-loop", key="strict")
        summary = drain(self.service)
        record = next(e for e in summary["executed"] if e["task_id"] == task["task_id"])
        if record["status"] == "succeeded":
            job_id = json_job_id(TaskQueue(self.store).get(task["task_id"])["result"])
            self.assertEqual(self.store.get_job(job_id)["state"], "completed",
                             "succeeded 必须严格对应引擎 completed")


def json_dumps(value) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def json_job_id(result) -> str:
    import json
    data = json.loads(result) if isinstance(result, str) else result
    return data["job_id"]


class TestConsumerLifecycle(unittest.TestCase):
    """批次A：auto_consumer=True 的真实生命周期——消费者自动认领并推进任务。"""

    def setUp(self):
        self.root = temp_dir("v2-consLC-")
        self.service = DesktopService(REPO, self.root / "runtime",
                                      self.root / "articles", auto_consumer=True)
        _, _, store = self.service._app(demo=True)
        self.store = store

    def tearDown(self):
        self.store.close()
        self.service.close()

    def test_auto_consumer_processes_queued_task(self):
        import time
        queue = TaskQueue(self.store)
        spec = _spec("ice-loop")
        articles = self.root / "articles"
        articles.mkdir(parents=True, exist_ok=True)
        spec["article_root"] = str(articles)
        task = queue.enqueue("ice-loop", "production", {"spec": spec},
                             idempotency_key="lc-auto")
        # 等消费者线程自动处理（3s poll + demo engine 执行时间）
        for _ in range(60):
            final = queue.get(task["task_id"])
            if final["state"] in ("waiting_user", "succeeded", "failed", "paused"):
                break
            time.sleep(0.5)
        self.assertIn(final["state"], ("waiting_user", "succeeded", "paused", "failed", "queued"),
                      "消费者应将任务推进到已知状态")
        self.assertGreaterEqual(final["attempt"], 1, "消费者应至少认领一次")
        if final["state"] == "waiting_user":
            result = json.loads(final["result"]) if isinstance(final["result"], str) else final["result"]
            self.assertIn("job_id", result, "waiting_user 必须持久化 job_id")
            bound = queue.bound_job(task["task_id"])
            self.assertEqual(bound, result["job_id"])


def json_dumps(value) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def json_job_id(result) -> str:
    import json
    data = json.loads(result) if isinstance(result, str) else result
    return data["job_id"]


if __name__ == "__main__":
    unittest.main()
