"""统一交付渲染（B-02/B-04）。

同一冻结版本 → 内联样式 HTML（供复制到公众号编辑器）、纯文本、图片顺序清单、问题列表。
三者来自同一次遍历，图片序号一致；delivery_hash 绑定版本内容、图片字节 hash 与渲染器版本。
这里不预设公众号后台的人工上传限制：只登记每张图的格式/大小/像素，供实测后再配置。
"""
from __future__ import annotations

import base64
import html as htmllib
import io
import re
from typing import Any, Callable

from ..domain.types import sha256_json
from .sanitize import html_text, sanitize_html
from .schema import plain_text_of

RENDERER_VERSION = 'wx-inline-1'


def _lighten(hex_color: str, amount: float) -> str:
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    mix = lambda c: round(c + (255 - c) * amount)
    return f'#{mix(r):02x}{mix(g):02x}{mix(b):02x}'


CALLOUT_COLORS = {'info': ('#eff6ff', '#2563eb'), 'tip': ('#ecfdf5', '#059669'), 'warn': ('#fffbeb', '#d97706')}


def theme_styles(style: dict) -> dict[str, str]:
    """各主题的内联样式。clean 与 v3.0 输出逐字一致；其他主题只覆盖少数元素。"""
    css = _clean_styles(style)
    brand, size, gap = style['brandColor'], style['fontSize'], style['paragraphSpacing']
    soft = _lighten(brand, 0.9)
    theme = style.get('theme', 'clean')
    if theme == 'magazine':
        css.update(
            h1=f'margin:{gap + 12}px 0 {gap}px 0;font-size:{size + 8}px;line-height:1.4;font-weight:bold;color:#111827;text-align:center;',
            h2=f'margin:{gap + 12}px 0 {gap}px 0;font-size:{size + 3}px;line-height:1.5;font-weight:bold;color:#111827;'
               f'text-align:center;border-bottom:1px solid {brand};padding-bottom:8px;',
            h3=f'margin:{gap + 6}px 0 {max(8, gap - 4)}px 0;font-size:{size + 1}px;line-height:1.5;font-weight:bold;color:{brand};',
            blockquote=f'margin:0 0 {gap}px 0;padding:12px 18px;border-left:0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;'
                       f'color:#4b5563;font-style:italic;text-align:center;',
            hr=f'margin:{gap + 12}px auto;width:30%;border:0;border-top:2px solid {brand};')
    elif theme == 'tech':
        css.update(
            h1=f'margin:{gap + 8}px 0 {gap}px 0;font-size:{size + 7}px;line-height:1.4;font-weight:bold;color:#0f172a;',
            h2=f'margin:{gap + 10}px 0 {gap}px 0;font-size:{size + 3}px;line-height:1.5;font-weight:bold;color:#ffffff;'
               f'background-color:{brand};padding:4px 12px;border-radius:4px;display:inline-block;',
            h3=f'margin:{gap + 4}px 0 {max(8, gap - 4)}px 0;font-size:{size + 1}px;line-height:1.5;font-weight:bold;color:{brand};'
               f'border-bottom:2px solid {soft};padding-bottom:4px;',
            blockquote=f'margin:0 0 {gap}px 0;padding:10px 14px;border-left:4px solid {brand};background-color:#f1f5f9;color:#334155;',
            pre=f'margin:0 0 {gap}px 0;padding:14px 16px;background-color:#0f172a;border-radius:8px;font-size:13px;'
                'line-height:1.65;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Consolas,monospace;color:#e2e8f0;',
            code=f'padding:1px 5px;background-color:#f1f5f9;border-radius:4px;font-size:0.9em;font-family:Menlo,Consolas,monospace;color:#be185d;')
    elif theme == 'warm':
        warm = _lighten(brand, 0.94)
        css.update(
            root=css['root'].replace('color:#333333;', 'color:#3f3a36;'),
            h1=f'margin:{gap + 8}px 0 {gap}px 0;font-size:{size + 7}px;line-height:1.45;font-weight:bold;color:#3f3a36;',
            h2=f'margin:{gap + 10}px 0 {gap}px 0;font-size:{size + 3}px;line-height:1.5;font-weight:bold;color:{brand};'
               f'background-color:{warm};padding:6px 12px;border-radius:12px;',
            h3=f'margin:{gap + 4}px 0 {max(8, gap - 4)}px 0;font-size:{size + 1}px;line-height:1.5;font-weight:bold;color:#3f3a36;',
            blockquote=f'margin:0 0 {gap}px 0;padding:12px 16px;border-left:0;border-radius:12px;background-color:#faf6f0;color:#5b524b;',
            figure=f'margin:0 0 {gap}px 0;text-align:center;',
            img='display:block;margin:0 auto;max-width:100%;height:auto;border-radius:8px;')
    return css


