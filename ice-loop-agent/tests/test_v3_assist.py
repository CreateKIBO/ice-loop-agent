"""v3 P1-01 文章内助手提案链：局部改写→提案→部分采纳→过期保留→撤销。

全部使用 owned 临时夹具和假模型；不调用真实模型、不访问网络。
"""
from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from ice_agent.documents import assist as assist_module
from ice_agent.documents.assist import DocumentAssist
from ice_agent.documents.schema import DocumentError
from ice_agent.documents.service import DocumentService
from ice_agent.domain.store import Store
from ice_agent.llm.errors import ModelError

from tests import temp_dir


def paragraph(text, **attrs):
    return {'type': 'paragraph', 'attrs': attrs, 'content': [{'type': 'text', 'text': text}]}


def doc(*blocks):
    return {'schema': 1, 'doc': {'type': 'doc', 'content': list(blocks)}, 'style': {}}


class FakeResponse:
    def __init__(self, data):
        self.json = data
        self.model_id = 'fake-model'
        self.usage = {'input_tokens': 10, 'output_tokens': 5}


class AssistFixture(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v3-assist-')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.store = Store(self.runtime / 'app.db')
        self.service = SimpleNamespace(runtime=self.runtime)
        self.account = {'id': 'acct-a', 'name': '冰环编译手记'}
        self.docs = DocumentService(self.service, self.store, self.account)
        self.reply: dict | Exception = {}
        self.requests: list = []
        self.profile: dict | None = None
        self.assist = DocumentAssist(self.service, self.store, self.account, submit=self._submit)
        created = self.docs.create({'kind': 'blank', 'title': '测试文章'})
        self.document_id = created['document_id']
        saved = self.docs.save_working({'document_id': self.document_id, 'base_revision': created['revision'], 'content': doc(
            paragraph('第一段原文。', id='b0000000001', textAlign='center'),
            paragraph('第二段原文。', id='b0000000002'),
            paragraph('第三段原文。', id='b0000000003'))})
        self.revision = saved['revision']

    def tearDown(self):
        self.store.close()

    def _submit(self, proposal_id, request, cancel):
        def generate(req):
            self.requests.append(req)
            if isinstance(self.reply, Exception):
                raise self.reply
            return FakeResponse(self.reply)
        DocumentAssist(self.service, self.store, self.account).run(proposal_id, request, generate, profile=self.profile)

    def blocks(self):
        return self.docs.get({'document_id': self.document_id})['content']['doc']['content']

    def texts(self):
        return [''.join(c.get('text', '') for c in b.get('content') or []) for b in self.blocks()]

    def start(self, action='rewrite', ids=('b0000000001', 'b0000000002'), **extra):
        return self.assist.start({'document_id': self.document_id, 'action': action, 'block_ids': list(ids),
                                  'base_revision': self.revision, **extra})


class TestAssistProposals(AssistFixture):
    def test_partial_accept_keeps_ids_and_versions(self):
        self.reply = {'notes': '让表达更紧凑', 'edits': [
            {'block_id': 'b0000000001', 'markdown': '第一段**改写后**。', 'reason': '更紧凑'},
            {'block_id': 'b0000000002', 'markdown': '第二段改写后。'},
            {'block_id': 'b0000000003', 'markdown': '选区以外，不应采纳'}]}
        proposal = self.start()
        self.assertEqual(proposal['status'], 'ready')
        self.assertEqual([op['block_id'] for op in proposal['ops']], ['b0000000001', 'b0000000002'])
        self.assertIn('选区以外', proposal['notes'])
        self.assertEqual(proposal['model_id'], 'fake-model')
        self.assertEqual(self.texts(), ['第一段原文。', '第二段原文。', '第三段原文。'])  # 提案不碰正文
        request = self.requests[0]
        self.assertEqual(request.node, 'document_assist')
        self.assertEqual([t['block_id'] for t in request.context['targets']], ['b0000000001', 'b0000000002'])
        self.assertEqual(request.context['after'], '第三段原文。')

        result = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1'], 'base_revision': self.revision})
        self.assertEqual(result['applied'], ['op1'])
        self.assertEqual(result['revision'], self.revision + 1)
        self.assertEqual(self.texts(), ['第一段改写后。', '第二段原文。', '第三段原文。'])
        first = self.blocks()[0]
        self.assertEqual(first['attrs']['id'], 'b0000000001')
        self.assertEqual(first['attrs']['textAlign'], 'center')
        self.assertEqual(first['content'][1]['marks'][0]['type'], 'bold')
        self.assertEqual(result['proposal']['status'], 'partially_applied')
        self.assertEqual(result['proposal']['decision']['rejected'], ['op2'])
        versions = self.docs.versions({'document_id': self.document_id})
        self.assertEqual(versions[0]['producer'], 'ai')
        self.assertIn('1/2', versions[0]['note'])
        self.assertEqual(versions[1]['note'], '采纳 AI 修改前')
        with self.assertRaisesRegex(DocumentError, '已处理'):
            self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op2'], 'base_revision': result['revision']})

    def test_stale_ops_are_kept_visible_and_skipped(self):
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '一改'}, {'block_id': 'b0000000002', 'markdown': '二改'}]}
        proposal = self.start()
        content = doc(paragraph('第一段原文。', id='b0000000001'), paragraph('用户又改了第二段。', id='b0000000002'),
                      paragraph('第三段原文。', id='b0000000003'))
        saved = self.docs.save_working({'document_id': self.document_id, 'base_revision': self.revision, 'content': content})
        listed = self.assist.list({'document_id': self.document_id})[0]
        self.assertEqual([op['state'] for op in listed['ops']], ['ok', 'stale'])
        self.assertEqual(listed['stale_count'], 1)
        with self.assertRaisesRegex(DocumentError, '原文已经变化'):
            self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op2'], 'base_revision': saved['revision']})
        with self.assertRaisesRegex(DocumentError, '未保存'):
            self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1'], 'base_revision': self.revision})
        result = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1', 'op2'], 'base_revision': saved['revision']})
        self.assertEqual(result['stale'], ['op2'])
        self.assertEqual(self.texts(), ['一改', '用户又改了第二段。', '第三段原文。'])
        self.assertEqual(result['proposal']['status'], 'partially_applied')

    def test_compress_can_merge_and_delete(self):
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '合并后的一段。'}, {'block_id': 'b0000000002', 'markdown': ''}]}
        proposal = self.start('compress')
        self.assertEqual([op['kind'] for op in proposal['ops']], ['replace', 'delete'])
        self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1', 'op2'], 'base_revision': self.revision})
        self.assertEqual(self.texts(), ['合并后的一段。', '第三段原文。'])

    def test_expand_into_several_blocks(self):
        self.reply = {'edits': [{'block_id': 'b0000000002', 'markdown': '扩写第一段。\n\n## 小标题\n\n扩写第二段。'}]}
        proposal = self.start('expand', ids=['b0000000002'])
        self.assertEqual(len(proposal['ops'][0]['after']), 3)
        result = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1'], 'base_revision': self.revision})
        blocks = result['content']['doc']['content']
        self.assertEqual([b['type'] for b in blocks], ['paragraph', 'paragraph', 'heading', 'paragraph', 'paragraph'])
        self.assertEqual(blocks[1]['attrs']['id'], 'b0000000002')
        self.assertEqual(len({b['attrs']['id'] for b in blocks}), 5)

    def test_unchanged_edit_is_not_an_op(self):
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '第一段原文。'}]}
        proposal = self.start(ids=['b0000000001'])
        self.assertEqual(proposal['ops'], [])
        self.assertIn('不需要修改', proposal['notes'])

    def test_image_slot_suggestions_insert_in_order(self):
        self.reply = {'image_slots': [
            {'after_block_id': 'b0000000001', 'caption': '流程示意', 'kind': '示意图', 'reason': '帮助理解'},
            {'after_block_id': 'b0000000001', 'caption': '界面截图', 'kind': '截图'},
            {'after_block_id': 'bmissing0001', 'caption': '无效位置'}]}
        proposal = self.start('image_slots', ids=[])
        self.assertEqual(len(proposal['ops']), 2)
        self.assertIn('位置无效', proposal['notes'])
        self.assertEqual(len(self.requests[0].context['article']), 3)
        result = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1', 'op2'], 'base_revision': self.revision})
        blocks = result['content']['doc']['content']
        self.assertEqual([b['type'] for b in blocks], ['paragraph', 'imageSlot', 'imageSlot', 'paragraph', 'paragraph'])
        self.assertEqual([blocks[1]['attrs']['caption'], blocks[2]['attrs']['caption']], ['流程示意', '界面截图'])
        self.assertEqual(blocks[2]['attrs']['kind'], '截图')

    def test_revert_restores_once_and_refuses_after_new_edits(self):
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '一改'}]}
        proposal = self.start(ids=['b0000000001'])
        applied = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1'], 'base_revision': self.revision})
        reverted = self.assist.revert({'proposal_id': proposal['proposal_id'], 'base_revision': applied['revision']})
        self.assertEqual(self.texts()[0], '第一段原文。')
        self.assertEqual(reverted['proposal']['status'], 'ready')
        self.assertEqual(len(reverted['proposal']['decision']['history']), 1)
        # 撤销后可再次采纳；采纳后再编辑则不能直接撤销
        again = self.assist.apply({'proposal_id': proposal['proposal_id'], 'op_ids': ['op1'], 'base_revision': reverted['revision']})
        edited = doc(paragraph('一改又手改', id='b0000000001'), paragraph('第二段原文。', id='b0000000002'),
                     paragraph('第三段原文。', id='b0000000003'))
        saved = self.docs.save_working({'document_id': self.document_id, 'base_revision': again['revision'], 'content': edited})
        with self.assertRaisesRegex(DocumentError, '历史版本'):
            self.assist.revert({'proposal_id': proposal['proposal_id'], 'base_revision': saved['revision']})

    def test_dismiss_marks_rejected(self):
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '一改'}]}
        proposal = self.start(ids=['b0000000001'])
        dismissed = self.assist.dismiss({'proposal_id': proposal['proposal_id']})
        self.assertEqual(dismissed['status'], 'rejected')
        self.assertEqual(self.texts()[0], '第一段原文。')


