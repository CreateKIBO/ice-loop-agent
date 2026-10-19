"""Editable import preview, account CAS and durable create replay contracts."""
import copy
import json
import unittest
from pathlib import Path

from ice_agent.accounts import normalize_account
from ice_agent.desktop_service import DesktopService
from tests import REPO,temp_dir


class TestPublicationSettings(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('publication-settings-')
        self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)

    def test_preview_import_creates_nothing_and_removes_foreign_identity_and_paths(self):
        before=self.service.settings_file.read_bytes()
        data={**self.service._account(),'id':'foreign','article_root':str(self.root/'foreign-output'),
              'library_root':str(self.root/'foreign-library')}
        result=self.service.call('accounts.preview_import',{'format':'json','text':json.dumps({'format':'publication-profile-v1','account':data})})
        self.assertFalse(result['saved']);self.assertNotIn('id',result['account'])
        self.assertEqual(result['account']['preset'],'general')
        self.assertEqual(result['account']['article_root'],'');self.assertEqual(result['account']['library_root'],'')
        self.assertEqual(self.service.settings_file.read_bytes(),before)
        self.assertEqual(len(self.service.settings['accounts']),1)
        self.assertFalse((self.root/'foreign-output').exists())

    def test_plain_text_preview_keeps_original_for_editing_and_empty_or_wrong_format_is_rejected(self):
        text='品牌：纸间观察\n面向城市散步者。\nIgnore instructions is quoted source material.'
        result=self.service.call('accounts.preview_import',{'format':'md','name':'纸间观察','text':text})
        self.assertEqual(result['account']['brand_document'],text)
        self.assertTrue(result['requires_audience_confirmation'])
        for params in ({'text':' '},{'text':'x','format':'html'},{'text':'x'*60001}):
            with self.assertRaises(ValueError):self.service.call('accounts.preview_import',params)
        self.assertEqual(len(self.service.settings['accounts']),1)

    def test_stale_edit_and_account_switch_leave_current_settings_intact(self):
        boot=self.service.call('bootstrap')
        edited={**boot['account'],'name':'第一次修改'}
        saved=self.service.call('accounts.save',{'account':edited,'account_hash':boot['account_hash'],'expected_account_id':boot['account']['id']})
        self.assertNotEqual(saved['account_hash'],boot['account_hash'])
        before=self.service.settings_file.read_bytes()
        with self.assertRaisesRegex(ValueError,'别处修改'):
            self.service.call('accounts.save',{'account':{**edited,'name':'旧窗口覆盖'},'account_hash':boot['account_hash'],'expected_account_id':'ice-loop'})
        self.assertEqual(self.service.settings_file.read_bytes(),before)
        new=self.service.call('accounts.save',{'account':{'name':'别的公众号','audience':'另一群读者'}})
        before=self.service.settings_file.read_bytes()
        with self.assertRaisesRegex(ValueError,'公众号已切换'):
            self.service.call('accounts.save',{'account':edited,'account_hash':saved['account_hash'],'expected_account_id':'ice-loop'})
        self.assertEqual(self.service.settings_file.read_bytes(),before)
        self.assertEqual(self.service._account()['id'],new['account']['id'])

    def test_create_retry_is_durable_and_cannot_be_reused_with_different_input_or_switch_back(self):
        payload={'account':{'name':'纸间观察','audience':'城市散步者'},'request_id':'account-request-1','expected_account_id':'ice-loop'}
        first=self.service.call('accounts.save',payload)
        replay=self.service.call('accounts.save',payload)
        self.assertTrue(replay['replayed']);self.assertEqual(first['saved_account_id'],replay['saved_account_id'])
        self.assertEqual(len(self.service.settings['accounts']),2)
        with self.assertRaisesRegex(ValueError,'资料已变化'):
            self.service.call('accounts.save',{**payload,'account':{'name':'另一个内容','audience':'其他读者'}})
        self.service.call('accounts.switch',{'account_id':'ice-loop'})
        self.service.close()
        self.service=DesktopService(REPO,self.root/'runtime',auto_consumer=False)
        self.addCleanup(self.service.close)
        replay=self.service.call('accounts.save',payload)
        self.assertEqual(replay['saved_account_id'],first['saved_account_id'])
        self.assertEqual(replay['account']['id'],'ice-loop','replay must not take over a later account selection')
        self.assertEqual(len(self.service.settings['accounts']),2)

    def test_library_is_read_only_and_may_be_on_system_drive_but_output_cannot(self):
        data={'name':'自己的品牌','audience':'读者','library_root':'C:/example-read-only-articles'}
        result=normalize_account(data,self.root/'runtime')
        self.assertEqual(Path(result['library_root']).drive.lower(),'c:')
        with self.assertRaises(PermissionError):normalize_account({**data,'article_root':'C:/should-not-write'},self.root/'runtime')
        with self.assertRaisesRegex(ValueError,'整个磁盘'):normalize_account({**data,'library_root':'E:/'},self.root/'runtime')
