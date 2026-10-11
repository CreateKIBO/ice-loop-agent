"""Targeted beta.1 regressions. Synthetic state; no cloud or article execution."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from ice_agent import __version__, migrations
from ice_agent.application.ops_export import _run_evidence_status
from ice_agent.automation import delivery_hash
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import sha256_text
from ice_agent.execution.plan import execution_plan
from ice_agent.export.bundle import ExportBlocked, export_bundle
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestReadyBoundaries(unittest.TestCase):
    def export(self, body, **kwargs):
        root = temp_dir('beta1-bundle-')
        return export_bundle(job_id='fixture', title='验收', body=body,
                             content_hash=sha256_text(body), figures=[], runs={},
                             allow_ready=True, destination=root/'export', mode='ready', **kwargs)

    def test_ready_missing_image_cannot_pass_allow_ready(self):
        with self.assertRaises(ExportBlocked):
            self.export('# 标题\n\n![图1：封面](待配图：封面｜生图)\n')

    def test_code_fence_placeholder_is_not_an_image_requirement(self):
        result = self.export('# 占位符写法\n\n```markdown\n![图1：示例](待配图：封面｜生图)\n```\n')
        self.assertEqual(result['checks']['pending_placeholders'], 0)

    def test_handler_blocking_cannot_be_overridden_by_allow_ready(self):
        with self.assertRaises(ExportBlocked):
            self.export('# 正文', blocking=['图片未通过审核'])


class TestRunEvidence(unittest.TestCase):
    def setUp(self):
        self.block = execution_plan({'spec': demo_spec(), 'draft_md': '```python\nprint(2)\n```'})['blocks'][0]
        self.record = {**self.block, 'stdout':'2\n', 'stderr':'', 'exit_code':0,
                       'output_sha256':sha256_text('2\n\x00'), 'verdict':'ok', 'runtime':{}}

    def test_current_source_input_output_pass(self):
        self.assertTrue(_run_evidence_status(self.record, self.block)['ok'])

    def test_stale_or_incomplete_records_fail_closed(self):
        cases = [{'code_sha256':'old'}, {'source':'print(1)\n'}, {'stdin_hash':'old'},
                 {'timed_out':True}, {'runtime':{'output_limited':'true'}},
                 {'verdict':'failed'}, {'exit_code':1}, {'stdout':'forged'},
                 {'expected_failure':True}]
        for change in cases:
            with self.subTest(change=change):
                self.assertFalse(_run_evidence_status({**self.record, **change}, self.block)['ok'])
        self.assertFalse(_run_evidence_status(self.record, None)['ok'])


class TestHandlerReadyReview(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = temp_dir('beta1-handler-')
        cls.service = DesktopService(REPO, cls.root/'runtime', cls.root/'articles')
        engine, _, store = cls.service._app(demo=True)
        try:
            cls.job, cls.article = engine.create_job({**demo_spec(), 'demo':True,
                'account_id':'ice-loop', 'article_root':str(cls.root/'articles')})
        finally:
            store.close()

    @classmethod
    def tearDownClass(cls):
        cls.service.close()

    def attempt(self, body, reviewed=False, runs=None):
        engine, _, store = self.service._app(demo=True)
        try:
            state = engine._load_state(self.job)
            state.update(integrated_md=body, draft_md=body, runs=runs or {})
            state.pop('delivery_review', None)
            if reviewed:
                state['delivery_review'] = delivery_hash(state, store.article_slots(self.article))
            engine._save_state(self.job, state)
        finally:
            store.close()
        # Isolate review/evidence from article writing rules, which have separate tests.
        target = temp_dir('beta1-ready-target-')/'export'
        with patch('ice_agent.rules.run_all_checks', return_value={'passed':True}):
            return self.service.call('articles.export_bundle',
                {'job_id':self.job, 'destination':str(target), 'mode':'ready'})

    def test_missing_final_human_review_blocks(self):
        with self.assertRaisesRegex(ExportBlocked, '统一审阅'):
            self.attempt('# 合成夹具\n\n验收正文')

    def test_current_review_without_code_exports(self):
        self.assertEqual(self.attempt('# 合成夹具\n\n验收正文', reviewed=True)['mode'], 'ready')

    def test_reviewed_article_cannot_export_without_current_code_evidence(self):
        with self.assertRaisesRegex(ExportBlocked, '有效运行证据'):
            self.attempt('# 合成夹具\n\n```python\nprint(2)\n```', reviewed=True)

    def test_matching_evidence_and_review_exports(self):
        body = '# 合成夹具\n\n```python\nprint(2)\n```'
        block = execution_plan({'spec':demo_spec(), 'draft_md':body})['blocks'][0]
        record = {**block, 'stdout':'2\n', 'stderr':'', 'exit_code':0, 'verdict':'ok',
                  'output_sha256':sha256_text('2\n\x00'), 'runtime':{}}
        self.assertEqual(self.attempt(body, reviewed=True, runs={'run-1':record})['mode'], 'ready')


class TestDryRunIsolation(unittest.TestCase):
    def run_case(self, fail=False):
        conn = sqlite3.connect(':memory:')
        conn.execute('PRAGMA user_version=9')
        def first(db):
            db.execute('CREATE TABLE dry_dependency (x INTEGER)')
        def second(db):
            db.execute('ALTER TABLE dry_dependency ADD COLUMN y INTEGER')
        registry = [migrations.Migration(10, 'first', first), migrations.Migration(11, 'second', second)]
        try:
            with patch.object(migrations, 'MIGRATIONS', registry):
                if fail:
                    with self.assertRaises(RuntimeError):
                        migrations.run_migrations(conn, dry_run=True, stop_after=11)
                else:
                    result = migrations.run_migrations(conn, dry_run=True)
                    self.assertEqual(result['dry_run_rolled_back'], [10,11])
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 9)
            self.assertEqual(conn.execute('SELECT name FROM sqlite_master').fetchall(), [])
        finally:
            conn.close()

    def test_dependent_migrations_execute_on_snapshot(self):
        self.run_case()

    def test_failure_leaves_original_tracking_and_schema_untouched(self):
        self.run_case(fail=True)

    def test_source_and_desktop_release_versions_match(self):
        self.assertEqual(__version__, json.loads((REPO/'desktop/package.json').read_text(encoding='utf-8'))['version'])
