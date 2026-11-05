"""HTML/纯文本粘贴导入（B-03）。

两种模式：
- adapt：适配当前样式。受支持的结构/行内样式映射到文档块；复杂模块（表格、
  带背景/边框/多栏布局的 section、SVG 等）在编辑器过滤之前整体保存为 rawHtml
  只读原件岛，并在报告中列出。
- text：仅保留文字，所有结构降级为段落/换行。

图片：data: URI 交给调用方导入为资源；http(s)/file 等无法离线取得的图片不伪造，
转为“粘贴缺图”图位并在报告中列出来源，待用户替换。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Callable

from .sanitize import DROP_CONTENT, VOID_TAGS, clean_style, html_text, sanitize_html
from .schema import INLINE_FONT_SIZES, SCHEMA_VERSION, block_id, normalize, normalize_style
from .markdown_io import text_to_content

BLOCK_TAGS = frozenset({'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
                        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
                        'hr', 'table', 'figure', 'figcaption', 'center', 'body', 'html'})
COMPLEX_STYLE = re.compile(r'(background(-color|-image)?\s*:|border(-\w+)?\s*:\s*[^;]*\d|display\s*:\s*(flex|grid|inline-block)'
                           r'|float\s*:|position\s*:|transform\s*:|box-shadow\s*:)', re.I)
_COLOR_RGB = re.compile(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)')
_COLOR_HEX = re.compile(r'^#([0-9a-f]{3}|[0-9a-f]{6})$', re.I)


@dataclass
class El:
    tag: str
    attrs: dict
    children: list = field(default_factory=list)
    parent: 'El | None' = None

    @property
    def style(self) -> str:
        return self.attrs.get('style', '') or ''


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = El('root', {})
        self.cur = self.root
        self.skip = 0
        self.dropped: dict[str, int] = {}

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT and tag != 'svg':
            if tag not in ('meta', 'link'):
                self.skip += 1
            self.dropped[tag] = self.dropped.get(tag, 0) + 1
            return
        if self.skip:
            return
        node = El(tag, {k.lower(): (v or '') for k, v in attrs}, parent=self.cur)
        self.cur.children.append(node)
        if tag not in VOID_TAGS:
            self.cur = node

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT and tag != 'svg':
            if tag not in ('meta', 'link'):
                self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        node = self.cur
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.cur = node.parent

    def handle_data(self, data):
        if not self.skip and data:
            self.cur.children.append(data)

    def handle_comment(self, data):
        pass


def _serialize(node) -> str:
    if isinstance(node, str):
        from html import escape
        return escape(node, quote=False)
    from html import escape
    attrs = ''.join(f' {k}="{escape(v, quote=True)}"' for k, v in node.attrs.items())
    if node.tag in VOID_TAGS:
        return f'<{node.tag}{attrs}>'
    return f'<{node.tag}{attrs}>' + ''.join(_serialize(c) for c in node.children) + f'</{node.tag}>'


def _color(value: str) -> str | None:
    value = value.strip().lower()
    match = _COLOR_HEX.match(value)
    if match:
        raw = match.group(1)
        if len(raw) == 3:
            raw = ''.join(ch * 2 for ch in raw)
        return '#' + raw
    match = _COLOR_RGB.match(value)
    if match:
        return '#' + ''.join(f'{min(255, int(v)):02x}' for v in match.groups())
    return None


def _style_map(style: str) -> dict:
    out = {}
    for decl in style.split(';'):
        prop, _, val = decl.partition(':')
        if val:
            out[prop.strip().lower()] = val.strip()
    return out


def _font_size(value: str) -> str | None:
    match = re.match(r'^(\d+(?:\.\d+)?)px$', value.strip())
    if not match:
        return None
    px = round(float(match.group(1)))
    choices = [int(v[:-2]) for v in INLINE_FONT_SIZES]
    nearest = min(choices, key=lambda c: abs(c - px))
    return f'{nearest}px'


class Converter:
    def __init__(self, mode: str, import_image: Callable[[str, str], dict | None] | None, base_font: int = 16):
        self.mode = mode
        self.import_image = import_image
        self.base_font = base_font
        self.report = {'mode': mode, 'paragraphs': 0, 'headings': 0, 'lists': 0, 'quotes': 0,
                       'code_blocks': 0, 'images': {'total': 0, 'imported': 0, 'missing': []},
                       'islands': [], 'styles': {'mapped': 0, 'ignored': {}}, 'dropped': {},
                       'characters': 0}
        self.figure = 0

    # ---------------------------------------------------------------- inline
    def _marks_for(self, el: El, marks: list) -> list:
        tag = el.tag
        add = []
        if tag in ('strong', 'b'):
            add.append({'type': 'bold'})
        elif tag in ('em', 'i'):
            add.append({'type': 'italic'})
        elif tag == 'u':
            add.append({'type': 'underline'})
        elif tag in ('s', 'del', 'strike'):
            add.append({'type': 'strike'})
        elif tag == 'code':
            add.append({'type': 'code'})
        elif tag == 'a' and re.match(r'^(https?://|mailto:)', el.attrs.get('href', ''), re.I):
            add.append({'type': 'link', 'attrs': {'href': el.attrs['href'][:2000]}})
        style = _style_map(el.style)
        text_style = {}
        for prop, val in style.items():
            if prop == 'color':
                color = _color(val)
                if color and color not in ('#000000', '#333333', '#3f3f3f', '#222222'):
                    text_style['color'] = color
            elif prop == 'font-size':
                size = _font_size(val)
                if size and size != f'{self.base_font}px':
                    text_style['fontSize'] = size
            elif prop == 'font-weight' and (val == 'bold' or val.isdigit() and int(val) >= 600):
                add.append({'type': 'bold'})
            elif prop == 'font-style' and val == 'italic':
                add.append({'type': 'italic'})
            elif prop == 'text-decoration' and 'underline' in val:
                add.append({'type': 'underline'})
            elif prop in ('text-align', 'line-height', 'margin', 'padding', 'letter-spacing', 'font-family',
                          'margin-top', 'margin-bottom', 'text-indent', 'white-space', 'word-break',
                          'box-sizing', 'max-width', 'visibility', 'caret-color', 'outline'):
                continue
            elif self.mode == 'adapt':
                key = prop.split('-')[0] if prop.startswith(('background', 'border')) else prop
                ignored = self.report['styles']['ignored']
                ignored[key] = ignored.get(key, 0) + 1
        if text_style and self.mode == 'adapt':
            add.append({'type': 'textStyle', 'attrs': text_style})
        if self.mode == 'text':
            add = []
        if add:
            self.report['styles']['mapped'] += len(add)
        merged = {m['type']: m for m in marks}
        for mark in add:
            if mark['type'] == 'textStyle' and 'textStyle' in merged:
                merged['textStyle'] = {'type': 'textStyle', 'attrs': {**merged['textStyle']['attrs'], **mark['attrs']}}
            else:
                merged[mark['type']] = mark
        return list(merged.values())

    def inline(self, nodes: list, marks: list | None = None) -> list[dict]:
        out: list[dict] = []
        marks = marks or []
        for node in nodes:
            if isinstance(node, str):
                text = re.sub(r'[\r\n\t ]+', ' ', node.replace('​', '').replace('﻿', ''))
                if text:
                    item = {'type': 'text', 'text': text}
                    if marks:
                        item['marks'] = [dict(m) for m in marks]
                    out.append(item)
                continue
            if node.tag == 'br':
                out.append({'type': 'hardBreak'})
            elif node.tag == 'img':
                continue
            else:
                out.extend(self.inline(node.children, self._marks_for(node, marks)))
        return out

    @staticmethod
    def _trim(content: list[dict]) -> list[dict]:
        while content and content[0]['type'] == 'text' and not content[0]['text'].strip():
            content.pop(0)
        while content and content[-1]['type'] == 'text' and not content[-1]['text'].strip():
            content.pop()
        while content and content[-1]['type'] == 'hardBreak':
            content.pop()
        if content and content[0]['type'] == 'text':
            content[0]['text'] = content[0]['text'].lstrip()
        if content and content[-1]['type'] == 'text':
            content[-1]['text'] = content[-1]['text'].rstrip()
        return [c for c in content if c['type'] != 'text' or c['text']]

    # ---------------------------------------------------------------- blocks
    def _align(self, el: El) -> str | None:
        style = _style_map(el.style)
        align = style.get('text-align', el.attrs.get('align', '')).lower()
        if el.tag == 'center':
            align = 'center'
        return align if align in ('center', 'right', 'justify') and self.mode == 'adapt' else None

    def _paragraph(self, content: list[dict], el: El | None) -> dict | None:
        content = self._trim(content)
        if not content:
            return None
        node = {'type': 'paragraph', 'attrs': {'id': block_id()}, 'content': content}
        align = self._align(el) if el is not None else None
        if align:
            node['attrs']['textAlign'] = align
        self.report['paragraphs'] += 1
        self.report['characters'] += sum(len(c.get('text', '')) for c in content)
        return node

    def _image(self, el: El) -> dict | None:
        src = el.attrs.get('src') or el.attrs.get('data-src') or ''
        alt = (el.attrs.get('alt') or el.attrs.get('title') or '').strip()[:300]
        self.report['images']['total'] += 1
        self.figure += 1
        if self.mode == 'text':
            self.report['images']['missing'].append({'src': src[:300] if not src.startswith('data:') else 'data:…',
                                                     'alt': alt, 'reason': '仅文字模式不保留图片'})
            return None
        resource = self.import_image(src, alt) if self.import_image and src else None
        if resource:
            self.report['images']['imported'] += 1
            return {'type': 'articleImage', 'attrs': {'id': block_id(), 'resourceId': resource['resource_id'],
                    'caption': alt, 'alt': alt, 'width': 100, 'align': 'center',
                    'sourceUrl': src if src.startswith('http') else ''}}
        reason = '远程图片需下载后替换' if src.startswith('http') else '本地/剪贴板图片无法读取，请重新插入'
        self.report['images']['missing'].append({'src': src[:300] if not src.startswith('data:') else 'data:…',
                                                 'alt': alt, 'reason': reason})
        return {'type': 'imageSlot', 'attrs': {'id': block_id(), 'figureNo': self.figure,
                'caption': alt or f'粘贴图片 {self.figure}', 'kind': '粘贴缺图',
                'obtain': (src[:180] if src.startswith('http') else reason)}}

    def _island(self, el: El, reason: str) -> list[dict]:
        if self.mode == 'text':
            return self._text_blocks(el)
        def report_images(node):
            if isinstance(node, str):
                return
            if node.tag == 'img':
                src = node.attrs.get('src') or node.attrs.get('data-src') or ''
                self.report['images']['total'] += 1
                self.report['images']['missing'].append({
                    'src': 'data:…' if src.startswith('data:') else src[:300],
                    'alt': node.attrs.get('alt', '')[:300],
                    'reason': '未支持模块内的图片未归档，请在正文中独立插入图片'})
            for child in node.children:
                report_images(child)
        report_images(el)
        html, dropped = sanitize_html(_serialize(el))
        for key, value in dropped.items():
            self.report['dropped'][key] = self.report['dropped'].get(key, 0) + value
        text = html_text(html)
        self.report['characters'] += len(text)
        self.report['islands'].append({'reason': reason, 'preview': text[:80]})
        return [{'type': 'rawHtml', 'attrs': {'id': block_id(), 'html': html, 'reason': reason,
                 'deliver': 'html' if el.tag == 'table' else 'text'}}]

    def _text_blocks(self, el: El) -> list[dict]:
        text = html_text(_serialize(el))
        out = []
        for chunk in re.split(r'\n\s*\n|\n', text):
            if chunk.strip():
                block = self._paragraph([{'type': 'text', 'text': chunk.strip()}], None)
                if block:
                    out.append(block)
        return out

    def _is_complex(self, el: El) -> str | None:
        if el.tag == 'table':
            return '表格'
        if el.tag == 'svg':
            return 'SVG 图形'
        if el.tag in ('section', 'div') and COMPLEX_STYLE.search(el.style):
            has_block = any(not isinstance(c, str) and c.tag in BLOCK_TAGS | {'img'} for c in el.children)
            if has_block:
                return '带背景/边框/多栏布局的样式模块'
        return None

    def blocks(self, nodes: list, parent: El | None = None) -> list[dict]:
        out: list[dict] = []
        pending: list = []

        def flush():
            if pending:
                block = self._paragraph(self.inline(pending), parent if parent is not None and parent.tag in ('p', 'div', 'section', 'center') else None)
                if block:
                    out.append(block)
                pending.clear()

        for node in nodes:
            if isinstance(node, str) or (node.tag not in BLOCK_TAGS and node.tag not in ('img', 'svg') and not self._has_block(node)):
                if not isinstance(node, str) and node.tag == 'img':
                    pass
                pending.append(node)
                continue
            flush()
            out.extend(self.block(node))
        flush()
        return out

    def _has_block(self, el: El) -> bool:
        for child in el.children:
            if isinstance(child, str):
                continue
            if child.tag in BLOCK_TAGS or child.tag in ('img', 'svg') or self._has_block(child):
                return True
        return False

    def block(self, el: El) -> list[dict]:
        tag = el.tag
        if self.mode == 'adapt':
            reason = self._is_complex(el)
            if reason:
                return self._island(el, reason)
        elif tag in ('table', 'svg'):
            return self._text_blocks(el)
        if tag == 'img':
            image = self._image(el)
            return [image] if image else []
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            content = self._trim(self.inline(el.children))
            if not content:
                return []
            self.report['characters'] += sum(len(c.get('text', '')) for c in content)
            if self.mode == 'text':
                self.report['paragraphs'] += 1
                return [{'type': 'paragraph', 'attrs': {'id': block_id()}, 'content': content}]
            self.report['headings'] += 1
            node = {'type': 'heading', 'attrs': {'id': block_id(), 'level': min(3, int(tag[1]))}, 'content': content}
            align = self._align(el)
            if align:
                node['attrs']['textAlign'] = align
            return [node]
        if tag in ('ul', 'ol'):
            items = []
            for child in el.children:
                if isinstance(child, str):
                    continue
                inner = self.blocks(child.children, child) if child.tag == 'li' else self.block(child)
                if inner:
                    items.append(inner)
            if self.mode == 'text':
                flat = []
                for index, inner in enumerate(items):
                    prefix = f'{index + 1}. ' if tag == 'ol' else '· '
                    for b in inner:
                        if b['type'] == 'paragraph':
                            b['content'].insert(0, {'type': 'text', 'text': prefix})
                            prefix = ''
                        flat.append(b)
                return flat
            if not items:
                return []
            self.report['lists'] += 1
            return [{'type': 'bulletList' if tag == 'ul' else 'orderedList', 'attrs': {'id': block_id()},
                     'content': [{'type': 'listItem', 'content': inner} for inner in items]}]
        if tag == 'blockquote':
            inner = self.blocks(el.children, el)
            if self.mode == 'text' or not inner:
                return inner
            self.report['quotes'] += 1
            return [{'type': 'blockquote', 'attrs': {'id': block_id()}, 'content': inner}]
        if tag == 'pre':
            text = html_text(_serialize(el)) if self.mode == 'text' else ''.join(_texts(el))
            if not text.strip():
                return []
            self.report['characters'] += len(text)
            if self.mode == 'text':
                return self._text_blocks(el)
            self.report['code_blocks'] += 1
            return [{'type': 'codeBlock', 'attrs': {'id': block_id()}, 'content': [{'type': 'text', 'text': text.rstrip()}]}]
        if tag == 'hr':
            return [] if self.mode == 'text' else [{'type': 'horizontalRule', 'attrs': {'id': block_id()}}]
        # 容器（p/div/section/figure/li…）：递归。
        return self.blocks(el.children, el)


def _texts(el: El):
    for child in el.children:
        if isinstance(child, str):
            yield child
        elif child.tag == 'br':
            yield '\n'
        else:
            yield from _texts(child)


def convert_html(html: str, *, mode: str = 'adapt', style: dict | None = None,
                 import_image: Callable[[str, str], dict | None] | None = None) -> tuple[dict, dict]:
    if mode not in ('adapt', 'text'):
        raise ValueError('粘贴模式应为“适配当前样式”或“仅保留文字”')
    if not isinstance(html, str) or len(html) > 8_000_000:
        raise ValueError('粘贴内容过大（上限约 8MB）')
    tree = _Tree()
    tree.feed(html)
    tree.close()
    style = normalize_style(style or {})
    worker = Converter(mode, import_image, style['fontSize'])
    blocks = worker.blocks(tree.root.children)
    worker.report['dropped'].update({k: worker.report['dropped'].get(k, 0) + v for k, v in tree.dropped.items()})
    content = normalize({'schema': SCHEMA_VERSION, 'doc': {'type': 'doc', 'content': blocks}, 'style': style})
    return content, worker.report


def convert_text(text: str, *, style: dict | None = None) -> tuple[dict, dict]:
    if not isinstance(text, str) or len(text) > 2_000_000:
        raise ValueError('粘贴文本过大')
    content = text_to_content(text, style)
    paragraphs = len(content['doc']['content'])
    report = {'mode': 'text', 'paragraphs': paragraphs, 'headings': 0, 'lists': 0, 'quotes': 0,
              'code_blocks': 0, 'images': {'total': 0, 'imported': 0, 'missing': []}, 'islands': [],
              'styles': {'mapped': 0, 'ignored': {}}, 'dropped': {}, 'characters': len(text.strip())}
    return content, report
