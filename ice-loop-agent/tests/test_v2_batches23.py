"""批次二/三/四回归：多轮工具反馈、引用ContextPack、幂等域、空稿插入、staging flush。"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.llm.router import LLMResponse, RoleRouter
from ice_agent.tasks import TaskQueue

from tests import REPO, temp_dir


def _png_bytes() -> bytes:
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "#2448DB").save(buffer, format="PNG")
    return buffer.getvalue()


def _wait(service, cid: str) -> list[dict]:
    import time
    for _ in range(400):
        rows = service.call("chat.get", {"conversation_id": cid})["messages"]
        if rows and all(m["status"] != "streaming" for m in rows):
            return rows
        time.sleep(0.05)
    raise AssertionError("会话 20s 未完成")


class TestMultiTurnAgentFeedback(unittest.TestCase):
    """R09：第二轮请求必须包含第一轮真实工具结果，而非重复同一 envelope。"""

    def setUp(self):
        self.dir = temp_dir("v2-b3-agent-")
        self.service = DesktopService(REPO, self.dir / "runtime")

    def tearDown(self):
        self.service.close()

    def test_second_round_receives_tool_results(self):
        conv = self.service.call("chat.create", {"title": "多轮"})
        cid = conv["conversation"]["id"]
        calls: list[str] = []

        def scripted_generate(self, req, *, job_id=None, conversation_id=None, max_attempts=3):
            calls.append(req.prompt)
            if len(calls) == 1:
                envelope = ('```json\n{"action": "tool_call", "calls": ['
                            '{"name": "search_articles", '
                            '"arguments": {"query": "唯一检索标记XYZ"}}]}\n```')
            else:
                # 第二轮基于真实结果回复；断言请求确实携带了工具执行结果
                assert '"search_articles"' in req.prompt and "succeeded" in req.prompt, \
                    "第二轮请求必须包含序列化后的工具结果"
                envelope = "根据检索结果完成，不再需要工具。"
            return LLMResponse(envelope, model_id="scripted")

        with patch.object(RoleRouter, "generate", scripted_generate):
            self.service.call("chat.send", {"conversation_id": cid,
                                            "text": "查一下资料", "mode": "discuss"})
            rows = _wait(self.service, cid)
        assistant = [m for m in rows if m["role"] == "assistant"][-1]
        self.assertEqual(assistant["status"], "completed")
        self.assertEqual(assistant["content"], "根据检索结果完成，不再需要工具。",
                         "用户必须收到最后一轮的答复，不能仍显示第一轮工具信封")
        metadata = assistant.get("metadata", {})
        self.assertEqual(metadata.get("agent_stop_reason"), "model_done",
                         "真实反馈后模型自然停止，而非 model_repeated_calls")
        self.assertGreaterEqual(len(calls), 2, "第二轮必须真实调用模型")
        cards = self.service.call("agent.tool_calls_list",
                                  {"run_id": metadata["agent_run_id"]})["cards"]
        self.assertEqual(cards[0]["tool"], "search_articles")
        self.assertEqual(cards[0]["status"], "succeeded")


class TestCitationsInChat(unittest.TestCase):
    """R11：手选引文按 hash 重读，进入真实请求上下文并记 manifest。"""

    def setUp(self):
        self.dir = temp_dir("v2-b3-cite-")
        self.service = DesktopService(REPO, self.dir / "runtime")
        _, _, store = self.service._app()
        from ice_agent.knowledge import import_source
        sample = self.dir / "cite.md"
        sample.write_text("# 唯一事实标记QW7\n\nIce Loop 的服务号每期限定一篇。\n", encoding="utf-8")
        self.source = import_source(store, self.service._account()["id"], sample)
        store.close()

    def tearDown(self):
        self.service.close()

    def test_citation_hash_verified_and_pack_in_context(self):
        _, _, store = self.service._app()
        try:
            rows = store.conn.execute(
                "SELECT chunk_id, chunk_hash FROM knowledge_chunks WHERE source_id=?",
                (self.source["source_id"],)).fetchall()
        finally:
            store.close()
        chunk_id, chunk_hash = rows[0]["chunk_id"], rows[0]["chunk_hash"]
        conv = self.service.call("chat.create", {"title": "引用"})
        cid = conv["conversation"]["id"]
        seen_contexts: list[dict] = []

        def scripted_generate(self, req, *, job_id=None, conversation_id=None, max_attempts=3):
            seen_contexts.append(req.context)
            return LLMResponse("收到，已结合引文讨论。", model_id="scripted")

        with patch.object(RoleRouter, "generate", scripted_generate):
            self.service.call("chat.send", {
                "conversation_id": cid, "text": "结合资料讨论",
                "mode": "discuss",
                "citations": [{"chunk_id": chunk_id, "hash": chunk_hash}]})
            _wait(self.service, cid)
        self.assertTrue(seen_contexts)
        pack = seen_contexts[0].get("context_pack", "")
        self.assertIn("唯一事实标记QW7", pack, "ContextPack 必须进入真实请求")
        # hash 不符 → 拒绝（来源已更新）
        with self.assertRaises(ValueError):
            self.service.call("chat.send", {
                "conversation_id": cid, "text": "过期引用", "mode": "discuss",
                "citations": [{"chunk_id": chunk_id, "hash": "0" * 64}]})

    def test_citation_cross_account_rejected(self):
        other_dir = temp_dir("v2-b3-cite-other-")
        other = DesktopService(other_dir / "projects", runtime_root=other_dir / "runtime")
        try:
            conv = other.call("chat.create", {"title": "越权"})
            cid = conv["conversation"]["id"]
            _, _, store = self.service._app()
            try:
                rows = store.conn.execute(
                    "SELECT chunk_id, chunk_hash FROM knowledge_chunks LIMIT 1").fetchall()
            finally:
                store.close()
            with self.assertRaises(ValueError):
                other.call("chat.send", {
                    "conversation_id": cid, "text": "x", "mode": "discuss",
                    "citations": [{"chunk_id": rows[0]["chunk_id"],
                                   "hash": rows[0]["chunk_hash"]}]})
        finally:
            other.close()


class TestIdempotencyDomain(unittest.TestCase):
    """R07：幂等域 (account,kind,key)，同 key 异输入冲突，跨账号独立。"""

    def setUp(self):
        self.dir = temp_dir("v2-b4-idem-")
        self.service = DesktopService(self.dir / "projects", runtime_root=self.dir / "runtime")
        _, _, store = self.service._app()
        self.store = store

    def tearDown(self):
        self.store.close()
        self.service.close()

    def test_same_key_different_payload_conflicts(self):
        queue = TaskQueue(self.store)
        first = queue.enqueue("acct-a", "export", {"rev": "r1"}, idempotency_key="k1")
        with self.assertRaises(ValueError):
            queue.enqueue("acct-a", "export", {"rev": "r2"}, idempotency_key="k1")
        again = queue.enqueue("acct-a", "export", {"rev": "r1"}, idempotency_key="k1")
        self.assertEqual(first["task_id"], again["task_id"])

    def test_same_key_across_accounts_independent(self):
        queue = TaskQueue(self.store)
        a = queue.enqueue("acct-a", "export", {"rev": "r1"}, idempotency_key="shared")
        b = queue.enqueue("acct-b", "export", {"rev": "r1"}, idempotency_key="shared")
        self.assertNotEqual(a["task_id"], b["task_id"], "跨账号同 key 不得复用")

    def test_stable_hash_uses_canonical_json(self):
        queue = TaskQueue(self.store)
        t1 = queue.enqueue("a", "k", {"b": 1, "a": 2})
        t2 = queue.enqueue("a", "k", {"a": 2, "b": 1})
        row1 = self.store.conn.execute(
            "SELECT input_hash FROM tasks WHERE task_id=?", (t1["task_id"],)).fetchone()[0]
        row2 = self.store.conn.execute(
            "SELECT input_hash FROM tasks WHERE task_id=?", (t2["task_id"],)).fetchone()[0]
        self.assertEqual(row1, row2, "键序不同的同内容 payload 必须得到稳定 SHA256")
        self.assertNotIn(" ", row1)  # SHA256 hex，不含 Python hash() 负号


if __name__ == "__main__":
    unittest.main()
