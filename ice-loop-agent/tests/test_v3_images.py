"""v3 P1 图片：来源记录与展示、裁切/缩放/压缩另存新图（原图不变）。"""
from __future__ import annotations

import base64
import io
import unittest
from types import SimpleNamespace

from PIL import Image

from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


def data_url(fmt='PNG', size=(400, 200), color=(200, 30, 30)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, fmt)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buffer.getvalue()).decode()


class TestImages(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-img-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        self.docs = DocumentService(self.service, self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()

    def test_source_recorded_and_editable(self):
        view = self.docs.image_import_data({'data_url': data_url(), 'name': '截图'})
        self.assertEqual(view['source']['kind'], 'clipboard')
        self.assertEqual(view['source']['label'], '剪贴板截图')
        self.assertTrue(view['source']['imported_at'])
        path = self.root / '封面图.png'
        path.write_bytes(base64.b64decode(data_url(color=(1, 2, 3)).split(',')[1]))
        picked = self.docs.image_import({'file_path': str(path)})
        self.assertEqual(picked['source']['original_name'], '封面图.png')
        updated = self.docs.image_source_update({'resource_id': view['resource_id'], 'source_url': 'https://example.com/p',
                                                 'rights_note': '作者授权使用'})
        self.assertEqual(updated['source']['source_url'], 'https://example.com/p')
        self.assertEqual(self.docs.image_view({'resource_id': view['resource_id']})['source']['rights_note'], '作者授权使用')
        with self.assertRaises(DocumentError):
            self.docs.image_source_update({'resource_id': view['resource_id'], 'source_url': 'javascript:alert(1)'})
        pasted = self.docs.convert_paste({'html': f'<p>正文<img src="{data_url(color=(9, 9, 9))}" alt="图"></p>'})
        image = next(b for b in pasted['content']['doc']['content'] if b['type'] == 'articleImage')
        self.assertEqual(self.docs.image_view({'resource_id': image['attrs']['resourceId']})['source']['kind'], 'paste_html')

    def test_crop_resize_compress_creates_new_resource(self):
        view = self.docs.image_import_data({'data_url': data_url(size=(2000, 1000)), 'name': '大图'})
        self.docs.image_source_update({'resource_id': view['resource_id'], 'source_url': 'https://example.com/a'})
        edited = self.docs.image_edit({'resource_id': view['resource_id'], 'crop': {'x': 0.25, 'y': 0, 'w': 0.5, 'h': 1},
                                       'max_width': 800, 'format': 'jpeg', 'quality': 80})
        self.assertNotEqual(edited['resource_id'], view['resource_id'])
        self.assertEqual((edited['width'], edited['height']), (800, 800))
        self.assertEqual(edited['mime'], 'image/jpeg')
        self.assertEqual(edited['source']['derived_from'], view['resource_id'])
        self.assertEqual(edited['source']['source_url'], 'https://example.com/a')  # 来源随处理结果继承
        self.assertEqual(edited['before']['width'], 2000)
        original = self.docs.image_view({'resource_id': view['resource_id']})
        self.assertEqual((original['width'], original['height']), (2000, 1000))  # 原图不变

    def test_png_with_alpha_to_jpeg_and_validation(self):
        buffer = io.BytesIO()
        image = Image.new('RGBA', (300, 300), (0, 0, 0, 0))
        image.paste((20, 120, 200, 255), (50, 50, 250, 250))
        image.save(buffer, 'PNG')
        view = self.docs.image_import_data({'data_url': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()})
        edited = self.docs.image_edit({'resource_id': view['resource_id'], 'format': 'jpeg'})
        self.assertEqual(edited['mime'], 'image/jpeg')
        for bad in ({'crop': {'x': 0.9, 'y': 0, 'w': 0.5, 'h': 1}}, {'crop': {'x': 0, 'y': 0, 'w': 0.001, 'h': 1}},
                    {'max_width': 50}, {'format': 'gif'}, {'quality': 10}, {}):
            with self.assertRaises(DocumentError, msg=str(bad)):
                self.docs.image_edit({'resource_id': view['resource_id'], **bad})


if __name__ == '__main__':
    unittest.main()
