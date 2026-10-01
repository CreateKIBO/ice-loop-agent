"""Regression coverage for production defects found in the v0.1 review."""
import copy
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pathlib import Path

from ice_agent.cli import build_app, build_profiles, build_routes
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.domain.types import sha256_json
from ice_agent.ledger.operations import OperationsLedger, DuplicateSubmitBlocked
from ice_agent.llm.errors import ModelError, IncompleteResponseError
from ice_agent.llm.router import LLMRequest, RoleRouter, validate_simple_schema
from ice_agent.llm.transport import _read_sse, _parse_json_response
from ice_agent.providers.tapnow import ManualImportProvider, validate_image_file, selected_asset
from ice_agent.workflow.nodes import NODE_FUNCS, evidence_errors
from tests import REPO, temp_dir
from tests.test_router import FakeTransport, make_profile
from tests.test_workflow import demo_spec
from tests import test_workflow as workflow_test


class TestProductionUpgrade(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('upgrade-')
        self.engine, self.cfg, self.store = build_app(self.root / 'articles', self.root / 'runtime',
                                                     provider='mock', allow_local_exec=True)
        self.job, self.article = self.engine.create_job(demo_spec())

    def tearDown(self):
        self.store.close()

    def test_formal_routes_never_use_mock(self):
        profiles = build_profiles('qwen-deepseek')
        self.assertFalse(any(p.adapter == 'mock' for p in profiles.values()))
        for route in build_routes(profiles).values():
            self.assertIn(route.primary, profiles)
            self.assertTrue(all(p in profiles for p in route.fallbacks))

    def test_resume_does_not_regenerate_approved_candidate(self):
        self.engine.run(self.job)
        before = len([i for i in self.store.job_invocations(self.job) if i['node_key'] == 'topic'])
        approval = self.store.pending_approval(self.job)
        self.engine.decide(self.job, approval['approval_id'], 'approve', expect_hash=approval['content_hash'])
        self.engine.run(self.job)
        after = len([i for i in self.store.job_invocations(self.job) if i['node_key'] == 'topic'])
        self.assertEqual(before, after)
        self.assertEqual(self.store.pending_approval(self.job)['scope'], 'outline')

    def test_canonical_checkpoint_survives_broken_file(self):
        state = self.engine._load_state(self.job)
        state['proof'] = 'committed'
        self.engine._save_state(self.job, state)
        (self.cfg.job_dir(self.job) / 'state.json').write_text('{partial', encoding='utf-8')
        self.assertEqual(self.engine._load_state(self.job)['proof'], 'committed')

    def test_unexpected_node_error_is_failed_and_releases_lease(self):
        def explode(ctx):
            raise RuntimeError('forced failure')
        with patch.dict(NODE_FUNCS, ingest=explode):
            result = self.engine.run(self.job)
        self.assertEqual(result['state'], 'failed')
        self.assertIsNone(self.store.get_job(self.job)['lease'])
        self.assertIn('forced failure', result['pause_reason'])

    def test_model_repair_respects_request_budget(self):
        profile = make_profile('qwen')
        transport = FakeTransport([{'ok': '{}'}, {'ok': '{"name":"fixed"}'}])
        self.store.conn.execute("UPDATE jobs SET limits_json=? WHERE job_id=?", (json.dumps({'max_model_calls':1}), self.job))
        self.store.conn.commit()
        from ice_agent.llm.router import RouteConfig
        router = RoleRouter({profile.profile_id:profile}, {'writer':RouteConfig(profile.profile_id)},
                            store=self.store, transport=transport)
        req = LLMRequest('writer', 'unit', 'test', schema={'type':'object','fields':{'name':{'type':'str'}}})
        with self.assertRaises(ModelError) as caught:
            router.generate(req, job_id=self.job)
        self.assertEqual(caught.exception.code, 'MODEL_BUDGET_EXCEEDED')
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(len(self.store.job_invocations(self.job)), 1)

    def test_config_snapshot_includes_profiles_and_restores(self):
        frozen = copy.deepcopy(self.engine.router.snapshot)
        self.engine.router.profiles.clear()
        self.engine.router.restore(frozen)
        self.assertEqual(self.engine.router.snapshot, frozen)

    def test_missing_required_fields_and_empty_strings_fail(self):
        schema = {'type':'object','fields':{'name':{'type':'str','nonempty':True},
                                          'items':{'type':'list','min_items':1,'item':'str'}}}
        self.assertTrue(validate_simple_schema({}, schema))
        self.assertTrue(validate_simple_schema({'name':' ', 'items':[]}, schema))

    def test_stream_callbacks_arrive_before_iterator_exhausted(self):
        position = []
        def chunks():
            for value in ('one', 'two'):
                position.append(value)
                yield ('data: ' + json.dumps({'choices':[{'delta':{'content':value},'finish_reason':None}]}) + '\n').encode()
            yield b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n'
            yield b'data: [DONE]\n'
        callbacks = []
        result = _read_sse(chunks(), lambda value: callbacks.append((value, len(position))))
        self.assertEqual(callbacks, [('one',1),('two',2)])
        self.assertEqual(result.content, 'onetwo')

    def test_missing_finish_and_truncation_are_not_success(self):
        for reason in ('length', ''):
            raw = json.dumps({'choices':[{'message':{'content':'partial'},'finish_reason':reason}]})
            with self.assertRaises(IncompleteResponseError):
                _parse_json_response(raw)

    def test_header_only_png_is_rejected(self):
        file = self.root / 'fake.png'
        file.write_bytes(b'\x89PNG\r\n\x1a\n' + b'x'*50)
        self.assertFalse(validate_image_file(file)[0])

    def test_managed_image_is_independent_of_source(self):
        file = self.root / 'original.png'
        file.write_bytes(workflow_test.TestReadinessLoop.PNG_1PX)
        slot = {'slot_id':'slot-x'}
        candidate = ManualImportProvider(self.root / 'managed').import_asset(self.store, slot, file)
        self.store.conn.execute("UPDATE asset_candidates SET review_status='accepted' WHERE candidate_id=?", (candidate['candidate_id'],))
        self.store.conn.commit()
        slot['selected_candidate'] = candidate['candidate_id']
        file.write_bytes(b'changed')
        self.assertIsNotNone(selected_asset(self.store, slot))
        Path(candidate['file_path']).write_bytes(b'changed')
        self.assertIsNone(selected_asset(self.store, slot))

    def test_selection_cannot_use_another_slots_candidate(self):
        file = self.root / 'valid.png'
        file.write_bytes(workflow_test.TestReadinessLoop.PNG_1PX)
        candidate = ManualImportProvider().import_asset(self.store, {'slot_id':'one'}, file)
        self.assertIsNone(selected_asset(self.store, {'slot_id':'two','selected_candidate':candidate['candidate_id']}))

    def test_concurrent_send_has_only_one_owner(self):
        ledger = OperationsLedger(self.store)
        op = ledger.prepare(article_id=self.article, slot_id='slot', candidate_index=1,
                            provider='manual', prompt='p', settings={}, max_candidates=2)
        barrier = threading.Barrier(2)
        def attempt(_):
            store = Store(self.cfg.db_path)
            try:
                barrier.wait(timeout=5)
                try:
                    OperationsLedger(store).acquire_send_lease(op['operation_id'])
                    return True
                except DuplicateSubmitBlocked:
                    return False
            finally:
                store.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(attempt, range(2))), [False, True])

    def test_http_requests_have_local_connections_and_authentication(self):
        from fastapi.testclient import TestClient
        from ice_agent.server import create_app
        factory = lambda: build_app(self.root / 'articles', self.root / 'runtime')
        app = create_app(factory)          # 未显式传入时使用随机生成的会话令牌
        client = TestClient(app)
        self.assertEqual(client.get('/v1/health').status_code, 401)
        response = client.get('/v1/jobs/' + self.job,
                              headers={'Authorization': 'Bearer ' + app.state.access_token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['job']['job_id'], self.job)

    def test_code_changed_without_run_is_detected(self):
        from ice_agent.domain.types import sha256_text
        runs = {'run-1':{'code_sha256':sha256_text('print(1)\n'), 'stdout':'1\n',
                         'stderr':'', 'exit_code':0, 'run_id':'real-run',
                         'output_sha256':sha256_text('1\n'), 'stdin_events':[]}}
        self.assertTrue(evidence_errors('```python\nprint(2)\n```\n', runs))

    def test_style_review_failure_stops_workflow(self):
        from ice_agent.workflow.nodes import NodeContext, node_style_review, NodeFailed
        from ice_agent.llm.router import LLMResponse
        state = self.engine._load_state(self.job)
        state.update(series='PY', integrated_md='A short non-code draft')
        ctx = NodeContext(self.cfg, self.store, self.engine.router, self.engine.runner,
                          self.engine.ledger, self.store.get_job(self.job), self.store.get_article(self.article), state)
        report = {layer:{'passed':layer != 'l3'} for layer in ('l1','l2','l3','l4')}
        with patch.object(self.engine.router, 'generate', return_value=LLMResponse(text=json.dumps(report), data=report)):
            with self.assertRaises(NodeFailed) as caught:
                node_style_review(ctx)
        self.assertEqual(caught.exception.code, 'STYLE_REVIEW_BLOCKING')


class TestDesktopUpgrade(unittest.TestCase):
    def setUp(self):
        root = temp_dir('desktop-service-')
        self.service = DesktopService(REPO, root, root / 'articles')

    def tearDown(self):
        self.service.close()

    def test_bootstrap_never_returns_credentials(self):
        self.service.call('secrets.set', {'keys':{}})
        result = self.service.call('bootstrap')
        self.assertEqual(len(result['settings']['profiles']), 5)
        self.assertFalse(result['tapnow']['automation_ready'])
        self.assertTrue(all('has_key' in p and 'api_key' not in p for p in result['settings']['profiles']))

    def test_invalid_settings_leave_previous_configuration_intact(self):
        before = copy.deepcopy(self.service.settings)
        with self.assertRaises(ValueError):
            self.service.call('models.save', {'provider':'qwen','model_id':'changed','max_model_calls':0})
        self.assertEqual(self.service.settings, before)

    def test_unlisted_rpc_method_is_rejected(self):
        with self.assertRaises(ValueError):
            self.service.call('shell.exec', {'cmd':'anything'})

    def test_library_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            self.service.call('library.read', {'folder':'../../outside'})

    def test_custom_model_loses_unverified_capabilities(self):
        self.service.call('models.save', {'provider':'qwen','model_id':'custom-model-id'})
        profile = self.service.settings['profiles']['qwen']
        self.assertEqual(profile['capabilities']['thinking'], 'unknown')
        self.assertEqual(profile['status'], 'requires_probe')

    def test_code_approval_cannot_accept_an_old_content_hash(self):
        engine, _, store = self.service._app(demo=True)
        try:
            spec = demo_spec()
            spec['approve_local_exec'] = False
            job, _ = engine.create_job(spec)
            state = engine._load_state(job)
            state['draft_md'] = '```python\nprint(1)\n```\n'
            engine._save_state(job, state)
            store.update_job(job, state='awaiting_user', current_node='verify_code')
        finally:
            store.close()
        data = self.service.call('jobs.get', {'job_id':job})
        with self.assertRaises(ValueError):
            self.service.call('execution.approve', {'job_id':job,'content_hash':'old'})
        self.service.call('execution.inputs', {'job_id':job,'content_hash':data['execution_hash'], 'stdin_by_filename':{'demo_1.py':'18'}})
        after = self.service.call('jobs.get', {'job_id':job})
        self.assertNotEqual(data['execution_hash'], after['execution_hash'])

    def test_approved_code_hash_permits_actual_execution(self):
        engine, _, store = self.service._app(demo=True)
        try:
            spec = demo_spec()
            spec['approve_local_exec'] = False
            job, _ = engine.create_job(spec)
            result = engine.run(job, auto_approver=lambda scope,payload:('approve','test',None))
            self.assertEqual(result['state'], 'awaiting_user')
        finally:
            store.close()
        data = self.service.call('jobs.get', {'job_id':job})
        self.service.call('execution.approve', {'job_id':job,'content_hash':data['execution_hash']})
        result = self.service.running[job].result(timeout=30)
        self.assertEqual(result['state'], 'awaiting_approval', result['pause_reason'])
        self.assertEqual(result['current_node'], 'title_workshop')
        after = self.service.call('jobs.get', {'job_id':job})
        self.assertEqual(len(after['runs']), 3)
        self.assertTrue(all(record['exit_code']==0 for record in after['runs'].values()))


if __name__ == '__main__':
    unittest.main()
