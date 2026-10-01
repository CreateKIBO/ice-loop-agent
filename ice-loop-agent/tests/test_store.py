"""存储层测试：CRUD、审批 hash 防重放、编号分配、事件序列。"""
from __future__ import annotations

import unittest

from ice_agent.domain.store import Store
from ice_agent.domain.types import new_id, sha256_json
from tests import temp_dir


class TestStore(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("store-")
        self.store = Store(self.dir / "app.db")

    def tearDown(self):
        self.store.close()

    def _article(self, no=None, aid=None):
        return {
            "article_id": aid or new_id("art"),
            "folder_no": no, "series": "PY", "episode": 5,
            "topic": "循环", "readiness": "draft", "spec": {},
        }

    def test_article_crud_and_update_guard(self):
        a = self._article()
        self.store.create_article(a)
        got = self.store.get_article(a["article_id"])
        self.assertEqual(got["topic"], "循环")
        self.store.update_article(a["article_id"], readiness="assets_pending")
        self.assertEqual(
            self.store.get_article(a["article_id"])["readiness"], "assets_pending")
        with self.assertRaises(ValueError):
            self.store.update_article(a["article_id"], bogus_column="x")

    def test_folder_no_allocation(self):
        root = self.dir / "articles"
        root.mkdir()
        (root / "002-已有").mkdir()
        self.store.create_article(self._article(no=1))
        self.assertEqual(self.store.next_folder_no(root), 3)
        (root / "003-新").mkdir()
        self.assertEqual(self.store.next_folder_no(root), 4)

    def test_approval_hash_replay_rejected(self):
        job = {"job_id": new_id("job"), "article_id": new_id("art"),
               "workflow": "w", "state": "queued", "current_node": "ingest",
               "mode": "semi_auto"}
        self.store.create_job(job)
        payload = {"x": 1}
        ap_id = self.store.add_approval({
            "approval_id": new_id("apr"), "job_id": job["job_id"],
            "scope": "topic", "revision": 1,
            "content_hash": sha256_json(payload), "payload": payload})
        # hash 不匹配 → False（409 语义）
        self.assertFalse(self.store.decide_approval(
            ap_id, "approve", "", "u", expect_hash="deadbeef"))
        self.assertTrue(self.store.decide_approval(
            ap_id, "approve", "ok", "u", expect_hash=sha256_json(payload)))
        # 重复决定 → False
        self.assertFalse(self.store.decide_approval(ap_id, "approve", "", "u"))

    def test_events_monotonic(self):
        job = {"job_id": new_id("job"), "article_id": new_id("art"),
               "workflow": "w", "state": "queued", "current_node": "ingest",
               "mode": "semi_auto"}
        self.store.create_job(job)
        s1 = self.store.append_event(job["job_id"], "step.started")
        s2 = self.store.append_event(job["job_id"], "step.completed")
        self.assertEqual(s2, s1 + 1)
        self.assertEqual(
            len(self.store.job_events(job["job_id"], after=s1)), 1)

    def test_revision_chain(self):
        a = self._article()
        self.store.create_article(a)
        self.store.add_revision({
            "revision_id": new_id("rev"), "article_id": a["article_id"],
            "kind": "draft", "content": "v1", "content_hash": "h1"})
        self.store.add_revision({
            "revision_id": new_id("rev"), "article_id": a["article_id"],
            "kind": "draft", "content": "v2", "content_hash": "h2"})
        latest = self.store.latest_revision(a["article_id"], "draft")
        self.assertEqual(latest["content"], "v2")
