"""v2.0 M1-07/M1-08 组合验收：取消链一致、命令幂等、未知副作用不重提交。"""
from __future__ import annotations

import json
import unittest

from ice_agent.desktop_service import DesktopService
from ice_agent.tasks import TaskQueue

from tests import temp_dir


def _service(root):
    return DesktopService(root / 'projects', runtime_root=root / 'runtime')


class TestCombinedCancelIdempotency(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir('v2-idem-')
        self.service = _service(self.dir)

    def tearDown(self):
        self.service.close()

    def _account(self):
        return self.service._account()

    def test_task_queue_idempotent_enqueue_blocks_duplicates(self):
        _, _, store = self.service._app()
        try:
            queue = TaskQueue(store)
            key = 'export:art-1:rev-3'
            first = queue.enqueue(self._account()['id'], 'export',
                                  {'revision': 'rev-3'}, idempotency_key=key)
            second = queue.enqueue(self._account()['id'], 'export',
                                   {'revision': 'rev-3'}, idempotency_key=key)
            self.assertEqual(first['task_id'], second['task_id'])
            claimed = queue.claim()
            self.assertIsNotNone(claimed)
            self.assertTrue(queue.complete(first['task_id'], claimed['lease_token'],
                                           {'exported': ['01-公众号正文.md']}))
            # 完成后同 key 再次入队仍返回既有任务（不重复执行导出）
            third = queue.enqueue(self._account()['id'], 'export',
                                  {'revision': 'rev-3'}, idempotency_key=key)
            self.assertEqual(third['task_id'], first['task_id'])
            self.assertEqual(third['state'], 'succeeded')
        finally:
            store.close()

    def test_chat_create_request_dedup_returns_same_conversation(self):
        account_id = self._account()['id']
        first = self.service.call('chat.create', {
            'account_id': account_id, 'request_id': 'req-100',
            'title': '第一轮', 'mode': 'discuss'})
        # 客户端重试同一 request_id（同输入 hash）：返回同一会话，不新建。
        again = self.service.call('chat.create', {
            'account_id': account_id, 'request_id': 'req-100',
            'title': '第一轮', 'mode': 'discuss'})
        self.assertEqual(first['conversation']['id'], again['conversation']['id'])
        self.assertTrue(again['reused'], '同 request_id 重复创建应标记 reused')
        # 同 request_id 但不同输入：冲突被拒（不是悄悄换语义）
        with self.assertRaises(ValueError):
            self.service.call('chat.create', {
                'account_id': account_id, 'request_id': 'req-100',
                'title': '不同的目标', 'mode': 'discuss'})
        listing = self.service.call('chat.list', {'account_id': account_id})
        self.assertEqual(len(listing), 1, '重复请求不产生第二条会话')

    def test_ledger_unknown_state_needs_reconciliation_not_resubmit(self):
        """sending/unknown 的付费操作必须走对账，不能自动重新提交。"""
        from ice_agent.ledger.operations import OperationsLedger
        account_id = self._account()['id']
        _, _, store = self.service._app()
        try:
            ledger = OperationsLedger(store)
            op = ledger.prepare(article_id='art-x', slot_id='slot-1', candidate_index=0,
                                provider='tapnow', prompt='ICE Loop 封面，信号蓝 #2448DB',
                                settings={'ratio': '3:1'}, max_candidates=2,
                                account_ref=account_id)
            lease = ledger.acquire_send_lease(op['operation_id'])
            self.assertEqual(lease['status'], 'sending')
            # 模拟崩溃：结果未知
            ledger.mark(op['operation_id'], 'unknown', notes='进程重启，结果未知')
            pending = ledger.needs_reconciliation('art-x')
            self.assertIn(op['operation_id'], [o['operation_id'] for o in pending])
            # 重复 acquire 不可能（非 prepared 拒绝）→ 不重提交
            with self.assertRaises(Exception):
                ledger.acquire_send_lease(op['operation_id'])
            # 对账"未提交"后释放预留
            reconciled = ledger.reconcile(op['operation_id'], 'not_submitted',
                                          'evidence: 用户确认未点击生成')
            self.assertIsNotNone(reconciled)
        finally:
            store.close()

    def test_stop_then_late_finish_leaves_consistent_state(self):
        """取消原语组合：队列取消后晚到结果被拒，状态停在 cancelled。"""
        account_id = self._account()['id']
        _, _, store = self.service._app()
        try:
            queue = TaskQueue(store)
            task = queue.enqueue(account_id, 'screenshot', {'slot': 'slot-9'})
            claimed = queue.claim()
            queue.cancel(task['task_id'])
            self.assertTrue(queue.confirm_cancelled(task['task_id'], claimed['lease_token']))
            final = queue.get(task['task_id'])
            self.assertEqual(final['state'], 'cancelled')
            # 晚到的"成功"结果不得覆盖已取消任务
            self.assertFalse(queue.complete(task['task_id'], claimed['lease_token'],
                                            {'late': True}))
            self.assertEqual(queue.get(task['task_id'])['result'], None)
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()
