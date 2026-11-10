"""v3.12 微信兼容测试稿与逐项记录：覆盖全部可交付元素；三阶段分开记录；未验不计为兼容。"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from ice_agent.documents.compat import ITEMS
from ice_agent.documents.schema import DocumentError, image_refs
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


class TestCompat(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-compat-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.docs = DocumentService(SimpleNamespace(runtime=self.runtime), self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()

    def test_sample_covers_every_item_and_renders(self):
        created = self.docs.compat_create({'themes': ['clean', 'tech']})
        self.assertEqual(len(created['document_ids']), 2)
        detail = self.docs.get({'document_id': created['document_ids'][1]})
        self.assertEqual(detail['content']['style']['theme'], 'tech')
        text = ''.join(b.get('content', [{}])[0].get('text', '') if b['type'] == 'paragraph' and b.get('content') else ''
                       for b in detail['content']['doc']['content'])
        for code, _ in ITEMS:
            self.assertIn(f'【{code}】', text)
        kinds = {b['type'] for b in detail['content']['doc']['content']}
        self.assertTrue({'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule',
                         'articleImage', 'imageGroup', 'callout'} <= kinds)
        self.assertEqual(len(image_refs(detail['content'])), 8)
        rendered = self.docs.render_delivery({'document_id': detail['document_id'], 'base_revision': detail['revision']})
        self.assertTrue(rendered['complete'], rendered['issues'])
        self.assertEqual(len(rendered['images']), 8)
        self.assertEqual(rendered['cover']['source'], 'explicit')
        rows = {r['document_id']: r for r in self.docs.list({})['documents']}
        self.assertEqual(rows[detail['document_id']]['series'], '兼容测试')
        with self.assertRaises(DocumentError):
            self.docs.compat_create({'themes': ['neon']})

    def test_record_and_report(self):
        document_id = self.docs.compat_create({})['document_ids'][0]
        empty = self.docs.compat_get({'document_id': document_id})
        self.assertEqual(len(empty['items']), len(ITEMS))
        self.assertTrue(all(item['paste'] == 'untested' for item in empty['items']))
        self.docs.compat_record({'document_id': document_id, 'items': {
            'C04': {'paste': 'pass', 'saved': 'pass', 'phone': 'partial', 'note': '手机上紫色偏暗 | 待复核'},
            'C15': {'paste': 'fail', 'note': '三列变成单列'}},
            'environment': {'os': 'Windows 11', 'scale': '150%', 'head': 'abc1234'}})
        again = self.docs.compat_record({'document_id': document_id, 'items': {'C15': {'saved': 'fail'}}})
        c15 = next(i for i in again['items'] if i['code'] == 'C15')
        self.assertEqual((c15['paste'], c15['saved'], c15['phone'], c15['note']), ('fail', 'fail', 'untested', '三列变成单列'))
        self.assertEqual(again['environment']['scale'], '150%')
        report = self.docs.compat_report({'document_id': document_id})
        self.assertIn('| C04 | 文字颜色 | 保留 | 保留 | 部分保留 | 手机上紫色偏暗 待复核 |', report['markdown'])
        self.assertIn('Windows 11 / 150%', report['markdown'])
        self.assertEqual(report['counts']['fail'], 2)
        self.assertEqual(report['total'], len(ITEMS) * 3)
        self.assertIn('不能计为兼容', report['markdown'])
        for bad in ({'C99': {'paste': 'pass'}}, {'C01': {'paste': 'ok'}}, {'C01': {'note': '长' * 301}}):
            with self.assertRaises(DocumentError):
                self.docs.compat_record({'document_id': document_id, 'items': bad})
        normal = self.docs.create({'kind': 'blank'})
        with self.assertRaisesRegex(DocumentError, '兼容测试稿'):
            self.docs.compat_get({'document_id': normal['document_id']})


if __name__ == '__main__':
    unittest.main()
