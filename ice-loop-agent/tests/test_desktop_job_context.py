"""Real old checkpoint compatibility and server-owned desktop output receipts."""
import copy
import json
import unittest
from unittest.mock import patch

from ice_agent.application.job_context import EVENT, desktop_context, record_context
from ice_agent.desktop_service import DesktopService
from ice_agent.execution.plan import execution_hash, execution_plan
from ice_agent.paths import atomic_write_text
from ice_agent.tasks import TaskQueue
from ice_agent.tasks.worker import drain
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestDesktopJobContext(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('desktop-context-')
        self.service = DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.engine,_,self.store = self.service._app(demo=True)
        self.addCleanup(self.store.close)

    def legacy(self, *, approved=False, file_only=False):
        spec = {**demo_spec(),'demo':True,'account_id':'ice-loop',
            'article_root':str(self.root/'forged-output'),'approve_local_exec':True}
        job,article = self.engine.create_job(spec)
        state = self.engine._load_state(job)
        state.update(draft_md='# 一个例子\n\n```python\nprint("legacy-run")\n```\n',
            runs={'older-evidence':{'stdout':'preserve me'}})
        if approved:
            state['execution_approval'] = execution_hash(state)
        self.engine._save_state(job,state)
        self.store.update_job(job,current_node='verify_code',state='awaiting_user')
        if file_only:
            self.store.conn.execute('DELETE FROM checkpoints WHERE job_id=?',(job,))
            self.store.conn.commit()
        return job,article,state

    def test_legacy_boolean_cannot_run_code_and_old_content_and_files_are_retained(self):
        job,article,old = self.legacy()
        marker = self.root/'forged-output'/'already-exported.txt'
        marker.parent.mkdir();marker.write_text('user output',encoding='utf-8')
        engine,cfg,connection = self.service._job_app(job)
        try:
            state = engine._load_state(job)
            self.assertEqual(state['draft_md'],old['draft_md'])
            self.assertEqual(state['runs'],old['runs'])
            self.assertFalse(state['spec']['approve_local_exec'])
            self.assertEqual(str(cfg.article_root),self.service._account()['article_root'])
            self.assertFalse(connection.get_article(article)['spec']['approve_local_exec'])
            self.assertFalse(execution_plan(state)['approved'])
            result = engine.run(job)
            self.assertEqual(result['state'],'awaiting_user')
            self.assertEqual(engine._load_state(job)['runs'],old['runs'])
        finally:
            connection.close()
        self.assertEqual(marker.read_text(encoding='utf-8'),'user output')
        for _ in range(2):
            _,_,connection = self.service._job_app(job);connection.close()
        self.assertEqual(len([e for e in self.store.job_events(job) if e['event_type']==EVENT]),1)
        self.assertEqual(len([e for e in self.store.job_events(job) if e['event_type']=='job.context_upgraded']),1)

    def test_valid_content_approval_survives_legacy_upgrade(self):
        job,_,old = self.legacy(approved=True)
        engine,_,connection = self.service._job_app(job)
        try:
            state = engine._load_state(job)
            self.assertEqual(state['execution_approval'],old['execution_approval'])
            self.assertEqual(execution_hash(state),execution_hash(old))
            self.assertFalse(state['spec']['approve_local_exec'])
            self.assertTrue(execution_plan(state)['approved'])
        finally:
            connection.close()

    def test_new_desktop_receipt_freezes_directory_even_after_account_settings_change(self):
        with patch.object(self.service,'_start',return_value={'started':False}):
            result = self.service.call('jobs.create',{'demo':True})
        root = self.service._account()['article_root']
        self.service.settings['accounts']['ice-loop']['article_root'] = str(self.root/'new-user-choice')
        _,cfg,connection = self.service._job_app(result['job_id'])
        try:
            self.assertEqual(str(cfg.article_root),root)
            receipt = next(json.loads(e['payload']) for e in connection.job_events(result['job_id']) if e['event_type']==EVENT)
            self.assertEqual(receipt['source'],'desktop_create')
            self.assertTrue(receipt['allow_demo_exec'])
        finally:
            connection.close()

    def test_admitted_metadata_poll_does_not_decode_full_body_or_acquire_a_write_lock(self):
        with patch.object(self.service,'_start',return_value={'started':False}):
            result = self.service.call('jobs.create',{'demo':True})
        with (patch.object(self.store,'load_checkpoint',side_effect=AssertionError('extra full-body decode')),
              patch.object(self.store,'transaction',side_effect=AssertionError('poll write lock'))):
            for _ in range(5):
                context = desktop_context(self.service,self.store,result['job_id'])
                self.assertEqual(context['account_id'],'ice-loop')

    def test_bound_legacy_queue_upgrades_same_job_without_altering_idempotent_payload(self):
        job,_,_ = self.legacy()
        queue = TaskQueue(self.store)
        payload = {'spec':{**demo_spec(),'demo':True,'account_id':'ice-loop'}}
        task = queue.enqueue('ice-loop','production',payload,idempotency_key='already-bound')
        queue.bind_job(task['task_id'],job,'ice-loop')
        drain(self.service,max_tasks=1)
        self.assertEqual(queue.bound_job(task['task_id']),job)
        self.assertEqual(queue.get(task['task_id'])['state'],'waiting_user')
        self.assertEqual(queue.get(task['task_id'])['payload'],payload)
        self.assertFalse(self.store.load_checkpoint(job)['spec']['approve_local_exec'])
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],1)

    def test_running_legacy_checkpoint_is_never_rewritten_by_a_reader(self):
        job,article,_ = self.legacy()
        before = self.store.load_checkpoint(job)
        self.store.update_job(job,lease='live-writer',state='running')
        with self.assertRaisesRegex(ValueError,'请先暂停'):
            self.service._job_app(job)
        self.assertEqual(self.store.load_checkpoint(job),before)
        self.assertTrue(self.store.get_article(article)['spec']['approve_local_exec'])
        self.assertFalse(any(e['event_type']==EVENT for e in self.store.job_events(job)))

    def test_file_only_checkpoint_is_admitted_and_hash_verified_on_subsequent_reads(self):
        job,_,old = self.legacy(file_only=True)
        engine,_,connection = self.service._job_app(job)
        try:
            state = connection.load_checkpoint(job)
            self.assertEqual(state['draft_md'],old['draft_md'])
            self.assertFalse(state['spec']['approve_local_exec'])
            self.assertEqual(engine._load_state(job),state)
        finally:
            connection.close()

    def test_receipt_and_article_creation_roll_back_together(self):
        def fail(job):
            record_context(self.store,job,'ice-loop',self.root/'articles')
            raise RuntimeError('binding failed')
        with self.assertRaisesRegex(RuntimeError,'binding failed'):
            self.engine.create_job(demo_spec(),on_created=fail)
        for table in ('articles','jobs','events','checkpoints'):
            # Literal SQL statements are enforced for production code; these
            # fixed test table names are not received from a caller.
            self.assertEqual(self.store.conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0],0)

    def test_checkpoint_account_conflict_is_rejected_without_mutation(self):
        job,_,_ = self.legacy()
        before = self.store.load_checkpoint(job)
        corrupt = copy.deepcopy(before);corrupt['spec']['account_id']='someone-else'
        self.store.save_checkpoint(job,corrupt)
        with self.assertRaisesRegex(ValueError,'检查点与公众号归属不一致'):
            self.service._job_app(job)
        self.assertEqual(self.store.load_checkpoint(job),corrupt)
        self.assertFalse(any(e['event_type']==EVENT for e in self.store.job_events(job)))

    def test_supplement_receipt_keeps_its_separate_output_root(self):
        source = self.root/'article.md'
        atomic_write_text(source,'# 已有文章\n\n![图1：封面](待配图：封面)\n')
        data = self.service.call('supplements.create',{'file_path':str(source)})
        _,cfg,connection = self.service._job_app(data['job_id'])
        try:
            self.assertEqual(cfg.article_root,self.root/'articles'/'补图候选')
            self.assertTrue(connection.get_article(data['article_id'])['spec']['image_only'])
        finally:
            connection.close()
