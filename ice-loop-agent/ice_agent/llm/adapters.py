"""供应商适配器（§9.9：BaseModelAdapter → 思考参数翻译 → 统一请求）。

thinking_policy ∈ {prefer_off, prefer_on, required_off, required_on, provider_default}：
- required_off / required_on 是硬约束，能力不满足直接 MODEL_CAPABILITY_MISMATCH，
  回退候选同样过滤，禁止悄悄降级为 prefer_off（§9.9）；
- prefer_off 在 always_on 模型上按供应商默认执行并附说明，不伪装成已关闭。
"""
from __future__ import annotations

import json
import re
from typing import Any

from ..domain.types import ModelProfile
from .capabilities import PROVIDER_PRESETS
from .errors import CapabilityMismatch, ModelError, SchemaInvalidError
from .transport import ChatResult, OpenAIChatTransport

POLICIES = ("prefer_off", "prefer_on", "required_off", "required_on", "provider_default")


class BaseModelAdapter:
    adapter_id = "base"
    def default_extra_body(self):return {}

    def __init__(self, profile: ModelProfile, transport: OpenAIChatTransport | None = None):
        self.profile = profile
        self.transport = transport or OpenAIChatTransport()

    # ---------------------------------------------------------- 能力
    def capabilities(self) -> dict[str, str]:
        caps = dict(self.profile.capabilities)
        preset = PROVIDER_PRESETS.get(self.adapter_id, {})
        defaults = preset.get("capabilities")
        if defaults:
            for key, val in defaults.to_dict().items():
                caps.setdefault(key, val)
        return caps

    def thinking_capability(self) -> str:
        return self.capabilities().get("thinking", "unknown")

    # ------------------------------------------------------ 思考翻译
    def preflight(self, thinking_policy: str) -> list[str]:
        """硬约束检查；返回需要向用户说明的 notes。"""
        if thinking_policy not in POLICIES:
            raise ModelError("PARAM_UNSUPPORTED", f"未知 thinking_policy：{thinking_policy}")
        cap = self.thinking_capability()
        notes: list[str] = []
        if thinking_policy == "required_off" and cap != "can_disable":
            raise CapabilityMismatch(
                f"{self.profile.model_id}（{self.adapter_id}）思考能力为 {cap}，"
                f"不满足 required_off 硬约束；请更换可关闭思考的模型")
        if thinking_policy == "required_on" and cap not in ("always_on", "can_disable"):
            raise CapabilityMismatch(
                f"{self.profile.model_id}（{self.adapter_id}）思考能力为 {cap}，"
                f"不满足 required_on 硬约束")
        if thinking_policy == "prefer_off" and cap == "always_on":
            notes.append(
                f"{self.profile.model_id} 官方文档写明思考不可关闭，"
                "prefer_off 按该模型允许的默认强度执行（未伪装为已关闭）")
        return notes

    def thinking_extra_body(self, thinking_policy: str) -> dict[str, Any]:
        """默认实现：不发送思考参数（provider_default / unknown 能力）。"""
        return {}

    # ---------------------------------------------------------- 请求
    def chat(self, messages: list[dict[str, Any]], *,
             thinking_policy: str = "provider_default",
             want_json: bool = False,
             stream: bool = False,
             on_delta=None, timeout: float = 120.0) -> ChatResult:
        notes = self.preflight(thinking_policy)
        extra: dict[str, Any] = self.default_extra_body()
        if self.thinking_capability() != 'unknown':
            extra.update(self.thinking_extra_body(thinking_policy))
        if want_json:
            if self.capabilities().get("json_object") in ("verified", "documented"):
                extra["response_format"] = {"type": "json_object"}
        key = self.profile.credential()
        if key is None:
            raise ModelError(
                "AUTH_FAILED",
                f"凭据未配置：环境变量 {self.profile.api_key_env or '(未指定)'} 为空")
        result = self.transport.chat(
            self.profile.base_url, key, self.profile.model_id, messages,
            stream=stream, extra_body=extra or None, timeout=timeout,
            on_delta=on_delta)
        result.notes.extend(notes)
        return result


class QwenAdapter(BaseModelAdapter):
    """阿里云百炼 DashScope 兼容模式；enable_thinking 开关（官方文档快照）。"""

    adapter_id = "qwen"

    def thinking_extra_body(self, thinking_policy: str) -> dict[str, Any]:
        if thinking_policy in ("required_off", "prefer_off"):
            return {"enable_thinking": False}
        if thinking_policy in ("required_on", "prefer_on"):
            return {"enable_thinking": True}
        return {}


class DeepSeekAdapter(BaseModelAdapter):
    """DeepSeek 原厂；thinking 对象开关（官方文档快照）。"""

    adapter_id = "deepseek"

    def chat(self, messages, **kwargs):
        if self.profile.model_id in ('deepseek-v4-pro','deepseek-chat','deepseek-reasoner') and any(
            isinstance(message.get('content'),list) and any(part.get('type') in ('image_url','file') for part in message['content'])
            for message in messages):
            raise CapabilityMismatch('DeepSeek图片输入请使用deepseek-flash；该模型不支持识图')
        return super().chat(messages,**kwargs)

    def thinking_extra_body(self, thinking_policy: str) -> dict[str, Any]:
        if thinking_policy in ("required_off", "prefer_off"):
            return {"thinking": {"type": "disabled"}}
        if thinking_policy in ("required_on", "prefer_on"):
            return {"thinking": {"type": "enabled"}}
        return {}


