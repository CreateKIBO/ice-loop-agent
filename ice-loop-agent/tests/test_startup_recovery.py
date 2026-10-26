"""Standalone recovery never constructs the failed service or writes its source DB."""
import hashlib
import json
import os
from pathlib import Path
from tests.schema_fixtures import downgrade_to_19
import sqlite3
import subprocess
import unittest
from contextlib import closing
from unittest.mock import patch

from tests import REPO
from tests import test_backup_recovery as fixtures
from ice_agent.migrations import MAX_KNOWN_VERSION
from ice_agent import startup_recovery as recovery


class TestStartupRecovery(unittest.TestCase):
    setUp = fixtures.TestBackupRecovery.setUp
    backup = fixtures.TestBackupRecovery.backup

    def inspect(self):
        return recovery.inspect_workspace(self.runtime, self.root / 'scratch')

    def snapshot(self):
        return hashlib.sha256((self.runtime / 'app.db').read_bytes()).hexdigest()

    def legacy(self):
        # Flush and close the fixture connection before observing raw bytes.
        self.store.close()
        with closing(sqlite3.connect(self.runtime / 'app.db')) as db:
            downgrade_to_19(db)
            db.commit()
            db.execute('PRAGMA journal_mode=DELETE')

    def test_workspace_inspection_migrates_only_the_disposable_snapshot(self):
        self.legacy()
        before = self.snapshot()
        result = self.inspect()
        self.assertEqual((result['database_schema'], result['database_target_schema']), (19, MAX_KNOWN_VERSION))
        self.assertEqual(result['accounts'][0]['id'], 'ice-loop')
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list((self.root / 'scratch').iterdir()))
        with closing(sqlite3.connect(self.runtime / 'app.db')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 19)

    def test_future_schema_refuses_without_modifying_original(self):
        self.store.conn.execute('PRAGMA user_version=9999'); self.store.conn.commit()
        before = self.snapshot()
        with self.assertRaises(ValueError):
            self.inspect()
        self.assertEqual(self.snapshot(), before)

    def test_checksum_drift_refuses_without_modifying_original(self):
        self.store.conn.execute("UPDATE schema_migrations SET checksum='changed' WHERE version=19")
        self.store.conn.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.inspect()
        self.assertEqual(self.snapshot(), before)

    def test_missing_database_does_not_create_one(self):
        target = self.root / 'missing'; target.mkdir()
        (target / 'settings.json').write_text('{}')
        with self.assertRaises(ValueError):
            recovery.inspect_workspace(target, self.root / 'scratch')
        self.assertFalse((target / 'app.db').exists())

    def test_invalid_settings_refuse_without_database_writes(self):
        before = self.snapshot()
        (self.runtime / 'settings.json').write_text('{"accounts": {}}')
        with self.assertRaises(ValueError):
            self.inspect()
        self.assertEqual(self.snapshot(), before)

    def test_disallowed_operation_cannot_construct_service(self):
        with patch('ice_agent.desktop_service.DesktopService', side_effect=AssertionError('no service')):
            with self.assertRaisesRegex(ValueError, '未授权'):
                recovery.execute('jobs.resume', {}, self.root / 'scratch')

    def test_real_engine_entry_can_preview_and_restore_without_service_start(self):
        summary = self.backup()
        destination = self.root / 'restored'
        scratch = self.root / 'scratch'
        before = self.snapshot()
        env = {**os.environ, 'TEMP':str(self.root), 'TMP':str(self.root), 'PYTHONUTF8':'1'}
        for operation, params in [
            ('backup.inspect', {'file_path':str(self.package)}),
            ('backup.restore', {'file_path':str(self.package), 'destination':str(destination), 'package_hash':summary['package_hash']}),
        ]:
            child = subprocess.run([str(REPO / '.venv/Scripts/python.exe'), '-X', 'utf8', '-B',
                '-m', 'ice_agent.desktop_service', '--project-root', str(REPO),
                '--runtime-root', str(scratch), '--recovery-operation', operation],
                cwd=REPO, input=json.dumps(params), capture_output=True, text=True, encoding='utf-8', env=env, timeout=30)
            self.assertEqual(child.returncode, 0, child.stderr)
            result = json.loads(child.stdout)['result']
            self.assertTrue(result)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((scratch / 'app.db').exists())
        self.assertFalse((scratch / 'settings.json').exists())
        self.assertTrue((destination / 'runtime/app.db').is_file())

    def test_committed_wal_rows_are_included_by_readonly_snapshot(self):
        self.store.conn.execute("UPDATE articles SET topic='read committed wal' WHERE article_id=?", (self.article,))
        self.store.conn.commit()
        from ice_agent.migrations import run_migrations
        def observe(db, **kwargs):
            self.assertEqual(db.execute('SELECT topic FROM articles WHERE article_id=?', (self.article,)).fetchone()[0], 'read committed wal')
            return run_migrations(db, **kwargs)
        with patch('ice_agent.migrations.run_migrations', observe):
            self.inspect()

    def test_invalid_model_settings_are_rejected_before_reading_database(self):
        settings_file = self.runtime / 'settings.json'
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        settings['routes'] = {'writer': 'invalid route'}
        settings_file.write_text(json.dumps(settings), encoding='utf-8')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, '路由'):
            self.inspect()
        self.assertEqual(self.snapshot(), before)

    def test_protocol_is_utf8_even_when_the_console_encoding_is_gbk(self):
        settings_file = self.runtime / 'settings.json'
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        settings['accounts'][settings['active_account_id']]['name'] = '中文验收公众号'
        settings_file.write_text(json.dumps(settings, ensure_ascii=False), encoding='utf-8')
        command = [str(REPO / '.venv/Scripts/python.exe'), '-X', 'utf8', '-B', '-c',
            "import sys;from pathlib import Path;from ice_agent.startup_recovery import main;sys.stdout.reconfigure(encoding='gbk');sys.exit(main('workspace.inspect',Path(sys.argv[1])))",
            str(self.root / 'scratch')]
        for runtime, expected_code in [(self.runtime, 0), (self.root / 'missing', 1)]:
            child = subprocess.run(command, input=json.dumps({'runtime_root':str(runtime)}).encode('utf-8'),
                capture_output=True, cwd=REPO, env={**os.environ,'TEMP':str(self.root),'TMP':str(self.root)}, timeout=30)
            self.assertEqual(child.returncode, expected_code, child.stderr.decode('utf-8', errors='replace'))
            response = json.loads(child.stdout.decode('utf-8'))
            if not expected_code:
                self.assertEqual(response['result']['accounts'][0]['name'], '中文验收公众号')
            else:
                self.assertTrue(any(ord(c) > 127 for c in response['error']))
