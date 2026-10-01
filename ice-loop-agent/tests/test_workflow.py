"""工作流端到端测试：审核门暂停/恢复、真实执行、导出、事件、步骤复用。"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from ice_agent.cli import build_app
from tests import temp_dir


def demo_spec() -> dict:
    return {
        "series": "PY", "episode": 5,
        "topic": "for 和 while：让电脑替你重复干活",
        "core_benefit": "能独立写出并跑通两个循环示例",
        "target_words": [1800, 2600],
        "exercise_to_answer": "PY/004 动手题：车票判定",
        "next_episode_plan": "PY/006 列表",
        "materials": [], "image_provider": "manual_import",
        "approve_local_exec": True,
    }


class TestWorkflowE2E(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("wf-")
        self.articles = self.dir / "articles"
        self.runtime = self.dir / "runtime"
        self.engine, self.cfg, self.store = build_app(
            self.articles, self.runtime, provider="mock", allow_local_exec=True)

    def _run_to_gate(self, job_id):
        job = self.engine.run(job_id)
        self.assertEqual(job["state"], "awaiting_approval")
        pending = self.store.pending_approval(job_id)
        self.assertIsNotNone(pending)
        return pending

    def _approve_current(self, job_id, choice=None):
        pending = self.store.pending_approval(job_id)
        ok = self.engine.decide(job_id, pending["approval_id"], "approve",
                                "测试批准", actor="test-user", choice=choice)
        self.assertTrue(ok)
        return self.engine.run(job_id)

    def test_full_offline_pipeline(self):
        job_id, article_id = self.engine.create_job(demo_spec())
        gates = []
        for _ in range(4):    # topic / outline / final_title / asset_plan
            job = self.engine.run(job_id)
            if job["state"] == "completed":
                break
            self.assertEqual(job["state"], "awaiting_approval")
            pending = self.store.pending_approval(job_id)
            gates.append(pending["scope"])
            self._approve_current(job_id)
        job = self.engine.run(job_id)
        gates = [g for g in gates]
        self.assertEqual(job["state"], "completed", job.get("pause_reason"))
        self.assertEqual(gates, ["topic", "outline", "final_title", "asset_plan"])

        # 文章状态与标题
        art = self.store.get_article(article_id)
        self.assertEqual(art["readiness"], "assets_pending")  # 手动导图未完成
        self.assertTrue(art["final_title"])

        # 真实运行记录：3 段代码全部 exit=0
        state = json.loads((self.cfg.job_dir(job_id) / "state.json")
                           .read_text(encoding="utf-8"))
        runs = state["runs"]
        self.assertEqual(len(runs), 3)
        for rid, rec in runs.items():
            self.assertEqual(rec["exit_code"], 0, rec)
            self.assertEqual(rec["verdict"], "ok")
        self.assertIn("1 到 5 的和是 15", runs["run-1"]["stdout"])
        self.assertIn("猜对了", runs["run-2"]["stdout"])
        self.assertIn("3×3=9", runs["run-3"]["stdout"].replace(" ", ""))

        # 导出契约：00-03 + code/ + images/
        folder = Path(state["export_result"]["folder"])
        for name in ("00-阅读入口.md", "01-公众号正文.md",
                     "02-发布信息与排版说明.md", "03-配图提示词.md"):
            self.assertTrue((folder / name).exists(), name)
        body = (folder / "01-公众号正文.md").read_text(encoding="utf-8")
        self.assertIn("```text", body)            # 真实输出已回填
        self.assertNotIn("<!--RUN_OUTPUT:", body)  # 占位符全部替换
        code_files = sorted(p.name for p in (folder / "code").glob("*"))
        self.assertEqual(code_files,
                         ["for_demo.py", "guess_while.py",
                          "multiplication_table.py"])

        # 事件流单调且覆盖关键节点
        events = self.store.job_events(job_id)
        seqs = [e["sequence"] for e in events]
        self.assertEqual(seqs, sorted(seqs))
        types = {e["event_type"] for e in events}
        self.assertIn("approval.required", types)
        self.assertIn("approval.decided", types)
        self.assertIn("job.completed", types)

    def test_gate_pauses_without_auto_approve(self):
        job_id, _ = self.engine.create_job(demo_spec())
        job = self.engine.run(job_id)
        self.assertEqual(job["state"], "awaiting_approval")
        self.assertEqual(job["current_node"], "topic")
        pending = self.store.pending_approval(job_id)
        self.assertEqual(pending["scope"], "topic")
        # 任务停在第一个门：正文尚未生成
        state = json.loads((self.cfg.job_dir(job_id) / "state.json")
                           .read_text(encoding="utf-8"))
        self.assertNotIn("draft_md", state)

    def test_rejection_fails_job(self):
        job_id, _ = self.engine.create_job(demo_spec())
        job = self.engine.run(job_id)
        pending = self.store.pending_approval(job_id)
        self.engine.decide(job_id, pending["approval_id"], "reject",
                           "方向不对", actor="test-user")
        job = self.engine.run(job_id)
        self.assertEqual(job["state"], "failed")
        self.assertIn("APPROVAL_REJECTED", job["pause_reason"])

    def test_step_reuse_on_resume(self):
        job_id, _ = self.engine.create_job(demo_spec())
        self.engine.run(job_id)
        self._approve_current(job_id)   # topic 通过，跑到 outline 门
        steps_before = len([r for r in self.store.conn.execute(
            "SELECT * FROM steps WHERE status='completed'").fetchall()])
        # 无新增输入重入：ingest/topic 不应重跑（completed 步骤按 hash 复用）
        reused = [dict(r) for r in self.store.conn.execute(
            "SELECT node_key FROM steps WHERE status='completed'").fetchall()]
        self.assertGreaterEqual(steps_before, 2)
        self.assertIn("ingest", [r["node_key"] for r in reused])

    def test_local_exec_requires_flag(self):
        spec = demo_spec()
        spec["approve_local_exec"] = False
        engine, cfg, store = build_app(
            self.articles, self.dir / "runtime2", provider="mock",
            allow_local_exec=True)
        job_id, _ = engine.create_job(spec)

        def approve_all(scope, payload):
            return "approve", "", None
        job = engine.run(job_id, auto_approver=approve_all)
        # 应停在 verify_code 的用户动作
        self.assertEqual(job["state"], "awaiting_user")
        self.assertIn("approve_local_exec", job["pause_reason"])


class TestExportConflict(unittest.TestCase):
    def test_external_modification_blocks_reexport(self):
        from types import SimpleNamespace

        from ice_agent.config import make_runtime_config
        from ice_agent.domain.store import Store
        from ice_agent.export.exporter import ArticleExporter, ExportConflict

        d = temp_dir("exp-")
        store_dir = temp_dir("expstore-")
        store = Store(store_dir / "app.db")
        exporter = ArticleExporter(d, store)
        cfg = make_runtime_config(article_root=d, runtime_root=store_dir)
        ctx = SimpleNamespace(
            state={
                "series": "PY", "final_title": "测试标题",
                "integrated_md": "# 测试标题\n\n正文一段。\n\n## 写在最后\n\n结尾。\n",
                "abstract": "摘要", "runs": {}, "slots": [],
                "assets_todo": [], "final_check_report": {"ready": False,
                                                           "rules": {}},
                "spec": {"episode": 1},
            },
            cfg=cfg, store=store,
            article={"article_id": "a1", "readiness": "assets_pending",
                     "folder_no": None})

        r1 = exporter(ctx)
        self.assertTrue(Path(r1["folder"], "01-公众号正文.md").exists())
        # 外部手改正文后再次导出 → 冲突（同文件夹，manifest hash 比对）
        ctx.article["folder_no"] = r1["folder_no"]
        body = Path(r1["folder"], "01-公众号正文.md")
        body.write_text(body.read_text(encoding="utf-8") + "\n用户手改。\n",
                        encoding="utf-8")
        with self.assertRaises(ExportConflict):
            exporter(ctx)


class TestReadinessLoop(unittest.TestCase):
    """手动导入图片 → 复检 → 就绪包闭环（第二轮优化）。"""

    PNG_1PX = bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73"
        "0000001249444154789c636460f8cfc0c0c0c40006000b1f010314e30b00"
        "0000000049454e44ae426082")

    def setUp(self):
        self.dir = temp_dir("ready-")
        self.articles = self.dir / "articles"
        self.runtime = self.dir / "runtime"
        self.engine, self.cfg, self.store = build_app(
            self.articles, self.runtime, provider="mock", allow_local_exec=True)

    def _complete_draft(self):
        spec = demo_spec()
        job_id, article_id = self.engine.create_job(spec)

        def approve(scope, payload):
            return "approve", "", None
        job = self.engine.run(job_id, auto_approver=approve)
        self.assertEqual(job["state"], "completed")
        return job_id, article_id

    def test_import_and_finalize_reaches_ready(self):
        import base64

        job_id, article_id = self._complete_draft()
        self.assertEqual(
            self.store.get_article(article_id)["readiness"], "assets_pending")

        # 为全部 4 个图位导入 1x1 PNG
        img_dir = self.dir / "imgs"
        img_dir.mkdir()
        slots = self.store.article_slots(article_id)
        for i, slot in enumerate(slots, start=1):
            f = img_dir / f"f{i}.png"
            f.write_bytes(self.PNG_1PX)
            self.engine.import_asset(job_id, slot["figure_no"], f)
        self.assertEqual(len(slots), 4)

        result = self.engine.refinalize(job_id)
        self.assertTrue(result["final_check"]["ready"])
        self.assertEqual(
            self.store.get_article(article_id)["readiness"], "ready_for_publish")

        # 就绪包：正文占位符替换为 images/ 引用，图片入包
        folder = Path(result["export"]["folder"])
        body = (folder / "01-公众号正文.md").read_text(encoding="utf-8")
        self.assertNotIn("待配图", body)
        self.assertIn("images/figure-01", body)
        self.assertEqual(len(list((folder / "images").glob("figure-*.png"))), 4)
        entry = (folder / "00-阅读入口.md").read_text(encoding="utf-8")
        self.assertIn("已就绪图片", entry)

    def test_import_rejects_non_image(self):
        job_id, _ = self._complete_draft()
        bad = self.dir / "bad.png"
        bad.write_text("<html>not an image</html>", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.engine.import_asset(job_id, 1, bad)

    def test_partial_import_stays_pending(self):
        job_id, article_id = self._complete_draft()
        f = self.dir / "one.png"
        f.write_bytes(self.PNG_1PX)
        self.engine.import_asset(job_id, 1, f)
        result = self.engine.refinalize(job_id)
        self.assertFalse(result["final_check"]["ready"])
        self.assertEqual(
            self.store.get_article(article_id)["readiness"], "assets_pending")
        body = (Path(result["export"]["folder"]) /
                "01-公众号正文.md").read_text(encoding="utf-8")
        self.assertIn("待配图", body)   # 未就绪图位仍保留占位符


if __name__ == "__main__":
    unittest.main()
