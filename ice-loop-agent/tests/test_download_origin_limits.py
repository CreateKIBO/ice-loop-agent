"""Download source ownership and bounded IO; no cloud or personal workspace."""
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from tests import REPO, temp_dir
from tests.test_v2_assets_budget import _png


class DownloadOriginLimitsTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('download-origin-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles', auto_consumer=False)
        self.account_a = self.service._account()['id']
        first = self.service._account()
        other = {key: value for key, value in first.items() if key != 'id'}
        other.update(name='Download B', preset='general', library_root='', article_root=str(self.root / 'b'))
        self.account_b = self.service.accounts_save({'account': other})['saved_account_id']

    def tearDown(self):
        self.service.close()

    def test_completion_after_switch_stays_with_source_account(self):
        source = _png(self.root, 'source.png')
        result = self.service.call('downloads.stage', {'file_path': str(source), 'account_id': self.account_a})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'], [])
        self.service.call('accounts.switch', {'account_id': self.account_a})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'][0]['download_id'], result['download_id'])

    def test_unknown_or_invalid_explicit_owner_cannot_fall_back_to_current(self):
        for account in ['missing-owner', '', True, 123, [], {}]:
            with self.subTest(account=account), self.assertRaises(ValueError):
                self.service.call('downloads.stage', {'file_path': str(_png(self.root, 'invalid.png')), 'account_id': account})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'], [])

    def test_legacy_caller_still_stages_for_current_account(self):
        result = self.service.call('downloads.stage', {'file_path': str(_png(self.root, 'legacy.png'))})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'][0]['download_id'], result['download_id'])

    def test_oversized_download_rejected_before_full_file_read(self):
        source = self.root / 'large.png'
        with source.open('wb') as stream:
            stream.write(b'\x89PNG\r\n\x1a\n')
            stream.truncate(32 * 1024 * 1024 + 1)
        with patch.object(type(source), 'read_bytes', side_effect=AssertionError('unbounded read')):
            with self.assertRaisesRegex(ValueError, '32MB'):
                self.service.call('downloads.stage', {'file_path': str(source)})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'], [])

    def test_hash_and_dedup_use_streaming_io(self):
        source = _png(self.root, 'stream.png')
        expected = hashlib.sha256(source.read_bytes()).hexdigest()
        with patch.object(type(source), 'read_bytes', side_effect=AssertionError('unbounded read')):
            first = self.service.call('downloads.stage', {'file_path': str(source)})
            again = self.service.call('downloads.stage', {'file_path': str(source)})
        self.assertEqual(first['file_sha256'], expected)
        self.assertEqual(again['download_id'], first['download_id'])
        self.assertTrue(again['deduped'])

    def test_file_changed_during_hash_is_not_staged(self):
        source = _png(self.root, 'changed.png')
        before = source.stat()
        changed = SimpleNamespace(st_size=before.st_size, st_mtime_ns=before.st_mtime_ns + 1)
        with patch('ice_agent.assets_v2.os.fstat', side_effect=[before, changed]):
            with self.assertRaisesRegex(ValueError, '发生变化'):
                self.service.call('downloads.stage', {'file_path': str(source)})
        self.assertEqual(self.service.call('downloads.list', {})['downloads'], [])


if __name__ == '__main__':
    unittest.main()
