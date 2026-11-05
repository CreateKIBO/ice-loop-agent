"""Markdown ⇄ 文档 JSON。

md_to_content：旧稿/纯文本/模型输出接入（一次性转换为新规范值）。
content_to_md：只读投影，供 AI 上下文、纯文本交付与“源码查看”使用；投影丢失
局部字号/颜色等样式属于已知限制（见 ADR-018），投影结果不能再作为规范值保存回去，
除非用户明确选择“以 Markdown 重建正文”（视为一次新的导入）。
"""
from __future__ import annotations

import re
from urllib.parse import unquote

from markdown_it import MarkdownIt
from markdown_it.tree import SyntaxTreeNode

from .sanitize import sanitize_html
from .schema import SCHEMA_VERSION, block_id, normalize, normalize_style

_MD = MarkdownIt('commonmark', {'html': True}).enable(['table', 'strikethrough'])
PLACEHOLDER_RE = re.compile(r'^!\[图(\d+)：(.+?)\]\(待配图：(.+?)｜(.+?)\)\s*$')
RUN_OUTPUT_RE = re.compile(r'^<!--RUN_OUTPUT:(run-[A-Za-z0-9_-]+)-->\s*$')
RESOURCE_SRC = re.compile(r'^resource:(resource-[A-Za-z0-9_-]+)$')

_MARKS = {'strong': 'bold', 'em': 'italic', 's': 'strike'}


def _inline(node: SyntaxTreeNode, marks: tuple = ()) -> list[dict]:
    out: list[dict] = []
    for child in node.children:
        kind = child.type
        if kind == 'text':
            if child.content:
                item = {'type': 'text', 'text': child.content}
                if marks:
                    item['marks'] = [dict(m) for m in marks]
                out.append(item)
        elif kind in ('softbreak', 'hardbreak'):
            out.append({'type': 'hardBreak'})
        elif kind == 'code_inline':
            out.append({'type': 'text', 'text': child.content, 'marks': [*map(dict, marks), {'type': 'code'}]})
        elif kind in _MARKS:
            out.extend(_inline(child, marks + ({'type': _MARKS[kind]},)))
        elif kind == 'link':
            href = str(child.attrs.get('href', ''))
            out.extend(_inline(child, marks + ({'type': 'link', 'attrs': {'href': href}},)))
        elif kind == 'image':
            alt = ''.join(c.content for c in child.children if c.type == 'text')
            out.append({'type': 'text', 'text': f'[图片：{alt or "未命名"}]'})
        elif kind == 'html_inline':
            continue
        else:
            out.extend(_inline(child, marks))
    return out


def _paragraph(node: SyntaxTreeNode, source_lines: list[str]) -> dict:
    inline = node.children[0] if node.children else None
    if inline is not None and len(inline.children) == 1 and inline.children[0].type == 'image':
        image = inline.children[0]
        src = unquote(str(image.attrs.get('src', '')))
        alt = ''.join(c.content for c in image.children if c.type == 'text')
        match = re.match(r'^图(\d+)：(.+)$', alt)
        if src.startswith('待配图：') and match:
            rest = src[len('待配图：'):]
            kind, _, obtain = rest.partition('｜')
            return {'type': 'imageSlot', 'attrs': {'id': block_id(), 'figureNo': int(match.group(1)),
                    'caption': match.group(2), 'kind': kind.strip() or '生图',
                    'obtain': (obtain or '见配图方案表').strip()}}
        resource = RESOURCE_SRC.match(src)
        if resource:
            return {'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': resource.group(1),
                    'caption': alt, 'alt': alt, 'width': 100, 'align': 'center', 'sourceUrl': ''}}
        # 外链/本地路径图片：不伪造资源，保留为待处理文本块。
        return {'type': 'rawBlock', 'attrs': {'id': block_id(), 'source': f'![{alt}]({src})'}}
    text = ''.join(c.content for c in (inline.children if inline else []) if c.type == 'text').strip()
    slot = PLACEHOLDER_RE.match(text)
    if slot:
        return {'type': 'imageSlot', 'attrs': {'id': block_id(), 'figureNo': int(slot.group(1)),
                'caption': slot.group(2), 'kind': slot.group(3), 'obtain': slot.group(4)}}
    out = {'type': 'paragraph', 'attrs': {'id': block_id()}}
    content = _inline(inline) if inline else []
    if content:
        out['content'] = content
    return out


def _source(node: SyntaxTreeNode, lines: list[str]) -> str:
    start, end = node.map or (0, 0)
    return '\n'.join(lines[start:end])


