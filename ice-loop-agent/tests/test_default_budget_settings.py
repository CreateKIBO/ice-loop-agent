import copy
import unittest

from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir


class TestDefaultBudgetSettings(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('default-budget-settings-')
        self.s = DesktopService(REPO, self.root/'runtime', self.root/'articles', auto_consumer=False)

    def tearDown(self):
        self.s.close()

    def get(self):
        return self.s.call('budgets.get', {'account_id':'ice-loop'})

    def save(self, **extra):
        return self.s.call('budgets.save', {'scope':'defaults', 'account_id':'ice-loop',
            'max_model_calls':30, 'max_image_model_calls':18, **extra})

    def test_revision_only_changes_with_effective_limits(self):
        before = self.get()
        self.s.call('models.save', {'provider':'qwen', 'model_id':'fixture-model-updated'})
        self.assertEqual(self.get()['defaults_hash'], before['defaults_hash'])
        saved = self.save(defaults_hash=before['defaults_hash'], max_chat_calls=0)
        self.assertNotEqual(saved['defaults_hash'], before['defaults_hash'])
        self.assertEqual(saved['max_chat_calls'], 0)
        self.assertTrue(saved['chat_unlimited'])

    def test_stale_revision_rejected_without_touching_settings(self):
        before = self.get()
        latest = self.save(max_chat_calls=8)
        original = self.s.settings_file.read_bytes()
        with self.assertRaisesRegex(ValueError, '全局预算已在别处修改'):
            self.save(defaults_hash=before['defaults_hash'], max_model_calls=31)
        self.assertEqual(self.s.settings_file.read_bytes(), original)
        self.assertEqual(self.get(), latest)
        self.assertEqual(self.save(defaults_hash=latest['defaults_hash'], max_model_calls=31)['max_chat_calls'], 8)

    def test_legacy_article_editor_preserves_explicit_chat_limit(self):
        for maximum in (0, 9, 1000):
            self.save(max_chat_calls=maximum)
            self.assertEqual(self.save(max_model_calls=35)['max_chat_calls'], maximum)
        for value in (None, '', True, -1, 1.5, 1001):
            before = self.s.settings_file.read_bytes()
            with self.assertRaises(ValueError):
                self.save(max_chat_calls=value)
            self.assertEqual(self.s.settings_file.read_bytes(), before)

    def test_new_normal_jobs_inherit_budget_existing_jobs_keep_limits(self):
        old = self.s.call('jobs.create', {'topic':'配置修改前', 'series':'PY', 'episode':51, 'demo':True})
        old_id = old['job_id']
        _, _, store = self.s._job_app(old_id)
        try:
            original = copy.deepcopy(store.get_job(old_id)['limits'])
        finally:
            store.close()
        self.save(max_model_calls=36)
        new = self.s.call('jobs.create', {'topic':'配置修改后', 'series':'PY', 'episode':52, 'demo':True})
        _, _, store = self.s._job_app(new['job_id'])
        try:
            self.assertEqual(store.get_job(new['job_id'])['limits']['max_model_calls'],36)
            self.assertEqual(store.get_job(old_id)['limits'],original)
        finally:
            store.close()

    def test_model_id_save_checks_account_and_original_id_without_probe(self):
        model = self.s.settings['profiles']['qwen']['model_id']
        self.s.call('models.save', {'provider':'qwen', 'model_id':'fixture-next', 'expected_model_id':model, 'account_id':'ice-loop'})
        for params, reason in [({'expected_model_id':model}, '模型配置已在别处修改'), ({'account_id':'other'}, '公众号已切换')]:
            before = self.s.settings_file.read_bytes()
            with self.assertRaisesRegex(ValueError, reason):
                self.s.call('models.save', {'provider':'qwen', 'model_id':'stale-fixture', **params})
            self.assertEqual(self.s.settings_file.read_bytes(), before)
        self.assertEqual(self.s.settings['profiles']['qwen']['model_id'], 'fixture-next')
        self.assertEqual(self.s.settings['profiles']['qwen']['status'], 'requires_probe')
