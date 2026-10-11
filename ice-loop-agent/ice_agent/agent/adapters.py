"""Agent 适配器（M5-02，报告 §11.3）：原生 tool_calls 与 ActionEnvelope 降级。

两条路径产出同一种规范化调用列表，经同一注册表校验（同权限、同 schema）；
读取文章内容的字符串不会被当成信封——只有显式 JSON 对象/标记块才解析；
畸形调用与未知工具名安全拒绝（错误反馈给下一轮，不中断循环）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

ENVELOPE_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.S)


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]
    source: str                      # native | envelope
    raw: str = ""
    parse_error: str | None = None   # 规范化阶段的错误（如 JSON 截断）
    args_hash: str = ""


@dataclass
class AgentTurnOutput:
    text: str = ""                            # 面向用户的正文（可与工具调用并存）
    calls: list[ToolCall] = field(default_factory=list)


def parse_native_tool_calls(message: dict[str, Any]) -> AgentTurnOutput:
    """provider 原生 tool_calls（OpenAI 形状 message.tool_calls）。"""
    output = AgentTurnOutput(text=str(message.get("content") or ""))
    for call in message.get("tool_calls") or []:
        name = call.get("function", {}).get("name", "")
        raw_args = call.get("function", {}).get("arguments", "{}")
        try:
            arguments = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
            if not isinstance(arguments, dict):
                raise ValueError("arguments 必须是对象")
            output.calls.append(ToolCall(name=name, arguments=arguments, source="native"))
        except (ValueError, TypeError) as exc:
            output.calls.append(ToolCall(name=name or "(unknown)", arguments={},
                                         source="native", raw=str(raw_args)[:200],
                                         parse_error=f"参数解析失败：{exc}"))
    return output


def parse_action_envelope(text: str) -> AgentTurnOutput:
    """ActionEnvelope 降级：模型输出 ```json {"action":"tool_call","calls":[...]} ```。

    正文其他内容原样保留为 text；没有信封就是纯讨论。
    """
    output = AgentTurnOutput(text=text)
    for match in ENVELOPE_RE.finditer(text or ""):
        raw = match.group(1)
        try:
            envelope = json.loads(raw)
        except ValueError as exc:
            output.calls.append(ToolCall(name="(envelope)", arguments={}, source="envelope",
                                         raw=raw[:200], parse_error=f"信封 JSON 解析失败：{exc}"))
            continue
        if not isinstance(envelope, dict) or envelope.get("action") != "tool_call":
            continue  # 其他 JSON 块是资料，不是指令
        calls = envelope.get("calls")
        if not isinstance(calls, list):
            output.calls.append(ToolCall(name="(envelope)", arguments={}, source="envelope",
                                         raw=raw[:200], parse_error="信封缺少 calls 列表"))
            continue
        for call in calls[:12]:
            if not isinstance(call, dict):
                output.calls.append(ToolCall(name="(envelope)", arguments={}, source="envelope",
                                             raw=str(call)[:200], parse_error="调用项必须是对象"))
                continue
            name = str(call.get("name", ""))
            arguments = call.get("arguments", {})
            if not isinstance(arguments, dict):
                output.calls.append(ToolCall(name=name, arguments={}, source="envelope",
                                             raw=str(call)[:200], parse_error="arguments 必须是对象"))
                continue
            output.calls.append(ToolCall(name=name, arguments=arguments, source="envelope"))
    return output


def normalize_model_output(message: dict[str, Any] | str, *,
                           native_tools_supported: bool) -> AgentTurnOutput:
    """M5-02 入口：按能力选择解析路径；两条路径同权限同 schema。"""
    if isinstance(message, str):
        return parse_action_envelope(message)
    if native_tools_supported and message.get("tool_calls"):
        return parse_native_tool_calls(message)
    text = str(message.get("content") or "")
    # 原生不支持时也尝试信封（模型可能自发输出结构化调用）
    envelope = parse_action_envelope(text)
    if envelope.calls or message.get("tool_calls") is None:
        return envelope
    return AgentTurnOutput(text=text)
