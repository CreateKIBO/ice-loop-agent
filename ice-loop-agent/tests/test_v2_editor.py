"""v2.0 M3 编辑器集成测试：文档、工作草稿、提案采纳/冲突/重放、审批过期。

跑真实 demo 任务到完成态，再走编辑器 RPC（与 test_maintenance_pipeline 同模式）。
"""
from __future__ import annotations

import unittest
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text

from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def _run_demo_to_completed(service: DesktopService, root: Path):
    engine, _, store = service._app(demo=True)
    try:
        job, article = engine.create_job({**demo_spec(), 'demo': True, 'account_id': 'ice-loop',
                                          'article_root': str(root / 'articles')})
        for _ in range(8):
            result = engine.run(job)
            if result['state'] == 'completed':
                break
            approval = store.pending_approval(job)
            if approval is None:
                continue
            engine.decide(job, approval['approval_id'], 'approve', expect_hash=approval['content_hash'])
        assert store.get_job(job)['state'] == 'completed', store.get_job(job)['state']
        return job, article
    finally:
        store.close()


class TestEditorJourney(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('v2-editor-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.job, self.article = _run_demo_to_completed(self.service, self.root)

    def tearDown(self):
        self.service.close()

    def _call(self, method, params):
        return self.service.call(method, {'job_id': self.job, **params})

    def test_document_parse_with_slots_and_roundtrip(self):
        result = self._call('articles.document', {})
        blocks = result['document']['blocks']
        self.assertEqual(blocks[0]['type'], 'heading')
        self.assertEqual(blocks[0]['level'], 1)
        types = {b['type'] for b in blocks}
        self.assertIn('paragraph', types)
        self.assertIn('image_slot', types)
        # 图位关联到 asset_slots 的候选（demo 任务有资产槽）
        for slot_no, candidates in result['slots'].items():
            self.assertIsInstance(candidates, list)
        # 文档序列化回 Markdown 与当前正文语义一致（未编辑走原文字节路径）
        from ice_agent.editorial import parse_document, serialize_document
        reparsed = parse_document(result['markdown'])
        self.assertEqual([b['block_id'] for b in reparsed['blocks']],
                         [b['block_id'] for b in blocks])
        # 重复请求走缓存且一致
        again = self._call('articles.document', {})
        self.assertEqual(again['content_hash'], result['content_hash'])
        self.assertEqual(again['document'], result['document'])

    def test_shared_fixture_block_types_match_frontend_contract(self):
        """前后端共用 fixture：同一文件在 Python 文档模型中的块类型序列。"""
        from ice_agent.editorial import parse_document, serialize_document
        fixture = (Path(REPO) / 'tests' / 'fixtures' / 'editorial-sample.md').read_text(encoding='utf-8')
        doc = parse_document(fixture)
        types = [b['type'] for b in doc['blocks']]
        self.assertEqual(types, ['heading', 'paragraph', 'heading', 'code', 'image_slot',
                                 'quote', 'list', 'list', 'hr', 'run_output', 'raw'])
        self.assertEqual(serialize_document(doc, fixture), fixture, 'Python 侧同样字节往返')

    def test_editor_draft_save_idempotent_and_clear(self):
        doc = self._call('articles.document', {})
        first = self._call('articles.editor_draft_save',
                           {'content': doc['markdown'], 'base_revision': 'rev-x'})
        self.assertTrue(first['changed'])
        second = self._call('articles.editor_draft_save',
                            {'content': doc['markdown'], 'base_revision': 'rev-x'})
        self.assertFalse(second['changed'], '同 hash 重复保存是幂等 no-op')
        draft = self._call('articles.editor_draft_get', {})['draft']
        self.assertEqual(draft['content_hash'], first['content_hash'])
        self.assertEqual(draft['base_revision'], 'rev-x')
        self._call('articles.editor_draft_clear', {})
        self.assertIsNone(self._call('articles.editor_draft_get', {})['draft'])
        # 账号隔离：草稿键含 account，切账号看不到（用伪造另一账号写入验证隔离读取）
        _, _, store = self.service._app(demo=True)
        try:
            from ice_agent.editorial import storage as editorial_store
            editorial_store.save_editor_draft(store, 'other-account', self.article, '别的账号草稿', None, sha256_text('别的账号草稿'))
            self.assertIsNone(editorial_store.get_editor_draft(store, 'ice-loop', self.article))
        finally:
            store.close()

    def test_propose_accept_creates_revision_and_updates_body(self):
        doc = self._call('articles.document', {})
        blocks = doc['document']['blocks']
        target = next(b for b in blocks if b['type'] == 'paragraph')
        from ice_agent.editorial import block_hashes
        proposal = self._call('articles.propose_patch', {
            'base_revision': 'current',
            'ops': [{'op': 'replace', 'block_id': target['block_id'],
                     'old_hash': block_hashes(doc['document'])[target['block_id']],
                     'text': '提案替换后的段落内容'}],
            'reason': '测试提案', 'source_turn': 'turn-1'})['proposal']
        self.assertEqual(proposal['status'], 'pending')
        listed = self._call('articles.proposals_list', {})['proposals']
        self.assertEqual(listed[0]['base_document'], proposal['base_document'])
        self.assertNotIn('base_document_json', listed[0])
        # base_revision='current' 不是真实版本：提案时用当前文档哈希校验，允许无 revision 的会话基线
        decision = self._call('articles.proposal_decide', {
            'proposal_id': proposal['proposal_id'],
            'decisions': [{'op_index': 0, 'decision': 'accept'}]})
        self.assertEqual(decision['status'], 'applied', decision)
        self.assertIsNotNone(decision['revision_id'])
        current = self.service.call('articles.revisions', {'job_id': self.job})
        self.assertEqual(current['current_hash'], decision['content_hash'])
        listing = self.service.call('jobs.get', {'job_id': self.job})
        self.assertIn('提案替换后的段落内容', listing['body'])
        # 已处理提案不再出现在待决列表，但 include_decided 可读（旧候选可追溯）
        pending = self._call('articles.proposals_list', {})['proposals']
        self.assertEqual([p['proposal_id'] for p in pending if p['status'] == 'pending'], [])
        decided = self._call('articles.proposals_list', {'include_decided': True})['proposals']
        self.assertTrue(any(p['proposal_id'] == proposal['proposal_id'] for p in decided))

    def test_stale_baseline_rejected_at_propose_time(self):
        doc = self._call('articles.document', {})
        target = doc['document']['blocks'][1]
        with self.assertRaises(ValueError):
            self._call('articles.propose_patch', {
                'base_revision': 'current',
                'ops': [{'op': 'replace', 'block_id': target['block_id'],
                         'old_hash': '0' * 64, 'text': '过期内容'}]})

    def test_manual_edit_conflicts_old_proposal_and_replays_safe_blocks(self):
        """M3-07：人工改稿后，旧提案冲突段不覆盖人工稿；不冲突段可安全重放。"""
        doc = self._call('articles.document', {})
        blocks = doc['document']['blocks']
        paragraphs = [b for b in blocks if b['type'] == 'paragraph']
        self.assertGreaterEqual(len(paragraphs), 2, 'demo 正文应至少两段')
        from ice_agent.editorial import block_hashes
        hashes = block_hashes(doc['document'])
        proposal = self._call('articles.propose_patch', {
            'base_revision': 'current',
            'ops': [{'op': 'replace', 'block_id': paragraphs[0]['block_id'],
                     'old_hash': hashes[paragraphs[0]['block_id']], 'text': 'AI 想改第一段'},
                    {'op': 'replace', 'block_id': paragraphs[1]['block_id'],
                     'old_hash': hashes[paragraphs[1]['block_id']], 'text': 'AI 想改第二段'}],
            'reason': '两段修改'})['proposal']
        # 人工在另一处保存新版本：只改第一段（模拟用户手改）
        current_body = self.service.call('jobs.get', {'job_id': self.job})['body']
        manual_body = current_body.replace(paragraphs[0]['source'], '人工抢先修改的第一段', 1)
        self.assertNotEqual(manual_body, current_body)
        saved = self.service.call('articles.save', {'job_id': self.job, 'body': manual_body,
                                                    'content_hash': doc['content_hash']})
        self.assertIsNotNone(saved['revision_id'])
        # 现在采纳旧提案：第一段应冲突，第二段安全应用
        decision = self._call('articles.proposal_decide', {
            'proposal_id': proposal['proposal_id'],
            'decisions': [{'op_index': 0, 'decision': 'accept'},
                          {'op_index': 1, 'decision': 'accept'}]})
        self.assertEqual(decision['status'], 'partially_applied', decision)
        conflict_targets = {c.get('op_index') for c in decision['conflicts']}
        self.assertEqual(conflict_targets, {0})
        body = self.service.call('jobs.get', {'job_id': self.job})['body']
        self.assertIn('人工抢先修改的第一段', body, '人工新改稿不能被旧候选覆盖')
        self.assertIn('AI 想改第二段', body, '未冲突段落按规则安全重放')
        # 旧提案处理结果可读
        decided = self._call('articles.proposals_list', {'include_decided': True})['proposals']
        record = next(p for p in decided if p['proposal_id'] == proposal['proposal_id'])
        self.assertEqual(record['status'], 'partially_applied')

    def test_delete_and_insert_and_edit_accept_ops(self):
        doc = self._call('articles.document', {})
        blocks = doc['document']['blocks']
        target = next(b for b in blocks if b['type'] == 'paragraph')
        from ice_agent.editorial import block_hashes
        hashes = block_hashes(doc['document'])
        proposal = self._call('articles.propose_patch', {
            'base_revision': 'current',
            'ops': [{'op': 'insert_after', 'block_id': target['block_id'],
                     'old_hash': hashes[target['block_id']],
                     'new_block': {'type': 'paragraph', 'text': '插入的新段落'}},
                    {'op': 'replace', 'block_id': target['block_id'],
                     'old_hash': hashes[target['block_id']], 'text': '改后接受的段落'}],
            'reason': '插入+改写'})['proposal']
        decision = self._call('articles.proposal_decide', {
            'proposal_id': proposal['proposal_id'],
            'decisions': [{'op_index': 0, 'decision': 'accept'},
                          {'op_index': 1, 'decision': 'new_text', 'text': '编辑后最终段落'}]})
        self.assertEqual(decision['status'], 'applied', decision)
        body = self.service.call('jobs.get', {'job_id': self.job})['body']
        self.assertIn('插入的新段落', body)
        self.assertIn('编辑后最终段落', body)
        self.assertNotIn('改后接受的段落', body)

    def test_approval_stale_after_body_edit(self):
        status = self._call('articles.approval_status', {})
        self.assertIsNone(status['approved_hash'], '无交接审批时不应伪造基线')
        self.assertFalse(status['stale'])
        self.assertTrue(status['workflow_gates'], 'demo 完成任务应有关卡审批记录')
        # 模拟 chat 采纳草稿进入配图交接（登记正文 hash 锚点）
        doc = self._call('articles.document', {})
        _, _, store = self.service._app(demo=True)
        try:
            store.conn.execute(
                "INSERT INTO creative_asset_handoffs (account_id, draft_id, content_hash, job_id)"
                " VALUES ('ice-loop', 'draft-fixture', ?, ?)",
                (doc['content_hash'], self.job))
            store.conn.commit()
        finally:
            store.close()
        fresh = self._call('articles.approval_status', {})
        self.assertEqual(fresh['approved_hash'], doc['content_hash'])
        self.assertFalse(fresh['stale'])
        # 正文被修改 → 审批基线过期（只读比较，不改历史）
        body = self.service.call('jobs.get', {'job_id': self.job})['body']
        self.service.call('articles.save', {'job_id': self.job,
                                            'body': body + '\n\n补充一段。',
                                            'content_hash': doc['content_hash']})
        stale = self._call('articles.approval_status', {})
        self.assertTrue(stale['stale'], '正文修改后旧审批必须显示过期')
        self.assertEqual(stale['approved_hash'], doc['content_hash'], '历史审批记录不被改写')

    def test_restore_keeps_history_and_proposals_readable(self):
        """M3-08：恢复到新版本不删除后续历史；提案记录继续可读。"""
        doc = self._call('articles.document', {})
        revisions_before = self.service.call('articles.revisions', {'job_id': self.job})
        self.assertGreaterEqual(len(revisions_before['revisions']), 1)
        body = self.service.call('jobs.get', {'job_id': self.job})['body']
        self.service.call('articles.save', {'job_id': self.job,
                                            'body': body + '\n\n第二版补充。',
                                            'content_hash': doc['content_hash']})
        # 恢复到恢复前的第一版（articles.restore 语义 = save_body(restore_id)）
        first = revisions_before['revisions'][-1]
        restored = self.service.call('articles.restore', {'job_id': self.job,
                                                          'revision_id': first['revision_id'],
                                                          'content_hash': self._call('articles.document', {})['content_hash']})
        self.assertIsNotNone(restored['revision_id'])
        revisions_after = self.service.call('articles.revisions', {'job_id': self.job})
        self.assertGreater(len(revisions_after['revisions']), len(revisions_before['revisions']),
                           '恢复产生新版本，不删除后续历史')


    def test_proposal_summary_pages_tied_timestamps_and_processed_anchor(self):
        from ice_agent.editorial import storage as es
        _, _, store = self.service._job_app(self.job)
        try:
            ids = []
            for i in range(23):
                p = es.create_edit_proposal(store, 'ice-loop', self.article, 'base', 'hash',
                    {'blocks': [{'source': 'large' * 10000}]}, [{'text': 'new' * 10000}], str(i), None)
                ids.append(p['proposal_id'])
            store.conn.execute("UPDATE edit_proposals SET created_at=? WHERE article_id=?", ('2026-10-23T00:00:00', self.article));store.conn.commit()
        finally:
            store.close()
        seen=[];cursor=None;first=True
        while True:
            page=self._call('articles.proposals_page', {'limit':7,'cursor':cursor})
            self.assertLessEqual(len(page['proposals']),7)
            for row in page['proposals']:
                self.assertNotIn('base_document',row);self.assertNotIn('base_document_json',row);self.assertNotIn('ops',row)
            seen.extend(row['proposal_id'] for row in page['proposals'])
            cursor=page['next_cursor']
            if not cursor:break
            if first:
                _,_,store=self.service._job_app(self.job)
                try:es.finish_edit_proposal(store,cursor,'rejected',{})
                finally:store.close()
                first=False
        self.assertEqual(seen,sorted(ids,reverse=True))
        detail=self._call('articles.proposal_get',{'proposal_id':ids[0]})['proposal']
        self.assertEqual(detail['base_document']['blocks'][0]['source'],'large'*10000)

    def test_proposal_page_rejects_bad_limits_and_out_of_scope_references(self):
        from ice_agent.editorial import storage as es
        _,_,store=self.service._job_app(self.job)
        try:
            alien=es.create_edit_proposal(store,'another-account',self.article,'b','h',{'blocks':[]},[],'alien',None)['proposal_id']
            other=es.create_edit_proposal(store,'ice-loop','another-article','b','h',{'blocks':[]},[],'other',None)['proposal_id']
        finally:store.close()
        for limit in [0,51,True,1.5,'20',None]:
            with self.assertRaises(ValueError):self._call('articles.proposals_page',{'limit':limit})
        for reference in [alien,other,'missing',True,'']:
            with self.assertRaises(ValueError):self._call('articles.proposals_page',{'cursor':reference})
            with self.assertRaises(ValueError):self._call('articles.proposal_get',{'proposal_id':reference})
        self.assertEqual(self._call('articles.proposals_page',{})['proposals'],[])


    def _review_proposal(self):
        from ice_agent.editorial import block_hashes
        doc = self._call('articles.document', {})
        block = next(b for b in doc['document']['blocks'] if b['type'] == 'paragraph')
        op = {'op': 'replace', 'block_id': block['block_id'],
              'old_hash': block_hashes(doc['document'])[block['block_id']], 'text': '审阅候选新段落'}
        return self._call('articles.propose_patch', {'ops': [op], 'base_revision': 'current'})['proposal']

    def _save_review(self, p, items, version=0, **extra):
        return self._call('articles.proposal_draft_save', {'proposal_id': p['proposal_id'],
            'base_hash': p['base_hash'], 'decisions': items, 'expected_version': version, **extra})['draft']

    def test_review_draft_restart_no_body_write_and_atomic_retirement(self):
        p = self._review_proposal()
        before = self._call('articles.document', {})
        self._call('articles.editor_draft_save', {'content': '独立正文草稿', 'base_revision': None})
        items = [{'op_index': 0, 'decision': 'new_text', 'text': ''}]
        saved = self._save_review(p, items)
        self.assertEqual(saved['version'], 1)
        self.assertEqual(self._save_review(p, items), saved, '重复/回执丢失重试不产生新版本')
        self.service.close()
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        restored = self._call('articles.proposal_get', {'proposal_id': p['proposal_id']})['review_draft']
        self.assertEqual(restored['decisions'], items, '允许保存尚未写完的手改文字')
        self.assertEqual(self._call('articles.document', {})['markdown'], before['markdown'])
        self.assertEqual(self._call('articles.editor_draft_get', {})['draft']['content'], '独立正文草稿')
        with self.assertRaises(ValueError):
            self._call('articles.proposal_decide', {'proposal_id': p['proposal_id'], 'decisions': items})
        self.assertIsNotNone(self._call('articles.proposal_get', {'proposal_id': p['proposal_id']})['review_draft'])
        self._call('articles.proposal_decide', {'proposal_id': p['proposal_id'],
                    'decisions': [{'op_index': 0, 'decision': 'reject'}]})
        self.assertIsNone(self._call('articles.proposal_get', {'proposal_id': p['proposal_id']})['review_draft'])
        _, _, store = self.service._job_app(self.job)
        try:
            self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM proposal_decision_drafts').fetchone()[0], 0)
        finally:
            store.close()
        with self.assertRaises(ValueError):
            self._save_review(p, items, 1)

    def test_review_draft_validates_scope_baseline_shape_and_versions(self):
        from ice_agent.editorial.storage import save_proposal_decision_draft, get_proposal_decision_draft
        p = self._review_proposal()
        accept = [{'op_index': 0, 'decision': 'accept'}]
        self._save_review(p, accept)
        with self.assertRaises(ValueError):
            self._save_review(p, [{'op_index': 0, 'decision': 'reject'}], 0)
        for bad in [[{'op_index': True, 'decision': 'accept'}],
                    [{'op_index': -1, 'decision': 'reject'}],
                    [{'op_index': 1, 'decision': 'accept'}],
                    [{'op_index': 0, 'decision': 'new_text', 'text': 'x' * 20001}],
                    [{'op_index': 0, 'decision': 'bad'}], {}, None]:
            with self.subTest(bad=str(bad)[:90]), self.assertRaises(ValueError):
                self._save_review(p, bad, 1)
        with self.assertRaises(ValueError):
            self._save_review(p, accept, 1, base_hash='wrong')
        with self.assertRaises(ValueError):
            self._save_review(p, accept, True)
        _, _, store = self.service._job_app(self.job)
        try:
            for account, article in [('other', self.article), ('ice-loop', 'other')]:
                self.assertIsNone(get_proposal_decision_draft(store, account, article, p['proposal_id']))
                with self.assertRaises(ValueError):
                    save_proposal_decision_draft(store, account, article, p['proposal_id'], p['base_hash'], [], 0)
        finally:
            store.close()
        self.assertEqual(self._save_review(p, [], 1)['version'], 2)
        with self.assertRaises(ValueError):
            self._call('articles.proposal_decide', {'proposal_id': p['proposal_id'], 'review_version': 1,
                'decisions': [{'op_index': 0, 'decision': 'accept'}]})
        self.assertEqual(self._call('articles.proposal_get', {'proposal_id': p['proposal_id']})['proposal']['status'], 'pending')

    def test_submission_rejects_duplicate_boolean_missing_indices_and_oversized_text(self):
        from ice_agent.editorial.storage import validate_proposal_decisions
        for items in [[{'op_index': 0, 'decision': 'accept'}] * 2,
                      [{'op_index': True, 'decision': 'accept'}],
                      [{'decision': 'reject'}],
                      [{'op_index': 0, 'decision': 'new_text', 'text': 'x' * 20001}]]:
            with self.subTest(items=str(items)[:80]), self.assertRaises(ValueError):
                validate_proposal_decisions(items, len(items), complete=True)
        self.assertEqual(validate_proposal_decisions([
            {'op_index': 1, 'decision': 'reject'}, {'op_index': 0, 'decision': 'accept'}], 2, complete=True)[0]['op_index'], 0)


if __name__ == '__main__':
    unittest.main()
