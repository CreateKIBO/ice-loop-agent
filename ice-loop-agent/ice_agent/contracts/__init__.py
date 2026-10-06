"""v2.0 权威请求/响应/事件契约（M1-01，报告 §7.1）。

单一真相：这里的 Pydantic 模型导出 JSON Schema（build/export_contracts.py），
前端由同一 schema 生成 TS 类型与预编译 Ajv 校验器（desktop/ui/scripts/）。
禁止在 TS/JS 里另写一套字段定义；合同漂移由 tests/test_v2_contracts.py 阻断。

兼容规则（ADR-003）：v1 JSON Lines 请求没有 kind 字段，按 RpcRequest 解析；
v2 响应显式 kind=response，事件 kind=event。旧客户端只看得到 v1 形状。
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PROTOCOL_VERSION = 2


class StrictModel(BaseModel):
    """拒绝未知字段：请求侧越权参数在入口就被挡下。"""
    model_config = ConfigDict(extra="forbid", protected_namespaces=())


class ErrorCode(str, Enum):
    """稳定错误码（M1-09）。display message 可变，code 是合同。"""
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    ACCOUNT_MISMATCH = "ACCOUNT_MISMATCH"
    REVISION_CONFLICT = "REVISION_CONFLICT"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    CANCELLED = "CANCELLED"
    NETWORK = "NETWORK"
    PROVIDER_ERROR = "PROVIDER_ERROR"
    CAPABILITY_MISMATCH = "CAPABILITY_MISMATCH"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    STATE_CONFLICT = "STATE_CONFLICT"
    INTERNAL = "INTERNAL"


class RpcRequest(StrictModel):
    """JSON Lines 请求行。v1 客户端发 {"id","method","params"}，兼容。"""
    id: str | None = Field(default=None, description="请求关联 ID；通知类可为空")
    method: str = Field(min_length=1, max_length=100)
    params: dict[str, Any] = Field(default_factory=dict)


class RpcErrorBody(StrictModel):
    code: ErrorCode
    message: str = Field(min_length=1, max_length=2000)
    recoverable: bool = False
    action: Literal["retry", "adjust_input", "resolve_conflict",
                    "check_budget", "contact_support"] | None = None
    request_id: str | None = None


class RpcResponse(StrictModel):
    kind: Literal["response"] = "response"
    id: str | None = None
    result: Any = None
    error: RpcErrorBody | None = None


class ProtocolEvent(StrictModel):
    """持久事件流的一行（M1-05 入库后经游标回放）。"""
    kind: Literal["event"] = "event"
    protocol_version: Literal[2] = 2
    event_id: str = Field(min_length=1, max_length=100)
    stream_id: str = Field(min_length=1, max_length=100)
    account_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=1)
    type: str = Field(min_length=1, max_length=100)
    payload: dict[str, Any] = Field(default_factory=dict)


class ChatMode(str, Enum):
    discuss = "discuss"
    draft = "draft"
    edit = "edit"
    images = "images"


class ChatSendRequest(StrictModel):
    """chat.send 参数合同（与 creative_chat.CreativeChat.send 对齐）。"""
    conversation_id: str = Field(min_length=1, max_length=100)
    text: str = Field(default="", max_length=12000)
    mode: ChatMode = ChatMode.discuss
    references: list[str] = Field(default_factory=list, max_length=8)
    clarification_message_id: str | None = Field(default=None, max_length=100)
    candidate_id: str | None = Field(default=None, max_length=100)
    request_id: str | None = Field(default=None, max_length=100,
                                   description="幂等键：同一会话重复提交同 request_id 返回同一结果")


class ModelDeltaPayload(StrictModel):
    """model.delta 事件载荷（流式增量）。"""
    turn_id: str = Field(min_length=1, max_length=100)
    attempt_id: str = Field(min_length=1, max_length=100)
    text: str


def payload_registry() -> dict[str, type[BaseModel]]:
    """需要导出 schema 的载荷模型。新增合同在此登记。"""
    return {
        "rpc.request": RpcRequest,
        "rpc.response": RpcResponse,
        "rpc.error": RpcErrorBody,
        "protocol.event": ProtocolEvent,
        "chat.send.request": ChatSendRequest,
        "model.delta.payload": ModelDeltaPayload,
    }
