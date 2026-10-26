"""Endpoint/model-bound metadata and explicit output limits; no guessed tokens."""
from __future__ import annotations

from ..domain.types import ModelProfile, now_iso, sha256_json
from .errors import ParamUnsupportedError

MAX_OUTPUT_TOKENS = 1_000_000  # Application safety bound, not provider capability.


def revision(profile: dict) -> str:
    return sha256_json({key:profile.get(key) for key in ('profile_id','adapter','base_url','model_id','extra')})


def window_metadata(profile: dict, rows: list[dict]) -> dict:
    matches = [row for row in rows if row.get('id') == profile['model_id']]
    metadata = {'base_url':profile['base_url'].rstrip('/'), 'model_id':profile['model_id'],
                'source':'models_endpoint', 'checked_at':now_iso(), 'state':'unknown'}
    if len(matches) != 1:
        metadata['state'] = 'model_not_listed' if not matches else 'ambiguous_model'
        return metadata
    for key in ('context_window','max_output_tokens'):
        value = matches[0].get(key)
        if type(value) is int and 0 < value <= 2**31-1:
            metadata[key] = value
    metadata['state'] = 'reported' if 'context_window' in metadata or 'max_output_tokens' in metadata else 'unknown'
    return metadata


def bound_window(profile: ModelProfile) -> dict:
    def scoped(value):
        return (isinstance(value, dict) and value.get('model_id') == profile.model_id
                and value.get('base_url') == profile.base_url.rstrip('/'))
    metadata = profile.extra.get('model_window')
    result = dict(metadata) if scoped(metadata) else {}
    manual = profile.extra.get('context_window_override')
    if scoped(manual) and type(manual.get('context_window')) is int and 1 <= manual['context_window'] <= 2**31-1:
        result.update(context_window=manual['context_window'], context_source='user')
    return result


def token_check_policy(profile: ModelProfile) -> str:
    policy = profile.extra.get('token_check', 'auto')
    if policy not in ('auto', 'required', 'off'):
        raise ParamUnsupportedError('Token预检策略需为自动、严格或关闭')
    return policy


def output_limit(profile: ModelProfile) -> int | None:
    value = profile.extra.get('max_output_tokens')
    if value is None:
        return None
    if type(value) is not int or not 1 <= value <= MAX_OUTPUT_TOKENS:
        raise ParamUnsupportedError('最大输出Token需为1–1,000,000的整数，或留空使用供应商默认值')
    metadata = bound_window(profile)
    for field, name in (('max_output_tokens','最大输出'),('context_window','上下文窗口')):
        limit = metadata.get(field)
        if type(limit) is int and limit > 0 and (value > limit or (field == 'context_window' and value == limit)):
            raise ParamUnsupportedError(f'最大输出Token超出最近读取的模型{name}（{limit:,}）；请降低设置或重新读取窗口信息')
    return value
