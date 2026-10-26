"""Editor recovery RPC regressions, without executing article code or cloud calls."""
import unittest

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestEditorRecovery(unittest.TestCase):
    def setUp(self):
        root = temp_dir('editor-recovery-')
        self.service = DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        engine,_,store = self.service._app(demo=True)
        try:
            self.job,_ = engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop'})
            state = engine._load_state(self.job)
            self.body = '# Original\n\nKeep published content.\n'
            state['integrated_md'] = self.body
            store.save_checkpoint(self.job,state)
            store.update_job(self.job,state='completed',current_node='export',lease=None)
        finally: store.close()

    def call(self,method,**params):
        return self.service.call(method,{'job_id':self.job,**params})

    def test_empty_working_draft_is_restorable_without_erasing_version(self):
        saved = self.call('articles.editor_draft_save',content='',base_revision='original')
        draft = self.call('articles.editor_draft_get')['draft']
        self.assertEqual(saved['content_hash'],sha256_text(''))
        self.assertEqual(draft['content'],'')
        self.assertEqual(draft['base_revision'],'original')
        self.assertEqual(self.call('articles.document')['markdown'],self.body)

    def test_empty_draft_idempotent_and_explicit_clear(self):
        self.assertTrue(self.call('articles.editor_draft_save',content='')['changed'])
        self.assertFalse(self.call('articles.editor_draft_save',content='')['changed'])
        self.call('articles.editor_draft_clear')
        self.assertIsNone(self.call('articles.editor_draft_get')['draft'])

    def test_new_baseline_updates_even_when_content_did_not_change(self):
        self.call('articles.editor_draft_save',content='same',base_revision='old')
        outcome = self.call('articles.editor_draft_save',content='same',base_revision='new')
        self.assertTrue(outcome['changed'])
        self.assertEqual(self.call('articles.editor_draft_get')['draft']['base_revision'],'new')
        self.assertFalse(self.call('articles.editor_draft_save',content='same',base_revision='new')['changed'])

    def test_invalid_or_oversized_recovery_does_not_replace_existing(self):
        self.call('articles.editor_draft_save',content='keep')
        for value in (None,1,[],{},'x'*100001):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError): self.call('articles.editor_draft_save',content=value)
                self.assertEqual(self.call('articles.editor_draft_get')['draft']['content'],'keep')

    def test_empty_published_version_remains_rejected(self):
        with self.assertRaisesRegex(ValueError,'正文不能为空'):
            self.call('articles.save',body='',content_hash=sha256_text(self.body))
        self.assertEqual(self.call('articles.document')['markdown'],self.body)


    def proposal(self):
        from ice_agent.editorial import block_hashes
        doc=self.call('articles.document');target=next(b for b in doc['document']['blocks'] if b['type']=='paragraph')
        return self.call('articles.propose_patch',base_revision='current',ops=[{'op':'replace',
            'block_id':target['block_id'],'old_hash':block_hashes(doc['document'])[target['block_id']],
            'text':'Approved proposal replacement.'}])['proposal']

    def test_unsaved_body_blocks_applying_proposal_without_losing_either_draft(self):
        proposal=self.proposal();before=self.call('articles.revisions')
        self.call('articles.editor_draft_save',content='# Unsaved manual draft\n\nKeep my input.',base_revision=sha256_text(self.body))
        self.call('articles.proposal_draft_save',proposal_id=proposal['proposal_id'],base_hash=proposal['base_hash'],
                  expected_version=0,decisions=[{'op_index':0,'decision':'accept'}])
        with self.assertRaisesRegex(ValueError,'工作草稿'):
            self.call('articles.proposal_decide',proposal_id=proposal['proposal_id'],decisions=[{'op_index':0,'decision':'accept'}])
        self.assertEqual(self.call('articles.document')['markdown'],self.body)
        self.assertEqual(self.call('articles.revisions'),before)
        self.assertIn('Keep my input',self.call('articles.editor_draft_get')['draft']['content'])
        p=self.call('articles.proposal_get',proposal_id=proposal['proposal_id'])
        self.assertEqual(p['proposal']['status'],'pending');self.assertIsNotNone(p['review_draft'])


    def test_reject_all_preserves_unsaved_body_and_never_saves_version(self):
        p=self.proposal();self.call('articles.editor_draft_save',content='')
        before=self.call('articles.revisions')
        result=self.call('articles.proposal_decide',proposal_id=p['proposal_id'],decisions=[{'op_index':0,'decision':'reject'}])
        self.assertEqual(result['status'],'rejected');self.assertIsNone(result['revision_id'])
        self.assertEqual(self.call('articles.editor_draft_get')['draft']['content'],'')
        self.assertEqual(self.call('articles.revisions'),before)

    def test_save_manual_version_then_apply_keeps_manual_paragraph_and_retires_clean_recovery(self):
        p=self.proposal();body=self.body+'\nAdditional manually written paragraph.\n'
        self.call('articles.editor_draft_save',content=body)
        saved=self.call('articles.save',body=body,content_hash=sha256_text(self.body))
        self.call('articles.editor_draft_save',content=body,base_revision=saved['content_hash'])
        result=self.call('articles.proposal_decide',proposal_id=p['proposal_id'],decisions=[{'op_index':0,'decision':'accept'}])
        self.assertEqual(result['status'],'applied')
        current=self.call('articles.document')['markdown']
        self.assertIn('Additional manually written paragraph.',current)
        self.assertIn('Approved proposal replacement.',current)
        self.assertIsNone(self.call('articles.editor_draft_get')['draft'])

    def test_body_draft_arriving_after_proposal_commit_is_never_cleared(self):
        from unittest.mock import patch
        from ice_agent.editorial import storage as es
        original=es.finish_edit_proposal
        p=self.proposal();self.call('articles.editor_draft_save',content=self.body)
        def finish(store,*args):
            original(store,*args)
            es.save_editor_draft(store,'ice-loop',p['article_id'],
                                 'Later window manual input',None,sha256_text('Later window manual input'))
        with patch('ice_agent.editorial.storage.finish_edit_proposal',side_effect=finish):
            result=self.call('articles.proposal_decide',proposal_id=p['proposal_id'],decisions=[{'op_index':0,'decision':'accept'}])
        self.assertEqual(result['status'],'applied')
        self.assertEqual(self.call('articles.editor_draft_get')['draft']['content'],'Later window manual input')
