import copy
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TextModelRoutesTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('text-model-routes-')
        self.service = DesktopService(REPO, self.root/'runtime', self.root/'articles', auto_consumer=False)

    def tearDown(self):
        self.service.close()

    def params(self):
        boot = self.service.call('bootstrap')
        writer = copy.deepcopy(boot['settings']['routes']['writer'])
        writer.update(primary=boot['settings']['profiles'][2]['profile_id'], fallbacks=[])
        return {'account_id': boot['account']['id'], 'routes_hash': boot['routes_hash'], 'routes': {'writer': writer}}

    def test_route_only_save_persists_without_changing_models_budgets_visual_or_accounts(self):
        before = copy.deepcopy(self.service.settings)
        params = self.params()
        result = self.service.call('models.routes_save', params)
        self.assertEqual(result['settings']['routes']['writer'], params['routes']['writer'])
        expected = copy.deepcopy(before)
        expected['routes']['writer'] = params['routes']['writer']
        self.assertEqual(self.service.settings, expected)
        self.service.close()
        self.service = DesktopService(REPO, self.root/'runtime', self.root/'articles', auto_consumer=False)
        self.assertEqual(self.service.settings['routes'], expected['routes'])

    def test_stale_route_hash_cannot_overwrite_and_noop_hash_is_stable(self):
        params = self.params()
        saved = self.service.call('models.routes_save', params)
        before = self.service.settings_file.read_bytes()
        with self.assertRaisesRegex(ValueError, '分工已在别处修改'):
            self.service.call('models.routes_save', params)
        self.assertEqual(self.service.settings_file.read_bytes(), before)
        params['routes_hash'] = saved['routes_hash']
        self.assertEqual(self.service.call('models.routes_save', params)['routes_hash'], saved['routes_hash'])

    def test_unrelated_model_and_budget_changes_are_preserved(self):
        params = self.params()
        self.service.call('models.save', {'provider': 'qwen', 'model_id': 'updated-saved-model'})
        self.service.call('budgets.save', {'scope': 'defaults', 'max_model_calls': 37,
            'max_image_model_calls': 13, 'max_chat_calls': 91})
        self.service.call('models.routes_save', params)
        self.assertEqual(self.service.settings['profiles']['qwen']['model_id'], 'updated-saved-model')
        self.assertEqual(self.service.settings['max_chat_calls'], 91)
        self.assertEqual(self.service.settings['max_model_calls'], 37)

    def test_invalid_later_role_rejects_the_whole_batch(self):
        params = self.params()
        params['routes']['planner'] = {**params['routes']['writer'], 'primary': 'foreign-profile'}
        before = copy.deepcopy(self.service.settings)
        content = self.service.settings_file.read_bytes() if self.service.settings_file.exists() else None
        with self.assertRaises(ValueError):
            self.service.call('models.routes_save', params)
        self.assertEqual(self.service.settings, before)
        self.assertEqual(self.service.settings_file.read_bytes() if self.service.settings_file.exists() else None, content)

    def test_invalid_shapes_and_visual_assignment_do_not_write(self):
        params = self.params()
        for routes in ([], {}, {'visual_reviewer': params['routes']['writer']}, {'writer': None},
                       {'writer': {**params['routes']['writer'], 'fallbacks': 'kimi'}},
                       {'writer': {**params['routes']['writer'], 'fallbacks': [params['routes']['writer']['primary']]}},
                       {'writer': {**params['routes']['writer'], 'fallbacks': [{}, None]}},
                       {'writer': {**params['routes']['writer'], 'thinking_policy': 'unknown'}},
                       {'writer': {**params['routes']['writer'], 'extra': True}}):
            with self.subTest(routes=routes):
                before = copy.deepcopy(self.service.settings)
                with self.assertRaises(ValueError):
                    self.service.call('models.routes_save', {**params, 'routes': routes})
                self.assertEqual(self.service.settings, before)

    def test_account_and_missing_revision_fail_closed(self):
        params = self.params()
        for extra in ({'account_id': None}, {'account_id': 'another-account'}, {'routes_hash': None}):
            with self.assertRaises(ValueError):
                self.service.call('models.routes_save', {**params, **extra})

    def test_existing_job_snapshot_stays_old_while_new_engine_uses_saved_writer(self):
        engine, _, store = self.service._app()
        try:
            old_job, _ = engine.create_job({**demo_spec(), 'account_id': 'ice-loop'})
            old_route = store.get_job(old_job)['model_route_snapshot']
        finally:
            store.close()
        params = self.params()
        self.service.call('models.routes_save', params)
        engine, _, store = self.service._app()
        try:
            self.assertEqual(engine.router.routes['writer'].primary, params['routes']['writer']['primary'])
            self.assertEqual(store.get_job(old_job)['model_route_snapshot'], old_route)
        finally:
            store.close()
        engine, _, store = self.service._job_app(old_job)
        try:
            # Restore is deliberately in WorkflowEngine.run, before constructing the first node context.
            with patch.object(engine, '_make_ctx', side_effect=RuntimeError('fixture stops before any model call')):
                engine.run(old_job)
            self.assertEqual(engine.router.routes['writer'].primary, old_route['routes']['writer']['primary'])
        finally:
            store.close()
