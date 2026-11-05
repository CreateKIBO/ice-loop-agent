"""HTML 白名单清洗（未支持模块原文岛 / 粘贴导入 / 交付输出共用）。

只用标准库 html.parser：脚本、样式表、iframe、表单、事件属性、javascript: 链接、
CSS url()/expression 一律去除；保留的内联样式限定在交付安全的属性内。
清洗结果用于隔离预览与交付，不参与可编辑正文。
"""
from __future__ import annotations

import html as htmllib
import re
from html.parser import HTMLParser

ALLOWED_TAGS = frozenset({
    'section', 'div', 'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'br', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'code',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'img', 'a', 'figure', 'figcaption', 'mark', 'small', 'center'})
VOID_TAGS = frozenset({'br', 'hr', 'img', 'col'})
DROP_CONTENT = frozenset({'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
                          'form', 'textarea', 'select', 'button', 'svg', 'math', 'video', 'audio',
                          'canvas', 'head', 'title', 'meta', 'link'})
ALLOWED_ATTRS = {'a': {'href', 'title'}, 'img': {'src', 'alt', 'title', 'width', 'height', 'data-src'},
                 'td': {'colspan', 'rowspan'}, 'th': {'colspan', 'rowspan'}, 'ol': {'start'},
                 'col': {'span'}}
STYLE_PROPS = frozenset({
    'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-align',
    'text-decoration', 'line-height', 'letter-spacing', 'text-indent', 'margin', 'margin-top',
    'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom',
    'padding-left', 'padding-right', 'border', 'border-top', 'border-bottom', 'border-left',
    'border-right', 'border-radius', 'border-color', 'border-style', 'border-width', 'width',
    'max-width', 'height', 'display', 'vertical-align', 'white-space', 'word-break', 'box-sizing',
    'border-collapse', 'list-style-type'})
_BAD_CSS = re.compile(r'url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding', re.I)
_SAFE_HREF = re.compile(r'^(https?://|mailto:|#)', re.I)
_SAFE_SRC = re.compile(r'^https?://', re.I)


def clean_style(value: str) -> str:
    out = []
    for decl in value.split(';'):
        if ':' not in decl:
            continue
        prop, _, val = decl.partition(':')
        prop, val = prop.strip().lower(), val.strip()
        if prop in STYLE_PROPS and val and len(val) < 200 and not _BAD_CSS.search(val):
            out.append(f'{prop}:{val}')
    return ';'.join(out)


class _Sanitizer(HTMLParser):
    def __init__(self, *, keep_images: bool = True):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0
        self.stack: list[str] = []
        self.keep_images = keep_images
        self.dropped: dict[str, int] = {}

    def _drop(self, what: str):
        self.dropped[what] = self.dropped.get(what, 0) + 1

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT:
            if tag not in VOID_TAGS and tag not in ('meta', 'link'):
                self.skip += 1
            self._drop(tag)
            return
        if self.skip or tag not in ALLOWED_TAGS:
            if not self.skip and tag not in ('html', 'body', 'font', 'o:p', 'label', 'abbr', 'cite', 'ins', 'nav',
                                             'article', 'header', 'footer', 'main', 'aside'):
                self._drop(tag)
            return
        if tag == 'img' and not self.keep_images:
            self._drop('img')
            return
        kept = []
        allowed = ALLOWED_ATTRS.get(tag, set())
        for name, value in attrs:
            name = (name or '').lower()
            value = value or ''
            if name.startswith('on'):
                self._drop('event-attr')
                continue
            if name == 'style':
                style = clean_style(value)
                if style:
                    kept.append(('style', style))
            elif name in allowed:
                if name == 'href' and not _SAFE_HREF.match(value.strip()):
                    self._drop('unsafe-link')
                    continue
                if name in ('src', 'data-src') and not _SAFE_SRC.match(value.strip()):
                    self._drop('unsafe-src')
                    continue
                kept.append((name, value[:2000]))
        text = ''.join(f' {n}="{htmllib.escape(v, quote=True)}"' for n, v in kept)
        if tag == 'a':
            text += ' target="_blank" rel="noopener noreferrer"'
        self.out.append(f'<{tag}{text}>')
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS and self.stack and self.stack[-1] == tag.lower():
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT:
            if tag not in VOID_TAGS and tag not in ('meta', 'link'):
                self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                top = self.stack.pop()
                self.out.append(f'</{top}>')
                if top == tag:
                    break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(htmllib.escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.out.append(f'</{self.stack.pop()}>')
        return ''.join(self.out)


def sanitize_html(source: str, *, keep_images: bool = True) -> tuple[str, dict]:
    parser = _Sanitizer(keep_images=keep_images)
    parser.feed(source)
    parser.close()
    return parser.result(), parser.dropped


def sanitize_island(source: str) -> str:
    return sanitize_html(source)[0]


class _Text(HTMLParser):
    BLOCK = frozenset({'p', 'div', 'section', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                       'blockquote', 'pre', 'table', 'figure', 'figcaption', 'hr'})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in DROP_CONTENT and tag not in ('meta', 'link'):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append('\n')
        elif tag in ('td', 'th'):
            self.parts.append('\t')

    def handle_endtag(self, tag):
        if tag in DROP_CONTENT and tag not in ('meta', 'link'):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_text(source: str) -> str:
    parser = _Text()
    parser.feed(source)
    parser.close()
    text = ''.join(parser.parts)
    text = re.sub(r'[ \t\r\f\v\u00a0]+\n', '\n', text)
    text = re.sub(r'\n[\t ]+', '\n', text)
    text = re.sub(r'\n{2,}', '\n', text) if '\t' in text else re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()
