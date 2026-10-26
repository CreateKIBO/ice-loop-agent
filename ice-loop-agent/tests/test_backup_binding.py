"""A restore preview and published workspace must refer to exactly the reviewed bytes."""
from tests.schema_fixtures import downgrade_to_19
import sqlite3
import io
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from tests import test_backup_recovery as fixtures
from ice_agent import backup as backups
from ice_agent import __version__
from ice_agent.migrations import MAX_KNOWN_VERSION


class TestBackupBinding(unittest.TestCase):
    setUp = fixtures.TestBackupRecovery.setUp
    backup = fixtures.TestBackupRecovery.backup
    rewrite = fixtures.TestBackupRecovery.rewrite

    def test_mutation_during_preview_never_binds_new_hash_to_old_summary(self):
        self.backup()
        replacement = self.rewrite('replacement', manifest_change=lambda m:m.update(app_version='replacement-version'))
        original = backups._check_workspace
        def changed_after_validation(*args, **kwargs):
            result = original(*args, **kwargs)
            self.package.write_bytes(replacement.read_bytes())
            return result
        with patch.object(backups, '_check_workspace', changed_after_validation):
            with self.assertRaisesRegex(ValueError, '备份包.*变化'):
                backups.inspect_backup(self.package)
        self.assertFalse(list(self.root.glob('ice-backup-check-*')))

    def test_restore_rechecks_reviewed_archive_after_staging_and_never_publishes_changed_bytes(self):
        summary = self.backup()
        destination = self.root / 'never-published'
        original = backups.migrate_database
        def changed_during_restore(*args, **kwargs):
            result = original(*args, **kwargs)
            with self.package.open('ab') as stream:
                stream.write(b'changed-after-validation')
            return result
        with patch.object(backups, 'migrate_database', changed_during_restore):
            with self.assertRaisesRegex(ValueError, '备份包.*变化'):
                backups.restore_backup(self.package, destination, summary['package_hash'])
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.glob('ice-restore-*')))

    def legacy_package(self):
        self.backup()
        def to_19(db):
            downgrade_to_19(db)
        return self.rewrite('schema-19', database=to_19)

    def test_supported_old_schema_is_migrated_inside_staging_before_publication(self):
        package = self.legacy_package()
        checksum = backups.digest(package)
        summary = backups.inspect_backup(package)
        self.assertEqual(summary['database_schema'], 19)
        result = backups.restore_backup(package, self.root / 'restored', checksum)
        with closing(sqlite3.connect(Path(result['runtime_root']) / 'app.db')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], MAX_KNOWN_VERSION)
            self.assertIsNotNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='proposal_decision_drafts'").fetchone())
            self.assertIsNotNone(db.execute('SELECT 1 FROM schema_migrations WHERE version=20').fetchone())
            self.assertEqual(db.execute('SELECT app_version FROM schema_migrations WHERE version=20').fetchone()[0], __version__)
        self.assertEqual(backups.digest(package), checksum)

    def test_failed_destination_migration_cannot_publish_a_workspace(self):
        package = self.legacy_package()
        # Fail the real migration entry only for the extracted destination, not
        # for the disposable checked.db used by preview validation.
        from ice_agent import migrations
        real_run = migrations.run_migrations
        def fail_destination(db, **kwargs):
            filename = db.execute('PRAGMA database_list').fetchone()[2]
            if Path(filename).name == 'app.db':
                raise RuntimeError('fixture destination migration failed')
            return real_run(db, **kwargs)
        destination = self.root / 'failed-migration'
        with patch.object(migrations, 'run_migrations', fail_destination):
            with self.assertRaisesRegex(RuntimeError, 'destination migration failed'):
                backups.restore_backup(package, destination, backups.digest(package))
        self.assertFalse(destination.exists())
        self.assertFalse(list(self.root.glob('ice-restore-*')))

    def test_legacy_checksum_limits_are_reported_in_preview(self):
        self.backup()
        package = self.rewrite('legacy-checksum', database=lambda db:db.execute("UPDATE schema_migrations SET checksum='legacy-code-only' WHERE version=10"))
        summary = backups.inspect_backup(package)
        self.assertEqual(summary.get('legacy_unverified'), [10])
        self.assertEqual(summary.get('database_target_schema'), MAX_KNOWN_VERSION)

    def test_extracted_payload_is_checked_even_when_the_archive_hash_stays_unchanged(self):
        note = self.root / 'articles' / 'extra.md'
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text('reviewed content', encoding='utf-8')
        summary = self.backup()
        real_validate, real_open = backups._validate, backups.zipfile.ZipFile.open
        validated = False
        def mark_validated(*args, **kwargs):
            nonlocal validated
            result = real_validate(*args, **kwargs)
            validated = True
            return result
        def inconsistent_read(bundle, name, *args, **kwargs):
            if validated and name == 'articles/root-0/extra.md':
                return io.BytesIO(b'unreviewed later read')
            return real_open(bundle, name, *args, **kwargs)
        destination = self.root / 'changed-extraction'
        with patch.object(backups, '_validate', mark_validated), patch.object(backups.zipfile.ZipFile, 'open', inconsistent_read):
            with self.assertRaisesRegex(ValueError, '校验|变化'):
                backups.restore_backup(self.package, destination, summary['package_hash'])
        self.assertFalse(destination.exists())
        self.assertEqual(backups.digest(self.package), summary['package_hash'])
