"""模型适配层测试：思考参数翻译、required_off 硬约束、回退、结构化校验。"""
from __future__ import annotations

import os
import unittest

from ice_agent.domain.store import Store
from ice_agent.domain.types import ModelProfile
from ice_agent.llm.adapters import make_adapter
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.errors import CapabilityMismatch, ModelError
from ice_agent.llm.router import LLMRequest, RoleRouter, RouteConfig, \
    validate_simple_schema
from ice_agent.llm.transport import ChatResult, OpenAIChatTransport
from tests import temp_dir

os.environ.setdefault("ICE_TEST_KEY", "test-key")   # 假凭据，只喂给 FakeTransport


class FakeTransport(OpenAIChatTransport):
    """可编程假传输：记录请求，按脚本返回或抛错。"""

    def __init__(self, script=None):
        super().__init__()
        self.calls: list[dict] = []
        self.script = script or []

    def chat(self, base_url, api_key, model, messages, *, stream=False,
             extra_body=None, timeout=120, on_delta=None):
        self.calls.append({
            "base_url": base_url, "model": model, "messages": messages,
            "extra_body": extra_body or {}, "stream": stream, "timeout": timeout})
        action = self.script.pop(0) if self.script else {"ok": "pong"}
        if isinstance(action, Exception):
            raise action
        if callable(action):
            return action(self.calls[-1])
        return ChatResult(content=action.get("ok", "pong"),
                          finish_reason=action.get("finish_reason", "stop"),
                          usage=action.get("usage", {}),
                          raw_model=action.get("raw_model", model))


def make_profile(adapter_id: str, profile_id: str | None = None,
                 **over) -> ModelProfile:
    pid = profile_id or f"{adapter_id}-t"
    p = preset_profile(adapter_id, profile_id=pid)
    p.update(over)
    p["api_key_env"] = over.get("api_key_env", "ICE_TEST_KEY")
    return ModelProfile(
        profile_id=p["profile_id"], adapter=p["adapter"], service=p["service"],
        protocol=p["protocol"], base_url=p["base_url"], model_id=p["model_id"],
        api_key_env=p["api_key_env"], status=p["status"],
        capabilities=p["capabilities"])


class TestThinkingTranslation(unittest.TestCase):
    def test_qwen_enable_thinking_false(self):
        t = FakeTransport()
        ad = make_adapter(make_profile("qwen"), t)
        ad.chat([{"role": "user", "content": "hi"}],
                thinking_policy="required_off")
        self.assertIs(t.calls[-1]["extra_body"].get("enable_thinking"), False)

    def test_deepseek_thinking_disabled(self):
        t = FakeTransport()
        ad = make_adapter(make_profile("deepseek"), t)
        ad.chat([{"role": "user", "content": "hi"}],
                thinking_policy="required_off")
        self.assertEqual(
            t.calls[-1]["extra_body"].get("thinking"), {"type": "disabled"})

    def test_glm_required_off_mismatch(self):
        ad = make_adapter(make_profile("bigmodel"), FakeTransport())
        with self.assertRaises(CapabilityMismatch):
            ad.chat([{"role": "user", "content": "hi"}],
                    thinking_policy="required_off")

    def test_glm_prefer_off_proceeds_with_note(self):
        t = FakeTransport()
        ad = make_adapter(make_profile("bigmodel"), t)
        result = ad.chat([{"role": "user", "content": "hi"}],
                         thinking_policy="prefer_off")
        self.assertEqual(result.content, "pong")
        self.assertTrue(any("不可关闭" in n for n in result.notes))

    def test_json_object_requested_when_documented(self):
        t = FakeTransport()
        ad = make_adapter(make_profile("qwen"), t)
        ad.chat([{"role": "user", "content": "hi"}],
                thinking_policy="provider_default", want_json=True)
        self.assertEqual(t.calls[-1]["extra_body"].get("response_format"),
                         {"type": "json_object"})


