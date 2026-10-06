"""v2.0 协议通道测试（M1-02）：帧协议、v1 兼容、非法行容错、错误码映射。"""
from __future__ import annotations

import json
import threading
import unittest

from ice_agent.contracts import ErrorCode
from ice_agent.rpc_channel import (
    RpcChannel,
    error_code_for,
    frame_event,
    frame_response,
)


class _Collect:
    def __init__(self):
        self.lines: list[bytes] = []
        self.lock = threading.Lock()

    def __call__(self, payload: bytes) -> None:
        with self.lock:
            self.lines.append(payload)

    def parsed(self):
        return [json.loads(line) for line in self.lines]


class TestRpcChannel(unittest.TestCase):
    def setUp(self):
        self.out = _Collect()

    def _channel(self, dispatch):
        return RpcChannel(dispatch, write=self.out.write if hasattr(self.out, "write") else self.out)

    def test_valid_request_frames_response_with_kind(self):
        channel = self._channel(lambda m, p: {"sum": p["a"] + p["b"]})
        channel.handle_raw(json.dumps({"id": "r1", "method": "math.add",
                                       "params": {"a": 1, "b": 2}}).encode())
        (response,) = self.out.parsed()
        self.assertEqual(response["kind"], "response")
        self.assertEqual(response["id"], "r1")
        self.assertEqual(response["result"], {"sum": 3})
        # 旧客户端兼容：id/result 顶层字段保持 v1 形状。
        self.assertIn("id", response)
        self.assertIn("result", response)

    def test_invalid_json_line_gets_validation_error_and_channel_survives(self):
        channel = self._channel(lambda m, p: "ok")
        for bad in [b"{partial", b"[1,2,3]", b'"a string"']:
            channel.handle_raw(bad)
        results = self.out.parsed()
        self.assertEqual(len(results), 3)
        for response in results:
            self.assertEqual(response["error"]["code"], "VALIDATION_ERROR")
            self.assertIsNone(response["id"])
        # 通道未中断：后续合法请求仍正常
        channel.handle_raw(json.dumps({"id": "ok-1", "method": "x"}).encode())
        last = self.out.parsed()[-1]
        self.assertEqual(last["result"], "ok")

    def test_missing_method_rejected(self):
        channel = self._channel(lambda m, p: "ok")
        channel.handle_raw(json.dumps({"id": "r9", "params": {}}).encode())
        (response,) = self.out.parsed()
        self.assertEqual(response["error"]["code"], "VALIDATION_ERROR")

    def test_dispatch_error_maps_to_stable_code(self):
        def dispatch(method, params):
            raise ValueError("公众号已切换，请刷新任务列表")
        channel = self._channel(dispatch)
        channel.handle_raw(json.dumps({"id": "r2", "method": "chat.send"}).encode())
        (response,) = self.out.parsed()
        self.assertEqual(response["error"]["code"], "VALIDATION_ERROR")
        self.assertEqual(response["error"]["message"], "公众号已切换，请刷新任务列表")
        self.assertNotIn("params", response["error"], "错误响应不得回显参数")

    def test_legacy_model_error_code_mapping(self):
        class FakeBudgetError(Exception):
            code = "MODEL_BUDGET_EXCEEDED"
        self.assertEqual(error_code_for(FakeBudgetError("x")), ErrorCode.BUDGET_EXCEEDED)
        self.assertEqual(error_code_for(ValueError("x")), ErrorCode.VALIDATION_ERROR)
        self.assertEqual(error_code_for(PermissionError("x")), ErrorCode.PERMISSION_DENIED)
        self.assertEqual(error_code_for(ConnectionError("x")), ErrorCode.NETWORK)

    def test_event_framing_has_version(self):
        payload = json.loads(frame_event({
            "event_id": "e1", "stream_id": "s1", "account_id": "a1",
            "sequence": 1, "type": "model.delta", "payload": {}}))
        self.assertEqual(payload["kind"], "event")
        self.assertEqual(payload["protocol_version"], 2)

    def test_concurrent_writes_produce_whole_lines(self):
        out = _Collect()
        channel = RpcChannel(lambda m, p: "ok", write=out)
        threads = [threading.Thread(target=channel.emit_event, args=(
            {"event_id": f"e{i}", "stream_id": "s", "account_id": "a",
             "sequence": i + 1, "type": "x", "payload": {}},)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(out.lines), 50)
        for line in out.lines:
            self.assertTrue(line.endswith(b"\n"))
            json.loads(line)  # 每行都是完整 JSON（无交叉写入）


if __name__ == "__main__":
    unittest.main()
