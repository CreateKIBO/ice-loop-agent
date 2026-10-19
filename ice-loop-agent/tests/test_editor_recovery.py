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
