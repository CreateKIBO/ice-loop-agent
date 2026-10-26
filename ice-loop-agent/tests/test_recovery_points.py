"""Complete pre-migration recovery, bounded private archives and safe cleanup."""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
from tests.schema_fixtures import downgrade_to_19
import sqlite3
import unittest
import zipfile
from unittest.mock import patch

from tests import test_backup_recovery as fixtures
from ice_agent.migrations import MAX_KNOWN_VERSION
from ice_agent import backup
from ice_agent.recovery_points import RecoveryPoints, prepare_upgrade


class TestRecoveryPoints(unittest.TestCase):
    setUp = fixtures.TestBackupRecovery.setUp

    def manager(self):
        return RecoveryPoints(self.runtime)

    def legacy(self):
        self.store.close()
        with closing(sqlite3.connect(self.runtime/'app.db')) as db:
            downgrade_to_19(db)
            db.commit()
            db.execute('PRAGMA journal_mode=DELETE')

    def test_full_point_contains_original_database_articles_and_managed_images(self):
        from PIL import Image
        image = self.root/'source.png'; Image.new('RGB',(60,40),'blue').save(image)
        resource = self.service.call('resources.import',{'file_path':str(image)})
        output = self.root/'articles'/'original.md';output.parent.mkdir(exist_ok=True);output.write_text('原始文章',encoding='utf-8')
        self.legacy()
        before = backup.digest(self.runtime/'app.db')
        point = prepare_upgrade(self.runtime,self.service.settings)
        manager = self.manager();row = manager.list()['points'][0]
        self.assertEqual(row['state'],'ready');self.assertEqual(row['source_schema'],19)
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)
        summary = manager.inspect(point['point_id'])
        restored = manager.restore(point['point_id'],self.root/'restored',summary['package_hash'])
        restored_root = Path(restored['runtime_root'])
        with closing(sqlite3.connect(restored_root/'app.db')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],MAX_KNOWN_VERSION)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM articles').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)
            path = json.loads(db.execute('SELECT metadata_json FROM publication_resources').fetchone()[0])['file_path']
            self.assertEqual(backup.digest(Path(path)),resource['sha256'])
        self.assertTrue(any(file.read_text(encoding='utf-8')=='原始文章' for file in (self.root/'restored/articles').rglob('original.md')))
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)

    def test_retry_reuses_only_unchanged_complete_point(self):
        self.legacy()
        first = prepare_upgrade(self.runtime,self.service.settings)
        second = prepare_upgrade(self.runtime,self.service.settings)
        self.assertEqual(first['point_id'],second['point_id']);self.assertTrue(second['reused'])
        self.assertEqual(len(self.manager().list()['points']),1)

    def test_new_unindexed_file_prevents_reusing_old_point(self):
        self.legacy();first=prepare_upgrade(self.runtime,self.service.settings)
        folder=self.root/'articles';folder.mkdir(exist_ok=True);(folder/'added.md').write_text('新增资料')
        second=prepare_upgrade(self.runtime,self.service.settings)
        self.assertNotEqual(first['point_id'],second['point_id'])

    def test_changed_existing_file_prevents_reuse(self):
        folder=self.root/'articles';folder.mkdir(exist_ok=True);file=folder/'edited.md';file.write_text('初稿')
        self.legacy();first=prepare_upgrade(self.runtime,self.service.settings)
        file.write_text('修改后的内容')
        second=prepare_upgrade(self.runtime,self.service.settings)
        self.assertNotEqual(first['point_id'],second['point_id'])

    def test_point_creation_can_preserve_inactive_running_lease_without_mutating_source(self):
        self.store.conn.execute("UPDATE jobs SET state='running',lease='dead-sidecar' WHERE job_id=?",(self.job,));self.store.conn.commit()
        self.legacy();before=backup.digest(self.runtime/'app.db')
        point=prepare_upgrade(self.runtime,self.service.settings)
        self.assertTrue(point['point_id']);self.assertEqual(backup.digest(self.runtime/'app.db'),before)
        with self.assertRaisesRegex(ValueError,'正在运行'):
            self.manager().create(self.service.settings)

    def test_current_and_new_workspaces_create_no_point_or_directory(self):
        self.assertIsNone(prepare_upgrade(self.runtime,self.service.settings));self.assertFalse((self.runtime/'recovery-points').exists())
        missing=self.root/'new';missing.mkdir();self.assertIsNone(prepare_upgrade(missing,self.service.settings));self.assertFalse((missing/'recovery-points').exists())

    def test_failed_copy_cancels_before_any_source_database_change(self):
        self.legacy();before=backup.digest(self.runtime/'app.db')
        def cancel(phase,**values):
            if phase=='copy_files':raise InterruptedError('用户取消')
        with self.assertRaises(InterruptedError):prepare_upgrade(self.runtime,self.service.settings,progress=cancel)
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)
        point=self.manager().list()['points'][0]
        self.assertEqual(point['state'],'failed');self.assertTrue(point['can_delete'])
        self.manager().delete(point['point_id'],point['record_hash']);self.assertEqual(self.manager().list()['points'],[])

    def test_normal_manual_archive_limits_are_not_weakened_by_private_policy(self):
        file=self.runtime/'assets'/'large.txt';file.parent.mkdir(exist_ok=True);file.write_bytes(b'x'*4096)
        with patch.object(backup,'MAX_FILE',1024):
            with self.assertRaises(ValueError):backup.create_backup(self.runtime,self.service.settings,self.root/'manual.zip')
            point=self.manager().create(self.service.settings)
            self.assertEqual(self.manager().inspect(point['point_id'])['package_hash'],point['package_hash'])
        with self.assertRaisesRegex(ValueError,'归属'):
            backup.create_backup(self.runtime,self.service.settings,self.root/'bypass.zip',_for_recovery=True)

    def test_delete_requires_current_record_and_preserves_unknown_files(self):
        point=self.manager().create(self.service.settings);row=self.manager().list()['points'][0]
        directory=self.runtime/'recovery-points'/point['point_id'];extra=directory/'user-important.txt';extra.write_text('保留')
        with self.assertRaisesRegex(ValueError,'未识别'):self.manager().delete(point['point_id'],row['record_hash'])
        self.assertEqual(extra.read_text(),'保留');self.assertTrue((directory/'workspace.zip').exists())
        extra.unlink()
        with self.assertRaisesRegex(ValueError,'已变化'):self.manager().delete(point['point_id'],'wrong-record')
        self.manager().delete(point['point_id'],row['record_hash']);self.assertFalse(directory.exists())

    def test_changed_archive_is_not_adopted_reused_or_deleted(self):
        self.legacy();point=prepare_upgrade(self.runtime,self.service.settings);row=self.manager().list()['points'][0]
        archive=self.runtime/'recovery-points'/point['point_id']/'workspace.zip'
        with archive.open('ab') as stream:stream.write(b'user-modified')
        with self.assertRaisesRegex(ValueError,'已变化'):self.manager().inspect(point['point_id'])
        with self.assertRaisesRegex(ValueError,'已变化'):self.manager().delete(point['point_id'],row['record_hash'])
        self.assertTrue(archive.exists())
        fresh=prepare_upgrade(self.runtime,self.service.settings);self.assertNotEqual(point['point_id'],fresh['point_id'])

    def test_unowned_recovery_directory_is_never_adopted(self):
        folder=self.runtime/'recovery-points';folder.mkdir();file=folder/'notes.txt';file.write_text('用户文件')
        with self.assertRaisesRegex(ValueError,'未归属'):self.manager().create(self.service.settings)
        self.assertEqual(file.read_text(),'用户文件');self.assertFalse((folder/'.owner.json').exists())

    def test_owned_points_are_not_recursively_included_in_manual_backup(self):
        self.manager().create(self.service.settings)
        settings=copy.deepcopy(self.service.settings)
        settings['article_root']=str(self.runtime)
        for account in settings['accounts'].values():account['article_root']=str(self.runtime)
        package=self.root/'outside.zip';backup.create_backup(self.runtime,settings,package)
        import zipfile
        with zipfile.ZipFile(package) as archive:
            self.assertFalse(any('/recovery-points/' in name for name in archive.namelist()))

    def test_desktop_prepares_complete_point_before_live_migration_and_workers(self):
        self.legacy()
        from ice_agent.desktop_service import DesktopService
        phases=[]
        service=DesktopService(fixtures.REPO,self.runtime,auto_consumer=False,startup_progress=lambda phase,**kw:phases.append(phase))
        self.addCleanup(service.close)
        point=service.startup_recovery_point
        self.assertTrue(point['point_id'])
        with zipfile.ZipFile(self.manager().root/point['point_id']/'workspace.zip') as archive:
            snapshot=self.root/'before.db';snapshot.write_bytes(archive.read('runtime/app.db'))
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],19)
        with closing(sqlite3.connect(self.runtime/'app.db')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],MAX_KNOWN_VERSION)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)
        self.assertLess(phases.index('save_recovery_point'),phases.index('upgrade_database'))
        self.assertEqual(phases[-1],'ready')

    def test_cancelled_startup_never_constructs_worker_or_migrates_source(self):
        self.legacy()
        from ice_agent.desktop_service import DesktopService
        from ice_agent.startup_progress import StartupCancelled
        before=backup.digest(self.runtime/'app.db')
        def progress(phase,**kw):
            if phase=='copy_files':raise StartupCancelled('cancelled')
        with patch('ice_agent.desktop_service.ThreadPoolExecutor',side_effect=AssertionError('worker started')):
            with self.assertRaises(StartupCancelled):
                DesktopService(fixtures.REPO,self.runtime,auto_consumer=False,startup_progress=progress)
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)

    def test_low_disk_rejects_before_source_upgrade_or_archive_copy(self):
        self.legacy()
        from types import SimpleNamespace
        before=backup.digest(self.runtime/'app.db')
        with patch('ice_agent.recovery_points.shutil.disk_usage',return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(ValueError,'空间不足'):prepare_upgrade(self.runtime,self.service.settings)
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)
        self.assertFalse(self.manager().root.exists())

    def test_offline_point_recovery_works_when_live_database_is_rejected(self):
        self.legacy()
        point=prepare_upgrade(self.runtime,self.service.settings)
        with closing(sqlite3.connect(self.runtime/'app.db')) as db:
            db.execute('PRAGMA user_version=9999');db.commit()
        original=backup.digest(self.runtime/'app.db')
        from ice_agent.startup_recovery import execute
        params={'runtime_root':str(self.runtime),'point_id':point['point_id']}
        summary=execute('recovery.inspect',params,self.root/'scratch')
        result=execute('recovery.restore',{**params,'destination':str(self.root/'rescued'),'package_hash':summary['package_hash']},self.root/'scratch')
        self.assertEqual(result['database_schema'],MAX_KNOWN_VERSION)
        self.assertEqual(backup.digest(self.runtime/'app.db'),original)

    def test_startup_progress_utf8_revision_throttle_and_cancel_contract(self):
        import io
        from types import SimpleNamespace
        from ice_agent.startup_progress import StartupProgress,StartupCancelled
        stream=io.BytesIO()
        callback=StartupProgress(self.runtime,'a'*32)
        callback.file.parent.mkdir()
        with patch('ice_agent.startup_progress.sys.stdout',SimpleNamespace(buffer=stream)):
            callback('copy_files',bytes_done=42)
            callback('copy_files',bytes_done=43)
            callback.file.write_text('cancel')
            with self.assertRaises(StartupCancelled):callback('copy_files')
        values=[json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(len(values),1)
        self.assertEqual(values[0]['bytes_done'],42)
        callback.close();self.assertFalse(callback.file.exists())
        stream=io.BytesIO()
        with patch('ice_agent.startup_progress.sys.stdout',SimpleNamespace(buffer=stream)):
            callback.fail(ValueError('磁盘空间不足，原资料保留'))
        self.assertEqual(json.loads(stream.getvalue())['message'],'磁盘空间不足，原资料保留')
        with self.assertRaises(ValueError):StartupProgress(self.runtime,'../other')

    def test_reuse_compares_content_even_with_same_size_and_timestamp(self):
        import os
        self.legacy()
        file=self.root/'articles'/'same.md';file.parent.mkdir(exist_ok=True);file.write_text('original')
        first=prepare_upgrade(self.runtime,self.service.settings)
        before=file.stat();file.write_text('modified');os.utime(file,ns=(before.st_atime_ns,before.st_mtime_ns))
        second=prepare_upgrade(self.runtime,self.service.settings)
        self.assertNotEqual(first['point_id'],second['point_id'])

    def test_actual_previous_schema20_gets_full_point_before21(self):
        self.store.close()
        with closing(sqlite3.connect(self.runtime/'app.db')) as db:
            db.execute('DROP TABLE creative_send_receipts');db.execute('DELETE FROM schema_migrations WHERE version=21')
            db.execute('PRAGMA user_version=20');db.commit();db.execute('PRAGMA journal_mode=DELETE')
        before=backup.digest(self.runtime/'app.db')
        point=prepare_upgrade(self.runtime,self.service.settings)
        self.assertEqual(backup.digest(self.runtime/'app.db'),before)
        self.assertEqual(point['database_schema'],20)
        self.assertEqual(point['database_target_schema'],21)
