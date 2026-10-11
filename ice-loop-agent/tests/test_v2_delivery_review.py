"""批次 B：最终交付审阅快照与确认。合成状态；无云调用、不执行文章流程。"""
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.export.bundle import ExportBlocked
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec

BODY = '# 合成夹具\n\n验收正文'


class TestDeliveryReview(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = temp_dir('delivery-review-')
        cls.service = DesktopService(REPO, cls.root/'runtime', cls.root/'articles')
        engine, _, store = cls.service._app(demo=True)
        try:
            cls.job, cls.article = engine.create_job({**demo_spec(), 'demo': True,
                'account_id': 'ice-loop', 'article_root': str(cls.root/'articles')})
            cls.foreign, _ = engine.create_job({**demo_spec(), 'demo': True,
                'account_id': 'someone-else', 'article_root': str(cls.root/'articles')})
        finally:
            store.close()

    @classmethod
    def tearDownClass(cls):
        cls.service.close()

    def write_state(self, job=None, **changes):
        engine, _, store = self.service._app(demo=True)
        try:
            state = engine._load_state(job or self.job)
            state.update(changes)
            engine._save_state(job or self.job, state)
        finally:
            store.close()

    def setUp(self):
        self.write_state(integrated_md=BODY, draft_md=BODY, runs={}, delivery_review=None)

    def snapshot(self):
        return self.service.call('articles.delivery_snapshot', {'job_id': self.job})

    def confirm(self, digest):
        return self.service.call('articles.delivery_confirm', {'job_id': self.job, 'delivery_hash': digest})

    def export_ready(self):
        target = temp_dir('delivery-review-export-')/'export'
        with patch('ice_agent.rules.run_all_checks', return_value={'passed': True}):
            return self.service.call('articles.export_bundle',
                                     {'job_id': self.job, 'destination': str(target), 'mode': 'ready'})

    def test_unreviewed_snapshot_lists_review_separately_from_blockers(self):
        snap = self.snapshot()
        self.assertEqual(len(snap['delivery_hash']), 64)
        self.assertEqual(snap['review'], {'reviewed': False, 'stale': False, 'reviewed_at': None})
        self.assertNotIn('review', [item['kind'] for item in snap['blocking']])
        self.assertTrue(all(item['message'] for item in snap['blocking']))

    def test_confirm_then_ready_export_passes_and_records_event(self):
        snap = self.snapshot()
        self.assertTrue(self.confirm(snap['delivery_hash'])['reviewed'])
        after = self.snapshot()
        self.assertTrue(after['review']['reviewed'])
        self.assertIsNotNone(after['review']['reviewed_at'])
        self.assertEqual(self.export_ready()['mode'], 'ready')

    def test_body_change_after_confirm_makes_review_stale_and_blocks_ready(self):
        self.confirm(self.snapshot()['delivery_hash'])
        self.write_state(integrated_md=BODY + '\n\n补一句')
        snap = self.snapshot()
        self.assertEqual((snap['review']['reviewed'], snap['review']['stale']), (False, True))
        with self.assertRaisesRegex(ExportBlocked, '统一审阅'):
            self.export_ready()

    def test_confirm_with_outdated_digest_is_rejected(self):
        digest = self.snapshot()['delivery_hash']
        self.write_state(integrated_md=BODY + '\n\n请求期间被修改')
        with self.assertRaisesRegex(ValueError, '已变化'):
            self.confirm(digest)
        self.assertFalse(self.snapshot()['review']['reviewed'])

    def test_confirm_requires_digest_and_stopped_job(self):
        with self.assertRaisesRegex(ValueError, '摘要'):
            self.confirm('')
        digest = self.snapshot()['delivery_hash']
        _, _, store = self.service._app(demo=True)
        try:
            store.conn.execute("UPDATE jobs SET lease='held-by-test' WHERE job_id=?", (self.job,))
            store.conn.commit()
            with self.assertRaisesRegex(ValueError, '正在运行'):
                self.confirm(digest)
        finally:
            store.conn.execute("UPDATE jobs SET lease=NULL WHERE job_id=?", (self.job,))
            store.conn.commit()
            store.close()

    def test_code_without_evidence_is_an_evidence_blocker_with_filename(self):
        self.write_state(integrated_md='# 合成夹具\n\n```python\nprint(2)\n```')
        snap = self.snapshot()
        evidence = [item for item in snap['blocking'] if item['kind'] == 'evidence']
        self.assertTrue(evidence and evidence[0].get('filename'))
        self.assertEqual([program['evidence'] for program in snap['programs']], [False])

    def test_empty_body_is_reported_and_cannot_be_confirmed(self):
        self.write_state(integrated_md='')
        snap = self.snapshot()
        self.assertEqual(snap['blocking'][0]['kind'], 'body')
        with self.assertRaisesRegex(ValueError, '正文为空'):
            self.confirm(snap['delivery_hash'])

    def test_other_account_article_is_refused(self):
        for method, params in [('articles.delivery_snapshot', {}),
                               ('articles.delivery_confirm', {'delivery_hash': '0' * 64})]:
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, '当前公众号'):
                self.service.call(method, {'job_id': self.foreign, **params})


if __name__ == '__main__':
    unittest.main()
