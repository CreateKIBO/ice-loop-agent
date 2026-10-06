import unittest
from ice_agent.domain.store import Store
from ice_agent.migrations import MAX_KNOWN_VERSION
from tests import temp_dir


class StoreReadConnectionTests(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('read-connection-')
        self.path=self.root/'app.db'
        self.writer=Store(self.path)

    def tearDown(self):
        self.writer.close()

    def test_opening_existing_reader_does_not_change_database_version(self):
        before=self.writer.conn.execute('PRAGMA data_version').fetchone()[0]
        reader=Store(self.path)
        reader.close()
        self.assertEqual(self.writer.conn.execute('PRAGMA data_version').fetchone()[0],before,
                         'Opening a read connection must not generate a write')

    def test_existing_reader_can_open_during_another_connection_write_transaction(self):
        with self.writer.transaction():
            reader=Store(self.path)
            try:
                # v2.0: a fresh database is migrated to this build's max known
                # version on first open; the reader must still see a consistent,
                # fully migrated schema (v1.5.3 asserted the fixed value 9).
                self.assertEqual(reader.conn.execute('PRAGMA user_version').fetchone()[0],MAX_KNOWN_VERSION)
                self.assertEqual(reader.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],0)
                self.assertTrue(self.writer.conn.in_transaction)
            finally:reader.close()