class TestAssistFailuresAndContext(AssistFixture):
    def test_model_failure_is_recorded(self):
        self.reply = ModelError('AUTH', '模型密钥无效')
        proposal = self.start()
        self.assertEqual(proposal['status'], 'failed')
        self.assertIn('密钥', proposal['error'])
        self.assertEqual(self.texts()[0], '第一段原文。')

    def test_submit_failure_is_recorded(self):
        assist = DocumentAssist(self.service, self.store, self.account, submit=None)
        proposal = assist.start({'document_id': self.document_id, 'action': 'rewrite', 'block_ids': ['b0000000001'],
                                 'base_revision': self.revision})
        self.assertEqual(proposal['status'], 'failed')

    def test_interrupted_generation_is_reconciled(self):
        assist = DocumentAssist(self.service, self.store, self.account, submit=lambda *a: None)
        proposal = assist.start({'document_id': self.document_id, 'action': 'rewrite', 'block_ids': ['b0000000001'],
                                 'base_revision': self.revision})
        self.assertEqual(proposal['status'], 'generating')
        assist_module.release(proposal['proposal_id'])  # 模拟进程重启：内存中的活动表清空
        self.assertEqual(assist.get({'proposal_id': proposal['proposal_id']})['status'], 'failed')

    def test_cancel(self):
        assist = DocumentAssist(self.service, self.store, self.account, submit=lambda *a: None)
        proposal = assist.start({'document_id': self.document_id, 'action': 'tone', 'tone': '更口语',
                                 'block_ids': ['b0000000001'], 'base_revision': self.revision})
        cancelled = assist.cancel({'proposal_id': proposal['proposal_id']})
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertEqual(cancelled['instruction'], '更口语')

    def test_validation(self):
        with self.assertRaisesRegex(DocumentError, '选中'):
            self.start(ids=[])
        with self.assertRaisesRegex(DocumentError, '重新选择'):
            self.start(ids=['bmissing0001'])
        with self.assertRaisesRegex(DocumentError, '未保存'):
            self.assist.start({'document_id': self.document_id, 'action': 'rewrite', 'block_ids': ['b0000000001'],
                               'base_revision': self.revision - 1})
        with self.assertRaisesRegex(DocumentError, '语气'):
            self.start('tone', tone='随便')
        with self.assertRaisesRegex(DocumentError, '怎样修改'):
            self.start('custom', instruction=' ')
        with self.assertRaisesRegex(DocumentError, '不支持'):
            self.start('publish')
        other = DocumentAssist(self.service, self.store, {'id': 'acct-b'}, submit=self._submit)
        with self.assertRaises(DocumentError):
            other.start({'document_id': self.document_id, 'action': 'rewrite', 'block_ids': ['b0000000001'], 'base_revision': self.revision})

    def test_profile_context_and_manifest(self):
        self.profile = {'writing_skill_snapshot': {'name': '冰环文风', 'rules': ['短句']}, 'article': {'paragraph_max': 120},
                        'brand': {'name': '冰环编译手记'}}
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '一改'}]}
        proposal = self.start('custom', ids=['b0000000001'], instruction='加一个反问')
        context = self.requests[0].context
        self.assertEqual(context['writing_skill']['name'], '冰环文风')
        self.assertEqual(context['house_rules'], {'paragraph_max': 120})
        self.assertIn('加一个反问', self.requests[0].prompt)
        self.assertTrue(proposal['context']['writing_skill'])
        self.assertEqual(proposal['context']['targets'], 1)
        json.dumps(proposal, ensure_ascii=False)  # RPC 可序列化


