"""Recover complete editorial Markdown without weakening other JSON workflows.

Transport must already have confirmed finish_reason=stop. This module never
turns an ordinary discussion reply or a partial response into an article.
"""
from __future__ import annotations

import json
import re
from typing import Any

from .errors import SchemaInvalidError


def markdown_h1_titles(body: str) -> list[str]:
    titles: list[str] = []
    fence: str | None = None
    for line in body.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            character = marker.group(1)[0]
            fence = None if fence == character else character if fence is None else fence
            continue
        if fence is None:
            heading = re.match(r'^#\s+(.+)$', line)
            if heading:
                titles.append(heading.group(1).strip())
    return titles


def _objects(text: str) -> list[dict[str, Any]]:
    candidates = [*re.findall(r'```json\s*\n?(.*?)```', text, re.S | re.I), text]
    decoder = json.JSONDecoder()
    found: list[dict[str, Any]] = []
    for candidate in candidates:
        try:
            value = json.loads(candidate.strip())
        except json.JSONDecodeError:
            # decode one object, rather than taking the last brace in a code
            # sample or an explanatory suffix as part of the JSON document.
            for match in list(re.finditer(r'\{', candidate))[:100]:
                try:
                    value, _ = decoder.raw_decode(candidate[match.start():])
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and any(k in value for k in ('body', 'markdown', 'content', 'article', 'questions')):
                    found.append(value)
            continue
        if isinstance(value, dict):
            found.append(value)
    return found


def _article_markdown(body: str, title: str = '') -> tuple[str, str, list[str]]:
    supplied_title = bool(title.strip())
    body = body.strip().lstrip('\ufeff')
    wrapper = re.fullmatch(r'```(?:markdown|md)?\s*\n(.*?)\n```', body, re.S | re.I)
    notes: list[str] = []
    if wrapper:
        body = wrapper.group(1).strip()
        notes.append('已移除包裹整篇文章的 Markdown 围栏。')
    lines = body.splitlines()
    fence: str | None = None
    headings: list[tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            character = marker.group(1)[0]
            fence = None if fence == character else character if fence is None else fence
            continue
        if fence is None:
            heading = re.match(r'^(#{1,6})\s+(.+?)\s*#*\s*$', line)
            if heading:
                headings.append((index, heading))
    if not headings:
        if not title.strip():
            raise SchemaInvalidError('模型没有返回可识别的文章标题或 Markdown 正文；请补充主题后重试。')
        body = '# ' + title.strip() + '\n\n' + body
    else:
        first_index, first = headings[0]
        if not title.strip():
            title = first.group(2).strip()
        # Preserve an introduction as article content, but make the supplied
        # title the first line. Normalizing heading levels never touches code.
        prepend_title = first_index != 0 or (supplied_title and first.group(1) != '#')
        if not prepend_title:
            lines[0] = '# ' + title.strip()
        else:
            lines.insert(0, '# ' + title.strip() + '\n')
        for index, heading in headings:
            if heading.group(1) == '#' and (index != 0 or prepend_title):
                offset = 1 if prepend_title else 0
                lines[index + offset] = '## ' + heading.group(2).strip()
                notes.append('已把正文中的重复一级标题调整为二级标题。')
        body = '\n'.join(lines)
    return title.strip(), body, list(dict.fromkeys(notes))


def normalize_creative_output(text: str) -> tuple[dict[str, Any], list[str]]:
    text = text.strip().lstrip('\ufeff')
    if not text or len(text) > 180000:
        raise SchemaInvalidError('创作回复为空或超过长度上限，请缩小单次写作范围。')
    raw = text
    wrapper = re.fullmatch(r'```(?:markdown|md)?\s*\n(.*?)\n```', raw, re.S | re.I)
    if wrapper:
        raw = wrapper.group(1).strip()
    if re.match(r'^#{1,6}\s+\S', raw):
        title, body, notes = _article_markdown(raw)
        return {'reply': '初稿已生成，请审阅后选择是否保存。', 'title': title, 'body': body,
                'prompts': [], 'questions': []}, ['模型返回完整 Markdown，已在本地恢复为未保存的候选稿。', *notes]
    for value in _objects(text):
        nested = value.get('article')
        if isinstance(nested, dict):
            value = {**value, **nested}
        body = value.get('body', value.get('markdown', value.get('content', '')))
        if isinstance(body, dict):
            body = body.get('markdown', body.get('text', ''))
        questions = value.get('questions', [])
        if not isinstance(body, str) or not isinstance(value.get('title', ''), str):
            continue
        if not body.strip() and not questions:
            continue
        result = {**value, 'body': body, 'title': value.get('title', ''),
                  'reply': value.get('reply', '请先补充以下信息，再继续生成初稿。' if questions else '初稿已生成，请审阅后选择是否保存。'),
                  'prompts': value.get('prompts', []), 'questions': questions}
        notes: list[str] = []
        if body.strip() and not questions:
            result['title'], result['body'], notes = _article_markdown(body, result['title'])
        return result, notes
    # Only a recognisable Markdown document is eligible for local recovery;
    # raw conversational replies still follow structured repair/error handling.
    raise SchemaInvalidError('模型返回了文字，但没有返回 JSON 或带标题的完整 Markdown 初稿。')
