"""Provider-backed input counting. Unknown models stay explicitly unverified.

Contract: https://docs.bigmodel.cn/api-reference/模型-api/文本分词器
No character/token ratios, history truncation, or guessed model windows.
"""
from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict

from ..domain.types import ModelProfile, now_iso, sha256_json
from .errors import AuthError, ContextLengthError, ModelError, ParamUnsupportedError
from .limits import bound_window, output_limit, token_check_policy

# Exact documented tokenizer models; no prefix matching or inference from names.
GLM_TOKENIZER_MODELS = frozenset(('glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5-turbo',
    'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.6v', 'glm-4.5', 'glm-4.5-air'))


def counter_supported(profile: ModelProfile) -> bool:
    return (profile.adapter == 'bigmodel'
            and profile.base_url.rstrip('/') == 'https://open.bigmodel.cn/api/paas/v4'
            and profile.model_id in GLM_TOKENIZER_MODELS)


class TokenCountCache:
    """At most 32 digests and integers, 5-minute TTL; no messages or credentials."""
    def __init__(self):
        self._rows = OrderedDict()
        self._guard = threading.Lock()

    def get(self, key):
        with self._guard:
            row = self._rows.get(key)
            if row is None:
                return None
            if row[0] <= time.monotonic():
                self._rows.pop(key, None)
                return None
            self._rows.move_to_end(key)
            return row[1]

    def put(self, key, tokens):
        with self._guard:
            self._rows[key] = (time.monotonic() + 300, tokens)
            self._rows.move_to_end(key)
            while len(self._rows) > 32:
                self._rows.popitem(last=False)


def check_input(profile, messages, transport, *, cache, timeout, cancelled=None, required=False):
    if cancelled and cancelled():
        raise ModelError('CANCELLED', '任务已停止，未进行Token预检')
    policy = 'required' if required else token_check_policy(profile)
    maximum = output_limit(profile)
    window = bound_window(profile)
    context = window.get('context_window')
    if type(context) is not int or context < 1:
        context = None
    report = {'state': 'unsupported', 'policy': policy, 'request_hash': sha256_json(messages),
              'output_reserved': maximum, 'context_window': context,
              'window_source': window.get('context_source', window.get('source', 'unknown'))}
    if policy == 'off':
        return {**report, 'state': 'disabled'}, []
    if not counter_supported(profile):
        if policy == 'required':
            raise ParamUnsupportedError('当前端点或模型尚未接通已核验的Token计数接口；请选择已支持的模型，或将Token预检改为自动/关闭。尚未发送生成请求。')
        return report, []
    if policy == 'required' and (context is None or maximum is None):
        raise ParamUnsupportedError('严格Token预检需要有效的上下文窗口和明确的最大输出Token；请在模型设置中补齐。尚未发送计数或生成请求。')
    key = profile.credential()
    if not key:
        raise AuthError('请先配置当前模型凭据，再进行Token预检；尚未发送生成请求')
    cache_key = sha256_json({'endpoint': profile.base_url.rstrip('/'), 'model': profile.model_id,
                            'credential_hash': hashlib.sha256(key.encode()).hexdigest(),
                            'request_hash': report['request_hash'], 'contract': 'bigmodel-tokenizer/v1'})
    tokens = cache.get(cache_key)
    hit = tokens is not None
    if not hit:
        tokens = transport.count_tokens(profile.base_url, key, profile.model_id, messages, timeout=min(15, timeout))
        if type(tokens) is not int or not 0 <= tokens <= 2**31 - 1:
            raise ParamUnsupportedError('Token计数响应无效，尚未发送生成请求；请检查端点或更换模型')
        if cancelled and cancelled():
            raise ModelError('CANCELLED', '任务已停止，未采纳Token计数结果')
        cache.put(cache_key, tokens)
    report.update(state='checked' if context is not None and maximum is not None else 'incomplete',
                  input_tokens=tokens, cache_hit=hit, source='bigmodel-tokenizer/v1', checked_at=now_iso())
    if context is not None and (tokens >= context or (maximum is not None and tokens + maximum > context)):
        reserve = f'，另需预留输出{maximum:,}Token' if maximum is not None else ''
        error = ContextLengthError(f'供应商计数输入{tokens:,}Token{reserve}，超过当前配置的{context:,}Token窗口。'
            '全部历史标题与前五篇全文仍保留；请减少附加引用/写作范围、降低输出上限或换用更大窗口模型。尚未发送生成请求，未占用本地生成次数。')
        error.input_preflight = {**report, 'state': 'blocked'}
        raise error
    note = f'供应商Token预检：输入{tokens:,}'
    if report['state'] == 'checked':
        note += f' + 输出预留{maximum:,} ≤ 窗口{context:,}（窗口来源：{report["window_source"]}）'
    else:
        note += '；窗口或明确输出上限未知，尚未完成输入加输出的窗口核验'
    return report, [note + '。实际计费与最终校验以供应商为准。']
