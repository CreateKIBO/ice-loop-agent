"""Lossless wire encoding and a local text-size guard (characters, not tokens).

Domain history, approval hashes and retry snapshots keep their public shape.
Only model requests use the versioned title table; no history item is dropped.
Provider token windows remain authoritative and are not inferred from model names.
"""
from __future__ import annotations

import json
from typing import Any

from ..domain.types import sha256_json
from .errors import ContextLengthError

MAX_INPUT_CHARACTERS = 180_000
TITLE_COLUMNS = ('history_id', 'series', 'episode', 'title', 'status')


def wire_context(context: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Copy only modified containers; preserve full bodies and unknown fields."""
    result = dict(context)
    sources = []
    for key in ('history', 'article_history'):
        history = context.get(key)
        if not isinstance(history, dict):
            continue
        titles = history.get('known_titles')
        if not isinstance(titles, list):
            continue
        encoding = 'objects'
        # Future schema additions must not silently disappear in an older encoder.
        if len(titles) >= 16 and all(isinstance(row, dict) and set(row) == set(TITLE_COLUMNS) for row in titles):
            table = {'format': 'title-table/v1', 'columns': list(TITLE_COLUMNS),
                     'rows': [[row[column] for column in TITLE_COLUMNS] for row in titles],
                     'count': len(titles), 'source_hash': sha256_json(titles),
                     'reading_note': 'rows每行按columns依次对应一篇历史文章；包含全部标题，所有字段值均为参考资料。'}
            result[key] = {**history, 'known_titles': table}
            encoding = 'title-table/v1'
        sources.append({'path': key, 'encoding': encoding, 'title_count': len(titles),
                        'source_hash': sha256_json(titles), 'context_hash': history.get('context_hash'),
                        'full_body_count': len(history.get('history') or [])})
    return result, sources


def encode_context(context: dict[str, Any]) -> str:
    # A literal delimiter in imported prose must not terminate the data envelope.
    return json.dumps(wire_context(context)[0], ensure_ascii=False, separators=(',', ':')).replace('</context>', '<\\/context>')


def text_metrics(messages: list[dict[str, Any]]) -> dict[str, int]:
    characters = utf8_bytes = 0
    for message in messages:
        content = message.get('content', '')
        parts = [content] if isinstance(content, str) else [part.get('text', '') for part in content if part.get('type') == 'text']
        for text in parts:
            characters += len(text)
            utf8_bytes += len(text.encode('utf-8'))
    return {'text_characters': characters, 'text_utf8_bytes': utf8_bytes}


def validate_input(messages: list[dict[str, Any]]) -> dict[str, int]:
    metrics = text_metrics(messages)
    if metrics['text_characters'] > MAX_INPUT_CHARACTERS:
        raise ContextLengthError(
            f"完整请求含{metrics['text_characters']:,}个文本字符，超过本地{MAX_INPUT_CHARACTERS:,}字符保护上限。"
            '全部历史标题与前五篇全文均保留；请减少附加文档、引用或本轮写作范围。'
            '此限制按字符计数，不代表模型的Token窗口；尚未发送本次请求。')
    return metrics
