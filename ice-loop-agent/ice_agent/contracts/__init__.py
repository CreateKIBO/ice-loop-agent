"""v2.0 权威请求/响应/事件契约（M1-01，报告 §7.1）。

单一真相：这里的 Pydantic 模型导出 JSON Schema（build/export_contracts.py），
前端由同一 schema 生成 TS 类型与预编译 Ajv 校验器（desktop/ui/scripts/）。
禁止在 TS/JS 里另写一套字段定义；合同漂移由 tests/test_v2_contracts.py 阻断。

兼容规则（ADR-003）：v1 JSON Lines 请求没有 kind 字段，按 RpcRequest 解析；
v2 响应显式 kind=response，事件 kind=event。旧客户端只看得到 v1 形状。
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Annotated

from pydantic import BaseModel, ConfigDict, Field, RootModel

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
    """JSON Lines 请求行。v1 客户端发 {"id","method","params"}，兼容。

    id 由调用方定义（main.cjs 用自增整数，测试用字符串）；响应必须原样回显。
    """
    id: str | int | None = Field(default=None, description="请求关联 ID；通知类可为空")
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
    id: str | int | None = None
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


class ChatCitation(StrictModel):
    chunk_id: str = Field(min_length=1, max_length=100)
    hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class ChatDocument(StrictModel):
    source_name: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=30000)


class ChatSendRequest(StrictModel):
    """chat.send 参数；同一账号/会话/请求标识仅受理一次，不把重放当重新生成。"""
    conversation_id: str = Field(min_length=1, max_length=100)
    text: str = Field(default="", max_length=12000)
    mode: ChatMode = ChatMode.discuss
    references: list[str] = Field(default_factory=list, max_length=8)
    citations: list[ChatCitation] = Field(default_factory=list, max_length=8)
    documents: list[ChatDocument] = Field(default_factory=list, max_length=3)
    selected_text: str = Field(default="", max_length=8000)
    profile_id: str | None = Field(default=None, max_length=100)
    clarification_message_id: str | None = Field(default=None, max_length=100)
    clarification_answers: dict[str, Annotated[str,Field(min_length=1,max_length=2000)]] = Field(default_factory=dict,max_length=3)
    retry_message_id: str | None = Field(default=None, max_length=100)
    candidate_id: str | None = Field(default=None, max_length=100)
    request_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$",
                                   description="同一账号/会话内相同请求返回原消息；内容改变须使用新的请求标识")


class ChatSendAccepted(StrictModel):
    message_id: str = Field(min_length=1,max_length=100)
    user_message_id: str = Field(min_length=1,max_length=100)
    started: bool
    accepted: Literal[True]
    replayed: bool
    status: Literal['streaming','completed','failed','stopped','interrupted']


class ChatSendCancelled(StrictModel):
    accepted: Literal[False]
    cancelled: Literal[True]
    request_id: str = Field(min_length=1,max_length=100)


class ChatSendMissing(StrictModel):
    accepted: Literal[False]
    found: Literal[False]


class ChatSendResponse(RootModel[ChatSendAccepted | ChatSendCancelled]):
    pass


class ChatReceiptResponse(RootModel[ChatSendAccepted | ChatSendCancelled | ChatSendMissing]):
    pass


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
        "chat.send.response": ChatSendResponse,
        "chat.receipt.response": ChatReceiptResponse,
        "model.delta.payload": ModelDeltaPayload,
    }
