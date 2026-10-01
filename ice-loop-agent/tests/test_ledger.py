"""操作账本测试：幂等 key、发送租约、预算、对账三决策。"""
from __future__ import annotations

import unittest

from ice_agent.domain.store import Store
from ice_agent.ledger.operations import (
    BudgetExceeded,
    DuplicateSubmitBlocked,
    OperationsLedger,
)
from ice_agent.domain.types import new_id
from tests import temp_dir


class TestLedger(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("ledger-")
        self.store = Store(self.dir / "app.db")
        self.ledger = OperationsLedger(self.store)
        self.article = new_id("art")
        self.slot = new_id("slot")

    def tearDown(self):
        self.store.close()

    def _prepare(self, candidate=1, prompt="a prompt", settings=None,
                 max_candidates=2):
        return self.ledger.prepare(
            article_id=self.article, slot_id=self.slot,
            candidate_index=candidate, provider="tapnow_browser",
            prompt=prompt, settings=settings or {"size": [1880, 800]},
            max_candidates=max_candidates)

    def test_same_key_returns_existing(self):
        op1 = self._prepare()
        op2 = self._prepare()          # 完全相同参数：复用旧 key，不新增
        self.assertEqual(op1["operation_id"], op2["operation_id"])
        self.assertEqual(
            len(self.store.article_operations(self.article)), 1)

    def test_send_lease_only_from_prepared(self):
        op = self._prepare()
        self.ledger.acquire_send_lease(op["operation_id"])
        with self.assertRaises(DuplicateSubmitBlocked):
            self.ledger.acquire_send_lease(op["operation_id"])  # 重复提交被拒

    def test_budget_exceeded_and_unknown_keeps_reservation(self):
        self._prepare(candidate=1)
        op2 = self._prepare(candidate=2)   # 不同候选 → 新 key
        self.ledger.acquire_send_lease(op2["operation_id"])
        self.ledger.mark(op2["operation_id"], "unknown")
        with self.assertRaises(BudgetExceeded):
            self._prepare(candidate=3, max_candidates=2)

    def test_reconcile_found_existing_needs_ref(self):
        op = self._prepare()
        self.ledger.acquire_send_lease(op["operation_id"])
        self.ledger.mark(op["operation_id"], "unknown")
        with self.assertRaises(Exception):
            self.ledger.reconcile(op["operation_id"], "found_existing",
                                  "画布上有结果", provider_task_ref="")
        done = self.ledger.reconcile(
            op["operation_id"], "found_existing",
            "画布节点确认为本任务参数", provider_task_ref="canvas-1/node-9",
            provider_asset_refs=["asset-1"])
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["provider_task_ref"], "canvas-1/node-9")

    def test_reconcile_not_submitted_releases_budget(self):
        op = self._prepare()
        self.ledger.acquire_send_lease(op["operation_id"])
        self.ledger.mark(op["operation_id"], "unknown")
        done = self.ledger.reconcile(
            op["operation_id"], "not_submitted",
            "网络错误发生在请求发出前，抓包确认未到达服务端")
        self.assertEqual(done["status"], "not_submitted_confirmed")
        self.assertEqual(done["reserved_budget"], 0)
        # 预算释放后可再登记新候选
        self.assertIsNotNone(self._prepare(candidate=2))

    def test_reconcile_unresolved_keeps_reservation(self):
        op = self._prepare()
        self.ledger.acquire_send_lease(op["operation_id"])
        self.ledger.mark(op["operation_id"], "unknown")
        done = self.ledger.reconcile(
            op["operation_id"], "unresolved", "画布上没找到，但无法证明未提交")
        self.assertEqual(done["status"], "needs_reconciliation")
        self.assertEqual(done["reserved_budget"], 1)
        self.assertEqual(
            len(self.ledger.needs_reconciliation(self.article)), 1)

    def test_reconcile_requires_evidence(self):
        op = self._prepare()
        self.ledger.acquire_send_lease(op["operation_id"])
        self.ledger.mark(op["operation_id"], "unknown")
        with self.assertRaises(Exception):
            self.ledger.reconcile(op["operation_id"], "not_submitted", "  ")
