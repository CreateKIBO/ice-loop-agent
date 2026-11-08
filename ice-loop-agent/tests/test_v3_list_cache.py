"""v3.18 文章列表派生信息缓存：按 content_hash 缓存摘要/字数/图片数/封面；命中时不读正文，内容变了立即反映。"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from ice_agent.documents import store as doc_store
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store

from tests import temp_dir


def doc(text):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': 'b0000000001'}, 'content': [{'type': 'text', 'text': text}]}]}, 'style': {}}


class TestListCache(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-list-cache-')
        (self.root / 'runtime').mkdir()
        self.store = Store(self.root / 'runtime' / 'app.db')
        self.docs = DocumentService(SimpleNamespace(runtime=self.root / 'runtime'), self.store, {'id': 'acct-a'})

    def tearDown(self):
        self.store.close()

    def test_cached_rows_skip_content_and_updates_show_immediately(self):
        created = self.docs.create({'kind': 'blank', 'title': '稿'})
        saved = self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'], 'content': doc('一二三四五')})
        loads = mock.patch.object(doc_store.DocumentStore, '_content_json', autospec=True, side_effect=doc_store.DocumentStore._content_json)
        with loads as spy:
            first = self.docs.list({})['documents'][0]
            second = self.docs.list({})['documents'][0]
        self.assertEqual(first['word_count'], second['word_count'])
        self.assertLessEqual(spy.call_count, 1)  # 第二次命中缓存，不再读正文
        self.docs.save_working({'document_id': created['document_id'], 'base_revision': saved['revision'], 'content': doc('一二三四五六七八九十')})
        updated = self.docs.list({})['documents'][0]
        self.assertGreater(updated['word_count'], first['word_count'])
        self.assertIn('六七八', updated['summary'])
        self.assertEqual(self.docs.list({'query': '六七八'})['documents'][0]['document_id'], created['document_id'])

    def test_cache_is_bounded(self):
        with mock.patch.object(doc_store, '_STATS_LIMIT', 3):
            for i in range(6):
                doc_store.content_stats(f'hash-{i}', lambda: None)
            self.assertLessEqual(len(doc_store._STATS), 3)


if __name__ == '__main__':
    unittest.main()
