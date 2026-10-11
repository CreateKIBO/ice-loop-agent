"""C2：下载待归档经 RPC 绑定真实图位；运行截图登记为领域资产并在证据变化后失效。离线。"""
import unittest

from ice_agent.assets_v2 import capture_status
from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir
from tests.test_v2_assets_budget import _png
from tests.test_workflow import demo_spec


class CaptureArchiveTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('capture-archive-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service._account()['id']
        engine, _, store = self.service._app(demo=True)
        try:
            self.job_id, _ = engine.create_job({**demo_spec(), 'demo': True,
                'account_id': self.account, 'article_root': str(self.root / 'articles')})
        finally:
            store.close()
        _, _, store = self.service._job_app(self.job_id)
        try:
            article_id = store.get_job(self.job_id)['article_id']
            store.upsert_slot({'slot_id': 'slot-fig1', 'article_id': article_id, 'figure_no': 1,
                               'prompt_no': 1, 'kind': 'cover', 'caption': '封面'})
        finally:
            store.close()

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def test_stage_then_bind_creates_one_candidate_and_duplicate_reuses_it(self):
        staged = self.service.call('downloads.stage', {
            'file_path': str(_png(self.root, 'shot.png')), 'origin_url': 'https://app.tapnow.media/x'})
        self.assertFalse(staged['deduped'])
        listed = self.service.call('downloads.list', {})['downloads']
        self.assertEqual(listed[0]['status'], 'pending')
        # 非图片扩展名拒绝进入归档。
        text = self.root / 'notes.txt'
        text.write_bytes(b'hello world, not an image')
        with self.assertRaisesRegex(ValueError, '只接受'):
            self.service.call('downloads.stage', {'file_path': str(text)})
        bound = self.service.call('downloads.bind', {
            'download_id': staged['download_id'], 'slot_label': '封面',
            'job_id': self.job_id, 'figure_no': 1})
        self.assertEqual(bound['status'], 'bound')
        # 同内容再次下载复用原记录，不新增候选。
        again = self.service.call('downloads.stage', {'file_path': str(self.root / 'shot.png')})
        self.assertTrue(again['deduped'])
        self.assertEqual(again['download_id'], staged['download_id'])
        _, _, store = self.service._job_app(self.job_id)
        try:
            candidates = store.slot_candidates('slot-fig1')
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]['source'], 'download')
            self.assertEqual(candidates[0]['review_status'], 'accepted')
        finally:
            store.close()

    def test_wrong_slot_and_other_account_are_refused(self):
        staged = self.service.call('downloads.stage', {'file_path': str(_png(self.root, 'b.png'))})
        with self.assertRaisesRegex(ValueError, '没有对应编号'):
            self.service.call('downloads.bind', {
                'download_id': staged['download_id'], 'slot_label': '图9',
                'job_id': self.job_id, 'figure_no': 9})
        self.service.settings['active_account_id'] = 'other-account'
        with self.assertRaises(ValueError):
            self.service.call('downloads.list', {})

    def test_capture_record_goes_stale_when_run_evidence_changes(self):
        _, _, store = self.service._job_app(self.job_id)
        try:
            from ice_agent.assets_v2 import record_capture
            runs = [{'run_id': 'run-1', 'code_sha256': 'a' * 64}]
            record_capture(store, self.account, self.job_id, 2,
                           candidate_id='cand-1', resource_id='res-1', file_sha256='b' * 64,
                           capture_hash='c' * 64, runs=runs, automatic=True)
            fresh = capture_status(store, self.account, self.job_id, 2,
                                   {'run-1': {'code_sha256': 'a' * 64}})
            self.assertFalse(fresh['stale'])
            self.assertEqual(fresh['run_ids'], ['run-1'])
            changed = capture_status(store, self.account, self.job_id, 2,
                                     {'run-1': {'code_sha256': 'd' * 64}})
            self.assertTrue(changed['stale'])
            self.assertEqual(changed['stale_runs'], ['run-1'])
            missing = capture_status(store, self.account, self.job_id, 2, {})
            self.assertTrue(missing['stale'])
            # 其他公众号看不到这条记录。
            self.assertIsNone(capture_status(store, 'other-account', self.job_id, 2, {}))
        finally:
            store.close()
        status = self.service.call('assets.capture_status', {'job_id': self.job_id, 'figure_no': 2})
        self.assertTrue(status['capture']['stale'])


if __name__ == '__main__':
    unittest.main()
