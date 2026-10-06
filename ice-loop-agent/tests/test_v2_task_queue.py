"""v2.0 持久任务队列测试（M1-06）：单租约、幂等、取消、租约过期恢复。"""
from __future__ import annotations

import threading
import unittest

from ice_agent.domain.store import Store
from ice_agent.tasks import TaskNotFoundError, TaskQueue
from tests import temp_dir


class TestTaskQueue(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir('v2queue-')
        self.store = Store(self.dir / 'app.db')
        self.queue = TaskQueue(self.store, lease_seconds=60)

    def tearDown(self):
        self.store.close()

    def test_enqueue_and_claim_by_priority(self):
        low = self.queue.enqueue('a1', 'demo', {'n': 1}, priority=9)
        high = self.queue.enqueue('a1', 'demo', {'n': 2}, priority=1)
        first = self.queue.claim()
        self.assertEqual(first['task_id'], high['task_id'], 'priority 小的先执行')
        self.assertEqual(first['state'], 'running')
        self.assertTrue(first['lease_token'])
        self.assertEqual(first['attempt'], 1)
        second = self.queue.claim()
        self.assertEqual(second['task_id'], low['task_id'])
        self.assertIsNone(self.queue.claim(), '队列空后无任务可领')

    def test_double_claim_cannot_get_same_task(self):
        task = self.queue.enqueue('a1', 'demo', {})
        first = self.queue.claim()
        second = self.queue.claim()
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        # 心跳只对持有者有效
        self.assertTrue(self.queue.heartbeat(task['task_id'], first['lease_token']))
        self.assertFalse(self.queue.heartbeat(task['task_id'], 'lease-forged'))

    def test_idempotency_key_returns_existing_task(self):
        a = self.queue.enqueue('a1', 'export', {'rev': 'r1'}, idempotency_key='exp-r1')
        b = self.queue.enqueue('a1', 'export', {'rev': 'r1'}, idempotency_key='exp-r1')
        self.assertEqual(a['task_id'], b['task_id'])
        self.assertEqual(self.queue.claim()['task_id'], a['task_id'])
        self.assertIsNone(self.queue.claim(), '重复入队不产生第二个可执行任务')

    def test_complete_requires_valid_lease(self):
        task = self.queue.enqueue('a1', 'demo', {})
        claimed = self.queue.claim()
        self.assertTrue(self.queue.complete(task['task_id'], claimed['lease_token'], {'ok': True}))
        done = self.queue.get(task['task_id'])
        self.assertEqual(done['state'], 'succeeded')
        self.assertEqual(done['result'], {'ok': True})
        # 终态后租约已清，旧 token 不能再写
        self.assertFalse(self.queue.complete(task['task_id'], claimed['lease_token'], {'x': 1}))

    def test_fail_retries_until_max_attempts(self):
        task = self.queue.enqueue('a1', 'demo', {}, max_attempts=2)
        first = self.queue.claim()
        self.queue.fail(task['task_id'], first['lease_token'], 'PROVIDER_ERROR')
        retry = self.queue.get(task['task_id'])
        self.assertEqual(retry['state'], 'queued')
        self.assertEqual(retry['error_code'], 'PROVIDER_ERROR')
        second = self.queue.claim()
        self.assertEqual(second['attempt'], 2)
        self.queue.fail(task['task_id'], second['lease_token'], 'PROVIDER_ERROR')
        final = self.queue.get(task['task_id'])
        self.assertEqual(final['state'], 'failed', '超过 max_attempts 落终态')

    def test_cancel_queued_is_immediate_running_requests_stop(self):
        queued = self.queue.enqueue('a1', 'demo', {'which': 'queued'})
        cancelled = self.queue.cancel(queued['task_id'])
        self.assertEqual(cancelled['state'], 'cancelled')
        self.assertIsNone(self.queue.claim(), '已取消任务不再被认领')

        running = self.queue.enqueue('a1', 'demo', {'which': 'running'})
        claimed = self.queue.claim()
        marked = self.queue.cancel(running['task_id'])
        self.assertEqual(marked['state'], 'running')
        self.assertTrue(marked['cancel_requested'])
        # 协作停止后由持有者确认终态
        self.assertTrue(self.queue.confirm_cancelled(running['task_id'], claimed['lease_token']))
        self.assertEqual(self.queue.get(running['task_id'])['state'], 'cancelled')

    def test_late_result_from_stale_lease_rejected(self):
        task = self.queue.enqueue('a1', 'demo', {})
        claimed = self.queue.claim()
        self.queue.release(task['task_id'], claimed['lease_token'], requeue=True)
        # 原租约的晚到结果不得写入
        self.assertFalse(self.queue.complete(task['task_id'], claimed['lease_token'], {'late': 1}))
        reclaimed = self.queue.claim()
        self.assertIsNotNone(reclaimed, '释放后任务可被重新认领')
        self.assertEqual(reclaimed['attempt'], 2)

    def test_requeue_expired_lease_on_restart(self):
        task = self.queue.enqueue('a1', 'demo', {})
        claimed = self.queue.claim()
        # 模拟持有者崩溃：把租约过期时间拨到过去
        self.store.conn.execute(
            "UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE task_id=?",
            (task['task_id'],))
        self.store.conn.commit()
        recovered = self.queue.requeue_expired()
        self.assertEqual(recovered, [task['task_id']])
        again = self.queue.claim()
        self.assertIsNotNone(again)
        self.assertNotEqual(again['lease_token'], claimed['lease_token'])

    def test_account_scoped_listing(self):
        self.queue.enqueue('acct-1', 'demo', {'a': 1})
        self.queue.enqueue('acct-2', 'demo', {'b': 2})
        rows = self.queue.list_for_account('acct-1')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['payload'], {'a': 1})

    def test_missing_task_raises(self):
        with self.assertRaises(TaskNotFoundError):
            self.queue.get('task-none')


if __name__ == '__main__':
    unittest.main()
