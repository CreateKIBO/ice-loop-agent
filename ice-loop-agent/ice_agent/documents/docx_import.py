"""P1 DOCX 文件导入（本地转换，不依赖订阅/云端转换服务）。

路线（见 docs/v3.0/v3.7-图片与DOCX导入.md）：只用标准库读取 .docx（zip + XML），转成受限 HTML，
再复用粘贴导入管线（convert_html）：同一套清洗、样式映射、图片导入与导入报告。
支持：标题（按样式名识别 Heading/标题/Title）、段落对齐与首行缩进、加粗/斜体/下划线/删除线、文字颜色、
高亮/底纹、超链接、项目/编号列表（按 numbering.xml 判断有序/无序）、换行、内嵌图片、表格（交给转换器按原件块保留）。
不支持（写入报告）：批注、修订痕迹（按“接受后的正文”读取）、文本框、页眉页脚、脚注、公式、SmartArt、图表。
"""
from __future__ import annotations

import base64
import html as htmllib
import io
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

from .schema import DocumentError

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
VML = 'urn:schemas-microsoft-com:vml'
MAX_DOCX = 20 * 1024 * 1024
MAX_UNPACKED = 200 * 1024 * 1024
MAX_IMAGES = 200
IMAGE_MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
              '.bmp': 'image/bmp', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff'}
HIGHLIGHT = {'yellow': '#fff3a3', 'green': '#dcfce7', 'cyan': '#cffafe', 'magenta': '#fce7f3', 'blue': '#dbeafe',
             'red': '#fee2e2', 'darkYellow': '#fef3c7', 'lightGray': '#e5e7eb', 'darkGray': '#d1d5db',
             'darkBlue': '#dbeafe', 'darkCyan': '#cffafe', 'darkGreen': '#dcfce7', 'darkMagenta': '#fce7f3',
             'darkRed': '#fee2e2', 'black': '#e5e7eb'}


def w(tag: str) -> str:
    return f'{{{W}}}{tag}'


def _xml(data: bytes) -> ET.Element:
    # Word 不使用 DTD；拒绝 DOCTYPE 以免实体扩展。
    if b'<!DOCTYPE' in data[:4096] or b'<!ENTITY' in data:
        raise DocumentError('文档包含不受支持的 XML 声明')
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise DocumentError('Word 文件内容损坏，无法读取') from None


