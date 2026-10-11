"""v2.0 M7/M8 核心测试：StylePack、提示词 lint/候选、图位-Run 绑定、下载归档、会话预算。"""
from __future__ import annotations

import unittest
from pathlib import Path

from ice_agent.assets_v2 import (
    bind_download, bind_slot_run, get_style_pack, lint_prompt, list_prompt_revisions,
    save_prompt_revision, save_style_pack, slot_run_binding, stage_download,
    staging_list,
)
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse, RoleRouter

from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def _png(tmp: Path, name: str) -> Path:
    from PIL import Image
    target = tmp / name
    Image.new("RGB", (8, 8), "#2448DB").save(target)
    return target


class TestStylePack(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("v2-style-")
        self.service = DesktopService(self.dir / "projects", runtime_root=self.dir / "runtime")
        _, _, store = self.service._app()
        self.store = store
        self.account_id = self.service._account()["id"]

    def tearDown(self):
        self.store.close()
        self.service.close()

    def test_default_then_versions_and_approval(self):
        first = get_style_pack(self.store, self.account_id)
        self.assertEqual(first["version"], 0)
        self.assertEqual(first["pack"]["colors"]["primary"], "#2448DB")
        saved = save_style_pack(self.store, self.account_id,
                                {"colors": {"primary": "#123456"}})
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["status"], "draft")
        approved = save_style_pack(self.store, self.account_id,
                                   {"colors": {"primary": "#2448DB"}}, approve=True)
        self.assertEqual(approved["status"], "approved")
        current = get_style_pack(self.store, self.account_id)
        self.assertEqual(current["version"], 2)
        self.assertTrue(current["status"] == "approved")
        self.assertEqual(current["pack"]["colors"]["primary"], "#2448DB")


class TestPromptLint(unittest.TestCase):
    def test_seven_element_complete_prompt_passes(self):
        prompt = ("Use case: editorial cover for a beginner programming article. "
                  "Canvas: 3:1 ratio. Colors: signal blue #2448DB, warm white. "
                  "Text in image (exactly): for & while. "
                  "Layout: title left, grid right. Style: flat editorial. "
                  "Forbidden: no 3D, gradients, shadows, product logos.")
        result = lint_prompt(prompt)
        self.assertTrue(result["passed"])
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["score_25"], 25)

    def test_missing_elements_and_residue_detected(self):
        result = lint_prompt("A nice cover picture with blue.")
        self.assertFalse(result["passed"])
        self.assertIn("use_case", result["missing"])
        self.assertIn("forbidden", result["missing"])
        residue = lint_prompt("Cover for episode / 005 with title area. Style: flat. Layout: grid. Use case: cover. Colors: #2448DB. Text in image: X. Forbidden: none.")
        self.assertTrue(any("期号" in w for w in residue["warnings"]), "残留期号要提示")
        screenshot = lint_prompt("Use case: a real terminal screenshot of a console. Canvas: 3:1. Colors: blue. Text: x. Layout: top. Style: flat. Forbidden: none.")
        self.assertTrue(any("实截" in w for w in screenshot["warnings"]),
                         "真实输出被生图替代要提示")

    def setUp(self):
        self.dir = temp_dir("v2-lint-")

    def test_revisions_versioned_and_user_origin_distinct(self):
        service = DesktopService(self.dir / "p2", runtime_root=self.dir / "r2")
        _, _, store = service._app()
        account_id = service._account()["id"]
        try:
            first = save_prompt_revision(store, account_id, "job-x", 1, "Use case: a", origin="agent")
            second = save_prompt_revision(store, account_id, "job-x", 1, "Use case: b", origin="user")
            self.assertEqual(second["version"], 2)
            self.assertEqual(second["origin"], "user")
            rows = list_prompt_revisions(store, account_id, "job-x", 1)
            self.assertEqual(len(rows), 2)
            self.assertIn("lint_json", rows[0])
        finally:
            store.close()
            service.close()


