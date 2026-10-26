"""OpenAI compatible Chat Completions with bounded, cancellable HTTPX I/O.

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
import zlib
from contextlib import closing
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
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024


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
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise EndpointRejected('端点不允许用户名、密码、查询或片段')
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
    invocation_id: str = ""  # Assigned locally by RoleRouter, never by a provider.
    input_preflight: dict[str, Any] = field(default_factory=dict)

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

    def count_tokens(self, base_url: str, api_key: str, model: str, messages: list[dict], *, timeout: float = 15) -> int:
        """GLM tokenizer contract; callers must bind it to the supported profile."""
        raw = self._receive(base_url, '/tokenizer', api_key, method='POST', timeout=timeout, limit=16384,
                            body=json.dumps({'model':model, 'messages':messages}, ensure_ascii=False).encode('utf-8'))
        try:
            data = json.loads(raw)
            usage = data.get('usage') if isinstance(data, dict) and not data.get('error') else None
            tokens = usage.get('total_tokens') if isinstance(usage, dict) else None
            if type(tokens) is not int or not 0 <= tokens <= 2**31-1:
                raise ValueError()
            for field in ('prompt_tokens', 'image_tokens', 'video_tokens'):
                if field in usage and (type(usage[field]) is not int or not 0 <= usage[field] <= tokens):
                    raise ValueError()
            return tokens
        except (ValueError, UnicodeError):
            raise ParamUnsupportedError('供应商Token计数响应无效，尚未发送生成请求；请核对模型和端点') from None

    def models(self, base_url: str, api_key: str, *, timeout: float = 25) -> list[dict]:
        """Bounded metadata GET; same endpoint/redirect/auth boundary as chat."""
        try:
            raw=self._receive(base_url,'/models',api_key,method='GET',timeout=timeout,limit=2_000_000)
            data=json.loads(raw)
            rows=data.get('data') if isinstance(data,dict) else None
            if not isinstance(rows,list) or len(rows)>10000:
                raise ParamUnsupportedError('模型目录格式无效，请手动填写模型ID')
            return [row for row in rows if isinstance(row,dict) and isinstance(row.get('id'),str) and 0<len(row['id'])<=200]
        except IncompleteResponseError:
            raise ParamUnsupportedError('模型目录过大或响应损坏，请手动填写模型ID') from None
        except (ValueError,UnicodeError):
            raise ParamUnsupportedError('模型目录不是有效JSON，请手动填写模型ID') from None

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
        body: dict[str, Any] = {"model": model, "messages": messages}
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
        if extra_body:
            body.update(extra_body)
        result=self._receive(base_url,'/chat/completions',api_key,method='POST',
            body=json.dumps(body,ensure_ascii=False).encode('utf-8'),timeout=timeout,
            limit=MAX_RESPONSE_BYTES,stream=stream,on_delta=on_delta)
        if isinstance(result,ChatResult):
            return result
        try:
            return _parse_json_response(result.decode('utf-8','strict'))
        except UnicodeError:
            raise IncompleteResponseError('响应包含损坏的UTF8字符') from None

    def _receive(self,base_url,suffix,api_key,*,method,timeout,limit,body=None,stream=False,on_delta=None):
        from .http_io import exchange
        headers={'Authorization':'Bearer '+api_key,'Accept':'text/event-stream' if stream else 'application/json',
                 'Accept-Encoding':'identity'}
        if body is not None:
            headers['Content-Type']='application/json'
        with closing(exchange(base_url,suffix,method=method,headers=headers,body=body,timeout=timeout,
                              allow_loopback=self._allow_loopback_http)) as events:
            kind,head=next(events)
            if kind!='headers':
                raise IncompleteResponseError('响应缺少HTTP头部')
            status,response_headers=head
            if 300<=status<400:
                raise EndpointRejected('服务端要求重定向，已拒绝以保护凭据')
            if status>=400:
                if status!=400:
                    _raise_for_status(status,'')
                prefix=b''.join(_decoded_chunks(events,response_headers,65536,prefix_only=True))
                _raise_for_status(status,prefix.decode('utf-8','replace'))
            chunks=_decoded_chunks(events,response_headers,limit)
            if stream and 'application/json' not in response_headers.get('content-type',''):
                parser=_SSEReader(on_delta)
                for chunk in chunks:
                    parser.feed(chunk)
                    if parser.done:
                        break
                return parser.result()
            return b''.join(chunks)


def _decoded_chunks(events,headers,limit,*,prefix_only=False):
    encoding=headers.get('content-encoding','identity').lower().strip()
    if encoding not in ('','identity','gzip','deflate'):
        raise IncompleteResponseError('响应使用了不支持的压缩格式')
    decoder=zlib.decompressobj(16+zlib.MAX_WBITS if encoding=='gzip' else zlib.MAX_WBITS) if encoding in ('gzip','deflate') else None
    wire=total=0
    try:
        for kind,raw in events:
            if kind!='data':continue
            wire+=len(raw)
            if wire>limit and not prefix_only:
                raise IncompleteResponseError('响应超过字节大小上限')
            while raw:
                chunk=decoder.decompress(raw,min(65536,limit-total+1)) if decoder else raw
                if decoder and decoder.unused_data:
                    raise IncompleteResponseError('压缩响应包含额外数据')
                raw=decoder.unconsumed_tail if decoder else b''
                total+=len(chunk)
                if total>limit:
                    if prefix_only:
                        yield chunk[:len(chunk)-(total-limit)]
                        return
                    raise IncompleteResponseError('响应超过字节大小上限')
                if chunk:yield chunk
            if prefix_only and (total>=limit or wire>=limit):return
        if decoder and not decoder.eof:
            raise IncompleteResponseError('压缩响应未完整结束')
    except zlib.error:
        raise IncompleteResponseError('压缩响应损坏') from None


def _parse_json_response(text: str) -> ChatResult:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise EmptyResponseError("响应不是合法 JSON") from e
    if not isinstance(data,dict):
        raise IncompleteResponseError('响应对象格式无效')
    if "error" in data and not data.get("choices"):
        raise ServerError("服务端返回错误对象")
    choices = data.get("choices") or []
    if not choices:
        raise EmptyResponseError("choices 为空（可能为 JSON 模式空内容）")
    if not isinstance(choices,list) or not isinstance(choices[0],dict) or not isinstance(choices[0].get('message'),dict):
        raise IncompleteResponseError('响应choices格式无效')
    content = choices[0]['message'].get('content') or ""
    if not isinstance(content,str):
        raise IncompleteResponseError('响应正文格式无效')
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


class _SSEReader:
    def __init__(self,on_delta=None):
        self.on_delta=on_delta
        self.buffer=bytearray();self.chunks=[];self.pending=[]
        self.total=0;self.event_bytes=0;self.done=False
        self.usage={};self.finish='';self.model=''
        self.depth=0;self.quoted=False;self.escaped=False;self.has_token=False

    def feed(self,chunk):
        self.total+=len(chunk)
        if self.total>MAX_RESPONSE_BYTES:
            raise IncompleteResponseError('流式响应超过字节大小上限')
        self.buffer.extend(chunk)
        while not self.done:
            split=self.buffer.find(b'\n')
            if split<0:break
            line=bytes(self.buffer[:split]);del self.buffer[:split+1]
            self.line(line)
        if len(self.buffer)>MAX_SSE_EVENT_BYTES:
            raise IncompleteResponseError('单个流式事件超过大小上限')

    def line(self,raw):
        if len(raw)>MAX_SSE_EVENT_BYTES:
            raise IncompleteResponseError('单个流式事件超过大小上限')
        try:
            line=raw.decode('utf-8','strict') if isinstance(raw,bytes) else raw
        except UnicodeError:
            raise IncompleteResponseError('流式事件包含损坏的UTF8字符') from None
        line=line.rstrip('\r\n')
        if not line:
            if self.pending:self.dispatch(final=True)
            return
        if not line.startswith('data:'):return
        payload=line[5:].lstrip(' ')
        self.event_bytes+=len(raw if isinstance(raw,bytes) else raw.encode('utf-8'))
        if self.event_bytes>MAX_SSE_EVENT_BYTES:
            raise IncompleteResponseError('单个流式事件超过大小上限')
        if payload=='[DONE]':
            if self.pending:self.dispatch(final=True)
            self.done=True;return
        self.pending.append(payload)
        # Scan once; do not repeatedly parse an ever-growing multiline prefix.
        for char in payload:
            if not char.isspace():self.has_token=True
            if self.quoted:
                if self.escaped:self.escaped=False
                elif char=='\\':self.escaped=True
                elif char=='"':self.quoted=False
            elif char=='"':self.quoted=True
            elif char in '{[':self.depth+=1
            elif char in '}]':self.depth-=1
            if self.depth<0:raise IncompleteResponseError('流式事件损坏')
        if self.has_token and self.depth==0 and not self.quoted:self.dispatch(final=True)

    def dispatch(self,*,final):
        try:
            event=json.loads('\n'.join(self.pending))
        except (ValueError,RecursionError):
            if final:raise IncompleteResponseError('流式事件损坏') from None
            return
        self.pending.clear();self.event_bytes=0
        self.depth=0;self.quoted=False;self.escaped=False;self.has_token=False
        if not isinstance(event,dict):raise IncompleteResponseError('流式事件对象格式无效')
        if event.get('error'):raise ServerError('流式响应返回错误事件')
        self.model=self.model or event.get('model','')
        if isinstance(event.get('usage'),dict):self.usage=event['usage']
        choices=event.get('choices') or []
        if not isinstance(choices,list):raise IncompleteResponseError('流式choices格式无效')
        for choice in choices:
            if not isinstance(choice,dict):raise IncompleteResponseError('流式choice格式无效')
            self.finish=choice.get('finish_reason') or self.finish
            delta=choice.get('delta') or {}
            if not isinstance(delta,dict):raise IncompleteResponseError('流式delta格式无效')
            piece=delta.get('content')
            if piece:
                if not isinstance(piece,str):raise IncompleteResponseError('流式正文格式无效')
                try:piece.encode('utf-8','strict')
                except UnicodeError:raise IncompleteResponseError('流式正文包含损坏的Unicode字符') from None
                self.chunks.append(piece)
                if self.on_delta:self.on_delta(piece)

    def result(self):
        if self.buffer and not self.done:self.line(bytes(self.buffer))
        if self.pending:self.dispatch(final=True)
        self.buffer.clear()
        content=''.join(self.chunks)
        if not content.strip():raise EmptyResponseError('流式响应没有收到任何正文增量')
        _check_finish(self.finish)
        return ChatResult(content=content,finish_reason=self.finish,usage=self.usage,raw_model=self.model,streamed=True)


def _read_sse(lines, on_delta=None, *, deadline: float | None = None) -> ChatResult:
    """In-memory line compatibility helper; live HTTP uses bounded byte chunks."""
    parser=_SSEReader(on_delta)
    for line in lines:
        if deadline is not None and time.monotonic()>deadline:
            raise IncompleteResponseError('流式请求超过总时限')
        parser.total+=len(line if isinstance(line,bytes) else line.encode('utf-8'))
        if parser.total>MAX_RESPONSE_BYTES:raise IncompleteResponseError('流式响应超过字节大小上限')
        parser.line(line)
        if parser.done:break
    return parser.result()


def _parse_sse(text: str, on_delta: Callable[[str], None] | None) -> ChatResult:
    return _read_sse(text.splitlines(), on_delta)
