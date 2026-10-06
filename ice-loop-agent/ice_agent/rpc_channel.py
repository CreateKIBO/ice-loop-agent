"""JSON Lines 通道：v2 帧协议 + v1 兼容解析（M1-02，报告 §7.1）。

- stdout 只输出协议 JSON；日志一律走 stderr。
- 响应显式 kind=response；事件 kind=event。旧客户端只读 id/result/error，
  多出的 kind 字段无影响（desktop/main.cjs 解析器已核对）。
- 非法行（坏 JSON/非对象/缺 method）回 VALIDATION_ERROR 且不中断通道。
- 线程安全：流式工作线程可能并发写事件，写出行时持有锁。
"""
from __future__ import annotations

import json
import sys
import threading
from typing import Any, Callable

from pydantic import ValidationError

from .contracts import ErrorCode, PROTOCOL_VERSION, RpcRequest, RpcResponse


class ProtocolError(Exception):
    def __init__(self, code: ErrorCode, message: str, recoverable: bool = False):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


_ERROR_CODE_MAP: list[tuple[type[BaseException], ErrorCode]] = [
    # 按子类优先匹配；ValueError 兜底为校验错误。
]

# 既有领域错误码（llm.errors.ModelError.code 等）→ v2 稳定错误码。
_LEGACY_CODE_MAP = {
    "AUTH_FAILED": ErrorCode.PERMISSION_DENIED,
    "RATE_LIMIT": ErrorCode.PROVIDER_ERROR,
    "SERVER_ERROR": ErrorCode.PROVIDER_ERROR,
    "NETWORK": ErrorCode.NETWORK,
    "CONTEXT_LENGTH": ErrorCode.VALIDATION_ERROR,
    "PARAM_UNSUPPORTED": ErrorCode.CAPABILITY_MISMATCH,
    "CONTENT_REFUSED": ErrorCode.PROVIDER_ERROR,
    "EMPTY_RESPONSE": ErrorCode.PROVIDER_ERROR,
    "SCHEMA_INVALID": ErrorCode.PROVIDER_ERROR,
    "RESPONSE_INCOMPLETE": ErrorCode.PROVIDER_ERROR,
    "MODEL_CAPABILITY_MISMATCH": ErrorCode.CAPABILITY_MISMATCH,
    "MODEL_BUDGET_EXCEEDED": ErrorCode.BUDGET_EXCEEDED,
}


def register_error(exc_type: type[BaseException], code: ErrorCode) -> None:
    _ERROR_CODE_MAP.append((exc_type, code))


def error_code_for(exc: BaseException) -> ErrorCode:
    if isinstance(exc, ProtocolError):
        return exc.code
    for exc_type, code in _ERROR_CODE_MAP:
        if isinstance(exc, exc_type):
            return code
    # 领域异常可自带稳定 code 属性（如 llm.errors.ModelError.code）。
    attr = getattr(exc, "code", None)
    if isinstance(attr, str):
        if attr in _LEGACY_CODE_MAP:
            return _LEGACY_CODE_MAP[attr]
        try:
            return ErrorCode(attr)
        except ValueError:
            pass
    if isinstance(exc, ValidationError):
        return ErrorCode.VALIDATION_ERROR
    if isinstance(exc, ValueError):
        return ErrorCode.VALIDATION_ERROR
    if isinstance(exc, PermissionError):
        return ErrorCode.PERMISSION_DENIED
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return ErrorCode.NETWORK
    return ErrorCode.INTERNAL


def frame_response(request_id: str | None, result: Any = None,
                   error: dict | None = None) -> bytes:
    response = {"kind": "response", "id": request_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")


def frame_event(event: dict) -> bytes:
    payload = {"kind": "event", "protocol_version": PROTOCOL_VERSION, **event}
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


class RpcChannel:
    """逐行服务 JSON Lines 请求。dispatch(method, params) 由入口注入。

    route(method) 返回 'inline'（默认）或 'pool'：pool 类请求提交到
    executor 后立即返回、不阻塞读循环，响应由工作线程写出（M1-04：
    长任务进行时查询/取消仍可响应）。pool 内部用串行锁保持与 v1.5.3
    相同的写语义（同时至多一个重操作）。
    """

    def __init__(self, dispatch: Callable[[str, dict], Any],
                 write=None, dispatch_checked: bool = True,
                 executor=None, route: Callable[[str], str] | None = None):
        self._dispatch = dispatch
        self._lock = threading.Lock()
        self._write = write or sys.stdout.buffer.write
        self._dispatch_checked = dispatch_checked
        self._executor = executor
        self._route = route or (lambda method: "inline")

    def handle_raw(self, raw: bytes) -> None:
        request_id = None
        try:
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ProtocolError(ErrorCode.VALIDATION_ERROR, "请求行必须是 JSON 对象")
            parsed = RpcRequest.model_validate(request)
            request_id = parsed.id
            if self._executor is not None and self._route(parsed.method) == "pool":
                self._executor.submit(self._run_pooled, parsed)
                return
            result = self._dispatch(parsed.method, parsed.params)
            self.write_line(frame_response(request_id, result=result))
        except ProtocolError as exc:
            self.write_line(frame_response(request_id, error={
                "code": exc.code.value, "message": str(exc),
                "recoverable": exc.recoverable, "request_id": request_id}))
        except ValidationError as exc:
            self.write_line(frame_response(request_id, error={
                "code": ErrorCode.VALIDATION_ERROR.value,
                "message": "请求参数不合法", "recoverable": True,
                "request_id": request_id}))
        except Exception as exc:
            # Never echo params: they can include an API key.
            self.write_line(frame_response(request_id, error={
                "code": error_code_for(exc).value, "message": str(exc),
                "recoverable": False, "request_id": request_id}))

    def _run_pooled(self, parsed: RpcRequest) -> None:
        try:
            result = self._dispatch(parsed.method, parsed.params)
            self.write_line(frame_response(parsed.id, result=result))
        except Exception as exc:
            self.write_line(frame_response(parsed.id, error={
                "code": error_code_for(exc).value, "message": str(exc),
                "recoverable": False, "request_id": parsed.id}))

    def write_line(self, payload: bytes) -> None:
        with self._lock:
            self._write(payload)
            try:
                sys.stdout.buffer.flush()
            except AttributeError:  # 测试注入的 write 可能没有 flush
                pass

    def emit_event(self, event: dict) -> None:
        self.write_line(frame_event(event))
