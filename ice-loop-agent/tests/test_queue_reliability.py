"""Queue state consistency and lease fencing; synthetic engines, real SQLite."""
import threading
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue
from ice_agent.tasks.worker import drain, _run_claimed
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestQueueStateSafety(unittest.TestCase):
    def setUp(self):
        self.store = Store(temp_dir('queue-state-')/'app.db')
        self.addCleanup(self.store.close)
        self.queue = TaskQueue(self.store)

    def test_paused_is_valid_visible_nonterminal_state(self):
        task = self.queue.enqueue('a','production',{})
        claimed = self.queue.claim()
        self.assertTrue(self.queue.finish_with_state(task['task_id'],claimed['lease_token'],'paused',{}))
        self.assertEqual([t['task_id'] for t in self.queue.list_for_account('a')],[task['task_id']])
        self.assertEqual(self.queue.cancel(task['task_id'])['state'],'cancelled')

    def test_requested_cancellation_cannot_be_overwritten_by_success(self):
        task = self.queue.enqueue('a','production',{})
        claimed = self.queue.claim()
        self.queue.cancel(task['task_id'])
        self.assertFalse(self.queue.complete(task['task_id'],claimed['lease_token'],{'late':True}))
        self.assertTrue(self.queue.get(task['task_id'])['cancel_requested'])

    def test_one_job_cannot_be_silently_bound_to_two_tasks(self):
        first = self.queue.enqueue('a','production',{'n':1})
        second = self.queue.enqueue('a','production',{'n':2})
        self.queue.bind_job(first['task_id'],'job-fixture','a')
        with self.assertRaises(ValueError): self.queue.bind_job(second['task_id'],'job-fixture','a')
        self.assertIsNone(self.queue.bound_job(second['task_id']))


