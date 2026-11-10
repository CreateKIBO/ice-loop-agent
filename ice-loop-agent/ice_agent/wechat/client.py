"""v3.22 微信公众号接口客户端（只用到草稿相关的几个接口）。

- 获取调用凭据：POST /cgi-bin/stable_token（稳定版，不会让其他地方已取得的凭据失效）
- 正文图片：POST /cgi-bin/media/uploadimg（仅 jpg/png，<1MB，返回图片地址）
- 封面：POST /cgi-bin/material/add_material?type=image（永久素材，返回 media_id）
- 草稿：/cgi-bin/draft/add、/cgi-bin/draft/update、/cgi-bin/draft/get

不调用发布（freepublish）与群发接口：发布仍由作者在公众号后台确认。
transport 可替换，测试与离线环境不访问网络。
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

BASE = 'https://api.weixin.qq.com'
TIMEOUT = 30

# 常见错误码 → 作者能操作的说明
ERRORS = {
    40001: '调用凭据无效：AppSecret 可能已重置，请重新填写',
    40002: '凭据类型无效',
    40013: 'AppID 无效，请核对公众号后台“设置与开发 → 基本配置”里的开发者 ID',
    40125: 'AppSecret 无效，请在公众号后台重置后重新填写',
    40164: '本机出口 IP 不在公众号的 IP 白名单里',
    40007: '素材或草稿不存在（可能已在后台删除）',
    40005: '图片格式不受支持',
    40006: '图片超过大小限制',
    40009: '图片超过大小限制',
    41005: '没有上传图片数据',
    42001: '调用凭据已过期',
    45003: '标题过长',
    45004: '摘要过长',
    45008: '正文过长',
    45009: '今天的接口调用次数已用完，请明天再试',
    45011: '调用太频繁，请稍后再试',
    45110: '作者名过长',
    48001: '这个公众号没有草稿箱接口权限（未认证或接口未开通）',
    50002: '公众号接口被限制',
    53404: '账号已被限制带货能力',
    61004: '本机出口 IP 不在公众号的 IP 白名单里',
    -1: '微信系统繁忙，请稍后再试',
}
IP_CODES = {40164, 61004}
# 写入可能已成功但没有拿到结果的情况：不重试，交给对账
UNKNOWN_OUTCOME = 'unknown'


class WeChatError(RuntimeError):
    def __init__(self, code: int | str, message: str, *, raw: str = '', outcome: str = 'failed'):
        self.code, self.raw, self.outcome = code, raw, outcome
        super().__init__(message)


def explain(code: int, errmsg: str = '') -> str:
    base = ERRORS.get(code, f'微信接口返回错误 {code}')
    if code in IP_CODES:
        ip = ''
        for token in errmsg.replace(',', ' ').split():
            if token.count('.') == 3 and all(p.isdigit() for p in token.split('.')):
                ip = token
                break
        base += f'（本机出口 IP：{ip}）' if ip else ''
        base += '。请在公众号后台“设置与开发 → 基本配置 → IP 白名单”里添加后重试'
    return base


Transport = Callable[..., dict]


def urllib_transport(method: str, url: str, *, body: bytes | None = None, headers: dict | None = None,
                     timeout: float = TIMEOUT) -> dict:
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # 遵循系统代理设置
            raw = response.read()
    except urllib.error.HTTPError as error:
        # 5xx（含网关超时）时请求可能已经被处理：和断网一样按“结果未知”交给对账；4xx 是确定的失败
        raise WeChatError('http', f'微信接口 HTTP {error.code}', raw=str(error),
                          outcome=UNKNOWN_OUTCOME if error.code >= 500 else 'failed') from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        # 已发出的写入请求可能已经成功：由调用方按“结果未知”处理
        raise WeChatError('network', f'连接微信接口失败：{getattr(error, "reason", error)}', raw=str(error),
                          outcome=UNKNOWN_OUTCOME) from error
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as error:
        raise WeChatError('format', '微信接口返回了无法识别的内容', raw=raw[:200].decode('utf-8', 'replace')) from error


_TOKENS: dict[str, tuple[str, float]] = {}


class WeChatClient:
    def __init__(self, appid: str, secret: str, transport: Transport | None = None):
        if not appid or not secret:
            raise WeChatError('config', '还没有填写公众号 AppID 与 AppSecret')
        self.appid, self.secret = appid, secret
        self.transport = transport or urllib_transport
        # 凭据缓存按“AppID + 密钥”区分：换了 AppSecret 不会继续用旧密钥取到的凭据
        self._cache_key = appid + ':' + hashlib.sha256(secret.encode('utf-8')).hexdigest()[:16]

    # ------------------------------------------------------------ 基础
    def _check(self, data: dict) -> dict:
        code = data.get('errcode', 0)
        if code:
            raise WeChatError(code, explain(int(code), str(data.get('errmsg', ''))), raw=str(data.get('errmsg', ''))[:300])
        return data

    def token(self, *, force: bool = False) -> str:
        cached = _TOKENS.get(self._cache_key)
        if cached and not force and cached[1] > time.time() + 120:
            return cached[0]
        body = json.dumps({'grant_type': 'client_credential', 'appid': self.appid, 'secret': self.secret,
                           'force_refresh': False}).encode('utf-8')
        try:
            data = self._check(self.transport('POST', f'{BASE}/cgi-bin/stable_token', body=body,
                                              headers={'Content-Type': 'application/json'}))
        except WeChatError as error:
            if error.outcome == UNKNOWN_OUTCOME:
                error.outcome = 'failed'  # 取凭据没有副作用
            raise
        token = data.get('access_token')
        if not isinstance(token, str) or not token:
            raise WeChatError('format', '微信没有返回调用凭据')
        _TOKENS[self._cache_key] = (token, time.time() + int(data.get('expires_in') or 7200))
        return token

    def _call(self, path: str, *, payload: dict | None = None, files: tuple[str, str, bytes, str] | None = None,
              query: dict | None = None, retry: bool = True) -> dict:
        params = {'access_token': self.token(), **(query or {})}
        url = f'{BASE}{path}?{urllib.parse.urlencode(params)}'
        if files:
            field, filename, content, mime = files
            boundary = 'ice' + uuid.uuid4().hex
            head = (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
                    f'Content-Type: {mime}\r\n\r\n').encode('utf-8')
            body = head + content + f'\r\n--{boundary}--\r\n'.encode('ascii')
            headers = {'Content-Type': f'multipart/form-data; boundary={boundary}'}
        else:
            body = json.dumps(payload or {}, ensure_ascii=False).encode('utf-8')
            headers = {'Content-Type': 'application/json; charset=utf-8'}
        data = self.transport('POST', url, body=body, headers=headers)
        if data.get('errcode') in (40001, 42001) and retry:  # 凭据被其他地方刷新：重取一次
            _TOKENS.pop(self._cache_key, None)
            return self._call(path, payload=payload, files=files, query=query, retry=False)
        return self._check(data)

    # ------------------------------------------------------------ 接口
    def upload_content_image(self, filename: str, content: bytes, mime: str) -> str:
        url = self._call('/cgi-bin/media/uploadimg', files=('media', filename, content, mime)).get('url')
        if not isinstance(url, str) or not url.startswith('http'):
            raise WeChatError('format', '上传正文图片后没有拿到图片地址')
        return url.replace('http://', 'https://', 1)

    def add_cover(self, filename: str, content: bytes, mime: str) -> tuple[str, str]:
        data = self._call('/cgi-bin/material/add_material', files=('media', filename, content, mime), query={'type': 'image'})
        if not data.get('media_id'):
            raise WeChatError('format', '上传封面后没有拿到素材 ID')
        return data['media_id'], data.get('url', '')

    def draft_add(self, article: dict | list[dict]) -> str:
        """新建草稿；传列表即多图文（最多 8 篇，第一篇为头条）。"""
        articles = article if isinstance(article, list) else [article]
        media_id = self._call('/cgi-bin/draft/add', payload={'articles': articles}).get('media_id')
        if not media_id:
            raise WeChatError('format', '创建草稿后没有拿到草稿 ID', outcome=UNKNOWN_OUTCOME)
        return media_id

    def draft_update(self, media_id: str, article: dict, index: int = 0) -> None:
        """接口一次只更新一篇（按位置）；不能增删或调整多图文的篇目顺序。"""
        self._call('/cgi-bin/draft/update', payload={'media_id': media_id, 'index': index, 'articles': article})

    def draft_items(self, media_id: str) -> list[dict] | None:
        """草稿里的全部文章；草稿不存在（已在后台删除）时返回 None。"""
        try:
            data = self._call('/cgi-bin/draft/get', payload={'media_id': media_id})
        except WeChatError as error:
            if error.code == 40007:
                return None
            raise
        return list(data.get('news_item') or [])

    def draft_get(self, media_id: str) -> dict | None:
        """草稿不存在（已在后台删除）时返回 None。"""
        items = self.draft_items(media_id)
        if items is None:
            return None
        return items[0] if items else None
