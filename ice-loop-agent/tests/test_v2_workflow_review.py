"""v2.0 M6 核心（M6-01/02/04/06）与 M5-08 摘要测试。"""
from __future__ import annotations

import unittest

from ice_agent.desktop_service import DesktopService
from ice_agent.editorial import accept_model_draft
from ice_agent.workflow.invalidation import batch_plan, invalidation_preview

from tests import temp_dir
from tests.test_workflow import demo_spec


class TestAcceptModelDraft(unittest.TestCase):
    """M6-01：IR → 同一规范化链；失败安全回退为 Markdown。"""

    def test_ir_envelope_becomes_markdown_via_same_chain(self):
        ir = ('```json\n{"ir_version": 1, "title": "IR 生成的文章", '
              '"blocks": [{"type": "paragraph", "text": "第一段"}, '
              '{"type": "image_slot", "figure_no": 1, "caption": "封面", "kind": "生图"}]}\n```')
        markdown, used = accept_model_draft(ir)
        self.assertTrue(used)
        self.assertTrue(markdown.startswith("# IR 生成的文章"))
        self.assertIn("![图1：封面](待配图：生图", markdown)

    def test_broken_ir_falls_back_to_markdown(self):
        broken = '```json\n{"ir_version": 1, "title": "", "blocks": []}\n```'
        markdown, used = accept_model_draft(broken)
        self.assertFalse(used, "校验失败回退原文，不抛错不硬造")
        self.assertEqual(markdown, broken.strip())

    def test_plain_markdown_untouched(self):
        plain = "# 普通草稿\n\n正文，含 {\"ir_version\": 0} 字样但不是 IR。"
        markdown, used = accept_model_draft(plain)
        self.assertFalse(used)
        self.assertEqual(markdown, plain)


class TestInvalidationPreview(unittest.TestCase):
    """M6-02：改动 → 最小重跑集合；改标题不重跑程序。"""

    def test_title_change_does_not_rerun_code_execution(self):
        result = invalidation_preview(["title"])
        self.assertNotIn("verify_code", result["stale_nodes"])
        self.assertIn("title_workshop", result["stale_nodes"])
        self.assertIn("asset_plan", result["stale_nodes"])

    def test_code_change_invalidates_execution_and_reviews(self):
        result = invalidation_preview(["code"])
        self.assertIn("verify_code", result["stale_nodes"])
        self.assertIn("article_review", result["stale_nodes"])
        self.assertNotIn("title_workshop", result["stale_nodes"],
                         "改代码不重跑标题工坊")
        self.assertEqual(result["reasons"]["verify_code"], ["code"])

    def test_rules_change_targets_reviews_only(self):
        result = invalidation_preview(["rules"])
        self.assertEqual(set(result["stale_nodes"]), {"article_review", "style_review"})

    def test_unknown_change_rejected(self):
        with self.assertRaises(ValueError):
            invalidation_preview(["vibes"])

    def test_batch_plan_priorities_and_dependencies(self):
        plan = batch_plan(
            [{"article_id": f"art-{i}", "revision": f"rev-{i}"} for i in range(5)],
            max_concurrency=2)
        self.assertEqual(len(plan["tasks"]), 5)
        self.assertEqual([t["priority"] for t in plan["tasks"]], [5, 5, 6, 6, 6],
                         "超过并发上限的篇目排后")
        self.assertEqual(plan["tasks"][2]["depends_on"], "art-1", "前篇依赖显式")
        self.assertIsNone(plan["tasks"][0]["depends_on"])
        with self.assertRaises(ValueError):
            batch_plan([{"article_id": "a"}], max_concurrency=99)


class TestReviewCenterAndSummary(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-review-")
        self.service = DesktopService(self.root / "projects", runtime_root=self.root / "runtime")
        engine, _, store = self.service._app(demo=True)
        try:
            job, article = engine.create_job({**demo_spec(), 'demo': True,
                                              'account_id': 'ice-loop',
                                              'article_root': str(self.root / 'articles')})
            for _ in range(8):
                result = engine.run(job)
                if result['state'] == 'completed':
                    break
                approval = store.pending_approval(job)
                if approval is None:
                    continue
                engine.decide(job, approval['approval_id'], 'approve',
                              expect_hash=approval['content_hash'])
            self.job = job
        finally:
            store.close()

    def tearDown(self):
        self.service.close()

    def test_review_center_aggregates_five_sections(self):
        center = self.service.call("review.center", {"job_id": self.job})
        for section in ("content", "facts", "code", "images", "export"):
            self.assertIn(section, center)
        self.assertGreater(center["content"]["characters"], 0)
        self.assertTrue(center["code"]["all_runs_archived"],
                        "demo 任务运行证据齐备")
        self.assertTrue(center["images"]["slots"], "demo 任务有图位")

    def test_review_center_account_scoped(self):
        service2_dir = temp_dir("v2-review-other-")
        other = DesktopService(service2_dir / "projects", runtime_root=service2_dir / "runtime")
        try:
            with self.assertRaises(ValueError):
                other.call("review.center", {"job_id": self.job})
        finally:
            other.close()

    def test_conversation_summary_deterministic_and_updatable(self):
        import time as _time
        account_id = self.service._account()["id"]
        conv = self.service.call("chat.create", {"title": "摘要测试"})
        cid = conv["conversation"]["id"]

        def send_and_wait(text: str) -> None:
            self.service.call("chat.send", {"conversation_id": cid, "text": text,
                                            "mode": "discuss"})
            for _ in range(400):
                rows = self.service.call("chat.get", {"conversation_id": cid})["messages"]
                if rows and all(m["status"] != "streaming" for m in rows):
                    return
                _time.sleep(0.05)
            self.fail("会话消息 20s 未完成")

        send_and_wait("目标读者是谁？")
        summary = self.service.call("chat.summary", {"conversation_id": cid})
        self.assertEqual(summary["digest"]["user_turn_count"], 1)
        self.assertIn("目标读者", summary["digest"]["last_user_intent"])
        self.assertIsNotNone(summary["covers_from"])
        # 更新同一 summary_id，涵盖范围推进
        send_and_wait("再补充一个问题")
        again = self.service.call("chat.summary", {"conversation_id": cid})
        self.assertEqual(again["summary_id"], summary["summary_id"], "摘要更新不重建")
        self.assertEqual(again["digest"]["user_turn_count"], 2)
        # 账号隔离
        service2_dir = temp_dir("v2-summary-other-")
        other = DesktopService(service2_dir / "projects", runtime_root=service2_dir / "runtime")
        try:
            with self.assertRaises(ValueError):
                other.call("chat.summary", {"conversation_id": cid})
        finally:
            other.close()


if __name__ == "__main__":
    unittest.main()