class TestHistoryAndReferences(AssistFixture):
    def make(self, title, text, series=None, episode=None):
        created = self.docs.create({'kind': 'blank', 'title': title, 'series': series, 'episode': episode})
        self.docs.save_working({'document_id': created['document_id'], 'base_revision': created['revision'],
                                'content': doc(paragraph(text))})
        return created['document_id']

    def test_search_title_and_body_in_current_account_only(self):
        a = self.make('Rust 所有权入门', '借用检查器让内存安全成为编译期保证。')
        b = self.make('周末随笔', '今天聊聊借用检查器和生命周期。')
        other = DocumentService(self.service, self.store, {'id': 'acct-b'})
        foreign = other.create({'kind': 'blank', 'title': '别的号：借用检查器'})
        found = self.assist.search({'document_id': self.document_id, 'query': '借用检查器'})
        ids = [r['document_id'] for r in found['results']]
        self.assertEqual(set(ids), {a, b})
        self.assertNotIn(foreign['document_id'], ids)
        self.assertNotIn(self.document_id, ids)
        self.assertIn('借用检查器', found['results'][0]['snippet'])
        self.assertEqual(self.assist.search({'document_id': self.document_id, 'query': 'Rust 借用'})['results'][0]['document_id'], a)
        self.assertEqual(self.assist.search({'document_id': self.document_id, 'query': '不存在的词'})['results'], [])
        with self.assertRaises(DocumentError):
            self.assist.search({'document_id': self.document_id, 'query': ' '})

    def test_pinned_references_and_series_context_reach_the_model(self):
        ref = self.make('术语表', '本号统一把 borrow checker 译为借用检查器。')
        for n in (1, 2, 4):
            self.make(f'第{n}期', f'第{n}期正文。', series='编译器笔记', episode=n)
        # 正在编辑的文章设为第 3 期
        self.store.conn.execute("UPDATE documents SET series='编译器笔记', episode=3 WHERE document_id=?", (self.document_id,))
        self.store.conn.commit()
        listed = self.assist.search({'document_id': self.document_id, 'series_only': True})
        self.assertEqual([r['episode'] for r in listed['results']], [2, 1, 4])
        self.reply = {'edits': [{'block_id': 'b0000000001', 'markdown': '一改'}]}
        proposal = self.start(ids=['b0000000001'], reference_ids=[ref], series_context=True)
        context = self.requests[0].context
        self.assertEqual(context['references'][0]['title'], '术语表')
        self.assertIn('借用检查器', context['references'][0]['excerpt'])
        self.assertEqual([e['episode'] for e in context['series']['episodes']], [2, 1, 4])
        self.assertEqual(proposal['context']['references'], ['术语表'])
        self.assertEqual(proposal['context']['series'], 3)
        self.assertIn('不得照抄', self.requests[0].system)

    def test_reference_validation(self):
        with self.assertRaisesRegex(DocumentError, '正在编辑'):
            self.start(reference_ids=[self.document_id])
        with self.assertRaisesRegex(DocumentError, '最多'):
            self.start(reference_ids=['doc-1', 'doc-2', 'doc-3', 'doc-4'])
        with self.assertRaisesRegex(DocumentError, '重新选择'):
            self.start(reference_ids=['doc-missing'])
        with self.assertRaisesRegex(DocumentError, '系列'):
            self.start(series_context=True)
        trashed = self.make('删掉的稿', '内容')
        self.docs.trash({'document_id': trashed})
        with self.assertRaisesRegex(DocumentError, '重新选择'):
            self.start(reference_ids=[trashed])


