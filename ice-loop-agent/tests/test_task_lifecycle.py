"""Task lifecycle regressions use isolated G-drive databases and mock workers."""
from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import new_id
from ice_agent.workflow.nodes import NODE_FUNCS, NodeFailed, node_integrate_evidence
from tests import REPO, temp_dir


class TestTaskLifecycle(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir('task-lifecycle-')
        self.service = DesktopService(REPO, self.dir / 'runtime', self.dir / 'articles')
        self.service.settings['accounts']['ice-loop']['library_root'] = ''

    def tearDown(self):
        self.service.close()

    def create(self, *, account_id='ice-loop', state='awaiting_approval'):
        engine, _, store = self.service._app(demo=True)
        try:
            job_id, article_id = engine.create_job({
                'series': 'PY', 'episode': 15, 'topic': '保留正文与配图证据',
                'account_id': account_id, 'article_root': str(self.dir / 'articles'),
                'demo': True, 'image_provider': 'manual_import'})
            checkpoint = engine._load_state(job_id)
            checkpoint['draft_md'] = '# 保留正文\n\n这是不能随任务删除丢失的文章内容。'
            engine._save_state(job_id, checkpoint)
            store.update_job(job_id, state=state)
            store.add_approval({'approval_id': new_id('apr'), 'job_id': job_id,
                                'scope': 'topic', 'revision': 1, 'content_hash': 'review-version',
                                'payload': {'title': '保留审核'}, 'status': 'pending'})
            store.upsert_slot({'slot_id': new_id('slot'), 'article_id': article_id,
                               'figure_no': 1, 'kind': 'cover', 'prompt': '保留配图提示词'})
            return job_id, article_id
        finally:
            store.close()

    def call(self, method, **params):
        return self.service.call(method, params)

    def test_archive_delete_restore_preserves_article_approvals_and_slots(self):
        job_id, article_id = self.create()
        original = self.call('jobs.get', job_id=job_id)
        archived = self.call('jobs.archive', job_id=job_id)
        self.assertEqual((archived['visibility'], archived['state']), ('archived', 'paused'))
        self.assertEqual(self.call('jobs.list'), [])
        self.assertEqual(len(self.call('jobs.list', visibility='archived')), 1)
        deleted = self.call('jobs.delete', job_id=job_id)
        self.assertEqual(deleted['visibility'], 'deleted')
        self.assertEqual(self.call('jobs.list', visibility='archived'), [])
        inspected = self.call('jobs.get', job_id=job_id)
        self.assertEqual(inspected['job']['visibility'], 'deleted')
        self.assertEqual(inspected['body'], original['body'])
        self.assertEqual(inspected['article']['article_id'], article_id)
        self.assertEqual(inspected['pending_approval'], original['pending_approval'])
        self.assertEqual(inspected['slots'], original['slots'])
        self.assertTrue(inspected['job']['deleted_at'])
        restored = self.call('jobs.restore', job_id=job_id)
        self.assertEqual((restored['visibility'], restored['state']), ('active', 'paused'))
        self.assertFalse(restored['stopping'])
        self.assertEqual(len(self.call('jobs.list')), 1)
        self.assertEqual(self.call('jobs.list', visibility='deleted'), [])
        self.assertNotIn(job_id, self.service.running)

    def test_repeated_actions_are_idempotent(self):
        job_id, _ = self.create()
        self.call('jobs.archive', job_id=job_id)
        before = self.call('jobs.get', job_id=job_id)
        self.call('jobs.archive', job_id=job_id)
        after = self.call('jobs.get', job_id=job_id)
        self.assertEqual(before['events'], after['events'])
        self.assertEqual(before['job']['archived_at'], after['job']['archived_at'])
        self.call('jobs.delete', job_id=job_id)
        with self.assertRaises(ValueError):
            self.call('jobs.archive', job_id=job_id)

    def test_hidden_task_mutations_are_blocked_but_read_inspection_is_allowed(self):
        job_id, _ = self.create()
        self.call('jobs.delete', job_id=job_id)
        for method in ('jobs.resume', 'jobs.stop', 'approvals.decide', 'approvals.edit',
                       'articles.semantic_review', 'articles.clipboard', 'assets.redo',
                       'execution.approve', 'execution.inputs', 'execution.code_save',
                       'execution.policy_save', 'supplements.plan', 'supplements.prepare',
                       'supplements.execute', 'assets.capture_context', 'assets.capture_finish'):
            with self.subTest(method=method), self.assertRaises(ValueError):
                self.call(method, job_id=job_id)
        with self.assertRaises(ValueError):
            self.service.jobs_get({'job_id': job_id})
        self.assertEqual(self.call('jobs.get', job_id=job_id)['job']['visibility'], 'deleted')

    def test_account_isolation_covers_inspection_actions_and_lists(self):
        mine, _ = self.create()
        other, _ = self.create(account_id='other')
        self.assertEqual([r['job_id'] for r in self.call('jobs.list', visibility='all')], [mine])
        for method in ('jobs.get', 'jobs.archive', 'jobs.delete', 'jobs.restore', 'jobs.resume', 'jobs.stop'):
            with self.subTest(method=method), self.assertRaises(ValueError):
                self.call(method, job_id=other)
        with self.assertRaises(ValueError):
            self.call('jobs.delete', job_id=mine, account_id='other')
        self.assertEqual(len(self.call('jobs.list')), 1)

    def test_invalid_filters_and_missing_tasks_do_not_change_visibility(self):
        job_id, _ = self.create()
        with self.assertRaises(ValueError):
            self.call('jobs.list', visibility="active' OR 1=1")
        with self.assertRaises(ValueError):
            self.call('jobs.delete', job_id='missing')
        with self.assertRaises(ValueError):
            self.call('jobs.delete', job_id=True)
        self.assertEqual(self.call('jobs.get', job_id=job_id)['job']['visibility'], 'active')

    def test_only_target_queued_future_is_cancelled(self):
        job_id, _ = self.create(state='queued')
        other, _ = self.create()
        entered = threading.Barrier(3)
        release = threading.Event()
        def blocker():
            entered.wait(timeout=10)
            release.wait(timeout=15)
        first = self.service.workers.submit(blocker)
        second = self.service.workers.submit(blocker)
        entered.wait(timeout=10)
        try:
            self.service._start(job_id)
            target = self.service.running[job_id]
            self.assertFalse(target.running())
            result = self.call('jobs.delete', job_id=job_id)
            self.assertTrue(target.cancelled())
            self.assertFalse(result['stopping'])
            self.assertFalse(first.cancelled())
            self.assertFalse(second.cancelled())
            self.assertEqual([row['job_id'] for row in self.call('jobs.list')], [other])
            with self.assertRaises(ValueError):
                self.service._start(job_id)
            self.assertEqual(self.call('jobs.restore', job_id=job_id)['state'], 'paused')
        finally:
            release.set()
            first.result(timeout=10)
            second.result(timeout=10)

    def test_running_delete_stops_worker_without_overwriting_pause_with_failure(self):
        job_id, _ = self.create(state='queued')
        entered = threading.Event()
        release = threading.Event()
        def interrupted_node(ctx):
            entered.set()
            if not release.wait(timeout=15):
                raise RuntimeError('test worker timeout')
            raise ValueError('远端请求在停止后返回错误')
        node = self.call('jobs.get', job_id=job_id)['job']['current_node']
        with patch.dict(NODE_FUNCS, {node: interrupted_node}):
            self.service._start(job_id)
            try:
                self.assertTrue(entered.wait(timeout=10))
                result = self.call('jobs.delete', job_id=job_id)
                self.assertTrue(result['stopping'])
                self.assertEqual(result['state'], 'paused')
                self.assertTrue(self.call('jobs.get', job_id=job_id)['job']['stopping'])
                with self.assertRaises(ValueError):
                    self.call('jobs.restore', job_id=job_id)
            finally:
                release.set()
                self.service.running[job_id].result(timeout=10)
        inspected = self.call('jobs.get', job_id=job_id)
        self.assertEqual(inspected['job']['state'], 'paused')
        self.assertFalse(inspected['job']['lease'])
        self.assertFalse(inspected['job']['stopping'])
        self.assertNotIn('step.failed', {event['event_type'] for event in inspected['events']})
        self.assertEqual(self.call('jobs.restore', job_id=job_id)['state'], 'paused')

    def test_pause_cancels_queued_job_and_preserves_other_worker_futures(self):
        job_id, _ = self.create(state='queued')
        entered = threading.Barrier(3)
        release = threading.Event()
        def blocker():
            entered.wait(timeout=10)
            release.wait(timeout=15)
        first = self.service.workers.submit(blocker)
        second = self.service.workers.submit(blocker)
        entered.wait(timeout=10)
        try:
            self.service._start(job_id)
            target = self.service.running[job_id]
            result = self.call('jobs.stop', job_id=job_id)
            self.assertEqual(result['state'], 'paused')
            self.assertFalse(result['stopping'])
            self.assertTrue(target.cancelled())
            self.assertFalse(first.cancelled())
            self.assertFalse(second.cancelled())
            # Even a stale worker entry does not restart the paused task.
            self.assertEqual(self.service._advance(job_id)['state'], 'paused')
        finally:
            release.set()
            first.result(timeout=10)
            second.result(timeout=10)

    def test_engine_cannot_start_an_archived_task_even_via_direct_cli_entry(self):
        job_id, _ = self.create(state='queued')
        self.call('jobs.archive', job_id=job_id)
        engine, _, store = self.service._job_app(job_id, allow_hidden=True)
        try:
            before = store.job_events(job_id)
            result = engine.run(job_id)
            self.assertEqual(result['state'], 'paused')
            self.assertEqual(store.job_events(job_id), before)
            self.assertEqual(store.job_invocations(job_id), [])
        finally:
            store.close()

    def test_delete_during_code_verification_retains_first_run_and_skips_second(self):
        job_id, _ = self.create(state='queued')
        engine, _, store = self.service._job_app(job_id)
        try:
            state = engine._load_state(job_id)
            state['draft_md'] = '# 运行验证\n\n```python\nprint("first")\n```\n\n```python\nprint("second")\n```\n'
            state['spec']['approve_local_exec'] = True
            engine._save_state(job_id, state)
            store.update_job(job_id, current_node='verify_code')
            original = engine.runner.run_python
            def first_run_then_delete(*args, **kwargs):
                record = original(*args, **kwargs)
                self.call('jobs.delete', job_id=job_id)
                return record
            with patch.object(engine.runner, 'run_python', side_effect=first_run_then_delete) as runner:
                result = engine.run(job_id)
            self.assertEqual(runner.call_count, 1)
            self.assertEqual(result['state'], 'paused')
            saved = engine._load_state(job_id)
            self.assertEqual(set(saved['runs']), {'run-1'})
            self.assertEqual(saved['runs']['run-1']['stdout'].strip(), 'first')
            self.assertEqual(saved['runs']['run-1']['exit_code'], 0)
            self.assertEqual(self.call('jobs.get', job_id=job_id)['job']['visibility'], 'deleted')
        finally:
            store.close()

    def test_missing_output_marker_has_a_useful_error_instead_of_name_error(self):
        job_id, _ = self.create(state='running')
        engine, _, store = self.service._job_app(job_id)
        try:
            job = store.get_job(job_id)
            state = engine._load_state(job_id)
            state['draft_md'] = '# 待回填正文\n\n<!--RUN_OUTPUT:run-2-->'
            state['runs'] = {}
            ctx = engine._make_ctx(job, store.get_article(job['article_id']), state)
            with self.assertRaises(NodeFailed) as error:
                node_integrate_evidence(ctx)
            self.assertEqual(error.exception.code, 'OUTPUT_MARKER_MISMATCH')
            self.assertIn('0 条真实运行记录', str(error.exception))
        finally:
            store.close()

    def test_lifecycle_survives_restart_and_restores_without_starting_work(self):
        job_id, _ = self.create(state='completed')
        self.call('jobs.archive', job_id=job_id)
        self.service.close()
        self.service = DesktopService(REPO, self.dir / 'runtime', self.dir / 'articles')
        self.assertEqual(self.call('jobs.list'), [])
        self.assertEqual(self.call('jobs.list', visibility='archived')[0]['job_id'], job_id)
        self.assertEqual(self.call('jobs.restore', job_id=job_id)['state'], 'paused')
        self.assertNotIn(job_id, self.service.running)


if __name__ == '__main__':
    unittest.main()
