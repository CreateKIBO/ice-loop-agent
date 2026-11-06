"""v3 P2 长图与切片、SVG 转图片（引擎侧：页面、拼接、切片、写入；可选：真实 Chromium 端到端）。"""
from __future__ import annotations

import base64
import io
import json
import unittest
from types import SimpleNamespace
from unittest import mock

from PIL import Image, ImageDraw

from ice_agent.documents.longimage import cut_points, page_html, stitch
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


def png(image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def striped(width, height, scale=2):
    """白底上每隔 300 CSS px 一块“文字”色块，色块之间是空白行。"""
    image = Image.new('RGB', (width * scale, height * scale), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for top in range(0, height, 300):
        draw.rectangle((10 * scale, (top + 20) * scale, (width - 10) * scale, (top + 260) * scale), fill=(40, 40, 40))
    return image


def segments_of(image, viewport_css, total_css, scale=2):
    out, y = [], 0
    while y < total_css:
        top = min(y, max(0, total_css - viewport_css))
        out.append({'y': top, 'png_base64': png(image.crop((0, top * scale, image.width, min(image.height, (top + viewport_css) * scale))))})
        y += viewport_css
    return out


class LongFixture(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-long-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.docs = DocumentService(SimpleNamespace(runtime=self.runtime), self.store, {'id': 'acct-a'})
        created = self.docs.create({'kind': 'blank', 'title': '长图测试'})
        content = {'schema': 1, 'doc': {'type': 'doc', 'content': [
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': '第一段' * 20}]}]}, 'style': {}, 'info': {'author': '冰环'}}
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': content})
        self.document_id = created['document_id']
        self.version_id = self.docs.commit_version({'document_id': self.document_id, 'base_revision': saved['revision']})['version_id']

    def tearDown(self):
        self.store.close()


class TestLongImage(LongFixture):
    def test_page_has_no_scripts_and_strict_csp(self):
        page = self.docs.long_image_page({'document_id': self.document_id, 'version_id': self.version_id, 'width': 375})
        self.assertIn("default-src 'none'", page['html'])
        self.assertNotIn('<script', page['html'].lower())
        self.assertIn('长图测试', page['html'])
        self.assertIn('冰环', page['html'])
        self.assertIn('width:375px', page['html'])
        with self.assertRaises(DocumentError):
            page_html('', 't', '', 500)

    def test_stitch_and_cut_on_blank_rows(self):
        full = striped(375, 3000)
        canvas, scale = stitch(segments_of(full, 1600, 3000), 3000, 375)
        self.assertEqual(scale, 2)
        self.assertEqual(canvas.size, full.size)
        self.assertEqual(canvas.tobytes(), full.tobytes())  # 重叠段不出错位
        points = cut_points(canvas, 1200 * 2, 160 * 2)
        self.assertEqual(points[0], 0)
        self.assertEqual(points[-1], canvas.height)
        gray = canvas.convert('L')
        for row in points[1:-1]:  # 切点都落在空白行
            self.assertEqual(gray.crop((0, row, gray.width, row + 1)).getextrema()[0], 255)
        for bad in ([], [{'y': -1, 'png_base64': 'x'}], [{'y': 0, 'png_base64': '***'}]):
            with self.assertRaises(DocumentError):
                stitch(bad, 100, 375)
        with self.assertRaises(DocumentError):
            stitch(segments_of(full, 1600, 3000), 70000, 375)

    def test_compose_writes_new_folder_with_manifest(self):
        full = striped(375, 2600)
        target = self.root / 'out' / 'ICE-Loop-Export-1'
        target.parent.mkdir()
        with mock.patch('ice_agent.paths.assert_not_c_drive'):
            result = self.docs.long_image_compose({'document_id': self.document_id, 'version_id': self.version_id, 'width': 375,
                                                   'destination': str(target), 'total_height': 2600, 'slice_height': 1000,
                                                   'segments': segments_of(full, 1600, 2600)})
            self.assertEqual(result['pixel_height'], 5200)
            self.assertGreaterEqual(result['slices'], 3)
            manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['version_id'], self.version_id)
            self.assertTrue((target / '长图.png').is_file())
            self.assertEqual(sum(s['height'] for s in manifest['slices']), 5200)
            self.assertFalse(any(p.name.endswith('-staging') for p in target.parent.iterdir()))
            with self.assertRaisesRegex(DocumentError, '已存在'):
                self.docs.long_image_compose({'document_id': self.document_id, 'version_id': self.version_id, 'width': 375,
                                              'destination': str(target), 'total_height': 2600, 'segments': segments_of(full, 1600, 2600)})
        with self.assertRaises(DocumentError):
            self.docs.long_image_compose({'document_id': self.document_id, 'version_id': self.version_id, 'width': 375,
                                          'destination': 'relative/path', 'total_height': 10, 'segments': []})

    def test_svg_import(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
        view = self.docs.svg_import({'svg': svg, 'name': '图标', 'png_base64': png(Image.new('RGB', (40, 40), (255, 0, 0)))})
        self.assertEqual(view['source']['kind'], 'svg')
        self.assertEqual(view['source']['label'], 'SVG 转图')
        self.assertTrue(list((self.runtime / 'imports' / 'acct-a').glob('*.svg')))
        with self.assertRaises(DocumentError):
            self.docs.svg_import({'svg': '<html></html>', 'png_base64': png(Image.new('RGB', (4, 4)))})


try:
    from playwright.sync_api import sync_playwright  # noqa: F401
    HAS_BROWSER = True
except ImportError:
    HAS_BROWSER = False


@unittest.skipUnless(HAS_BROWSER, '需要 Playwright Chromium')
class TestLongImageInChromium(LongFixture):
    """与主进程相同的流程：载入页面 → 按视口滚动截图 → 引擎拼接（验证页面在真实 Chromium 中可排版）。"""

    def test_end_to_end(self):
        from playwright.sync_api import sync_playwright
        content = {'schema': 1, 'doc': {'type': 'doc', 'content': [
            {'type': 'heading', 'attrs': {'level': 2}, 'content': [{'type': 'text', 'text': f'第{i}节'}]} if i % 3 == 0 else
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': '正文内容。' * 40}]} for i in range(40)]}, 'style': {}}
        detail = self.docs.get({'document_id': self.document_id})
        saved = self.docs.save_working({'document_id': self.document_id, 'base_revision': detail['revision'], 'content': content})
        version = self.docs.commit_version({'document_id': self.document_id, 'base_revision': saved['revision']})['version_id']
        page_html_text = self.docs.long_image_page({'document_id': self.document_id, 'version_id': version, 'width': 375})['html']
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 375, 'height': 1600}, device_scale_factor=2)
            page.set_content(page_html_text)
            total = page.evaluate('document.documentElement.scrollHeight')
            segments, y = [], 0
            while y < total:
                top = min(y, max(0, total - 1600))
                page.evaluate(f'window.scrollTo(0, {top})')
                segments.append({'y': top, 'png_base64': base64.b64encode(page.screenshot()).decode()})
                y += 1600
            browser.close()
        canvas, scale = stitch(segments, total, 375)
        self.assertEqual(scale, 2)
        self.assertGreater(total, 3000)
        points = cut_points(canvas, 1200 * 2, 160 * 2)
        self.assertGreater(len(points), 3)


if __name__ == '__main__':
    unittest.main()