class TestSlotRunBinding(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-bind-")
        self.service = DesktopService(REPO, self.root / "runtime", self.root / "articles")
        engine, _, store = self.service._app(demo=True)
        try:
            job, article = engine.create_job({**demo_spec(),
                                              'demo': True, 'account_id': 'ice-loop',
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
            view = self.service.call("jobs.get", {"job_id": job})
            runs = view["runs"]
            self.run_id, record = next(iter(runs.items()))
            self.source_hash = record["code_sha256"]
        finally:
            store.close()

    def tearDown(self):
        self.service.close()

    def test_binding_with_matching_hash_and_error_needs_approval(self):
        _, _, store = self.service._app(demo=True)
        try:
            result = bind_slot_run(store, "ice-loop", self.job, 2, self.run_id,
                                   self.source_hash[:16])
            self.assertEqual(result["figure_no"], 2)
            stored = slot_run_binding(store, "ice-loop", self.job, 2)
            self.assertEqual(stored["run_id"], self.run_id)
            # 预期错误素材未批准 → 拒绝
            with self.assertRaises(ValueError):
                bind_slot_run(store, "ice-loop", self.job, 3, self.run_id,
                              self.source_hash[:16], expected_result_kind="expected_error")
            approved = bind_slot_run(store, "ice-loop", self.job, 3, self.run_id,
                                     self.source_hash[:16],
                                     expected_result_kind="expected_error", approved_error=True)
            self.assertEqual(approved["expected_result_kind"], "expected_error")
            # hash 不符拒绝
            with self.assertRaises(ValueError):
                bind_slot_run(store, "ice-loop", self.job, 4, self.run_id, "0" * 16)
            # 不存在的 run 拒绝
            with self.assertRaises(ValueError):
                bind_slot_run(store, "ice-loop", self.job, 5, "run-none", self.source_hash[:16])
        finally:
            store.close()


class TestDownloadStaging(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("v2-dl-")
        self.service = DesktopService(self.dir / "projects", runtime_root=self.dir / "runtime")
        _, _, store = self.service._app()
        self.store = store
        self.runtime = self.dir / "runtime"
        self.account_id = self.service._account()["id"]

    def tearDown(self):
        self.store.close()
        self.service.close()

    def test_magic_mismatch_rejected_and_bind_flow(self):
        fake = self.dir / "fake.png"
        fake.write_bytes(b"not-a-png-at-all" + b"\x00" * 16)
        with self.assertRaises(ValueError):
            stage_download(self.store, self.account_id, str(fake))
        good = _png(self.dir, "real.png")
        staged = stage_download(self.store, self.account_id, str(good),
                                origin_url="https://app.tapnow.media/x")
        self.assertFalse(staged["deduped"])
        rows = staging_list(self.store, self.account_id)
        self.assertEqual(rows[0]["status"], "pending", "待归档：不确定图位前不是就绪候选")
        # 同内容再入库去重
        again = stage_download(self.store, self.account_id, str(good))
        self.assertTrue(again["deduped"])
        # 无任务上下文的自由 label 不再被接受（R10：必须绑真实图位）
        with self.assertRaises(ValueError):
            bind_download(self.store, self.runtime, self.account_id,
                          staged["download_id"], "图2")
        # 丢弃后不能绑
        discarded = stage_download(self.store, self.account_id, _png(self.dir, "b.png"))
        bind_download(self.store, self.runtime, self.account_id,
                      discarded["download_id"], None)
        with self.assertRaises(ValueError):
            bind_download(self.store, self.runtime, self.account_id,
                          discarded["download_id"], "图1")


class TestChatBudgetAndAttribution(unittest.TestCase):
    """M8-03/KI-002：会话调用计入 conversation_id 且受预算约束。

    不 patch generate：无 Key 时真实路由逐个 preflight 失败，但每次尝试
    都经 _record 落账（AUTH_FAILED）——正好验证归属与计数走真实代码。
    """

    def test_chat_invocations_attributed_and_budget_blocks(self):
        dir_ = temp_dir("v2-budget-")
        service = DesktopService(REPO, dir_ / "runtime")
        try:
            # 会话预算按"调用条数"计：无 Key 时链上每个 profile 一次尝试各记一条
            # （本路由 qwen+deepseek = 每次发送 2 条）。
            service.settings["max_chat_calls"] = 1
            conv = service.call("chat.create", {"title": "预算"})
            cid = conv["conversation"]["id"]
            service.call("chat.send", {"conversation_id": cid, "text": "一",
                                       "mode": "discuss"})
            for _ in range(400):
                rows = service.call("chat.get", {"conversation_id": cid})["messages"]
                if rows and all(m["status"] != "streaming" for m in rows):
                    break
                time_sleep(0.05)
            _, _, store = service._app()
            try:
                count = store.conversation_invocation_count(cid)
                self.assertGreaterEqual(count, 1, "会话调用应记入 conversation_id")
            finally:
                store.close()
            # 计数已 >= 3 → 下一通发送在入口被预算拦截（消息不落库、不产生新调用）
            with self.assertRaises(ValueError):
                service.call("chat.send", {"conversation_id": cid, "text": "超预算",
                                           "mode": "discuss"})
        finally:
            service.close()


def time_sleep(seconds: float) -> None:
    import time
    time.sleep(seconds)


if __name__ == "__main__":
    unittest.main()