def _clean_styles(style: dict) -> dict[str, str]:
    brand = style['brandColor']
    size = style['fontSize']
    line = style['lineHeight']
    gap = style['paragraphSpacing']
    soft = _lighten(brand, 0.9)
    return {
        'root': f'font-size:{size}px;line-height:{line};color:#333333;letter-spacing:{style.get("letterSpacing", 0.5)}px;word-break:break-word;',
        'p': f'margin:0 0 {gap}px 0;',
        'h1': f'margin:{gap + 8}px 0 {gap}px 0;font-size:{size + 8}px;line-height:1.4;font-weight:bold;color:{brand};',
        'h2': f'margin:{gap + 8}px 0 {gap}px 0;font-size:{size + 4}px;line-height:1.45;font-weight:bold;color:#1f2937;'
              f'border-left:4px solid {brand};padding-left:10px;',
        'h3': f'margin:{gap + 4}px 0 {max(8, gap - 4)}px 0;font-size:{size + 2}px;line-height:1.5;font-weight:bold;color:{brand};',
        'blockquote': f'margin:0 0 {gap}px 0;padding:10px 14px;border-left:3px solid {brand};background-color:{soft};color:#4b5563;',
        'ul': f'margin:0 0 {gap}px 0;padding-left:1.6em;',
        'ol': f'margin:0 0 {gap}px 0;padding-left:1.8em;',
        'li': 'margin:0 0 6px 0;',
        'li_p': 'margin:0;',
        'pre': f'margin:0 0 {gap}px 0;padding:12px 14px;background-color:#f6f8fa;border-radius:6px;font-size:13px;'
               'line-height:1.6;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Consolas,monospace;color:#24292f;',
        'code': f'padding:1px 4px;background-color:#f2f3f5;border-radius:3px;font-size:0.9em;font-family:Menlo,Consolas,monospace;color:{brand};',
        'hr': f'margin:{gap + 8}px 0;border:0;border-top:1px solid #e5e7eb;',
        'a': f'color:{brand};text-decoration:underline;',
        'figure': f'margin:0 0 {gap}px 0;text-align:center;',
        'img': 'display:block;margin:0 auto;max-width:100%;height:auto;',
        'caption': 'margin:6px 0 0 0;font-size:13px;line-height:1.5;color:#8a8f99;text-align:center;',
        'slot': f'margin:0 0 {gap}px 0;padding:10px;border:1px dashed #d97706;color:#b45309;text-align:center;font-size:14px;',
    }


