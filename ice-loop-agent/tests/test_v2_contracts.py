"""v2.0 契约测试（M1-01）：信封兼容、载荷校验、生成漂移阻断。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

from pydantic import ValidationError

from ice_agent.contracts import (
    PROTOCOL_VERSION,
    ChatSendRequest,
    ErrorCode,
    ProtocolEvent,
    RpcRequest,
    RpcResponse,
    ModelDeltaPayload,
    payload_registry,
)

REPO = Path(__file__).resolve().parent.parent


class TestEnvelope(unittest.TestCase):
    def test_v1_request_still_parses(self):
        req = RpcRequest.model_validate({"id": "r1", "method": "chat.send", "params": {}})
        self.assertEqual(req.id, "r1")
        bare = RpcRequest.model_validate({"method": "bootstrap"})
        self.assertIsNone(bare.id)
        self.assertEqual(bare.params, {})

    def test_request_rejects_unknown_fields(self):
        with self.assertRaises(ValidationError):
            RpcRequest.model_validate({"id": "r", "method": "x", "admin": True})

    def test_v2_response_and_event_shapes(self):
        ok = RpcResponse.model_validate({"kind": "response", "id": "r1", "result": {"v": 1}})
        self.assertEqual(ok.kind, "response")
        err = RpcResponse.model_validate({
            "kind": "response", "id": "r1",
            "error": {"code": "BUDGET_EXCEEDED", "message": "预算已用尽",
                      "recoverable": True, "action": "check_budget"}})
        self.assertEqual(err.error.code, ErrorCode.BUDGET_EXCEEDED)
        with self.assertRaises(ValidationError):
            RpcResponse.model_validate({"kind": "event", "id": "x"})
        event = ProtocolEvent.model_validate({
            "kind": "event", "protocol_version": 2, "event_id": "e1",
            "stream_id": "conv-1", "account_id": "ice-loop", "sequence": 18,
            "type": "model.delta",
            "payload": {"turn_id": "t1", "attempt_id": "a1", "text": "增"}})
        self.assertEqual(event.protocol_version, PROTOCOL_VERSION)
        with self.assertRaises(ValidationError):
            ProtocolEvent.model_validate({**event.model_dump(), "sequence": 0})
        with self.assertRaises(ValidationError):
            ProtocolEvent.model_validate({**event.model_dump(), "protocol_version": 1})


class TestChatSendContract(unittest.TestCase):
    def test_valid_minimal(self):
        req = ChatSendRequest.model_validate({"conversation_id": "conv-1"})
        self.assertEqual(req.mode.value, "discuss")
        self.assertEqual(req.references, [])

    def test_bounds_match_backend(self):
        with self.assertRaises(ValidationError):
            ChatSendRequest.model_validate({"conversation_id": "c", "text": "x" * 12001})
        with self.assertRaises(ValidationError):
            ChatSendRequest.model_validate(
                {"conversation_id": "c", "references": [f"r{i}" for i in range(9)]})
        with self.assertRaises(ValidationError):
            ChatSendRequest.model_validate({"conversation_id": "c", "mode": "auto"})
        with self.assertRaises(ValidationError):
            ChatSendRequest.model_validate({"conversation_id": "", })

    def test_delta_payload(self):
        delta = ModelDeltaPayload.model_validate(
            {"turn_id": "t1", "attempt_id": "a1", "text": "你好"})
        self.assertEqual(delta.text, "你好")
        with self.assertRaises(ValidationError):
            ModelDeltaPayload.model_validate({"turn_id": "", "attempt_id": "a", "text": ""})


class TestContractDrift(unittest.TestCase):
    """再生的 JSON Schema 必须与 desktop/ui/contracts/ 已提交内容一致。"""

    def test_exported_schemas_match_registry(self):
        out_dir = REPO / "desktop" / "ui" / "contracts"
        self.assertTrue(out_dir.exists(), "缺少 desktop/ui/contracts/，请运行 build/export_contracts.py")
        import json
        for name, model in payload_registry().items():
            target = out_dir / f"{name}.schema.json"
            self.assertTrue(target.exists(), f"{target.name} 未提交，请运行 build/export_contracts.py")
            schema = model.model_json_schema(ref_template="#/$defs/{model}", mode="validation")
            schema = {"$id": name, "$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
            committed = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(committed, schema, f"{target.name} 与当前模型不一致（合同漂移），请重新导出")
        # 注册表里没有多余文件
        expected = {f"{name}.schema.json" for name in payload_registry()}
        actual = {p.name for p in out_dir.glob("*.schema.json")}
        self.assertEqual(actual, expected, "contracts 目录存在未登记或过期的 schema 文件")


if __name__ == "__main__":
    unittest.main()
