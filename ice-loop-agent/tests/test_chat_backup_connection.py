"""Migration backups must release their SQLite handle on success and failure."""
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import Mock, patch

from ice_agent.creative_chat import initialize_chat
from ice_agent.domain.store import Store
from tests import temp_dir


class TestChatBackupConnection(unittest.TestCase):
    def test_backup_preserves_source_and_closes_destination(self):
        root = temp_dir('chat-backup-close-')
        with closing(Store(root / 'app.db')) as store:
            source_version = store.conn.execute('PRAGMA user_version').fetchone()[0]
            connect = sqlite3.connect
            destinations = []

            def capture(*args, **kwargs):
                connection = connect(*args, **kwargs)
                destinations.append(connection)
                return connection

            with patch('sqlite3.connect', side_effect=capture):
                initialize_chat(store)
            self.assertEqual(len(destinations), 1)
            try:
                with self.assertRaises(sqlite3.ProgrammingError):
                    destinations[0].execute('SELECT 1')
                with closing(connect(root / 'app-before-v1.3.db')) as backup:
                    self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], source_version)
                    self.assertIsNotNone(backup.execute("SELECT name FROM sqlite_master WHERE name='jobs'").fetchone())
                    self.assertIsNone(backup.execute("SELECT name FROM sqlite_master WHERE name='creative_conversations'").fetchone())
                self.assertIsNotNone(store.conn.execute("SELECT name FROM sqlite_master WHERE name='creative_conversations'").fetchone())
                # Reinitialization must reuse the existing backup, never overwrite it.
                with patch('sqlite3.connect', side_effect=AssertionError('backup reopened')):
                    initialize_chat(store)
            finally:
                destinations[0].close()

    def test_backup_failure_still_closes_destination_and_propagates(self):
        root = temp_dir('chat-backup-failure-')
        with closing(Store(root / 'app.db')) as store:
            destination = sqlite3.connect(root / 'destination.db')
            source = Mock(wraps=store.conn)
            source.backup.side_effect = sqlite3.OperationalError('controlled backup failure')
            proxy = Mock(conn=source, db_path=store.db_path)
            try:
                with patch('sqlite3.connect', return_value=destination):
                    with self.assertRaisesRegex(sqlite3.OperationalError, 'controlled backup failure'):
                        initialize_chat(proxy)
                with self.assertRaises(sqlite3.ProgrammingError):
                    destination.execute('SELECT 1')
                self.assertIsNone(store.conn.execute("SELECT name FROM sqlite_master WHERE name='creative_conversations'").fetchone())
            finally:
                destination.close()
