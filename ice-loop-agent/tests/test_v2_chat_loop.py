"""M5-06 收口：chat.send 回复携带 ActionEnvelope 时自动执行有界工具循环。

模型调用按项目测试约定 patch（RoleRouter.generate，包住发送+等待全程）；
_generate 落库、信封检测、AgentLoop 执行、行动卡读取全部走真实代码。
"""
from __future__ import annotations

import time
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse, RoleRouter

from tests import REPO, temp_dir

ENVELOPE_REPLY = (
    "好的，我来查看任务队列。\n```json\n"
    '{"action": "tool_call", "calls": ['
    '{"name": "list_task_status", "arguments": {}}]}\n```'
)


class TestChatToolLoopIntegration(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-chat-loop-")
        self.service = DesktopService(REPO, self.root)
        self.service.call("bootstrap")

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def _wait_completed(self, cid: str) -> list[dict]:
        for _ in range(400):
            rows = self.service.call("chat.get", {"conversation_id": cid})["messages"]
            if rows and all(m["status"] != "streaming" for m in rows):
                return rows
            time.sleep(0.05)
        self.fail("会话消息 20s 未完成")

    def _send_and_wait(self, text: str) -> tuple[list[dict], str]:
        conv = self.service.call("chat.create", {"title": text[:10]})
        cid = conv["conversation"]["id"]
        # patch 必须包住发送与等待：send 仅入队，worker 异步执行
        with patch.object(RoleRouter, "generate",
                          return_value=LLMResponse(ENVELOPE_REPLY, model_id="test")):
            self.service.call("chat.send", {"conversation_id": cid, "text": text,
                                            "mode": "discuss"})
            rows = self._wait_completed(cid)
        return rows, cid

    def test_envelope_reply_runs_tool_loop_and_action_cards_read_it(self):
        rows, cid = self._send_and_wait("看看任务")
        assistant = [m for m in rows if m["role"] == "assistant"][-1]
        self.assertEqual(assistant["status"], "completed")
        metadata = assistant.get("metadata", {})
        self.assertIn("agent_run_id", metadata, "信封回复应触发工具循环并记录 run")
        # 固定回复每轮重复同一调用 → 循环以重复停止语义收口，不空转烧预算
        self.assertEqual(metadata.get("agent_stop_reason"), "model_repeated_calls")
        cards = self.service.call("agent.tool_calls_list",
                                  {"run_id": metadata["agent_run_id"]})["cards"]
        self.assertEqual([c["tool"] for c in cards], ["list_task_status"])
        self.assertEqual(cards[0]["status"], "succeeded")
        runs = self.service.call("agent.runs_list", {"conversation_id": cid})["runs"]
        self.assertTrue(any(r["run_id"] == metadata["agent_run_id"] for r in runs))

    def test_plain_reply_does_not_create_agent_run(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(RoleRouter, "generate",
                                             return_value=LLMResponse("这里可以讨论观点。", model_id="test")))
            conv = self.service.call("chat.create", {"title": "普通讨论"})
            cid = conv["conversation"]["id"]
            self.service.call("chat.send", {"conversation_id": cid, "text": "随便聊聊",
                                            "mode": "discuss"})
            rows = self._wait_completed(cid)
        assistant = [m for m in rows if m["role"] == "assistant"][-1]
        self.assertEqual(assistant["status"], "completed")
        metadata = assistant.get("metadata", {})
        self.assertNotIn("agent_run_id", metadata)
        self.assertNotIn("agent_run_error", metadata)
        self.assertEqual(self.service.call("agent.runs_list",
                                           {"conversation_id": cid})["runs"], [])

    def test_cancelled_chat_run_has_terminal_state(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(RoleRouter, "generate",
                                             return_value=LLMResponse(ENVELOPE_REPLY, model_id="test")))
            conv = self.service.call("chat.create", {"title": "停止"})
            cid = conv["conversation"]["id"]
            self.service.call("chat.send", {"conversation_id": cid, "text": "看看任务",
                                            "mode": "discuss"})
            self.service.call("chat.stop", {"conversation_id": cid})
            rows = self._wait_completed(cid)
        assistant = [m for m in rows if m["role"] == "assistant"][-1]
        self.assertIn(assistant["status"], ("completed", "stopped"))
        metadata = assistant.get("metadata", {})
        if "agent_run_id" in metadata:
            runs = self.service.call("agent.runs_list", {"conversation_id": cid})["runs"]
            record = next(r for r in runs if r["run_id"] == metadata["agent_run_id"])
            self.assertIn(record["status"], ("completed", "cancelled"),
                         "取消路径的 run 必须有终态")


if __name__ == "__main__":
    unittest.main()
