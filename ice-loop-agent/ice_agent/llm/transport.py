"""OpenAI 兼容 Chat Completions 传输层（纯标准库 urllib 实现）。

安全边界（设计文档 §9.15 / §20.3）：
- base_url 只允许 https（本机联调可显式放行 http 且仅限回环地址）；
- 域名解析后阻断私网 / 回环 / 链路本地 / 保留地址，防 SSRF；
- 禁止跟随重定向，避免 Authorization 头被转发到不相干主机；
- 请求只发往已配置的 base_url，不做 SDK 默认回退（§9.5）；
- Authorization 不进入日志与异常文本；用量缺失标记 usage_unknown。
"""
from __future__ import annotations

import ipaddress
import json
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

from .errors import (
    AuthError,
    ContentRefusedError,
    ContextLengthError,
    EmptyResponseError,
    NetworkError,
    RateLimitError,
    ServerError,
    IncompleteResponseError,
    ParamUnsupportedError,
)

_SENSIBLE_TIMEOUT = 120


class EndpointRejected(NetworkError):
    def __init__(self, message: str):
        super().__init__(f"endpoint 拒绝：{message}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁止自动重定向：Authorization 不得被转发到任何其他主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def validate_endpoint(base_url: str, *, allow_loopback_http: bool = False) -> str:
    """校验端点协议与主机地址边界；返回规范化的 base_url（尾部不带 /）。"""
    parsed = urlparse(base_url)
    host = parsed.hostname or ""
    if not host:
        raise EndpointRejected(f"base_url 缺少主机名：{base_url}")
    is_loopback_name = host in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme == "https":
        pass
    elif parsed.scheme == "http" and allow_loopback_http and is_loopback_name:
        pass
    else:
        raise EndpointRejected(
            f"仅允许 https 端点（http 仅限回环联调）：{parsed.scheme}://{host}")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise EndpointRejected(f"域名解析失败：{host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback:
            if allow_loopback_http:
                continue
            raise EndpointRejected(f"目标主机 {host} 解析到回环地址 {ip}")
        if (ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast
                or ip.is_unspecified):
            raise EndpointRejected(
                f"目标主机 {host} 解析到内网/保留地址 {ip}，已阻断（SSRF 防护）")
    return base_url.rstrip("/")


@dataclass
class ChatResult:
    content: str
    finish_reason: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    raw_model: str = ""
    streamed: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def usage_known(self) -> bool:
        return bool(self.usage)


def _raise_for_status(status: int, body: str) -> None:
    hint = ""  # Remote bodies can echo credentials; never put them in persisted errors.
    if status in (401, 403):
        raise AuthError(
            f"认证/权限失败（HTTP {status}）：检查 Key、地域/业务空间与模型权限。{hint}",
            status=status)
    if status == 429:
        raise RateLimitError(f"限流（HTTP 429）。{hint}", status=status)
    if status >= 500:
        raise ServerError(f"服务端错误（HTTP {status}）。{hint}", status=status)
    if status == 400 and ("length" in body.lower() or "context" in body.lower()):
        raise ContextLengthError(f"上下文/输出超限。{hint}")
    if status == 400 and ("refus" in body.lower() or "content_filter" in body.lower()):
        raise ContentRefusedError(f"内容被拒绝。{hint}")
    if status < 500:
        raise ParamUnsupportedError(f"HTTP {status}：请求参数或模型配置不受支持")
    raise ServerError(f"HTTP {status}", status=status)


class OpenAIChatTransport:
    """chat_completions 协议传输；adapter 只负责差异参数。"""

    def __init__(self, *, allow_loopback_http: bool = False):
        self._allow_loopback_http = allow_loopback_http

    def chat(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: list[dict[str, str]],
        *,
        stream: bool = False,
        extra_body: dict[str, Any] | None = None,
        timeout: float = _SENSIBLE_TIMEOUT,
        on_delta: Callable[[str], None] | None = None,
    ) -> ChatResult:
        url = validate_endpoint(base_url,
                                allow_loopback_http=self._allow_loopback_http)
        url = url + "/chat/completions"
        body: dict[str, Any] = {"model": model, "messages": messages}
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
        if extra_body:
            body.update(extra_body)
        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "Accept": "text/event-stream" if stream else "application/json",
            },
            method="POST",
        )
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                raise EndpointRejected(
                    f"服务端要求重定向（HTTP {e.code}），已拒绝以免凭据外泄") from e
            _raise_for_status(e.code, e.read().decode("utf-8", "replace"))
        except urllib.error.URLError as e:
            if isinstance(e.reason, urllib.error.HTTPError):
                raise
            raise NetworkError(f"网络请求失败：{type(e.reason).__name__}") from e
        except (TimeoutError, OSError) as e:
            raise NetworkError(f"网络请求失败：{type(e).__name__}") from e
        with resp:
            if stream:
                return _read_sse(resp, on_delta, deadline=time.monotonic() + timeout)
            raw = resp.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise IncompleteResponseError("响应超过大小上限")
        text = raw.decode("utf-8", "replace")
        return _parse_json_response(text)


def _parse_json_response(text: str) -> ChatResult:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise EmptyResponseError("响应不是合法 JSON") from e
    if "error" in data and not data.get("choices"):
        raise ServerError("服务端返回错误对象")
    choices = data.get("choices") or []
    if not choices:
        raise EmptyResponseError("choices 为空（可能为 JSON 模式空内容）")
    content = (choices[0].get("message") or {}).get("content") or ""
    if not content.strip():
        raise EmptyResponseError("模型返回空正文（JSON 模式可能出现空内容，需重试）")
    finish = choices[0].get("finish_reason", "")
    _check_finish(finish)
    return ChatResult(
        content=content,
        finish_reason=finish,
        usage=data.get("usage") or {},
        raw_model=data.get("model", ""),
    )


def _check_finish(reason: str) -> None:
    if reason == "content_filter":
        raise ContentRefusedError("模型拒绝了本次内容")
    if reason != "stop":
        raise IncompleteResponseError(f"正文没有正常完成（finish_reason={reason or 'missing'}）")


def _read_sse(lines, on_delta=None, *, deadline: float | None = None) -> ChatResult:
    chunks: list[str] = []
    usage: dict[str, Any] = {}
    finish = ""
    model = ""
    size = 0
    for line in lines:
        if deadline is not None and time.monotonic() > deadline:
            raise IncompleteResponseError("流式请求超过总时限")
        if isinstance(line, bytes):
            line = line.decode("utf-8", "strict")
        size += len(line)
        if size > 8 * 1024 * 1024:
            raise IncompleteResponseError("流式响应超过大小上限")
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            evt = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise IncompleteResponseError("流式事件损坏") from exc
        if evt.get("error"):
            raise ServerError("流式响应返回错误事件")
        model = model or evt.get("model", "")
        if evt.get("usage"):
            usage = evt["usage"]
        for ch in evt.get("choices") or []:
            finish = ch.get("finish_reason") or finish
            delta = ch.get("delta") or {}
            piece = delta.get("content")
            if piece:
                chunks.append(piece)
                if on_delta:
                    on_delta(piece)
    content = "".join(chunks)
    if not content.strip():
        raise EmptyResponseError("流式响应没有收到任何正文增量")
    _check_finish(finish)
    return ChatResult(content=content, finish_reason=finish,
                      usage=usage, raw_model=model, streamed=True)


def _parse_sse(text: str, on_delta: Callable[[str], None] | None) -> ChatResult:
    return _read_sse(text.splitlines(), on_delta)
