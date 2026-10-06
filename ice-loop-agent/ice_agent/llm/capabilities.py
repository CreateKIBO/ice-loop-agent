"""模型能力登记（§9.7：能力绑定 endpoint+protocol+model_id+mode，
状态 documented / verified / unsupported / unknown，unknown 不按支持处理）。

快照来源：2026-10-01 官方文档（设计文档 §9.6），仅为 documented，
未做账号级实测；verified 只能由显式 probe 设置。
"""
from __future__ import annotations

from dataclasses import dataclass, field

STATUSES = ("documented", "verified", "unsupported", "unknown")

# thinking 能力取值：
#   can_disable  官方文档写明可关闭（可满足 required_off）
#   always_on    官方文档写明不可关闭（GLM-5.3 属于此类）
#   unknown      未核验（不满足任何硬性思考约束）
THINKING = ("can_disable", "always_on", "unknown")


@dataclass
class CapabilitySet:
    text: str = "documented"
    stream: str = "documented"
    json_object: str = "documented"
    json_schema: str = "unknown"
    tool_calls: str = "unknown"
    vision: str = "unsupported"
    thinking: str = "unknown"
    usage: str = "documented"
    evidence_date: str = "2026-10-01"
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, str]:
        return {
            "text": self.text, "stream": self.stream, "json_object": self.json_object,
            "json_schema": self.json_schema, "tool_calls": self.tool_calls,
            "vision": self.vision, "thinking": self.thinking, "usage": self.usage,
            "evidence_date": self.evidence_date,
        }


# 官方资料快照（§9.6）：不代表账号可调用，真实调用前 probe
PROVIDER_PRESETS: dict[str, dict] = {
    "qwen": {
        "service": "bailian",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key_env": "DASHSCOPE_API_KEY",
        "model_id": "qwen3.7-plus",
        "capabilities": CapabilitySet(thinking="can_disable", json_schema="documented"),
    },
    "deepseek": {
        "service": "deepseek-native",
        "base_url": "https://api.deepseek.com",
        "api_key_env": "DEEPSEEK_API_KEY",
        "model_id": "deepseek-flash",
        "capabilities": CapabilitySet(thinking="can_disable",vision="documented",evidence_date="2026-10-03"),
    },
    "kimi": {
        "service": "moonshot-cn",
        "base_url": "https://api.moonshot.cn/v1",
        "api_key_env": "MOONSHOT_API_KEY",
        "model_id": "kimi-k3",
        "capabilities": CapabilitySet(thinking="unknown"),
    },
    "bigmodel": {
        "service": "bigmodel",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "api_key_env": "BIGMODEL_API_KEY",
        "model_id": "glm-5.3",
        # GLM-5.3 当前仅文本且思考不能关闭（官方文档快照）
        "capabilities": CapabilitySet(
            thinking="always_on", vision="unsupported",
            notes=["GLM-5.3 思考不可关闭，不能承担 required_off 角色"]),
    },
    "ark": {
        "service": "volc-ark",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "api_key_env": "ARK_API_KEY",
        "model_id": "doubao-seed-2-1-pro-260628",
        "capabilities": CapabilitySet(thinking="unknown"),
    },
    "minimax": {
        "service":"minimax-cn-native",
        "base_url":"https://api.minimax.cn/v1",
        "api_key_env":"MINIMAX_API_KEY",
        "model_id":"MiniMax-M3",
        "capabilities":CapabilitySet(thinking="can_disable",vision="documented",json_object="unknown",evidence_date="2026-10-02"),
    },
    "mock": {
        "service": "offline-mock",
        "base_url": "mock://local",
        "api_key_env": "",
        "model_id": "ice-mock-writer",
        "capabilities": CapabilitySet(
            text="verified", stream="verified", json_object="verified",
            json_schema="verified", thinking="can_disable",
            evidence_date="builtin",
        ),
    },
}


def preset_profile(adapter_id: str, profile_id: str | None = None,
                   **overrides) -> dict:
    """从预置生成 ModelProfile dict（不落盘、不含明文 Key）。"""
    preset = PROVIDER_PRESETS.get(adapter_id)
    if not preset:
        raise KeyError(f"未知 adapter：{adapter_id}（可选：{sorted(PROVIDER_PRESETS)}）")
    profile = {
        "profile_id": profile_id or f"{adapter_id}-default",
        "adapter": adapter_id,
        "service": preset["service"],
        "protocol": "chat_completions",
        "base_url": preset["base_url"],
        "model_id": preset["model_id"],
        "api_key_env": preset["api_key_env"],
        "region": "",
        "status": "verified" if adapter_id == "mock" else "requires_probe",
        "capabilities": preset["capabilities"].to_dict(),
    }
    profile.update(overrides)
    return profile
