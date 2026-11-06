"""v3 文章文档规范值（ADR-018 / DOC-00）。

规范值是结构化文档 JSON（与 ProseMirror/Tiptap JSON 同形），Markdown 只是只读投影。
保存前统一经 normalize 校验：未知节点/标记/属性不会静默进入规范值，
而是转为 rawBlock（保留原文文本）或被拒绝。块级节点带稳定 id，供版本对比、
提案定位与图片顺序清单使用。
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any

from ..domain.types import sha256_json

SCHEMA_VERSION = 1
MAX_CONTENT_BYTES = 4_000_000
MAX_BLOCKS = 6000
MAX_TEXT = 400_000

# P2：排版主题。clean 输出与 v3.0 完全一致（旧文章交付不变）。
THEMES = ('clean', 'magazine', 'tech', 'warm')
CALLOUT_TONES = ('brand', 'info', 'tip', 'warn')
FONT_SIZES = (14, 15, 16, 17, 18)
LINE_HEIGHTS = (1.5, 1.6, 1.75, 1.8, 2.0)
PARAGRAPH_SPACINGS = (0, 8, 12, 16, 20, 24)
ALIGNS = ('left', 'center', 'right', 'justify')
INLINE_FONT_SIZES = ('12px', '13px', '14px', '15px', '16px', '17px', '18px', '20px', '22px', '24px')

# v3.2：默认正文字号与公众号编辑器一致（17px）；只影响新文章，已有文章的样式里都显式带着字号。
DEFAULT_STYLE = {'theme': 'clean', 'brandColor': '#2563eb', 'fontSize': 17,
                 'lineHeight': 1.75, 'paragraphSpacing': 16}
# 字间距（px）。为不改变已有文章的内容 hash，仅在用户设置过时才写入 style。
LETTER_SPACINGS = (0, 0.5, 1, 1.5, 2)
DEFAULT_LETTER_SPACING = 0.5
TITLE_LIMIT = 64          # 公众号标题上限（超出只提示，不阻止保存）
AUTHOR_LIMIT = 8          # 公众号作者上限
SUMMARY_LIMIT = 120       # 公众号摘要上限

_COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
_ID = re.compile(r'^[A-Za-z0-9_-]{4,40}$')
_RUN = re.compile(r'^run-[A-Za-z0-9_-]+$')
_SAFE_URL = re.compile(r'^(https?://|mailto:)', re.I)

BLOCK_TYPES = frozenset({'paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote',
                         'horizontalRule', 'codeBlock', 'articleImage', 'rawHtml', 'rawBlock',
                         'imageSlot', 'runOutput', 'callout', 'imageGroup'})
INLINE_TYPES = frozenset({'text', 'hardBreak'})
MARK_TYPES = frozenset({'bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle'})


class DocumentError(ValueError):
    pass


def block_id() -> str:
    return 'b' + uuid.uuid4().hex[:10]


def empty_content(style: dict | None = None) -> dict:
    return {'schema': SCHEMA_VERSION,
            'doc': {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': block_id()}}]},
            'style': normalize_style(style or {})}


def normalize_style(style: Any) -> dict:
    if not isinstance(style, dict):
        raise DocumentError('排版设置格式无效')
    out = dict(DEFAULT_STYLE)
    theme = style.get('theme', out['theme'])
    if theme not in THEMES:
        raise DocumentError('暂只支持一个主题')
    color = style.get('brandColor', out['brandColor'])
    if not isinstance(color, str) or not _COLOR.match(color):
        raise DocumentError('品牌色需为 #RRGGBB')
    size = style.get('fontSize', out['fontSize'])
    if size not in FONT_SIZES:
        raise DocumentError('正文字号不在可选范围')
    line = style.get('lineHeight', out['lineHeight'])
    if line not in LINE_HEIGHTS:
        raise DocumentError('行距不在可选范围')
    spacing = style.get('paragraphSpacing', out['paragraphSpacing'])
    if spacing not in PARAGRAPH_SPACINGS:
        raise DocumentError('段距不在可选范围')
    out.update(theme=theme, brandColor=color.lower(), fontSize=size, lineHeight=line, paragraphSpacing=spacing)
    if 'letterSpacing' in style:
        letter = style['letterSpacing']
        if letter not in LETTER_SPACINGS:
            raise DocumentError('字间距不在可选范围')
        out['letterSpacing'] = letter
    return out


def normalize_info(info: Any) -> dict:
    """文章设置（作者/摘要/原文链接/封面），随版本冻结、随交付输出。空值不写入。"""
    if info is None:
        return {}
    if not isinstance(info, dict):
        raise DocumentError('文章设置格式无效')
    out: dict = {}
    author = info.get('author', '')
    if not isinstance(author, str) or len(author.strip()) > 20:
        raise DocumentError('作者最多 20 字（公众号限 8 字）')
    if author.strip():
        out['author'] = author.strip()
    summary = info.get('summary', '')
    if not isinstance(summary, str) or len(summary.strip()) > SUMMARY_LIMIT:
        raise DocumentError(f'摘要最多 {SUMMARY_LIMIT} 字')
    if summary.strip():
        out['summary'] = summary.strip()
    source = info.get('sourceUrl', '')
    if not isinstance(source, str) or len(source) > 2000 or (source.strip() and not re.match(r'^https?://', source.strip(), re.I)):
        raise DocumentError('原文链接需为 http(s) 地址')
    if source.strip():
        out['sourceUrl'] = source.strip()
    cover = info.get('coverResourceId', '')
    if not isinstance(cover, str) or (cover and (not cover.startswith('resource-') or len(cover) > 80)):
        raise DocumentError('封面图片引用无效')
    if cover:
        out['coverResourceId'] = cover
    return out


class _Normalizer:
    def __init__(self):
        self.blocks = 0
        self.text = 0
        self.ids: set[str] = set()

    def _id(self, attrs: dict) -> str:
        value = attrs.get('id') if isinstance(attrs, dict) else None
        if not isinstance(value, str) or not _ID.match(value) or value in self.ids:
            value = block_id()
            while value in self.ids:
                value = block_id()
        self.ids.add(value)
        return value

    def marks(self, marks: Any) -> list[dict]:
        out = []
        if not isinstance(marks, list):
            return out
        seen = set()
        for mark in marks:
            if not isinstance(mark, dict) or mark.get('type') not in MARK_TYPES or mark['type'] in seen:
                continue
            kind = mark['type']
            attrs = mark.get('attrs') or {}
            if kind == 'link':
                href = attrs.get('href')
                if not isinstance(href, str) or not _SAFE_URL.match(href) or len(href) > 2000:
                    continue
                out.append({'type': 'link', 'attrs': {'href': href}})
            elif kind == 'textStyle':
                clean = {}
                color = attrs.get('color')
                if isinstance(color, str) and _COLOR.match(color):
                    clean['color'] = color.lower()
                size = attrs.get('fontSize')
                if size in INLINE_FONT_SIZES:
                    clean['fontSize'] = size
                background = attrs.get('backgroundColor')
                if isinstance(background, str) and _COLOR.match(background):
                    clean['backgroundColor'] = background.lower()
                if not clean:
                    continue
                out.append({'type': 'textStyle', 'attrs': clean})
            else:
                out.append({'type': kind})
            seen.add(kind)
        return out

    def inline(self, nodes: Any, *, allow_marks: bool = True) -> list[dict]:
        out: list[dict] = []
        if not isinstance(nodes, list):
            return out
        for node in nodes:
            if not isinstance(node, dict):
                continue
            kind = node.get('type')
            if kind == 'hardBreak':
                out.append({'type': 'hardBreak'})
            elif kind == 'text':
                text = node.get('text')
                if not isinstance(text, str) or not text:
                    continue
                self.text += len(text)
                item = {'type': 'text', 'text': text}
                marks = self.marks(node.get('marks')) if allow_marks else []
                if marks:
                    item['marks'] = marks
                out.append(item)
            else:
                # 行内未知节点只保留其文字，避免静默丢字。
                text = plain_text_of(node)
                if text:
                    self.text += len(text)
                    out.append({'type': 'text', 'text': text})
        return out

    def align(self, attrs: dict) -> str | None:
        value = attrs.get('textAlign')
        return value if value in ALIGNS and value != 'left' else None

    def block(self, node: Any) -> dict | None:
        if not isinstance(node, dict):
            return None
        self.blocks += 1
        if self.blocks > MAX_BLOCKS:
            raise DocumentError('文章块数量超过上限')
        kind = node.get('type')
        attrs = node.get('attrs') if isinstance(node.get('attrs'), dict) else {}
        if kind not in BLOCK_TYPES:
            text = plain_text_of(node)
            return {'type': 'rawBlock', 'attrs': {'id': self._id({}), 'source': text[:50000]}} if text else None
        out: dict = {'type': kind, 'attrs': {'id': self._id(attrs)}}
        if kind == 'paragraph':
            align = self.align(attrs)
            if align:
                out['attrs']['textAlign'] = align
            if attrs.get('indent') is True:
                out['attrs']['indent'] = True
            content = self.inline(node.get('content'))
            if content:
                out['content'] = content
        elif kind == 'heading':
            level = attrs.get('level', 2)
            out['attrs']['level'] = level if level in (1, 2, 3) else 2
            align = self.align(attrs)
            if align:
                out['attrs']['textAlign'] = align
            content = self.inline(node.get('content'))
            if content:
                out['content'] = content
        elif kind in ('bulletList', 'orderedList'):
            if kind == 'orderedList':
                start = attrs.get('start', 1)
                out['attrs']['start'] = start if isinstance(start, int) and 0 <= start < 100000 else 1
            items = []
            for item in node.get('content') or []:
                if not isinstance(item, dict) or item.get('type') != 'listItem':
                    continue
                inner = [b for b in (self.block(child) for child in item.get('content') or []) if b]
                if not inner:
                    inner = [{'type': 'paragraph', 'attrs': {'id': self._id({})}}]
                # listItem 第一个子块需为段落（Tiptap 约束）。
                if inner[0]['type'] != 'paragraph':
                    inner.insert(0, {'type': 'paragraph', 'attrs': {'id': self._id({})}})
                items.append({'type': 'listItem', 'content': inner})
            if not items:
                return None
            out['content'] = items
        elif kind == 'blockquote':
            inner = [b for b in (self.block(child) for child in node.get('content') or []) if b]
            out['content'] = inner or [{'type': 'paragraph', 'attrs': {'id': self._id({})}}]
        elif kind == 'horizontalRule':
            pass
        elif kind == 'codeBlock':
            language = attrs.get('language')
            if isinstance(language, str) and re.match(r'^[A-Za-z0-9_+-]{1,30}$', language):
                out['attrs']['language'] = language
            content = self.inline(node.get('content'), allow_marks=False)
            text = ''.join(c.get('text', '') for c in content if c['type'] == 'text')
            if text:
                out['content'] = [{'type': 'text', 'text': text}]
        elif kind == 'articleImage':
            resource = attrs.get('resourceId')
            if not isinstance(resource, str) or not resource.startswith('resource-') or len(resource) > 80:
                raise DocumentError('图片块缺少有效资源引用')
            caption = attrs.get('caption', '')
            width = attrs.get('width', 100)
            align = attrs.get('align', 'center')
            source = attrs.get('sourceUrl', '')
            alt = attrs.get('alt', '')
            if not isinstance(caption, str) or len(caption) > 300 or not isinstance(alt, str) or len(alt) > 300:
                raise DocumentError('图注最多 300 字')
            if not isinstance(width, int) or not 20 <= width <= 100:
                raise DocumentError('图片宽度需为 20%–100%')
            if align not in ('left', 'center', 'right'):
                align = 'center'
            if not isinstance(source, str) or len(source) > 2000 or (source and not _SAFE_URL.match(source)):
                source = ''
            out['attrs'].update(resourceId=resource, caption=caption.strip(), alt=alt.strip(),
                                width=width, align=align, sourceUrl=source)
        elif kind == 'callout':
            # P2 提示卡片：只容纳段落与列表，交付为带底色的卡片。
            tone = attrs.get('tone', 'brand')
            out['attrs']['tone'] = tone if tone in CALLOUT_TONES else 'brand'
            title = attrs.get('title', '')
            if isinstance(title, str) and title.strip():
                if len(title.strip()) > 60:
                    raise DocumentError('卡片标题最多 60 字')
                out['attrs']['title'] = title.strip()
            inner = [b for b in (self.block(child) for child in node.get('content') or []) if b
                     and b['type'] in ('paragraph', 'bulletList', 'orderedList')]
            out['content'] = inner or [{'type': 'paragraph', 'attrs': {'id': self._id({})}}]
        elif kind == 'imageGroup':
            # P2 多图并排：2–9 张，2 或 3 列。
            images = attrs.get('images')
            if not isinstance(images, list) or not 2 <= len(images) <= 9:
                raise DocumentError('多图组件需要 2–9 张图片')
            clean = []
            for item in images:
                resource = item.get('resourceId') if isinstance(item, dict) else None
                if not isinstance(resource, str) or not resource.startswith('resource-') or len(resource) > 80:
                    raise DocumentError('多图组件里有图片缺少有效资源引用')
                caption = item.get('caption', '')
                if not isinstance(caption, str) or len(caption) > 100:
                    raise DocumentError('多图的单图说明最多 100 字')
                clean.append({'resourceId': resource, 'caption': caption.strip()})
            columns = attrs.get('columns', 2)
            caption = attrs.get('caption', '')
            if not isinstance(caption, str) or len(caption) > 300:
                raise DocumentError('图注最多 300 字')
            out['attrs'].update(columns=columns if columns in (2, 3) else 2, images=clean, caption=caption.strip())
        elif kind == 'rawHtml':
            from .sanitize import sanitize_island
            html = attrs.get('html', '')
            if not isinstance(html, str) or len(html) > 400_000:
                raise DocumentError('未支持模块原文过大')
            reason = attrs.get('reason', '')
            out['attrs'].update(html=sanitize_island(html), reason=str(reason)[:200],
                                deliver=attrs.get('deliver') in ('html', 'text', 'omit') and attrs['deliver'] or 'text')
        elif kind == 'rawBlock':
            source = attrs.get('source', '')
            out['attrs']['source'] = source[:50000] if isinstance(source, str) else ''
        elif kind == 'imageSlot':
            figure = attrs.get('figureNo', 1)
            out['attrs'].update(figureNo=figure if isinstance(figure, int) and 0 < figure < 1000 else 1,
                                caption=str(attrs.get('caption', ''))[:300], kind=str(attrs.get('kind', '生图'))[:40],
                                obtain=str(attrs.get('obtain', '见配图方案表'))[:200])
        elif kind == 'runOutput':
            ref = attrs.get('runRef', '')
            out['attrs']['runRef'] = ref if isinstance(ref, str) and _RUN.match(ref) else ''
        return out


def normalize(content: Any) -> dict:
    """校验并规范化一份文档内容；返回新对象，不修改入参。"""
    if not isinstance(content, dict):
        raise DocumentError('文档内容格式无效')
    if len(json.dumps(content, ensure_ascii=False)) > MAX_CONTENT_BYTES:
        raise DocumentError('文章内容超过 4MB 上限')
    schema = content.get('schema', SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        raise DocumentError('文档格式版本过新，请升级应用后打开')
    doc = content.get('doc')
    if not isinstance(doc, dict) or doc.get('type') != 'doc':
        raise DocumentError('文档缺少正文')
    worker = _Normalizer()
    blocks = [b for b in (worker.block(node) for node in doc.get('content') or []) if b]
    if worker.text > MAX_TEXT:
        raise DocumentError('正文超过 40 万字上限')
    if not blocks:
        blocks = [{'type': 'paragraph', 'attrs': {'id': worker._id({})}}]
    out = {'schema': SCHEMA_VERSION, 'doc': {'type': 'doc', 'content': blocks},
           'style': normalize_style(content.get('style') or {})}
    info = normalize_info(content.get('info'))
    if info:
        out['info'] = info
    return out


def content_hash(content: dict) -> str:
    return sha256_json(content)


def plain_text_of(node: Any) -> str:
    if not isinstance(node, dict):
        return ''
    if node.get('type') == 'text':
        return node.get('text', '') if isinstance(node.get('text'), str) else ''
    if node.get('type') == 'hardBreak':
        return '\n'
    attrs = node.get('attrs') or {}
    if node.get('type') == 'rawBlock':
        return str(attrs.get('source', ''))
    if node.get('type') == 'callout':
        title = attrs.get('title') or ''
        body = '\n'.join(plain_text_of(child) for child in node.get('content') or [])
        return (title + '\n' + body) if title else body
    if node.get('type') == 'imageGroup':
        return ''
    if node.get('type') == 'rawHtml':
        from .sanitize import html_text
        return html_text(str(attrs.get('html', '')))
    return ''.join(plain_text_of(child) for child in node.get('content') or [])


def iter_blocks(content: dict):
    """深度优先遍历所有块（含列表、引用内部）。"""
    stack = list(reversed(content['doc']['content']))
    while stack:
        node = stack.pop()
        yield node
        if node.get('type') in ('bulletList', 'orderedList', 'listItem', 'blockquote', 'callout'):
            stack.extend(reversed(node.get('content') or []))


def image_refs(content: dict) -> list[dict]:
    out = []
    for node in iter_blocks(content):
        if node.get('type') == 'articleImage':
            out.append(dict(node['attrs']))
        elif node.get('type') == 'imageGroup':
            out.extend({'resourceId': item['resourceId'], 'caption': item.get('caption', ''), 'group': node['attrs'].get('id')}
                       for item in node['attrs'].get('images') or [])
    return out


def word_count(content: dict) -> int:
    text = ''.join(plain_text_of(node) for node in content['doc']['content'])
    cjk = len(re.findall(r'[㐀-鿿]', text))
    latin = len(re.findall(r'[A-Za-z0-9]+', text))
    return cjk + latin


def summary(content: dict, limit: int = 120) -> str:
    for node in content['doc']['content']:
        if node.get('type') in ('paragraph', 'blockquote', 'bulletList', 'orderedList'):
            text = re.sub(r'\s+', ' ', plain_text_of(node)).strip()
            if text:
                return text[:limit]
    return ''


def derive_title(content: dict) -> str:
    for node in content['doc']['content']:
        if node.get('type') == 'heading':
            text = plain_text_of(node).strip()
            if text:
                return text[:300]
    text = summary(content, 40)
    return text or '未命名文章'


def clone(content: dict) -> dict:
    return copy.deepcopy(content)
