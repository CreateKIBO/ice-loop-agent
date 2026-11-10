"""v3.12 长文多图性能固定样本与预览缩略图缓存。"""
from __future__ import annotations

import io
import unittest
from types import SimpleNamespace

from PIL import Image

from ice_agent.documents import perfsample
from ice_agent.documents.render import image_data_url
from ice_agent.documents.schema import DocumentError, image_refs, plain_text_of
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


class TestPerfSample(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-perf-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.docs = DocumentService(SimpleNamespace(runtime=self.runtime), self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()

    def test_fixed_sample_is_deterministic_and_registered(self):
        first = self.docs.perf_sample({'chars': 3000, 'images': 6, 'seed': 7})
        second = self.docs.perf_sample({'chars': 3000, 'images': 6, 'seed': 7})
        a = self.docs.get({'document_id': first['document_id']})
        b = self.docs.get({'document_id': second['document_id']})
        text = lambda d: '\n'.join(plain_text_of(n) for n in d['content']['doc']['content'])
        self.assertEqual(text(a), text(b))
        self.assertGreaterEqual(first['chars'], 3000)
        self.assertEqual(len(image_refs(a['content'])), 6)
        registry = a['meta']['perf_sample']['registry']
        self.assertEqual([r['index'] for r in registry], list(range(1, 7)))
        self.assertTrue(all(r['bytes'] > 0 and r['width'] and r['height'] and len(r['sha256']) == 64 for r in registry))
        self.assertEqual(registry, b['meta']['perf_sample']['registry'])  # 同一环境下图片字节一致
        self.assertEqual(sum(r['bytes'] for r in registry), first['image_bytes'])
        rendered = self.docs.render_delivery({'document_id': first['document_id'], 'base_revision': a['revision']})
        self.assertTrue(rendered['complete'])
        for bad in ({'chars': 10}, {'images': 61}, {'seed': -1}):
            with self.assertRaises(DocumentError):
                self.docs.perf_sample(bad)

    def test_preview_cache_hits_and_clipboard_path_unchanged(self):
        path = self.root / 'big.jpg'
        Image.new('RGB', (2400, 1600), (120, 30, 200)).save(path, 'JPEG', quality=90)
        cache = self.runtime / 'cache'
        sha = 'a' * 64
        first = image_data_url(path, 'image/jpeg', preview=True, cache_dir=cache, sha256=sha)
        self.assertTrue((cache / f'{sha}-1080.jpg').is_file())
        path.write_bytes(b'not an image any more')  # 命中缓存时不再读取原图
        self.assertEqual(image_data_url(path, 'image/jpeg', preview=True, cache_dir=cache, sha256=sha), first)
        # 不带缓存目录（复制用缩略图）：仍走完整解码，与 v3.0 一致
        Image.new('RGB', (2400, 1600), (120, 30, 200)).save(path, 'JPEG', quality=90)
        plain = image_data_url(path, 'image/jpeg', preview=True)
        self.assertTrue(plain.startswith('data:image/jpeg;base64,'))
        with self.assertRaises(Exception):
            image_data_url(self.root / 'missing.jpg', 'image/jpeg', preview=True, cache_dir=cache, sha256='bad')

    def test_preview_render_uses_cache_across_renders(self):
        sample = self.docs.perf_sample({'chars': 1500, 'images': 3, 'seed': 2})
        detail = self.docs.get({'document_id': sample['document_id']})
        one = self.docs.render_delivery({'document_id': sample['document_id'], 'base_revision': detail['revision']})
        cached = list((self.runtime / 'cache' / 'delivery-previews').glob('*-1080.*'))
        self.assertEqual(len(cached), 3)
        two = self.docs.render_delivery({'document_id': sample['document_id'], 'version_id': one['version_id']})
        self.assertEqual(one['html'], two['html'])
        self.assertEqual(one['delivery_hash'], two['delivery_hash'])


if __name__ == '__main__':
    unittest.main()