class TestRouter(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir("router-")
        self.store = Store(self.dir / "app.db")

    def tearDown(self):
        self.store.close()

    def test_required_off_skips_always_on_fallback(self):
        """主模型 always-on，required_off 回退过滤后落到 Qwen（§9.9）。"""
        t = FakeTransport()
        glm = make_profile("bigmodel", profile_id="glm-1")
        qwen = make_profile("qwen", profile_id="qwen-1")
        router = RoleRouter(
            {"glm-1": glm, "qwen-1": qwen},
            {"writer": RouteConfig("glm-1", ["qwen-1"], "required_off")},
            store=self.store, transport=t)
        resp = router.generate(LLMRequest(role="writer", node="draft", prompt="p"))
        self.assertEqual(resp.profile_id, "qwen-1")
        self.assertTrue(resp.fell_back)
        # 调用记录：glm 记 capability_mismatch，qwen 记 ok
        rows = [dict(r) for r in self.store.conn.execute(
            "SELECT * FROM model_invocations ORDER BY rowid").fetchall()]
        self.assertEqual(rows[0]["status"], "MODEL_CAPABILITY_MISMATCH")
        self.assertEqual(rows[-1]["status"], "ok")

    def test_required_off_no_qualified_raises(self):
        glm = make_profile("bigmodel", profile_id="glm-only")
        kimi = make_profile("kimi", profile_id="kimi-1")  # thinking unknown
        router = RoleRouter(
            {"glm-only": glm, "kimi-1": kimi},
            {"writer": RouteConfig("glm-only", ["kimi-1"], "required_off")},
            store=self.store, transport=FakeTransport())
        with self.assertRaises(ModelError) as ctx:
            router.generate(LLMRequest(role="writer", node="draft", prompt="p"))
        self.assertIn("MODEL_CAPABILITY_MISMATCH", str(ctx.exception))

    def test_fallback_on_server_error(self):
        # 主模型连续 3 次 5xx（重试上限内）后回退到备用（§9.14）
        t = FakeTransport(script=[ServerErrorFactory(), ServerErrorFactory(),
                                  ServerErrorFactory(), {"ok": "from-backup"}])
        p1 = make_profile("qwen", profile_id="p1")
        p2 = make_profile("deepseek", profile_id="p2")
        router = RoleRouter(
            {"p1": p1, "p2": p2},
            {"writer": RouteConfig("p1", ["p2"], "prefer_off")},
            store=self.store, transport=t)
        resp = router.generate(LLMRequest(role="writer", node="draft", prompt="p"))
        self.assertEqual(resp.text, "from-backup")
        self.assertTrue(resp.fell_back)
        self.assertEqual(t.calls[0]["base_url"], p1.base_url)
        self.assertEqual(t.calls[-1]["base_url"], p2.base_url)

    def test_usage_unknown_recorded(self):
        t = FakeTransport(script=[{"ok": "x", "usage": {}}])
        p = make_profile("qwen", profile_id="p")
        router = RoleRouter({"p": p}, {"writer": RouteConfig("p")},
                            store=self.store, transport=t)
        router.generate(LLMRequest(role="writer", node="draft", prompt="p"))
        rows = [dict(r) for r in self.store.conn.execute(
            "SELECT usage_json FROM model_invocations").fetchall()]
        self.assertIn("usage_unknown", rows[0]["usage_json"])

    def test_structured_repair_once(self):
        p = make_profile("qwen", profile_id="p")
        good = '{"candidates": [{"title": "t", "mechanism": "m", "total": 20}], "recommended": 0, "recommend_reason": "r"}'
        t = FakeTransport(script=[
            {"ok": "前言 ```json\n{broken json\n`` 后记"},
            {"ok": good},
        ])
        router = RoleRouter({"p": p}, {"title_editor": RouteConfig("p")},
                            store=self.store, transport=t)
        resp = router.generate(LLMRequest(
            role="title_editor", node="title_workshop", prompt="p",
            schema={"type": "object", "fields": {
                "candidates": {"type": "list", "item": {"type": "object",
                                                        "fields": {}}},
                "recommended": {"type": "int"},
                "recommend_reason": {"type": "str"}}}))
        self.assertEqual(resp.json["candidates"][0]["title"], "t")
        self.assertEqual(len(t.calls), 2)   # 一次原始 + 一次修复

    def test_structured_invalid_raises(self):
        p = make_profile("qwen", profile_id="p")
        t = FakeTransport(script=[
            {"ok": '{"recommended": "not-int"}'},
            {"ok": '{"recommended": "still-not-int"}'},
        ])
        router = RoleRouter({"p": p}, {"title_editor": RouteConfig("p")},
                            store=self.store, transport=t)
        with self.assertRaises(ModelError):
            router.generate(LLMRequest(
                role="title_editor", node="title_workshop", prompt="p",
                schema={"type": "object", "fields": {
                    "recommended": {"type": "int"}}}))

    def test_mock_adapter_offline(self):
        p = make_profile("mock", profile_id="m")
        router = RoleRouter(
            {"m": p},
            {"planner": RouteConfig("m"), "writer": RouteConfig("m")},
            store=self.store)
        resp = router.generate(LLMRequest(
            role="planner", node="topic", prompt="p",
            context={"series": "PY", "episode": 5,
                     "topic": "for 和 while：让电脑替你重复干活"},
            schema={"type": "object", "fields": {
                "directions": {"type": "list",
                               "item": {"type": "object", "fields": {}}},
                "working_title": {"type": "str"}}}))
        self.assertEqual(resp.json["working_title"],
                         "for 和 while：让电脑替你重复干活")


class TestSchemaValidator(unittest.TestCase):
    def test_types_and_required(self):
        schema = {"type": "object", "fields": {
            "a": {"type": "str", "required": True},
            "b": {"type": "list", "item": "int"},
            "c": {"type": "enum", "values": ["x", "y"]}}}
        self.assertEqual(validate_simple_schema(
            {"a": "s", "b": [1, 2], "c": "x"}, schema), [])
        errs = validate_simple_schema({"b": ["s"], "c": "z"}, schema)
        self.assertEqual(len(errs), 3)   # a 缺失 + b 类型 + c 枚举


def ServerErrorFactory():
    from ice_agent.llm.errors import ServerError
    return ServerError("boom", status=500)


if __name__ == "__main__":
    unittest.main()