class TestConsumerStateSafety(unittest.TestCase):
    def setUp(self):
        root = temp_dir('queue-worker-')
        self.service = DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.engine,_,self.store = self.service._app(demo=True)
        self.addCleanup(self.store.close)
        self.queue = TaskQueue(self.store)
        self.spec = {**demo_spec(),'demo':True,'account_id':'ice-loop'}
        self.task = self.queue.enqueue('ice-loop','production',{'spec':self.spec})
        self.job,_ = self.engine.create_job(self.spec)
        self.queue.bind_job(self.task['task_id'],self.job,'ice-loop')

    def run_with_state(self,state):
        real_app = self.service._app
        def app(**kwargs):
            engine,cfg,store = real_app(**kwargs)
            def run(job):
                store.update_job(job,state=state)
                return store.get_job(job)
            engine.run = run
            return engine,cfg,store
        with patch.object(self.service,'_app',side_effect=app):
            return drain(self.service,max_tasks=1)['executed'][-1]

    def test_engine_pause_is_persisted_as_pause_without_retry(self):
        outcome = self.run_with_state('paused')
        self.assertEqual(outcome['status'],'paused')
        saved = self.queue.get(self.task['task_id'])
        self.assertEqual(saved['state'],'paused')
        self.assertEqual(saved['attempt'],1)

    def test_engine_cancellation_is_persisted_even_without_queue_cancel_request(self):
        outcome = self.run_with_state('cancelled')
        self.assertEqual(outcome['status'],'cancelled')
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'cancelled')

    def test_engine_user_action_is_not_retried_as_step_limit(self):
        outcome = self.run_with_state('awaiting_user')
        self.assertEqual(outcome['status'],'waiting_user')
        saved = self.queue.get(self.task['task_id'])
        self.assertEqual(saved['state'],'waiting_user')
        self.assertEqual(saved['attempt'],1)

    def test_waiting_task_maps_failed_job_without_retrying_it(self):
        claimed = self.queue.claim()
        self.queue.finish_with_state(self.task['task_id'],claimed['lease_token'],'waiting_user',{})
        self.store.update_job(self.job,state='failed',pause_reason='APPROVAL_REJECTED')
        drain(self.service,max_tasks=1)
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'failed')

    def test_lost_lease_does_not_pause_new_owners_job_or_report_queued(self):
        claimed = self.queue.claim()
        self.store.update_job(self.job,state='running')
        self.queue.release(self.task['task_id'],claimed['lease_token'])
        current = self.queue.claim()
        result = _run_claimed(self.service,self.store,self.queue,claimed,None)
        self.assertEqual(self.store.get_job(self.job)['state'],'running')
        self.assertEqual(self.queue.get(self.task['task_id'])['lease_token'],current['lease_token'])
        self.assertEqual(result['status'],'running')

    def test_cancel_waiting_task_stops_bound_job_and_finishes(self):
        claimed = self.queue.claim()
        self.queue.finish_with_state(self.task['task_id'],claimed['lease_token'],'waiting_user',{})
        self.store.update_job(self.job,state='awaiting_user')
        self.queue.cancel(self.task['task_id'])
        drain(self.service,max_tasks=1)
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'cancelled')
        self.assertEqual(self.store.get_job(self.job)['state'],'paused')

    def test_binding_failure_rolls_back_article_job_checkpoint_and_event(self):
        second = self.queue.enqueue('ice-loop','production',{'spec':{**self.spec,'topic':'new task'}})
        # Keep the original fixture from being claimed in this test.
        self.queue.cancel(self.task['task_id'])
        before = {table:self.store.conn.execute(sql).fetchone()[0] for table,sql in (
            ('jobs','SELECT COUNT(*) FROM jobs'),('articles','SELECT COUNT(*) FROM articles'),
            ('checkpoints','SELECT COUNT(*) FROM checkpoints'),('events','SELECT COUNT(*) FROM events'))}
        with patch.object(TaskQueue,'bind_job',side_effect=RuntimeError('binding fault')):
            drain(self.service,max_tasks=1)
        after = {table:self.store.conn.execute(sql).fetchone()[0] for table,sql in (
            ('jobs','SELECT COUNT(*) FROM jobs'),('articles','SELECT COUNT(*) FROM articles'),
            ('checkpoints','SELECT COUNT(*) FROM checkpoints'),('events','SELECT COUNT(*) FROM events'))}
        self.assertEqual(before,after,'binding failure must not leave an orphan article/job')
        self.assertIsNone(self.queue.bound_job(second['task_id']))

    def test_file_failure_after_commit_keeps_binding_and_reuses_same_job(self):
        from ice_agent.workflow.engine import WorkflowEngine
        self.queue.cancel(self.task['task_id'])
        second = self.queue.enqueue('ice-loop','production',{'spec':{**self.spec,'topic':'new task'}})
        with patch.object(WorkflowEngine,'_write_state_file',side_effect=OSError('disk busy')):
            drain(self.service,max_tasks=1)
        bound = self.queue.bound_job(second['task_id'])
        self.assertIsNotNone(bound,'DB checkpoint and binding must survive a state-file write failure')
        self.assertIsNotNone(self.store.load_checkpoint(bound))
        drain(self.service,max_tasks=1)
        self.assertEqual(self.queue.bound_job(second['task_id']),bound)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],2)

    def test_long_engine_run_renews_lease_before_another_consumer_can_reclaim(self):
        ready,finish = threading.Event(),threading.Event()
        errors = []
        real_app = self.service._app
        def app(**kwargs):
            engine,cfg,store = real_app(**kwargs)
            def run(job):
                ready.set()
                if not finish.wait(10): raise RuntimeError('test coordination timed out')
                store.update_job(job,state='completed')
                return store.get_job(job)
            engine.run = run
            return engine,cfg,store
        def execute():
            try: drain(self.service,max_tasks=1)
            except Exception as error: errors.append(error)
        class ShortLease(TaskQueue):
            def __init__(self,store): super().__init__(store,lease_seconds=2)
        with patch.object(self.service,'_app',side_effect=app), \
             patch('ice_agent.tasks.worker.TaskQueue',ShortLease), \
             patch('ice_agent.tasks.worker.HEARTBEAT_POLL_SECONDS',0.05,create=True):
            thread = threading.Thread(target=execute,daemon=True)
            thread.start()
            try:
                self.assertTrue(ready.wait(5))
                original_expiry = self.queue.get(self.task['task_id'])['lease_expires_at']
                time.sleep(3.2)  # SQLite timestamps are second-granularity; must exceed equality.
                self.assertGreater(self.queue.get(self.task['task_id'])['lease_expires_at'],original_expiry)
                self.assertEqual(self.queue.requeue_expired(),[],'live long task lease must stay valid')
            finally:
                finish.set()
                thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'succeeded')

    def exercise_real_engine_stop(self,reason):
        from ice_agent.workflow.nodes import NODE_FUNCS
        entered,release = threading.Event(),threading.Event()
        service_stop = threading.Event()
        calls,errors = [],[]
        old_monitors = {t.ident for t in threading.enumerate() if t.name=='ice-task-lease'}
        def topic(ctx):
            calls.append('topic')
            entered.set()
            while not release.wait(0.03): ctx.check_cancelled()
            ctx.check_cancelled()
            return {}
        def research(ctx):
            calls.append('research')
            raise RuntimeError('a stopped task must not reach another node')
        def execute():
            try: drain(self.service,max_tasks=1,stop_event=service_stop)
            except Exception as error: errors.append(error)
        takeover = None
        with patch.dict(NODE_FUNCS,{'topic':topic,'research':research}), \
             patch('ice_agent.tasks.worker.HEARTBEAT_POLL_SECONDS',0.05):
            thread = threading.Thread(target=execute,daemon=True)
            thread.start()
            try:
                self.assertTrue(entered.wait(6))
                if reason=='cancel': self.queue.cancel(self.task['task_id'])
                elif reason=='close': service_stop.set()
                else:
                    old = self.queue.get(self.task['task_id'])
                    self.queue.release(self.task['task_id'],old['lease_token'])
                    takeover = self.queue.claim()
                thread.join(5)
                self.assertFalse(thread.is_alive(),'stop must be observed during an in-flight node')
            finally:
                release.set()
                thread.join(5)
        self.assertEqual(errors,[])
        self.assertEqual(calls,['topic'])
        self.assertIsNone(self.store.get_job(self.job)['lease'])
        self.assertEqual({t.ident for t in threading.enumerate() if t.name=='ice-task-lease'},old_monitors)
        return takeover

    def test_cancel_interrupts_real_engine_node_without_advancing(self):
        self.exercise_real_engine_stop('cancel')
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'cancelled')
        self.assertEqual(self.store.get_job(self.job)['state'],'paused')

    def test_shutdown_interrupts_real_engine_and_leaves_visible_pause(self):
        self.exercise_real_engine_stop('close')
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'paused')
        self.assertEqual(self.store.get_job(self.job)['state'],'paused')

    def test_lease_takeover_does_not_pause_new_owner_or_advance_old_engine(self):
        takeover = self.exercise_real_engine_stop('takeover')
        self.assertEqual(self.queue.get(self.task['task_id'])['lease_token'],takeover['lease_token'])
        self.assertEqual(self.store.get_job(self.job)['state'],'running')

    def test_restart_pauses_bound_running_task_and_retains_binding(self):
        claimed = self.queue.claim()
        self.store.update_job(self.job,state='running',lease='previous-process')
        self.service.close()
        restarted = DesktopService(REPO,self.service.runtime,auto_consumer=False)
        self.addCleanup(restarted.close)
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'paused')
        self.assertIsNone(self.queue.get(self.task['task_id'])['lease_token'])
        self.assertEqual(self.queue.bound_job(self.task['task_id']),self.job)
        self.assertEqual(self.store.get_job(self.job)['state'],'paused')
        self.assertIsNone(self.store.get_job(self.job)['lease'])
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)

    def test_restart_requeues_unbound_task_without_creating_an_orphan(self):
        self.queue.cancel(self.task['task_id'])
        second = self.queue.enqueue('ice-loop','production',{'spec':self.spec})
        self.queue.claim()
        self.service.close()
        restarted = DesktopService(REPO,self.service.runtime,auto_consumer=False)
        self.addCleanup(restarted.close)
        self.assertEqual(self.queue.get(second['task_id'])['state'],'queued')
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],1)

    def test_real_approval_decision_resumes_same_job_to_the_next_gate(self):
        first = drain(self.service,max_tasks=1)['executed'][-1]
        self.assertEqual(first['status'],'waiting_user')
        approval = self.store.pending_approval(self.job)
        self.assertTrue(self.engine.decide(self.job,approval['approval_id'],'approve',
            expect_hash=approval['content_hash']))
        # decide() records a decision; it does not change awaiting_approval itself.
        self.assertEqual(self.store.get_job(self.job)['state'],'awaiting_approval')
        second = drain(self.service,max_tasks=1)['executed'][-1]
        self.assertEqual(second['job_id'],self.job)
        self.assertEqual(self.queue.bound_job(self.task['task_id']),self.job)
        self.assertEqual(self.queue.get(self.task['task_id'])['attempt'],2)
        self.assertNotEqual(self.store.pending_approval(self.job)['approval_id'],approval['approval_id'])
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],1)

    def test_new_job_inherits_configured_global_budget(self):
        self.queue.cancel(self.task['task_id'])
        self.service.settings['max_model_calls'] = 7
        second = self.queue.enqueue('ice-loop','production',{'spec':self.spec})
        drain(self.service,max_tasks=1)
        job = self.store.get_job(self.queue.bound_job(second['task_id']))
        self.assertEqual(job['limits']['max_model_calls'],7)

    def test_unsupported_legacy_task_fails_explicitly_without_execution(self):
        self.queue.cancel(self.task['task_id'])
        legacy = self.queue.enqueue('ice-loop','export',{'rev':'r1'})
        drain(self.service,max_tasks=1)
        saved = self.queue.get(legacy['task_id'])
        self.assertEqual(saved['state'],'failed')
        self.assertEqual(saved['error_code'],'UNSUPPORTED_TASK_KIND')
        self.assertEqual(saved['attempt'],0)

    def test_corrupt_cross_account_binding_never_pauses_another_accounts_job(self):
        foreign,_ = self.engine.create_job({**self.spec,'account_id':'other'})
        self.store.update_job(foreign,state='awaiting_user')
        self.store.conn.execute('UPDATE task_job_bindings SET job_id=? WHERE task_id=?',
            (foreign,self.task['task_id']))
        self.store.conn.commit()
        claimed = self.queue.claim()
        self.assertFalse(self.queue.pause_bound_job(self.task['task_id'],claimed['lease_token'],'must not pause'))
        self.queue.finish_with_state(self.task['task_id'],claimed['lease_token'],'waiting_user',{})
        self.queue.cancel(self.task['task_id'])
        drain(self.service,max_tasks=1)
        self.assertEqual(self.store.get_job(foreign)['state'],'awaiting_user')
        self.assertEqual(self.queue.get(self.task['task_id'])['state'],'failed')
        self.assertEqual(self.queue.get(self.task['task_id'])['error_code'],'ACCOUNT_CONFLICT')
