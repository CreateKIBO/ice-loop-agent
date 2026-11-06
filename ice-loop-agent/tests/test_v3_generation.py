"""v3 P1 整篇生成：快速模式（不提问）、引导模式（先提问）与两版对照。

使用假的创作会话；不调用真实模型、不访问网络。
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from ice_agent.documents.schema import DocumentError

from tests import REPO, temp_dir


class FakeChat:
    sent: list[dict] = []
    created: list[dict] = []

    def __init__(self, service):
        self.service = service

    def call(self, method, params):
        if method == 'chat.create':
            FakeChat.created.append(params)
            return {'conversation': {'id': 'conv-' + params['request_id']}}
        if method == 'chat.send':
            FakeChat.sent.append(params)
            return {'accepted': True, 'status': 'streaming', 'message_id': 'msg-' + params['request_id']}
        raise AssertionError(method)


class TestGenerationModes(unittest.TestCase):
    def setUp(self):
        from ice_agent.desktop_service import DesktopService
        FakeChat.sent, FakeChat.created = [], []
        self.root = temp_dir('v3-gen-')
        self.env = mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '0'})
        self.env.start()
        self.patch = mock.patch('ice_agent.creative_chat.CreativeChat', FakeChat)
        self.patch.start()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')

    def tearDown(self):
        self.service.close()
        self.patch.stop()
        self.env.stop()

    def test_quick_mode_tells_model_not_to_ask(self):
        detail = self.service.call('documents.ai_draft_start', {'brief': '写一篇家庭收纳经验', 'request_id': 'r1'})
        self.assertEqual(detail['generation_state'], 'running')
        self.assertIn('不要提问', FakeChat.sent[0]['text'])
        self.assertTrue(FakeChat.sent[0]['text'].startswith('写一篇家庭收纳经验'))
        self.assertEqual(detail['meta']['brief'], '写一篇家庭收纳经验')  # 文章上只记原始需求
        self.assertNotIn('variant_documents', detail)

    def test_two_variants_are_grouped_and_idempotent(self):
        params = {'brief': '写一篇家庭收纳经验', 'request_id': 'r2', 'variants': 2}
        detail = self.service.call('documents.ai_draft_start', params)
        ids = detail['variant_documents']
        self.assertEqual(len(set(ids)), 2)
        self.assertEqual(len(FakeChat.sent), 2)
        self.assertNotIn('第二个版本', FakeChat.sent[0]['text'])
        self.assertIn('第二个版本', FakeChat.sent[1]['text'])
        listed = self.service.call('documents.variants', {'document_id': ids[1]})
        self.assertEqual([v['variant'] for v in listed], ['A', 'B'])
        self.assertEqual([v['current'] for v in listed], [False, True])
        rows = {r['document_id']: r for r in self.service.call('documents.list', {})['documents']}
        self.assertEqual(rows[ids[0]]['variant'], 'A')
        self.assertEqual(rows[ids[1]]['source_label'], 'AI 初稿·版本B')
        again = self.service.call('documents.ai_draft_start', params)  # 重复提交不再生成
        self.assertEqual(again['variant_documents'], ids)
        self.assertEqual(len(FakeChat.sent), 2)
        single = self.service.call('documents.ai_draft_start', {'brief': '另一篇短文章', 'request_id': 'r3'})
        self.assertEqual(self.service.call('documents.variants', {'document_id': single['document_id']}), [])
        with self.assertRaises(DocumentError):
            self.service.call('documents.ai_draft_start', {'brief': '写一篇', 'request_id': 'r4', 'variants': 3})

    def test_guided_mode_starts_conversation_with_question_hint(self):
        result = self.service.call('documents.ai_guided_start', {'brief': '写一篇家庭收纳经验', 'request_id': 'g1'})
        self.assertEqual(result['conversation_id'], 'conv-guide-g1')
        self.assertIn('提问框', FakeChat.sent[0]['text'])
        self.assertEqual(FakeChat.sent[0]['mode'], 'draft')
        self.assertEqual(self.service.call('documents.list', {})['documents'], [])  # 引导模式不预建文章
        with self.assertRaises(DocumentError):
            self.service.call('documents.ai_guided_start', {'brief': '短', 'request_id': 'g2'})

    def test_invalid_variant_params_rejected_by_service(self):
        from ice_agent.documents.service import DocumentService
        from ice_agent.domain.store import Store
        store = Store(self.service.runtime / 'app.db')
        try:
            docs = DocumentService(self.service, store, self.service._account())
            with self.assertRaisesRegex(DocumentError, '版本对照'):
                docs.ai_draft_start({'brief': '写一篇收纳', 'request_id': 'x1', 'variant': 'C', 'variant_group': 'vg-x1'})
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()