class Renderer:
    def __init__(self, content: dict, *, resolve_image: Callable[[dict], dict | None],
                 image_mode: str = 'embed', for_preview: bool = False):
        self.content = content
        self.style = content['style']
        self.css = theme_styles(self.style)
        self.resolve_image = resolve_image
        self.image_mode = image_mode
        self.for_preview = for_preview
        self.images: list[dict] = []
        self.issues: list[dict] = []
        self.text: list[str] = []

    def issue(self, severity: str, kind: str, message: str, block_id: str = '') -> None:
        self.issues.append({'severity': severity, 'kind': kind, 'message': message, 'block_id': block_id})

    # -------------------------------------------------------------- inline
    def inline(self, nodes: list[dict] | None) -> tuple[str, str]:
        html_parts, text_parts = [], []
        for node in nodes or []:
            if node['type'] == 'hardBreak':
                html_parts.append('<br>')
                text_parts.append('\n')
                continue
            text = node.get('text', '')
            text_parts.append(text)
            piece = htmllib.escape(text, quote=False)
            marks = {m['type']: m for m in node.get('marks', [])}
            if 'code' in marks:
                piece = f'<code style="{self.css["code"]}">{piece}</code>'
            if 'bold' in marks:
                piece = f'<strong>{piece}</strong>'
            if 'italic' in marks:
                piece = f'<em>{piece}</em>'
            if 'underline' in marks:
                piece = f'<span style="text-decoration:underline;">{piece}</span>'
            if 'strike' in marks:
                piece = f'<span style="text-decoration:line-through;">{piece}</span>'
            if 'textStyle' in marks:
                attrs = marks['textStyle']['attrs']
                css = ''.join(f'{k}:{v};' for k, v in (('color', attrs.get('color')), ('font-size', attrs.get('fontSize')),
                                                       ('background-color', attrs.get('backgroundColor'))) if v)
                piece = f'<span style="{css}">{piece}</span>'
            if 'link' in marks:
                href = htmllib.escape(marks['link']['attrs']['href'], quote=True)
                piece = f'<a href="{href}" style="{self.css["a"]}">{piece}</a>'
            html_parts.append(piece)
        return ''.join(html_parts), ''.join(text_parts)

    @staticmethod
    def _align(attrs: dict) -> str:
        align = attrs.get('textAlign')
        return f'text-align:{align};' if align else ''

    # -------------------------------------------------------------- blocks
    def block(self, node: dict, *, in_list: bool = False) -> tuple[str, str]:
        kind, attrs = node['type'], node.get('attrs', {})
        bid = attrs.get('id', '')
        if kind == 'paragraph':
            inner, text = self.inline(node.get('content'))
            style = (self.css['li_p'] if in_list else self.css['p']) + self._align(attrs) + ('text-indent:2em;' if attrs.get('indent') else '')
            return f'<p style="{style}">{inner or "<br>"}</p>', text
        if kind == 'heading':
            inner, text = self.inline(node.get('content'))
            level = attrs.get('level', 2)
            return f'<h{level} style="{self.css[f"h{level}"]}{self._align(attrs)}">{inner}</h{level}>', text
        if kind in ('bulletList', 'orderedList'):
            tag = 'ul' if kind == 'bulletList' else 'ol'
            start = attrs.get('start', 1)
            items_html, items_text = [], []
            for index, item in enumerate(node.get('content') or []):
                parts = [self.block(child, in_list=True) for child in item.get('content') or []]
                items_html.append(f'<li style="{self.css["li"]}">' + ''.join(p[0] for p in parts) + '</li>')
                prefix = '· ' if tag == 'ul' else f'{start + index}. '
                items_text.append(prefix + '\n'.join(p[1] for p in parts if p[1]))
            start_attr = f' start="{start}"' if tag == 'ol' and start != 1 else ''
            return f'<{tag}{start_attr} style="{self.css[tag]}">' + ''.join(items_html) + f'</{tag}>', '\n'.join(items_text)
        if kind == 'blockquote':
            parts = [self.block(child, in_list=True) for child in node.get('content') or []]
            return (f'<blockquote style="{self.css["blockquote"]}">' + ''.join(p[0] for p in parts) + '</blockquote>',
                    '\n'.join('「' + p[1] + '」' if i == 0 and len(parts) == 1 else p[1] for i, p in enumerate(parts)))
        if kind == 'horizontalRule':
            return f'<hr style="{self.css["hr"]}">', '————'
        if kind == 'codeBlock':
            text = ''.join(c.get('text', '') for c in node.get('content') or [])
            return f'<pre style="{self.css["pre"]}">{htmllib.escape(text, quote=False)}</pre>', text
        if kind == 'articleImage':
            return self.image(attrs)
        if kind == 'imageSlot':
            label = f"图{attrs.get('figureNo')}：{attrs.get('caption', '')}"
            self.issue('error', 'image_missing', f'{label} 还没有实际图片，请插入或替换图片', bid)
            return f'<p style="{self.css["slot"]}">【待配图】{htmllib.escape(label, quote=False)}</p>', f'【待配图：{label}】'
        if kind == 'runOutput':
            self.issue('warning', 'legacy_run', f"旧运行输出引用 {attrs.get('runRef')} 属于只读历史证据，交付时已省略", bid)
            return '', ''
        if kind == 'callout':
            return self.callout(node)
        if kind == 'imageGroup':
            return self.image_group(attrs)
        if kind == 'rawHtml':
            deliver = attrs.get('deliver', 'text')
            reason = attrs.get('reason') or '未支持模块'
            text = html_text(attrs.get('html', ''))
            if deliver == 'omit':
                self.issue('warning', 'island_omitted', f'「{reason}」已按设置从交付中省略', bid)
                return '', ''
            if re.search(r'<img\b', attrs.get('html', ''), re.I):
                self.issue('error', 'island_images', f'「{reason}」中的图片未归档，交付时不会加载外链图片；请在正文中独立插入', bid)
            if deliver == 'html':
                self.issue('warning', 'island_html', f'「{reason}」按原始 HTML 输出，微信中的实际效果尚未验证', bid)
                html = sanitize_html(attrs.get('html', ''), keep_images=False)[0]
                # 未带样式的表格补上基础边框（公众号编辑器不带默认表格样式）。
                html = html.replace('<table>', '<table style="border-collapse:collapse;width:100%;font-size:14px;">')
                html = re.sub(r'<(td|th)(\s[^>]*)?>', lambda m: m.group(0) if 'style=' in (m.group(2) or '') else
                              f'<{m.group(1)}{m.group(2) or ""} style="border:1px solid #e5e7eb;padding:6px 8px;">', html)
                return f'<section style="margin:0 0 {self.style["paragraphSpacing"]}px 0;overflow-x:auto;">{html}</section>', text
            self.issue('info', 'island_text', f'「{reason}」已降级为纯文字输出；原件可在编辑器中查看', bid)
            paragraphs = [p for p in re.split(r'\n+', text) if p.strip()]
            return ''.join(f'<p style="{self.css["p"]}">{htmllib.escape(p.strip(), quote=False)}</p>' for p in paragraphs), text
        if kind == 'rawBlock':
            source = attrs.get('source', '')
            self.issue('warning', 'raw_block', '有未识别的内容按纯文本输出，请检查', bid)
            paragraphs = [p for p in re.split(r'\n\s*\n', source) if p.strip()]
            return ''.join(f'<p style="{self.css["p"]}">{htmllib.escape(p, quote=False).replace(chr(10), "<br>")}</p>'
                           for p in paragraphs), source
        return '', plain_text_of(node)

    def callout(self, node: dict) -> tuple[str, str]:
        attrs = node.get('attrs', {})
        tone = attrs.get('tone', 'brand')
        background, accent = CALLOUT_COLORS.get(tone, (_lighten(self.style['brandColor'], 0.92), self.style['brandColor']))
        gap = self.style['paragraphSpacing']
        parts = [self.block(child, in_list=True) for child in node.get('content') or []]
        title = attrs.get('title', '')
        head = (f'<p style="margin:0 0 6px 0;font-weight:bold;color:{accent};">{htmllib.escape(title, quote=False)}</p>' if title else '')
        body = ''.join(p[0] for p in parts)
        html = (f'<section style="margin:0 0 {gap}px 0;padding:12px 16px;background-color:{background};'
                f'border-left:4px solid {accent};border-radius:6px;">{head}{body}</section>')
        text = '\n'.join(([f'【{title}】'] if title else []) + [p[1] for p in parts if p[1]])
        return html, text

    def image_group(self, attrs: dict) -> tuple[str, str]:
        columns = attrs.get('columns', 2)
        width = {2: 49, 3: 32}[columns] if columns in (2, 3) else 49
        cells, labels = [], []
        for item in attrs.get('images') or []:
            body, order, _ = self._image_body({'id': attrs.get('id', ''), 'resourceId': item['resourceId'], 'caption': item.get('caption', ''),
                                           'width': 100, 'align': 'center'})
            labels.append(f'图{order}')
            cap = (f'<p style="{self.css["caption"]}">{htmllib.escape(item["caption"], quote=False)}</p>' if item.get('caption') else '')
            cells.append(f'<section style="display:inline-block;width:{width}%;vertical-align:top;margin:0 0.5% 6px 0.5%;'
                         f'font-size:{self.style["fontSize"]}px;">{body}{cap}</section>')
        caption = attrs.get('caption', '')
        cap = f'<p style="{self.css["caption"]}">{htmllib.escape(caption, quote=False)}</p>' if caption else ''
        html = (f'<section style="margin:0 0 {self.style["paragraphSpacing"]}px 0;text-align:center;font-size:0;">'
                + ''.join(cells) + '</section>' + cap)
        return html, f'【{"、".join(labels)}{"：" + caption if caption else ""}】'

    def image(self, attrs: dict) -> tuple[str, str]:
        caption = attrs.get('caption', '')
        body, order, missing = self._image_body(attrs)
        text = f'【图{order}{"：" + caption if caption else ""}】'
        if missing:
            return body, text
        cap = f'<p style="{self.css["caption"]}">{htmllib.escape(caption, quote=False)}</p>' if caption else ''
        return f'<section style="{self.css["figure"]}">{body}{cap}</section>', text

    def _image_body(self, attrs: dict) -> tuple[str, int, bool]:
        """登记一张图片（序号、清单、问题），返回其 <img> 或缺图占位；单图与多图共用。"""
        order = len(self.images) + 1
        caption = attrs.get('caption', '')
        resolved = self.resolve_image(attrs)
        bid = attrs.get('id', '')
        if not resolved:
            self.issue('error', 'image_missing', f'图{order}{"「" + caption + "」" if caption else ""} 的图片文件缺失或已改变，请重新插入', bid)
            self.images.append({'order': order, 'resource_id': attrs.get('resourceId'), 'caption': caption,
                                'missing': True, 'block_id': bid})
            return f'<p style="{self.css["slot"]}">【图片缺失】{htmllib.escape(caption, quote=False)}</p>', order, True
        self.images.append({'order': order, 'resource_id': attrs['resourceId'], 'caption': caption, 'missing': False,
                            'block_id': bid, 'mime': resolved['mime'], 'size': resolved['size'],
                            'width': resolved['width'], 'height': resolved['height'], 'sha256': resolved['sha256'],
                            'source_url': attrs.get('sourceUrl', ''), 'file_path': resolved['file_path']})
        width = attrs.get('width', 100)
        align = attrs.get('align', 'center')
        margin = {'center': 'margin:0 auto;', 'left': 'margin:0 auto 0 0;', 'right': 'margin:0 0 0 auto;'}[align]
        if self.image_mode == 'placeholder':
            body = f'<p style="{self.css["slot"]}">【在此处插入图{order}】</p>'
        else:
            src = resolved['data_url'](self.for_preview)
            alt = htmllib.escape(attrs.get('alt') or caption, quote=True)
            body = (f'<img src="{src}" alt="{alt}" data-ice-order="{order}" '
                    f'style="{self.css["img"]}width:{width}%;{margin}">')
        return body, order, False

    def run(self) -> dict:
        html_parts, text_parts = [], []
        for node in self.content['doc']['content']:
            piece, text = self.block(node)
            if piece:
                html_parts.append(piece)
            if text.strip():
                text_parts.append(text.strip())
        if not text_parts and not self.images:
            self.issue('error', 'empty', '正文为空')
        links = sum(1 for _ in re.finditer(r'<a href=', ''.join(html_parts)))
        if links:
            self.issue('info', 'links', f'正文含 {links} 个外部链接；公众号可能只允许部分链接可点击，请在后台预览确认')
        html = f'<section data-ice-delivery="{RENDERER_VERSION}" style="{self.css["root"]}">' + ''.join(html_parts) + '</section>'
        return {'html': html, 'text': '\n\n'.join(text_parts) + '\n', 'images': self.images, 'issues': self.issues}


def delivery_hash(version: dict, images: list[dict]) -> str:
    return sha256_json({'renderer': RENDERER_VERSION, 'version_id': version['version_id'],
                        'content_hash': version['content_hash'],
                        'images': [(i['order'], i.get('sha256'), i.get('missing')) for i in images]})


def image_data_url(path, mime: str, *, preview: bool) -> str:
    """复制用：原图字节内嵌（不改格式/不重压缩）；预览用：缩略图以节省内存。"""
    data = path.read_bytes()
    if preview:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            image.thumbnail((1080, 1080 * 4))
            buffer = io.BytesIO()
            if image.mode in ('RGBA', 'LA', 'P'):
                image.save(buffer, 'PNG', optimize=True)
                mime = 'image/png'
            else:
                image.convert('RGB').save(buffer, 'JPEG', quality=85)
                mime = 'image/jpeg'
            data = buffer.getvalue()
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')
