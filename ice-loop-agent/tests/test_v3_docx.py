"""v3 P1 DOCX 文件导入：本地 zip+XML 转换，复用粘贴管线；不依赖云端转换服务。"""
from __future__ import annotations

import base64
import io
import unittest
import zipfile
from types import SimpleNamespace

from PIL import Image

from ice_agent.documents.docx_import import docx_to_html
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')


def png() -> bytes:
    buffer = io.BytesIO()
    Image.new('RGB', (120, 80), (30, 120, 200)).save(buffer, 'PNG')
    return buffer.getvalue()


def make_docx(body: str, *, image: bool = True, comments: bool = False, extra: dict | None = None) -> bytes:
    styles = (f'<w:styles {NS}>'
              '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="标题 2"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>')
    numbering = (f'<w:numbering {NS}>'
                 '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
                 '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
                 '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
                 '</w:numbering>')
    rels = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId5" Type="image" Target="media/image1.png"/>'
            '<Relationship Id="rId9" Type="hyperlink" Target="https://example.com/x" TargetMode="External"/>'
            '<Relationship Id="rId10" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr('word/document.xml', f'<w:document {NS}><w:body>{body}<w:sectPr/></w:body></w:document>')
        archive.writestr('word/styles.xml', styles)
        archive.writestr('word/numbering.xml', numbering)
        archive.writestr('word/_rels/document.xml.rels', rels)
        if image:
            archive.writestr('word/media/image1.png', png())
        if comments:
            archive.writestr('word/comments.xml', f'<w:comments {NS}/>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return buffer.getvalue()


def p(text: str, ppr: str = '', rpr: str = '') -> str:
    return f'<w:p><w:pPr>{ppr}</w:pPr><w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


SAMPLE = (
    p('编译器笔记第三期', '<w:pStyle w:val="Title"/>') +
    p('一、词法分析', '<w:pStyle w:val="1"/>') +
    p('首行缩进且居中的段落', '<w:jc w:val="center"/><w:ind w:firstLineChars="200" w:firstLine="420"/>') +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="C00000"/></w:rPr><w:t>红色斜体</w:t></w:r>'
    '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>高亮</w:t></w:r>'
    '<w:hyperlink r:id="rId9"><w:r><w:t>链接</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId10"><w:r><w:t>坏链接</w:t></w:r></w:hyperlink>'
    '<w:del><w:r><w:delText>已删除</w:delText></w:r></w:del><w:ins><w:r><w:t>新插入</w:t></w:r></w:ins></w:p>' +
    p('二、语法分析', '<w:pStyle w:val="a3"/>') +
    p('无序一', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
    p('无序二', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
    p('有序一', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
    '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic>'
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
)


class TestDocxImport(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-docx-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        self.docs = DocumentService(self.service, self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()

    def test_html_mapping(self):
        html, report = docx_to_html(make_docx(SAMPLE, comments=True))
        self.assertIn('<h1>编译器笔记第三期</h1>', html)
        self.assertIn('<h2>二、语法分析</h2>', html)
        self.assertIn('text-align:center;text-indent:2em', html)
        self.assertIn('<strong>加粗</strong>', html)
        self.assertIn('color:#c00000', html)
        self.assertIn('background-color:#fff3a3', html)
        self.assertIn('<a href="https://example.com/x">链接</a>', html)
        self.assertNotIn('javascript', html)
        self.assertNotIn('已删除', html)
        self.assertIn('新插入', html)
        self.assertIn('<ul><li>无序一</li><li>无序二</li></ul><ol><li>有序一</li></ol>', html)
        self.assertIn('data:image/png;base64,', html)
        self.assertEqual(report['images'], 1)
        self.assertEqual(report['tables'], 1)
        self.assertIn('批注（未导入）', report['unsupported'])

    def test_import_creates_document_with_report_and_original(self):
        data = make_docx(SAMPLE)
        result = self.docs.import_docx({'file_name': '第三期.docx', 'data_base64': base64.b64encode(data).decode()})
        blocks = result['content']['doc']['content']
        kinds = [b['type'] for b in blocks]
        self.assertEqual(kinds[:2], ['heading', 'heading'])
        self.assertIn('bulletList', kinds)
        self.assertIn('orderedList', kinds)
        self.assertIn('articleImage', kinds)
        self.assertEqual(result['title'], '编译器笔记第三期')
        self.assertEqual(result['origin'], 'import')
        self.assertEqual(result['report']['docx']['file_name'], '第三期.docx')
        self.assertEqual(result['report']['images']['imported'], 1)
        image = next(b for b in blocks if b['type'] == 'articleImage')
        self.assertEqual(self.docs.image_view({'resource_id': image['attrs']['resourceId']})['source']['kind'], 'docx')
        self.assertTrue((self.runtime / 'imports' / 'acct-a' / (result['report']['docx']['sha256'] + '.docx')).is_file())
        self.assertEqual(len(result['imports']), 1)
        # 原件可按“仅保留文字”重新转换
        text = self.docs.reconvert({'document_id': result['document_id'], 'import_id': result['import_id'], 'mode': 'text',
                                    'base_revision': result['revision']})
        self.assertTrue(all(b['type'] == 'paragraph' for b in text['content']['doc']['content']))

    def test_title_falls_back_to_file_name(self):
        data = make_docx(p('只有正文没有标题。'), image=False)
        result = self.docs.import_docx({'file_name': '周记.docx', 'data_base64': base64.b64encode(data).decode()})
        self.assertEqual(result['title'], '周记')

    def test_rejects_bad_files(self):
        for name, data in (('a.doc', b'x'), ('a.docx', b'not a zip')):
            with self.assertRaises(DocumentError):
                self.docs.import_docx({'file_name': name, 'data_base64': base64.b64encode(data).decode()})
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('word/document.xml', '<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')
        with self.assertRaisesRegex(DocumentError, 'XML'):
            docx_to_html(buffer.getvalue())
        with self.assertRaises(DocumentError):
            self.docs.import_docx({'file_name': 'a.docx', 'data_base64': '***'})


if __name__ == '__main__':
    unittest.main()