class TestAssistRpc(unittest.TestCase):
    def test_methods_registered_and_exposed(self):
        from ice_agent.application.documents import PUBLIC
        from tests import REPO
        methods = (REPO / 'desktop' / 'workbench-methods.cjs').read_text(encoding='utf-8')
        for name in ('documents.assist_start', 'documents.assist_list', 'documents.assist_get', 'documents.assist_cancel',
                     'documents.assist_apply', 'documents.assist_dismiss', 'documents.assist_revert',
                     'documents.assist_search'):
            self.assertIn(name, PUBLIC)
            self.assertIn(f"'{name}'", methods)


    def test_real_worker_path_fails_honestly_without_models(self):
        import os
        import time
        from unittest import mock
        from ice_agent.desktop_service import DesktopService
        from tests import REPO
        root = temp_dir('v3-assist-rpc-')
        with mock.patch.dict(os.environ, {'ICE_LEGACY_CODE_EXECUTION': '0'}):
            service = DesktopService(REPO, root / 'runtime', root / 'articles')
            try:
                created = service.call('documents.create', {'kind': 'blank', 'title': '无模型'})
                saved = service.call('documents.save_working', {'document_id': created['document_id'], 'base_revision': created['revision'],
                                                                'content': doc(paragraph('一段话。', id='b0000000001'))})
                proposal = service.call('documents.assist_start', {'document_id': created['document_id'], 'action': 'rewrite',
                                                                   'block_ids': ['b0000000001'], 'base_revision': saved['revision']})
                deadline = time.monotonic() + 20
                while proposal['status'] == 'generating' and time.monotonic() < deadline:
                    time.sleep(0.05)
                    proposal = service.call('documents.assist_get', {'proposal_id': proposal['proposal_id']})
                self.assertEqual(proposal['status'], 'failed')
                self.assertTrue(proposal['error'])
                listed = service.call('documents.assist_list', {'document_id': created['document_id']})
                self.assertEqual(listed[0]['proposal_id'], proposal['proposal_id'])
            finally:
                service.close()


if __name__ == '__main__':
    unittest.main()