class DocxReader:
    def __init__(self, data: bytes):
        if not data or len(data) > MAX_DOCX:
            raise DocumentError('Word 文件需小于 20MB')
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise DocumentError('这不是有效的 .docx 文件（旧版 .doc 请先在 Word 中另存为 .docx）') from None
        names = set(self.zip.namelist())
        if 'word/document.xml' not in names:
            raise DocumentError('这不是有效的 .docx 文件')
        if sum(info.file_size for info in self.zip.infolist()) > MAX_UNPACKED:
            raise DocumentError('Word 文件解压后过大')
        self.names = names
        self.rels = self._rels('word/_rels/document.xml.rels')
        self.styles = self._styles()
        self.numbering = self._numbering()
        self.report = {'paragraphs': 0, 'headings': 0, 'images': 0, 'tables': 0, 'lists': 0, 'unsupported': {}}
        self.image_count = 0

    def _read(self, name: str) -> bytes | None:
        return self.zip.read(name) if name in self.names else None

    def _rels(self, name: str) -> dict[str, tuple[str, str]]:
        data = self._read(name)
        if not data:
            return {}
        out = {}
        for rel in _xml(data).findall(f'{{{PR}}}Relationship'):
            out[rel.get('Id', '')] = (rel.get('Target', ''), rel.get('TargetMode', ''))
        return out

    def _styles(self) -> dict[str, dict]:
        data = self._read('word/styles.xml')
        out: dict[str, dict] = {}
        if not data:
            return out
        for style in _xml(data).findall(w('style')):
            sid = style.get(w('styleId'), '')
            name_el = style.find(w('name'))
            name = (name_el.get(w('val'), '') if name_el is not None else '').strip()
            outline = style.find(f"{w('pPr')}/{w('outlineLvl')}")
            out[sid] = {'name': name, 'outline': int(outline.get(w('val'), '9')) if outline is not None else None,
                        'based': (style.find(w('basedOn')).get(w('val')) if style.find(w('basedOn')) is not None else '')}
        return out

    def _numbering(self) -> dict[tuple[str, str], str]:
        """(numId, ilvl) -> 'ol' | 'ul'"""
        data = self._read('word/numbering.xml')
        if not data:
            return {}
        root = _xml(data)
        abstract: dict[str, dict[str, str]] = {}
        for item in root.findall(w('abstractNum')):
            levels = {}
            for lvl in item.findall(w('lvl')):
                fmt = lvl.find(w('numFmt'))
                value = fmt.get(w('val'), 'bullet') if fmt is not None else 'bullet'
                levels[lvl.get(w('ilvl'), '0')] = 'ul' if value in ('bullet', 'none') else 'ol'
            abstract[item.get(w('abstractNumId'), '')] = levels
        out = {}
        for num in root.findall(w('num')):
            ref = num.find(w('abstractNumId'))
            levels = abstract.get(ref.get(w('val'), '') if ref is not None else '', {})
            for ilvl, kind in levels.items():
                out[(num.get(w('numId'), ''), ilvl)] = kind
        return out

    # --------------------------------------------------------------- blocks
    def heading_level(self, style_id: str) -> int:
        seen = set()
        while style_id and style_id not in seen:
            seen.add(style_id)
            style = self.styles.get(style_id)
            if not style:
                break
            name = style['name'].lower()
            if name in ('title', '标题'):
                return 1
            match = re.match(r'(?:heading|标题)\s*(\d)', name)
            if match:
                return min(3, max(1, int(match.group(1))))
            if style['outline'] is not None and style['outline'] < 3:
                return style['outline'] + 1
            style_id = style['based']
        if re.fullmatch(r'[1-3]', style_id or ''):
            return int(style_id)
        return 0

    def _unsupported(self, label: str) -> None:
        self.report['unsupported'][label] = self.report['unsupported'].get(label, 0) + 1

    def _image(self, rid: str) -> str:
        target = self.rels.get(rid)
        if not target or target[1] == 'External':
            self._unsupported('外链图片')
            return ''
        path = posixpath.normpath(posixpath.join('word', target[0])) if not target[0].startswith('/') else target[0].lstrip('/')
        ext = posixpath.splitext(path)[1].lower()
        data = self._read(path)
        if not data or ext not in IMAGE_MIME:
            self._unsupported('无法读取的图片（如 EMF/WMF 矢量图）')
            return ''
        if self.image_count >= MAX_IMAGES:
            self._unsupported('超过 200 张的图片')
            return ''
        self.image_count += 1
        self.report['images'] += 1
        return f'<img src="data:{IMAGE_MIME[ext]};base64,{base64.b64encode(data).decode()}" alt="图片{self.image_count}">'

    def runs(self, parent: ET.Element) -> str:
        out = []
        for child in parent:
            tag = child.tag
            if tag == w('r'):
                out.append(self.run(child))
            elif tag == w('hyperlink'):
                inner = self.runs(child)
                target = self.rels.get(child.get(f'{{{R}}}id', ''), ('', ''))[0]
                if target and re.match(r'^(https?:|mailto:)', target, re.I):
                    out.append(f'<a href="{htmllib.escape(target, quote=True)}">{inner}</a>')
                else:
                    out.append(inner)
            elif tag in (w('ins'), w('smartTag'), w('sdt'), w('sdtContent'), w('fldSimple'), w('customXml')):
                out.append(self.runs(child))  # 修订“插入”按接受后的正文读取
            elif tag == w('del'):
                continue  # 修订“删除”不进入正文
            elif tag in (w('commentRangeStart'), w('commentRangeEnd'), w('bookmarkStart'), w('bookmarkEnd'), w('proofErr'), w('pPr')):
                if tag == w('commentRangeStart'):
                    self._unsupported('批注（未导入）')
                continue
            elif tag == f'{{http://schemas.openxmlformats.org/officeDocument/2006/math}}oMath' or tag.endswith('}oMathPara'):
                self._unsupported('公式（已省略）')
        return ''.join(out)

    def run(self, run: ET.Element) -> str:
        props = run.find(w('rPr'))
        parts = []
        for child in run:
            if child.tag == w('t'):
                parts.append(htmllib.escape(child.text or ''))
            elif child.tag == w('tab'):
                parts.append('&emsp;')
            elif child.tag in (w('br'), w('cr')):
                if child.get(w('type')) == 'page':
                    continue
                parts.append('<br>')
            elif child.tag == w('drawing'):
                blip = child.find(f'.//{{{A}}}blip')
                if blip is not None:
                    parts.append(self._image(blip.get(f'{{{R}}}embed', '')))
                elif child.find('.//{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}txbx') is not None:
                    self._unsupported('文本框（未导入）')
                else:
                    self._unsupported('图表/SmartArt（未导入）')
            elif child.tag == w('pict'):
                image = child.find(f'.//{{{VML}}}imagedata')
                if image is not None:
                    parts.append(self._image(image.get(f'{{{R}}}id', '')))
                else:
                    self._unsupported('旧式图形（未导入）')
            elif child.tag in (w('footnoteReference'), w('endnoteReference')):
                self._unsupported('脚注/尾注（未导入）')
            elif child.tag == w('object'):
                self._unsupported('嵌入对象（未导入）')
        text = ''.join(parts)
        if not text or props is None:
            return text

        def on(tag: str) -> bool:
            el = props.find(w(tag))
            return el is not None and el.get(w('val'), 'true') not in ('0', 'false', 'none')
        styles = []
        color = props.find(w('color'))
        if color is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', color.get(w('val'), '')) and color.get(w('val')).lower() != '000000':
            styles.append('color:#' + color.get(w('val')).lower())
        highlight = props.find(w('highlight'))
        shade = props.find(w('shd'))
        if highlight is not None and highlight.get(w('val')) in HIGHLIGHT:
            styles.append('background-color:' + HIGHLIGHT[highlight.get(w('val'))])
        elif shade is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', shade.get(w('fill'), '')) and shade.get(w('fill')).lower() not in ('ffffff', 'auto'):
            styles.append('background-color:#' + shade.get(w('fill')).lower())
        if styles:
            text = f'<span style="{";".join(styles)}">{text}</span>'
        if on('strike') or on('dstrike'):
            text = f'<s>{text}</s>'
        if props.find(w('u')) is not None and props.find(w('u')).get(w('val'), 'single') != 'none':
            text = f'<u>{text}</u>'
        if on('i'):
            text = f'<em>{text}</em>'
        if on('b'):
            text = f'<strong>{text}</strong>'
        return text

    def paragraph(self, p: ET.Element) -> tuple[str, tuple[str, int] | None]:
        """返回 (HTML, 列表信息)；列表段落由调用方合并成 <ul>/<ol>。"""
        props = p.find(w('pPr'))
        style_id, align, indent, numbering = '', '', False, None
        if props is not None:
            style = props.find(w('pStyle'))
            style_id = style.get(w('val'), '') if style is not None else ''
            jc = props.find(w('jc'))
            if jc is not None and jc.get(w('val')) in ('center', 'right', 'end', 'both', 'distribute'):
                align = {'end': 'right', 'both': 'justify', 'distribute': 'justify'}.get(jc.get(w('val')), jc.get(w('val')))
            ind = props.find(w('ind'))
            if ind is not None and (ind.get(w('firstLine')) or ind.get(w('firstLineChars'))) and \
                    int(ind.get(w('firstLine'), '0') or 0) + int(ind.get(w('firstLineChars'), '0') or 0) > 0:
                indent = True
            num = props.find(w('numPr'))
            if num is not None:
                num_id = num.find(w('numId'))
                ilvl = num.find(w('ilvl'))
                nid = num_id.get(w('val'), '') if num_id is not None else ''
                level = ilvl.get(w('val'), '0') if ilvl is not None else '0'
                if nid and nid != '0':
                    numbering = (self.numbering.get((nid, level), 'ul'), int(level) if level.isdigit() else 0)
        inner = self.runs(p)
        level = self.heading_level(style_id)
        css = []
        if align:
            css.append('text-align:' + align)
        if indent and not level:
            css.append('text-indent:2em')
        attr = f' style="{";".join(css)}"' if css else ''
        if numbering and not level:
            return inner, numbering
        if level and re.sub(r'<[^>]+>', '', inner).strip():
            self.report['headings'] += 1
            return f'<h{level}{attr}>{inner}</h{level}>', None
        self.report['paragraphs'] += 1
        return f'<p{attr}>{inner or "<br>"}</p>', None

    def table(self, table: ET.Element) -> str:
        self.report['tables'] += 1
        rows = []
        for tr in table.findall(w('tr')):
            cells = []
            for tc in tr.findall(w('tc')):
                content = ''.join(self.paragraph(p)[0] if p.tag == w('p') else '' for p in tc)
                cells.append(f'<td>{content}</td>')
            rows.append('<tr>' + ''.join(cells) + '</tr>')
        return '<table>' + ''.join(rows) + '</table>'

    def to_html(self) -> str:
        body = _xml(self.zip.read('word/document.xml')).find(w('body'))
        if body is None:
            raise DocumentError('Word 文件没有正文')
        out: list[str] = []
        pending: list[tuple[str, str]] = []  # (kind, li-html)

        def flush() -> None:
            if not pending:
                return
            kind = pending[0][0]
            out.append(f'<{kind}>' + ''.join(f'<li>{item}</li>' for _, item in pending) + f'</{kind}>')
            self.report['lists'] += 1
            pending.clear()

        def walk(nodes) -> None:
            for node in nodes:
                if node.tag == w('p'):
                    html, numbering = self.paragraph(node)
                    if numbering:
                        if pending and pending[0][0] != numbering[0]:
                            flush()
                        pending.append((numbering[0], html))
                        continue
                    flush()
                    out.append(html)
                elif node.tag == w('tbl'):
                    flush()
                    out.append(self.table(node))
                elif node.tag in (w('sdt'), w('sdtContent'), w('customXml')):
                    walk(list(node))
                elif node.tag == w('sectPr'):
                    continue
        walk(list(body))
        flush()
        if self._read('word/comments.xml'):
            self.report['unsupported'].setdefault('批注（未导入）', 1)
        return '<html><body>' + ''.join(out) + '</body></html>'


def docx_to_html(data: bytes) -> tuple[str, dict]:
    reader = DocxReader(data)
    html = reader.to_html()
    if len(html) > 8_000_000:
        raise DocumentError('Word 文件里的图片过多或过大（转换后超过 8MB），请压缩图片后再导入')
    return html, reader.report
