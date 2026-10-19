"""Restore fault acceptance: real ZIP/SQLite; no personal data or cloud calls."""
import hashlib
import copy
import json
import os
import sqlite3
import threading
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from ice_agent.backup import create_backup, digest, inspect_backup, restore_backup
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.migrations import MAX_KNOWN_VERSION
from ice_agent.tasks import TaskQueue, canonical_input_hash
from ice_agent.tasks.worker import drain
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestBackupRecovery(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('backup-recovery-')
        self.runtime = self.root / 'runtime'
        self.service = DesktopService(REPO, self.runtime, self.root / 'articles', auto_consumer=False)
        self.addCleanup(self.service.close)
        engine, _, store = self.service._app(demo=True)
        self.addCleanup(store.close)
        self.store = store
        self.spec = {**demo_spec(), 'account_id':'ice-loop', 'article_root':str(self.root / 'articles'), 'demo':True}
        self.job, self.article = engine.create_job(self.spec)
        self.package = self.root / 'workspace.zip'

    def backup(self):
        return self.service.call('backup.create', {'file_path':str(self.package)})

    def rewrite(self, name, *, member=None, database=None, manifest_change=None):
        target = self.root / (name + '.zip')
        with zipfile.ZipFile(self.package) as source:
            contents = {n:source.read(n) for n in source.namelist()}
        manifest = json.loads(contents.pop('manifest.json'))
        if member:
            key, value = member
            contents[key] = value
        if database:
            file = self.root / (name + '.db')
            file.write_bytes(contents['runtime/app.db'])
            with closing(sqlite3.connect(file)) as conn:
                database(conn)
                conn.commit()
            contents['runtime/app.db'] = file.read_bytes()
        manifest['files'] = {n:{'size':len(b), 'sha256':hashlib.sha256(b).hexdigest()} for n,b in contents.items()}
        if manifest_change:
            manifest_change(manifest)
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dest:
            for n,b in contents.items():
                dest.writestr(n, b)
            dest.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
        return target

    def assert_rejected_without_publish(self, package, pattern):
        before = (digest(self.runtime / 'app.db'), digest(self.runtime / 'settings.json'))
        with self.assertRaisesRegex(ValueError, pattern):
            inspect_backup(package)
        destination = self.root / 'never-published'
        with self.assertRaisesRegex(ValueError, pattern):
            restore_backup(package, destination, digest(package))
        self.assertFalse(destination.exists())
        self.assertEqual(before, (digest(self.runtime / 'app.db'), digest(self.runtime / 'settings.json')))
        self.assertFalse(list(self.root.glob('ice-restore-*')))
        self.assertFalse(list(self.root.glob('ice-backup-check-*')))

    def test_valid_checks_open_database_without_mutating_package_or_live_data(self):
        summary = self.backup()
        before = (digest(self.package), digest(self.runtime / 'app.db'))
        checked = self.service.call('backup.inspect', {'file_path':str(self.package)})
        self.assertTrue(checked['database_checked'])
        self.assertEqual(checked['database_schema'], MAX_KNOWN_VERSION)
        self.assertEqual(summary['package_hash'], checked['package_hash'])
        self.assertEqual(before, (digest(self.package), digest(self.runtime / 'app.db')))

    def test_hashed_but_unreadable_database_rejected_in_preview(self):
        self.backup()
        broken = self.rewrite('bad-db', member=('runtime/app.db', b'not a sqlite database'))
        self.assert_rejected_without_publish(broken, '数据库或配置无法读取')

    def test_hashed_but_malformed_settings_rejected_in_preview(self):
        self.backup()
        for n, value in enumerate(([], {'accounts':{}}, {**self.service.settings, 'active_account_id':'absent'})):
            with self.subTest(n=n):
                broken = self.rewrite('bad-settings-' + str(n), member=('runtime/settings.json', json.dumps(value).encode()))
                self.assert_rejected_without_publish(broken, '配置不完整')

    def test_future_database_version_rejected_in_preview(self):
        self.backup()
        broken = self.rewrite('future-db', database=lambda db:db.execute('PRAGMA user_version=999'))
        self.assert_rejected_without_publish(broken, '不支持的版本')

    def test_hashed_but_unusable_brand_or_model_settings_are_rejected(self):
        self.backup()
        for n, field in enumerate(('audience', 'words_range', 'profiles', 'routes')):
            settings = copy.deepcopy(self.service.settings)
            if field == 'audience':
                del settings['accounts']['ice-loop']['audience']
            elif field == 'words_range':
                settings['accounts']['ice-loop']['words_range'] = [9000, 300]
            elif field == 'profiles':
                settings['profiles'] = {'bad':{'unexpected':'cannot construct ModelProfile'}}
            else:
                settings['routes'] = {'writer':{'unexpected':'cannot construct RouteConfig'}}
            with self.subTest(field=field):
                broken = self.rewrite('unusable-settings-' + str(n), member=('runtime/settings.json', json.dumps(settings).encode()))
                self.assert_rejected_without_publish(broken, '备份|请填写|字数区间')

    def test_current_migration_checksum_drift_rejected_in_preview(self):
        self.backup()
        broken = self.rewrite('drift-db', database=lambda db:db.execute("UPDATE schema_migrations SET checksum='drift' WHERE version=19"))
        self.assert_rejected_without_publish(broken, 'checksum')

    def test_checkpoint_tampering_is_detected_even_with_new_zip_hash(self):
        self.backup()
        broken = self.rewrite('checkpoint-db', database=lambda db:db.execute("UPDATE checkpoints SET state_json='{}'"))
        self.assert_rejected_without_publish(broken, '检查点校验失败')

    def test_manifest_summary_and_unmanaged_files_are_rejected(self):
        self.backup()
        variants = [
            {'manifest_change':lambda m:m.update(accounts=[])},
            {'manifest_change':lambda m:m.update(files=[])},
            {'member':('runtime/credentials.json', b'never restore secrets')},
            {'member':('articles/unknown/image.png', b'unowned')},
        ]
        for n, variant in enumerate(variants):
            with self.subTest(n=n):
                self.assert_rejected_without_publish(self.rewrite('manifest-' + str(n), **variant), '备份')

    def test_large_media_streams_instead_of_reading_entire_file(self):
        asset = self.runtime / 'assets' / 'large.bin'
        asset.parent.mkdir(parents=True, exist_ok=True)
        with asset.open('wb') as stream:
            for _ in range(5):
                stream.write(b'streamed-media\0' * 65536)
        read = zipfile.ZipFile.read
        def bounded_read(bundle, name, *args, **kwargs):
            self.assertIn(name, ('manifest.json', 'runtime/settings.json'))
            return read(bundle, name, *args, **kwargs)
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('whole file read')), patch.object(zipfile.ZipFile, 'read', bounded_read):
            summary = self.backup()
            restored = restore_backup(self.package, self.root / 'streamed', summary['package_hash'])
        self.assertEqual(digest(asset), digest(Path(restored['runtime_root']) / 'assets' / 'large.bin'))
        self.assertFalse(list((self.root / 'streamed').rglob('checked.db')))

    def test_backup_publish_failure_keeps_previous_package_and_cleans_temporary_files(self):
        self.package.write_bytes(b'previous backup must survive')
        original = self.package.read_bytes()
        with patch('ice_agent.backup.os.replace', side_effect=PermissionError('fixture write denied')):
            with self.assertRaises(PermissionError):
                self.backup()
        self.assertEqual(self.package.read_bytes(), original)
        self.assertFalse(list(self.root.glob('ice-backup-*')))

    def test_restore_publish_failure_keeps_live_data_and_cleans_temporary_files(self):
        summary = self.backup()
        before = digest(self.runtime / 'app.db')
        with patch.object(Path, 'rename', side_effect=PermissionError('fixture publish denied')):
            with self.assertRaises(PermissionError):
                restore_backup(self.package, self.root / 'denied', summary['package_hash'])
        self.assertFalse((self.root / 'denied').exists())
        self.assertEqual(digest(self.runtime / 'app.db'), before)
        self.assertFalse(list(self.root.glob('ice-restore-*')))

    def test_running_chat_and_claimed_queue_refuse_backup(self):
        self.service.chat_cancel['fixture-chat'] = threading.Event()
        with self.assertRaisesRegex(ValueError, '创作回复'):
            self.backup()
        self.service.chat_cancel.clear()
        queue = TaskQueue(self.store)
        queue.enqueue('ice-loop', 'production', {'spec':self.spec})
        queue.claim()
        with self.assertRaisesRegex(ValueError, '队列正在执行'):
            self.backup()
        self.assertFalse(self.package.exists())

    def test_restored_queue_stays_paused_across_restart_and_resumes_same_binding(self):
        queue = TaskQueue(self.store)
        unbound = queue.enqueue('ice-loop', 'production', {'spec':self.spec}, idempotency_key='unbound')
        bound = queue.enqueue('ice-loop', 'production', {'spec':self.spec}, idempotency_key='bound')
        queue.bind_job(bound['task_id'], self.job, 'ice-loop')
        summary = self.backup()
        restored = restore_backup(self.package, self.root / 'restored', summary['package_hash'])
        service = DesktopService(REPO, Path(restored['runtime_root']), auto_consumer=False)
        self.addCleanup(service.close)
        with closing(Store(service.runtime / 'app.db')) as store:
            q = TaskQueue(store)
            for task in (bound, unbound):
                row = q.get(task['task_id'])
                self.assertEqual(row['state'], 'paused')
                self.assertEqual(row['error_code'], 'RESTORE_REVIEW')
                self.assertEqual(row['input_hash'], canonical_input_hash(row['payload']))
                self.assertTrue(Path(row['payload']['spec']['article_root']).is_relative_to(self.root / 'restored'))
                self.assertEqual(q.enqueue('ice-loop', 'production', row['payload'], idempotency_key=row['idempotency_key'])['task_id'], row['task_id'])
            self.assertEqual(drain(service)['executed'], [])
            pending = service.call('backup.queue', {'account_id':'ice-loop'})
            self.assertEqual(pending['total'], 2)
            row = next(t for t in pending['tasks'] if t['task_id'] == bound['task_id'])
            for change in ({'input_hash':'stale'}, {'account_id':'foreign'}, {'account_id':None}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    service.call('backup.resume_queue', {**row, **change})
            self.assertTrue(service.call('backup.resume_queue', row)['ok'])
            with self.assertRaisesRegex(ValueError, '已处理'):
                service.call('backup.resume_queue', row)
            self.assertEqual(q.get(unbound['task_id'])['state'], 'paused')
            result = drain(service)
            self.assertEqual(q.bound_job(bound['task_id']), self.job)
            self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 1)
            self.assertEqual(result['executed'][-1]['status'], 'waiting_user')

    def test_pending_cancellation_is_not_resurrected_on_restore(self):
        queue = TaskQueue(self.store)
        task = queue.enqueue('ice-loop', 'production', {'spec':self.spec})
        self.store.conn.execute('UPDATE tasks SET cancel_requested=1 WHERE task_id=?', (task['task_id'],))
        self.store.conn.commit()
        summary = self.backup()
        restored = restore_backup(self.package, self.root / 'cancelled', summary['package_hash'])
        with closing(Store(Path(restored['runtime_root']) / 'app.db')) as store:
            self.assertEqual(TaskQueue(store).get(task['task_id'])['state'], 'cancelled')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction boundary')
    def test_article_root_junction_is_rejected_without_touching_its_target(self):
        import _winapi
        outside = self.root / 'unmanaged'
        outside.mkdir()
        important = outside / 'keep.txt'
        important.write_text('outside data must survive', encoding='utf-8')
        junction = self.root / 'linked-articles'
        _winapi.CreateJunction(str(outside), str(junction))
        try:
            settings = copy.deepcopy(self.service.settings)
            settings['article_root'] = str(junction)
            settings['accounts']['ice-loop']['article_root'] = str(junction)
            with self.assertRaisesRegex(ValueError, '目录联接'):
                create_backup(self.runtime, settings, self.package)
            self.assertEqual(important.read_text(encoding='utf-8'), 'outside data must survive')
            self.assertFalse(self.package.exists())
        finally:
            # Remove only the exact fixture-owned junction itself, never its target.
            self.assertEqual(junction.parent.resolve(), self.root.resolve())
            self.assertTrue(junction.is_junction())
            os.rmdir(junction)
