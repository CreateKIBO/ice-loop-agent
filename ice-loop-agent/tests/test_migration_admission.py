"""Migration admission rejects unsupported data before mutation and closes failed opens."""
import hashlib
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from tests import temp_dir
from tests import test_v2_migrations as fixtures
from ice_agent.domain import store as stores
from ice_agent.migrations import run_migrations, verify_migrations, MAX_KNOWN_VERSION, BASELINE_VERSION


class TestMigrationAdmission(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('migration-admission-')

    def current(self):
        file = self.root / 'app.db'
        store = stores.Store(file)
        store.close()
        return file

    def digest(self, file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def test_current_store_checks_checksum_before_wal_or_schema_writes(self):
        file = self.current()
        with closing(sqlite3.connect(file)) as db:
            db.execute("UPDATE schema_migrations SET checksum='drift' WHERE version=19")
            db.commit()
            db.execute('PRAGMA journal_mode=DELETE')
        before = self.digest(file)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            store = stores.Store(file)
            store.close()
        self.assertEqual(self.digest(file), before)
        self.assertFalse(file.with_name('app.db-wal').exists())

    def test_future_direct_migration_is_rejected_without_creating_tracking(self):
        file = self.root / 'future.db'
        db = fixtures._fresh_v9_db(file)
        self.addCleanup(db.close)
        db.execute('PRAGMA user_version=9999')
        db.commit()
        before = self.digest(file)
        with self.assertRaisesRegex(ValueError, '较新|未知|不支持'):
            run_migrations(db)
        self.assertEqual(self.digest(file), before)
        self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone())

    def test_unknown_tracking_row_is_rejected_before_any_pending_migration(self):
        file = self.root / 'unknown.db'
        db = fixtures._fresh_v9_db(file)
        self.addCleanup(db.close)
        db.execute('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, checksum TEXT, applied_at TEXT, app_version TEXT)')
        db.execute("INSERT INTO schema_migrations VALUES(9999,'unknown','unknown','now','future')")
        db.commit()
        before = self.digest(file)
        with self.assertRaises(ValueError):
            run_migrations(db)
        self.assertEqual(self.digest(file), before)
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 9)
        self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='stream_events'").fetchone())

    def test_audit_of_baseline_database_is_read_only(self):
        file = self.root / 'audit.db'
        db = fixtures._fresh_v9_db(file)
        self.addCleanup(db.close)
        before = self.digest(file)
        self.assertEqual(verify_migrations(db)['problems'], [])
        self.assertEqual(self.digest(file), before)
        self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone())

    def test_current_schema_without_migration_history_is_not_silently_blessed(self):
        file = self.current()
        with closing(sqlite3.connect(file)) as db:
            db.execute('DROP TABLE schema_migrations')
            db.commit()
            db.execute('PRAGMA journal_mode=DELETE')
        before = self.digest(file)
        with self.assertRaisesRegex(ValueError, '迁移|记录|历史'):
            store = stores.Store(file)
            store.close()
        self.assertEqual(self.digest(file), before)

    def test_failed_store_initialization_closes_its_sqlite_connection(self):
        opened = []
        connect = sqlite3.connect
        def observe(*args, **kwargs):
            db = connect(*args, **kwargs)
            opened.append(db)
            self.addCleanup(db.close)
            return db
        with patch.object(stores.sqlite3, 'connect', observe), patch.object(stores, '_SCHEMA', 'BROKEN SQL;'):
            with self.assertRaises(sqlite3.Error):
                stores.Store(self.root / 'failed.db')
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute('SELECT 1')

    def test_pending_caller_transaction_is_never_rolled_back_by_migration_runner(self):
        db = fixtures._fresh_v9_db(self.root / 'caller.db')
        self.addCleanup(db.close)
        db.execute("UPDATE articles SET topic='尚未提交的编辑' WHERE article_id='art-1'")
        with self.assertRaisesRegex(ValueError, '事务'):
            run_migrations(db)
        self.assertTrue(db.in_transaction)
        self.assertEqual(db.execute("SELECT topic FROM articles WHERE article_id='art-1'").fetchone()[0], '尚未提交的编辑')
        self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone())

    def test_legacy_checksum_difference_is_visible_without_rewriting_history(self):
        file = self.current()
        with closing(sqlite3.connect(file)) as db:
            db.execute("UPDATE schema_migrations SET checksum='legacy-code-only' WHERE version=10")
            db.commit()
            audit = verify_migrations(db)
            self.assertEqual(audit['problems'], [])
            self.assertEqual(audit['legacy_unverified'], [10])
        store = stores.Store(file)
        self.addCleanup(store.close)
        self.assertEqual(store.conn.execute('SELECT checksum FROM schema_migrations WHERE version=10').fetchone()[0], 'legacy-code-only')

    def test_reader_admission_stays_available_while_another_writer_is_active(self):
        file = self.current()
        writer = sqlite3.connect(file)
        self.addCleanup(writer.close)
        writer.execute('BEGIN IMMEDIATE')
        connect = sqlite3.connect
        def short_wait(*args, **kwargs):
            return connect(*args, **{**kwargs, 'timeout':0.1})
        with patch.object(stores.sqlite3, 'connect', short_wait):
            reader = stores.Store(file)
        self.addCleanup(reader.close)
        self.assertFalse(reader.conn.in_transaction)
        self.assertEqual(reader.conn.execute('SELECT COUNT(*) FROM schema_migrations').fetchone()[0], MAX_KNOWN_VERSION-BASELINE_VERSION)

    def test_lowered_version_repairs_forward_without_reapplying_history(self):
        file = self.current()
        with closing(sqlite3.connect(file)) as db:
            history = db.execute('SELECT * FROM schema_migrations ORDER BY version').fetchall()
            db.execute('PRAGMA user_version=9')
            db.commit()
        store = stores.Store(file)
        self.addCleanup(store.close)
        self.assertEqual(store.conn.execute('PRAGMA user_version').fetchone()[0], MAX_KNOWN_VERSION)
        self.assertEqual([tuple(r) for r in store.conn.execute('SELECT * FROM schema_migrations ORDER BY version')], history)

    def test_missing_record_is_not_recreated_from_a_higher_version(self):
        file = self.current()
        with closing(sqlite3.connect(file)) as db:
            db.execute('DELETE FROM schema_migrations WHERE version=19')
            db.commit()
            db.execute('PRAGMA journal_mode=DELETE')
        before = self.digest(file)
        with self.assertRaisesRegex(ValueError, '缺少记录'):
            stores.Store(file)
        self.assertEqual(self.digest(file), before)

    def test_view_cannot_masquerade_as_migration_history(self):
        file = self.root / 'view.db'
        db = fixtures._fresh_v9_db(file)
        self.addCleanup(db.close)
        db.execute('CREATE VIEW schema_migrations AS SELECT 10 AS version')
        db.commit()
        before = self.digest(file)
        with self.assertRaisesRegex(ValueError, '有效的数据表'):
            run_migrations(db)
        self.assertEqual(self.digest(file), before)