def _blocks(nodes, lines: list[str]) -> list[dict]:
    out: list[dict] = []
    for node in nodes:
        kind = node.type
        if kind == 'heading':
            level = min(3, int(node.tag[1]))
            item = {'type': 'heading', 'attrs': {'id': block_id(), 'level': level}}
            content = _inline(node.children[0]) if node.children else []
            if content:
                item['content'] = content
            out.append(item)
        elif kind == 'paragraph':
            out.append(_paragraph(node, lines))
        elif kind in ('bullet_list', 'ordered_list'):
            items = []
            for li in node.children:
                inner = _blocks(li.children, lines)
                items.append({'type': 'listItem', 'content': inner or [{'type': 'paragraph', 'attrs': {'id': block_id()}}]})
            item = {'type': 'bulletList' if kind == 'bullet_list' else 'orderedList', 'attrs': {'id': block_id()},
                    'content': items}
            if kind == 'ordered_list':
                start = node.attrs.get('start', 1)
                item['attrs']['start'] = int(start) if str(start).isdigit() else 1
            out.append(item)
        elif kind == 'blockquote':
            out.append({'type': 'blockquote', 'attrs': {'id': block_id()}, 'content': _blocks(node.children, lines)})
        elif kind == 'hr':
            out.append({'type': 'horizontalRule', 'attrs': {'id': block_id()}})
        elif kind in ('fence', 'code_block'):
            item = {'type': 'codeBlock', 'attrs': {'id': block_id()}}
            language = (node.info or '').strip().split(' ')[0] if kind == 'fence' else ''
            if language:
                item['attrs']['language'] = language
            text = node.content.rstrip('\n')
            if text:
                item['content'] = [{'type': 'text', 'text': text}]
            out.append(item)
        elif kind == 'html_block':
            raw = node.content.strip()
            run = RUN_OUTPUT_RE.match(raw)
            if run:
                out.append({'type': 'runOutput', 'attrs': {'id': block_id(), 'runRef': run.group(1)}})
            elif raw.startswith('<!--') and raw.endswith('-->'):
                continue
            else:
                html, _ = sanitize_html(raw)
                out.append({'type': 'rawHtml', 'attrs': {'id': block_id(), 'html': html,
                            'reason': 'Markdown 中的 HTML 片段', 'deliver': 'text'}})
        elif kind == 'table':
            html, _ = sanitize_html(_MD.render(_source(node, lines)))
            out.append({'type': 'rawHtml', 'attrs': {'id': block_id(), 'html': html,
                        'reason': '表格（只读原件，交付时按设置输出）', 'deliver': 'html'}})
        else:
            text = _source(node, lines)
            if text.strip():
                out.append({'type': 'rawBlock', 'attrs': {'id': block_id(), 'source': text}})
    return out


def md_to_content(markdown: str, style: dict | None = None) -> dict:
    if not isinstance(markdown, str):
        raise ValueError('Markdown 正文应为文本')
    lines = markdown.split('\n')
    tree = SyntaxTreeNode(_MD.parse(markdown))
    blocks = _blocks(tree.children, lines)
    return normalize({'schema': SCHEMA_VERSION, 'doc': {'type': 'doc', 'content': blocks},
                      'style': normalize_style(style or {})})


def text_to_content(text: str, style: dict | None = None) -> dict:
    """纯文本：空行分段，单换行保留为行内换行；不解释任何 Markdown 语法。"""
    blocks = []
    for chunk in re.split(r'\n\s*\n', text.replace('\r\n', '\n').strip()):
        if not chunk.strip():
            continue
        content = []
        for index, line in enumerate(chunk.split('\n')):
            if index:
                content.append({'type': 'hardBreak'})
            if line:
                content.append({'type': 'text', 'text': line})
        blocks.append({'type': 'paragraph', 'attrs': {'id': block_id()}, 'content': content})
    return normalize({'schema': SCHEMA_VERSION, 'doc': {'type': 'doc', 'content': blocks},
                      'style': normalize_style(style or {})})


# ------------------------------------------------------------------ 投影

def _escape(text: str) -> str:
    return re.sub(r'([\\`*_\[\]<>])', r'\\\1', text)


def _inline_md(nodes: list[dict] | None) -> str:
    out = []
    for node in nodes or []:
        if node['type'] == 'hardBreak':
            out.append('  \n')
            continue
        text = node.get('text', '')
        marks = {m['type']: m for m in node.get('marks', [])}
        if 'code' in marks:
            text = '`' + text.replace('`', '\\`') + '`'
        else:
            text = _escape(text)
        if 'bold' in marks:
            text = f'**{text}**'
        if 'italic' in marks:
            text = f'*{text}*'
        if 'strike' in marks:
            text = f'~~{text}~~'
        if 'link' in marks:
            text = f"[{text}]({marks['link']['attrs']['href']})"
        out.append(text)
    return ''.join(out)


def _block_md(node: dict, indent: str = '') -> str:
    kind, attrs = node['type'], node.get('attrs', {})
    if kind == 'paragraph':
        return indent + _inline_md(node.get('content')).replace('\n', '\n' + indent)
    if kind == 'heading':
        return '#' * attrs.get('level', 2) + ' ' + _inline_md(node.get('content'))
    if kind in ('bulletList', 'orderedList'):
        lines = []
        start = attrs.get('start', 1)
        for index, item in enumerate(node.get('content') or []):
            bullet = '- ' if kind == 'bulletList' else f'{start + index}. '
            inner = [_block_md(child, '') for child in item.get('content') or []]
            text = '\n\n'.join(inner).replace('\n', '\n' + ' ' * len(bullet))
            lines.append(indent + bullet + text)
        return '\n'.join(lines)
    if kind == 'blockquote':
        inner = '\n\n'.join(_block_md(child) for child in node.get('content') or [])
        return '\n'.join('> ' + line if line else '>' for line in inner.split('\n'))
    if kind == 'horizontalRule':
        return '---'
    if kind == 'codeBlock':
        text = ''.join(c.get('text', '') for c in node.get('content') or [])
        fence = '````' if '```' in text else '```'
        return f"{fence}{attrs.get('language', '')}\n{text}\n{fence}"
    if kind == 'articleImage':
        return f"![{attrs.get('caption', '')}](resource:{attrs['resourceId']})"
    if kind == 'imageSlot':
        return f"![图{attrs['figureNo']}：{attrs['caption']}](待配图：{attrs['kind']}｜{attrs['obtain']})"
    if kind == 'runOutput':
        return f"<!--RUN_OUTPUT:{attrs['runRef']}-->"
    if kind == 'rawHtml':
        return attrs.get('html', '')
    if kind == 'rawBlock':
        return attrs.get('source', '')
    return ''


def content_to_md(content: dict) -> str:
    parts = [_block_md(node) for node in content['doc']['content']]
    return '\n\n'.join(p for p in parts if p is not None).strip() + '\n'
