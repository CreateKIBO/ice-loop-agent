"""Known historical numeric task hashes can be promoted only for identical payloads."""
import threading
import unittest
from contextlib import closing

from tests import temp_dir
from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue, TaskInputConflict, canonical_input_hash


class TestLegacyTaskReplay(unittest.TestCase):
    def setUp(self):
        self.file = temp_dir('legacy-task-replay-') / 'app.db'
        self.store = Store(self.file)
        self.addCleanup(self.store.close)
        self.queue = TaskQueue(self.store)
        self.payload = {'spec':{'topic':'历史任务','n':2}}
        self.task = self.queue.enqueue('a','production',self.payload,idempotency_key='old-key')
        self.store.conn.execute("UPDATE tasks SET input_hash='-812345678',state='succeeded',result='{}',attempt=2 WHERE task_id=?",(self.task['task_id'],))
        self.store.conn.commit()

    def test_same_legacy_request_reuses_completed_task_without_reexecuting_it(self):
        before = dict(self.store.conn.execute('SELECT * FROM tasks').fetchone())
        replay = self.queue.enqueue('a','production',self.payload,idempotency_key='old-key')
        after = dict(self.store.conn.execute('SELECT * FROM tasks').fetchone())
        self.assertEqual(replay['task_id'],self.task['task_id'])
        self.assertEqual(replay['state'],'succeeded')
        self.assertEqual(after,{**before,'input_hash':canonical_input_hash(self.payload)})
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],1)

    def test_different_input_remains_a_conflict_and_does_not_promote_hash(self):
        with self.assertRaises(TaskInputConflict):
            self.queue.enqueue('a','production',{'spec':{'n':3}},idempotency_key='old-key')
        self.assertEqual(self.queue.get(self.task['task_id'])['input_hash'],'-812345678')

    def test_current_sha_mismatch_is_not_treated_as_an_old_format(self):
        self.store.conn.execute('UPDATE tasks SET input_hash=?',('f'*64,))
        self.store.conn.commit()
        with self.assertRaises(TaskInputConflict):
            self.queue.enqueue('a','production',self.payload,idempotency_key='old-key')
        self.assertEqual(self.queue.get(self.task['task_id'])['input_hash'],'f'*64)

    def test_legacy_promotion_does_not_merge_account_or_kind_domains(self):
        other_account = self.queue.enqueue('b','production',self.payload,idempotency_key='old-key')
        other_kind = self.queue.enqueue('a','export',self.payload,idempotency_key='old-key')
        self.assertEqual(len({self.task['task_id'],other_account['task_id'],other_kind['task_id']}),3)
        self.assertEqual(self.queue.get(self.task['task_id'])['input_hash'],'-812345678')
        self.queue.enqueue('a','production',self.payload,idempotency_key='old-key')
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],3)

    def test_concurrent_legacy_replays_return_one_existing_identity(self):
        barrier=threading.Barrier(2)
        replies=[]
        failures=[]
        def replay():
            try:
                with closing(Store(self.file)) as store:
                    barrier.wait(timeout=5)
                    replies.append(TaskQueue(store).enqueue('a','production',self.payload,idempotency_key='old-key'))
            except BaseException as error:
                failures.append(error)
        threads=[threading.Thread(target=replay) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertFalse(failures)
        self.assertEqual(len(replies),2)
        self.assertTrue(all(row['task_id']==self.task['task_id'] and row['state']=='succeeded' for row in replies))
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],1)
