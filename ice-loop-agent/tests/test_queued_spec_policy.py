"""Legacy unbound queue payloads cannot authorize code or choose output paths."""
import copy
import unittest
from unittest.mock import patch
from ice_agent.desktop_service import DesktopService
from ice_agent.tasks import TaskQueue
from ice_agent.tasks.worker import drain
from tests import REPO,temp_dir
from tests.test_workflow import demo_spec


class TestQueuedSpecPolicy(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('queued-spec-policy-')
        self.service = DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.engine,_,self.store = self.service._app(demo=True)
        self.addCleanup(self.store.close)
        self.queue = TaskQueue(self.store)

    def legacy(self,**values):
        return {**demo_spec(),'demo':True,'account_id':'ice-loop',**values}

    def test_legacy_paths_approval_and_history_are_normalized_without_rewriting_replay_payload(self):
        foreign = self.root/'model-chosen-output'
        raw = self.legacy(article_root=str(foreign),approve_local_exec=True,target_words=[1,999999],
            execution_mode='docker',container_images={'python':'model:latest'},
            article_history={'fabricated':True},title_selection={'locked':True},publication_confirmation={'actor':'user'})
        task = self.queue.enqueue('ice-loop','production',{'spec':raw},idempotency_key='legacy')
        drain(self.service,max_tasks=1)
        job = self.queue.bound_job(task['task_id'])
        saved = self.store.get_article(self.store.get_job(job)['article_id'])['spec']
        self.assertFalse(saved['approve_local_exec'])
        self.assertEqual(saved['article_root'],self.service._account()['article_root'])
        self.assertEqual(saved['execution_mode'],self.service.settings.get('execution',{'mode':'local_reviewed'})['mode'])
        self.assertNotEqual(saved['container_images']['python'],'model:latest')
        self.assertEqual(saved['target_words'],self.service._account()['words_range'])
        self.assertNotIn('fabricated',saved['article_history'])
        self.assertNotIn('title_selection',saved);self.assertNotIn('publication_confirmation',saved)
        self.assertFalse(foreign.exists())
        self.assertEqual(self.queue.get(task['task_id'])['payload']['spec'],raw)
        self.assertEqual(self.queue.enqueue('ice-loop','production',{'spec':raw},idempotency_key='legacy')['task_id'],task['task_id'])
        self.assertEqual(len([event for event in self.store.job_events(job) if event['event_type']=='task.spec_normalized']),1)

    def test_legacy_unbound_host_approval_stops_at_actual_code_and_current_hash_approval_still_works(self):
        task = self.queue.enqueue('ice-loop','production',{'spec':self.legacy()})
        for _ in range(3):
            drain(self.service,max_tasks=1)
            job = self.queue.bound_job(task['task_id'])
            approval = self.store.pending_approval(job)
            if approval is None: break
            self.engine.decide(job,approval['approval_id'],'approve',expect_hash=approval['content_hash'])
        self.assertEqual(self.store.get_job(job)['state'],'awaiting_user')
        data = self.service.call('jobs.get',{'job_id':job})
        self.assertFalse(data['execution']['approved']);self.assertEqual(data['runs'],{})
        with patch.object(self.service,'_start',return_value={'started':False}):
            self.service.call('execution.approve',{'job_id':job,'content_hash':data['execution_hash'],
                'stdin_by_filename':data['stdin_by_filename']})
        drain(self.service,max_tasks=1)
        self.assertEqual(self.queue.bound_job(task['task_id']),job)
        fresh = self.service.call('jobs.get',{'job_id':job})
        self.assertEqual(fresh['pending_approval']['scope'],'final_title')
        self.assertEqual(len(fresh['runs']),3)
        self.assertTrue(all(run['verdict']=='ok' for run in fresh['runs'].values()))

    def test_missing_owner_uses_trusted_queue_account_without_switching_selected_account(self):
        other = copy.deepcopy(self.service._account())
        other.update(id='other',name='另一个品牌',article_root=str(self.root/'other'))
        self.service.settings['accounts']['other'] = other
        raw = self.legacy();raw.pop('account_id')
        task = self.queue.enqueue('other','production',{'spec':raw})
        drain(self.service,max_tasks=1)
        job = self.queue.bound_job(task['task_id'])
        spec = self.store.get_article(self.store.get_job(job)['article_id'])['spec']
        self.assertEqual(spec['account_id'],'other');self.assertEqual(spec['article_root'],other['article_root'])
        self.assertEqual(self.service._account()['id'],'ice-loop')

    def test_cross_owner_payload_and_invalid_column_fail_without_creating_an_article(self):
        for payload in ({'account_id':'other','spec':self.legacy()}, {'spec':self.legacy(series='removed')}):
            task = self.queue.enqueue('ice-loop','production',payload)
            drain(self.service,max_tasks=1)
            saved = self.queue.get(task['task_id'])
            self.assertEqual(saved['state'],'failed')
            self.assertIn(saved['error_code'],('ACCOUNT_CONFLICT','INVALID_PAYLOAD'))
            self.assertIsNone(self.queue.bound_job(task['task_id']))
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM articles').fetchone()[0],0)
