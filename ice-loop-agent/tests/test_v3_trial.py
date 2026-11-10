"""v3.13 作者试用记录：手动开启才记录；只记操作类型与数量，不含正文；改稿量与采纳率统计。"""
from __future__ import annotations

import os
import sqlite3
import unittest
from contextlib import closing
from unittest import mock

from ice_agent.application.documents import _assist_apply
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.trial import edit_cost

from tests import REPO, temp_dir

SECRET = '这是一段只属于作者的正文内容，不能出现在试用报告里。'


def para(text):
    return {'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}


def doc(*texts):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': [para(t) for t in texts]}, 'style': {}}


class TestTrial(unittest.TestCase):
    def setUp(self):
        from ice_agent.desktop_service import DesktopService
        self.root = temp_dir('v3-trial-')
        self.env = mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '0'})
        self.env.start()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')

    def tearDown(self):
        self.service.close()
        self.env.stop()

    def events(self):
        with closing(sqlite3.connect(self.service.runtime / 'app.db')) as db:
            return db.execute('SELECT kind, payload_json FROM trial_events ORDER BY created_at, rowid').fetchall()

    def test_nothing_recorded_until_started(self):
        self.service.call('documents.create', {'kind': 'blank', 'title': '未开始'})
        self.assertEqual(self.events(), [])
        self.assertIsNone(self.service.call('documents.trial_status', {})['active'])
        with self.assertRaises(DocumentError):
            self.service.call('documents.trial_note', {'text': '没开始也想记'})

    def test_session_records_steps_without_content(self):
        self.service.call('documents.trial_start', {'label': '第一位作者'})
        with self.assertRaisesRegex(DocumentError, '进行中'):
            self.service.call('documents.trial_start', {})
        created = self.service.call('documents.create', {'kind': 'blank', 'title': '私人标题'})
        saved = self.service.call('documents.save_working', {'document_id': created['document_id'], 'base_revision': created['revision'],
                                                            'content': doc(SECRET)})
        version = self.service.call('documents.commit_version', {'document_id': created['document_id'], 'base_revision': saved['revision']})
        rendered = self.service.call('documents.render_delivery', {'document_id': created['document_id'], 'version_id': version['version_id']})
        self.service.call('documents.delivery_record', {'document_id': created['document_id'], 'version_id': rendered['version_id'],
                                                        'delivery_hash': rendered['delivery_hash'], 'kind': 'copy_html'})
        self.service.call('documents.trial_note', {'text': '找不到图片在哪里插入', 'where': 'editor', 'document_id': created['document_id']})
        status = self.service.call('documents.trial_status', {})
        self.assertEqual(status['events'], 4)
        self.assertEqual([k for k, _ in self.events()], ['doc_created', 'version', 'delivery', 'friction'])
        self.service.call('documents.trial_stop', {})
        self.service.call('documents.create', {'kind': 'blank'})  # 停止后不再记录
        self.assertEqual(len(self.events()), 4)
        report = self.service.call('documents.trial_report', {})
        text = report['markdown']
        self.assertIn('第一位作者', text)
        self.assertIn('找不到图片在哪里插入', text)
        self.assertIn('| 复制到公众号/纯文本 | 1 |', text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('私人标题', text)  # 默认不含标题
        self.assertIsNotNone(report['journey']['开始 → 第一次交付（复制/导出）'])

    def test_ai_edit_cost_and_titles_opt_in(self):
        self.service.call('documents.trial_start', {'include_titles': True})
        from ice_agent.documents.store import DocumentStore
        from ice_agent.domain.store import Store
        account = self.service._account()
        store = Store(self.service.runtime / 'app.db')
        try:
            ai_doc = DocumentStore(store, account['id']).create(title='AI 初稿样例', origin='ai', producer='ai',
                                                                  content=doc('第一段AI写的。', '第二段AI写的。', '第三段AI写的。', '第四段AI写的。'))
        finally:
            store.close()
        detail = self.service.call('documents.get', {'document_id': ai_doc['document_id']})
        saved = self.service.call('documents.save_working', {'document_id': ai_doc['document_id'], 'base_revision': detail['revision'],
                                                            'content': doc('第一段AI写的。', '作者重写了第二段，加了自己的例子。', '第三段AI写的。')})
        version = self.service.call('documents.commit_version', {'document_id': ai_doc['document_id'], 'base_revision': saved['revision']})
        rendered = self.service.call('documents.render_delivery', {'document_id': ai_doc['document_id'], 'version_id': version['version_id']})
        self.service.call('documents.delivery_record', {'document_id': ai_doc['document_id'], 'version_id': rendered['version_id'],
                                                        'delivery_hash': rendered['delivery_hash'], 'kind': 'copy_html'})
        report = self.service.call('documents.trial_report', {})
        cost = report['edit_costs'][0]
        self.assertEqual((cost['ai_paragraphs'], cost['kept_paragraphs'], cost['final_paragraphs']), (4, 2, 3))
        self.assertEqual(cost['compared_to'], '最近一次交付')
        self.assertGreater(cost['changed_ratio'], 0.2)
        self.assertIn('AI 初稿样例', report['markdown'])

    def test_edit_cost_and_apply_extractor(self):
        same = edit_cost(doc('一', '二'), doc('一', '二'))
        self.assertEqual((same['kept_ratio'], same['changed_chars'], same['changed_ratio']), (1.0, 0, 0.0))
        rewritten = edit_cost(doc('原来的句子'), doc('完全不同的新句子内容'))
        self.assertEqual(rewritten['kept_paragraphs'], 0)
        self.assertEqual(rewritten['changed_ratio'], 1.0)  # 上限 100%
        empty = edit_cost(doc(), doc('作者自己写'))
        self.assertIsNone(empty['kept_ratio'])
        payload = _assist_apply({}, {'applied': ['op1', 'op2'], 'stale': ['op3'], 'proposal': {'document_id': 'doc-1', 'ops': [1, 2, 3, 4]}})
        self.assertEqual(payload, {'document_id': 'doc-1', 'accepted': 2, 'total': 4, 'stale': 1})

    def test_validation_and_isolation(self):
        with self.assertRaises(DocumentError):
            self.service.call('documents.trial_start', {'label': '长' * 61})
        self.service.call('documents.trial_start', {})
        for bad in ({'text': ''}, {'text': '长' * 501}, {'text': '好', 'where': 'x' * 41}):
            with self.assertRaises(DocumentError):
                self.service.call('documents.trial_note', bad)
        with self.assertRaises(ValueError):
            self.service.call('documents.trial_status', {'account_id': 'acct-other'})
        with self.assertRaises(DocumentError):
            self.service.call('documents.trial_report', {'session_id': 'trial-missing'})


if __name__ == '__main__':
    unittest.main()