class KimiAdapter(BaseModelAdapter):
    """Moonshot 中国平台；思考参数按模型差异未核验，默认不发送。"""

    adapter_id = "kimi"


class BigModelAdapter(BaseModelAdapter):
    """智谱 BigModel；GLM-5.3 思考不可关闭（官方文档快照）。"""

    adapter_id = "bigmodel"


class ArkAdapter(BaseModelAdapter):
    """火山方舟兼容端点；思考参数按模型核验后再启用。"""

    adapter_id = "ark"

    def thinking_extra_body(self, thinking_policy: str) -> dict[str, Any]:
        # 方舟兼容接口示例带 thinking 对象；能力 unknown 时不硬性声明
        if thinking_policy in ("required_off", "prefer_off") and \
                self.thinking_capability() == "can_disable":
            return {"thinking": {"type": "disabled"}}
        return {}


class MockAdapter(BaseModelAdapter):
    """离线确定性生成器：无网络、零费用，产出通过规则引擎的中文内容。

    仅用于开发联调与测试，正式写作必须配置国内模型 API。
    """

    adapter_id = "mock"

    def __init__(self, profile: ModelProfile, transport: OpenAIChatTransport | None = None):
        super().__init__(profile, transport)
        from . import mockgen
        self.mockgen = mockgen

    def chat(self, messages: list[dict[str, str]], *,
             thinking_policy: str = "provider_default",
             want_json: bool = False,
             stream: bool = False,
             on_delta=None, timeout: float = 120.0) -> ChatResult:
        self.preflight(thinking_policy)
        # context 由调用方放在最后一条消息的 JSON 前缀里
        context = _extract_context(messages)
        node = context.get("node", "generic")
        if self.profile.profile_id == 'offline-chat-fixture' and node == 'creative_chat':
            context['fixture_clarification'] = '请先问清楚资料' in messages[-1]['content']
        if want_json or context.get("structured"):
            data = self.mockgen.generate_structured(node, context)
            content = json.dumps(data, ensure_ascii=False, indent=2)
        else:
            content = self.mockgen.generate_text(node, context)
        if stream and on_delta:
            # A deliberately named isolated fixture exercises real UI waiting,
            # cancellation and motion; normal mock and production routes stay fast.
            fixture_delay = self.profile.profile_id == 'offline-chat-fixture' and node == 'creative_chat'
            if fixture_delay:
                import time
                time.sleep(.7)
            for i in range(0, len(content), 48):
                if fixture_delay:
                    time.sleep(.6)
                on_delta(content[i:i + 48])
        return ChatResult(
            content=content, finish_reason="stop",
            usage={"prompt_tokens": 0, "completion_tokens": 0, "usage": "mock"},
            raw_model="ice-mock-writer",
            notes=["离线 Mock 生成（零费用），非真实模型输出"])


def _extract_context(messages: list[dict[str, str]]) -> dict[str, Any]:
    m = re.search(r"<context>(.*?)</context>", messages[-1]["content"], re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


class MiniMaxAdapter(BaseModelAdapter):
    adapter_id='minimax'
    def default_extra_body(self):return {'reasoning_split':True}
    def thinking_extra_body(self,thinking_policy):
        extra={}
        if thinking_policy in ('prefer_off','required_off'):
            extra['thinking']={'type':'disabled'}
        elif thinking_policy in ('prefer_on','required_on'):
            extra['thinking']={'type':'adaptive'}
        return extra

ADAPTERS: dict[str, type[BaseModelAdapter]] = {
    'minimax':MiniMaxAdapter,
    "qwen": QwenAdapter,
    "deepseek": DeepSeekAdapter,
    "kimi": KimiAdapter,
    "bigmodel": BigModelAdapter,
    "ark": ArkAdapter,
    "mock": MockAdapter,
}


def make_adapter(profile: ModelProfile,
                 transport: OpenAIChatTransport | None = None) -> BaseModelAdapter:
    cls = ADAPTERS.get(profile.adapter)
    if cls is None:
        raise KeyError(f"未知 adapter：{profile.adapter}")
    return cls(profile, transport)


def extract_json_block(text: str) -> dict[str, Any]:
    """从模型输出提取 JSON 对象（容忍围栏与前后说明文字）。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise SchemaInvalidError("输出中找不到 JSON 对象")
        try:
            obj = json.loads(text[start:end + 1])
        except json.JSONDecodeError as e:
            raise SchemaInvalidError(f"JSON 解析失败：{e}") from e
    if not isinstance(obj, dict):
        raise SchemaInvalidError("结构化输出应为 JSON 对象")
    return obj
