"""v2.0 M8-02/05/06/07/08 + M9-01/02/03 测试：SSE fixtures、ops、导出 bundle。"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from ice_agent.export.bundle import export_bundle, plain_text_from_markdown
from ice_agent.llm.transport import _read_sse
from ice_agent.llm.errors import IncompleteResponseError, ServerError

from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def _sse_lines(*events: str) -> list[str]:
    return [f"data: {event}" for event in events] + ["data: [DONE]"]


_STOP = {"choices": [{"delta": {}, "finish_reason": "stop"}]}


class TestSseFixtures(unittest.TestCase):
    """M8-02：脱敏 fixture 逐类通过（不触网）。"""

    def test_split_multibyte_across_chunks(self):
        lines = _sse_lines(
            json.dumps({"choices": [{"delta": {"content": "你"}}]}, ensure_ascii=False),
            json.dumps({"choices": [{"delta": {"content": "好"}}]}, ensure_ascii=False),
            json.dumps(_STOP))
        result = _read_sse(lines)
        self.assertEqual(result.content, "你好")
        self.assertEqual(result.finish_reason, "stop")

    def test_usage_arrives_late_before_done(self):
        lines = _sse_lines(
            json.dumps({"choices": [{"delta": {"content": "x"}}]}),
            json.dumps({"usage": {"prompt_tokens": 3, "completion_tokens": 1},
                        "choices": []}),
            json.dumps(_STOP))
        result = _read_sse(lines)
        self.assertEqual(result.usage["prompt_tokens"], 3)

    def test_finish_length_raises_incomplete(self):
        lines = _sse_lines(
            json.dumps({"choices": [{"delta": {"content": "截断"}, "finish_reason": "length"}]}))
        with self.assertRaises(IncompleteResponseError):
            _read_sse(lines)

    def test_error_event_raises_server_error(self):
        lines = _sse_lines(json.dumps({"error": {"message": "rate limited"}}))
        with self.assertRaises(ServerError):
            _read_sse(lines)

    def test_broken_json_line_raises_incomplete(self):
        lines = ["data: {broken", "data: [DONE]"]
        with self.assertRaises(IncompleteResponseError):
            _read_sse(lines)

    def test_bytes_lines_decoded(self):
        payload = b"data: " + json.dumps({"choices": [{"delta": {"content": "字节"}}]}).encode("utf-8")
        stop = b"data: " + json.dumps(_STOP).encode("utf-8")
        result = _read_sse([payload, stop, b"data: [DONE]"])
        self.assertEqual(result.content, "字节")


class TestOpsEndpoints(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("v2-ops-")
        self.service = DesktopService(self.dir / "projects", runtime_root=self.dir / "runtime")
        _, _, store = self.service._app()
        self.store = store
        (self.dir / "runtime" / "staging" / "ice-junk").mkdir(parents=True, exist_ok=True)
        (self.dir / "runtime" / "staging" / "unknown-dir").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.store.close()
        self.service.close()

    def test_health_snapshot_sections(self):
        health = self.service.call("tools.health", {})
        for key in ("app_version", "schema_version", "tasks", "recent_model_errors",
                    "invocations", "disk", "fts5"):
            self.assertIn(key, health)
        self.assertEqual(health["invocations"]["conversation_scoped"] >= 0, True)
        self.assertIn("evidence_bytes", health["disk"])
        self.assertEqual(health["disk"]["note"], "逻辑字节估算；证据与正式资源不自动清理，缓存可设配额")

    def test_staging_report_lists_but_never_deletes(self):
        report = self.service.call("tools.staging_report", {})
        names = {c["name"] for c in report["candidates"]}
        self.assertIn("ice-junk", names)
        unknown = next(c for c in report["candidates"] if c["name"] == "unknown-dir")
        self.assertFalse(unknown["safe_to_consider"], "无法识别命名的目录标记为不安全")
        # 只列不删
        self.assertTrue((self.dir / "runtime" / "staging" / "ice-junk").exists())

    def test_capacity_classifies(self):
        capacity = self.service.call("tools.capacity", {})
        self.assertIn("database_bytes", capacity)
        self.assertGreater(capacity["database_bytes"], 0)


class TestOfflineEval(unittest.TestCase):
    def test_eval_suite_passes_with_json_and_exit(self):
        import subprocess
        import sys
        out_path = self.dir / "eval-result.json"
        proc = subprocess.run(
            [sys.executable, "-X", "utf8", "-B", "-m", "ice_agent.eval",
             "--json", str(out_path)],
            capture_output=True, text=True, cwd=str(REPO), timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stdout[-800:])
        report = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(report["failed"], 0)
        self.assertGreaterEqual(report["total"], 6)

    def setUp(self):
        self.dir = temp_dir("v2-eval-")


class TestExportBundle(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-export-")
        self.service = DesktopService(REPO, self.root / "runtime", self.root / "articles")
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

    def _export(self, mode: str, destination: Path) -> dict:
        return self.service.call("articles.export_bundle", {
            "job_id": self.job, "destination": str(destination), "mode": mode})

    def test_bundle_two_dirs_manifest_and_plain_text(self):
        from ice_agent.domain.types import sha256_text
        view = self.service.call("jobs.get", {"job_id": self.job})
        body = view["body"]
        target = self.root / "005-示例文章"
        result = self._export("draft", target)
        self.assertTrue((target / "文本" / "01-公众号正文.md").is_file())
        self.assertTrue((target / "文本" / "02-公众号正文.txt").is_file())
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["format"], "ice-export-v2")
        self.assertEqual(manifest["body_sha256"], sha256_text(body))
        # manifest 与实际文件一致（manifest.json 自身不进自校验）
        from ice_agent.export.bundle import _tree_hashes
        non_self = {k: v for k, v in _tree_hashes(target).items() if k != "manifest.json"}
        self.assertEqual(manifest["files"], non_self)
        # TXT 保留代码内容（不用正则删语法）
        txt = (target / "文本" / "02-公众号正文.txt").read_text(encoding="utf-8")
        md_code_lines = [line for line in body.splitlines()
                         if line.strip().startswith(("print", "def ", "import "))]
        for line in md_code_lines[:2]:
            self.assertIn(line, txt, f"代码行应保留在 TXT：{line}")
        # 账号隔离
        other_dir = temp_dir("v2-export-other-")
        other = DesktopService(other_dir / "projects", runtime_root=other_dir / "runtime")
        try:
            with self.assertRaises(ValueError):
                other.call("articles.export_bundle", {
                    "job_id": self.job, "destination": str(other_dir / "x"), "mode": "draft"})
        finally:
            other.close()

    def test_existing_destination_rejected_and_ready_blocks(self):
        target = self.root / "005-占位"
        self._export("draft", target)
        with self.assertRaises(ValueError):
            self._export("draft", target), "已存在目录不得无声覆盖"
        ready_target = self.root / "005-ready"
        view = self.service.call("jobs.get", {"job_id": self.job})
        has_pending = view["body"].count("待配图：") > 0
        if has_pending:
            with self.assertRaises(ValueError):
                self._export("ready", ready_target)

    def test_plain_text_helpers(self):
        txt = plain_text_from_markdown("# 标题\n\n正文一段。\n\n```python\nprint(1)\n```\n\n"
                                       "![图2：说明](待配图：图示｜方式)\n")
        self.assertIn("标题", txt)
        self.assertIn("print(1)", txt, "代码原样保留")
        self.assertIn("[图2：说明", txt, "图位转说明行")


if __name__ == "__main__":
    unittest.main()
