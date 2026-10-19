"""Release blockers: approval reconciliation and persisted account ownership."""
import copy
import sqlite3
import unittest
import threading
from types import SimpleNamespace
from concurrent.futures import Future
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.tasks.worker import _reconcile_waiting
from tests import REPO, temp_dir


class TestWaitingReconciliation(unittest.TestCase):
    def test_approved_waiting_task_requeues_without_recreating_job(self):
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE tasks(task_id TEXT,account_id TEXT,state TEXT,lease_token TEXT,lease_expires_at TEXT,updated_at TEXT);
            CREATE TABLE task_job_bindings(task_id TEXT,job_id TEXT);
            INSERT INTO tasks VALUES('task-a','a','waiting_user',NULL,NULL,'old');
            INSERT INTO task_job_bindings VALUES('task-a','job-a');
            ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT 'production';
            ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER DEFAULT 0;
            ALTER TABLE tasks ADD COLUMN error_code TEXT;
        """)
        store = SimpleNamespace(conn=conn, transaction=lambda: conn,
            get_job=lambda _: {'state':'running','article_id':'art-a'},
            get_article=lambda _: {'spec':{'account_id':'a'}},pending_approval=lambda _: None)
        executed = []
        _reconcile_waiting(store, None, None, executed)
        self.assertEqual(conn.execute('SELECT state FROM tasks').fetchone()[0], 'queued')
        self.assertEqual(conn.execute('SELECT job_id FROM task_job_bindings').fetchone()[0], 'job-a')
        self.assertEqual(executed[0]['status'], 'requeued')

    def test_scoped_reconcile_does_not_touch_other_accounts(self):
        conn = sqlite3.connect(':memory:'); conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE tasks(task_id TEXT,account_id TEXT,state TEXT,lease_token TEXT,lease_expires_at TEXT,updated_at TEXT);
            CREATE TABLE task_job_bindings(task_id TEXT,job_id TEXT);
            INSERT INTO tasks VALUES('a','a','waiting_user',NULL,NULL,'old');
            INSERT INTO tasks VALUES('b','b','waiting_user',NULL,NULL,'old');
            INSERT INTO task_job_bindings VALUES('a','job-a');
            INSERT INTO task_job_bindings VALUES('b','job-b');
            ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT 'production';
            ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER DEFAULT 0;
            ALTER TABLE tasks ADD COLUMN error_code TEXT;
        """)
        store = SimpleNamespace(conn=conn,transaction=lambda: conn,
            get_job=lambda _: {'state':'running','article_id':'art-b'},
            get_article=lambda _: {'spec':{'account_id':'b'}},pending_approval=lambda _: None)
        _reconcile_waiting(store,None,None,[],account_id='b')
        self.assertEqual(dict(conn.execute('SELECT task_id,state FROM tasks')),{'a':'waiting_user','b':'queued'})


class TestAccountEngineContext(unittest.TestCase):
    def setUp(self):
        root = temp_dir('release-account-')
        self.service = DesktopService(REPO, root/'runtime', root/'articles', auto_consumer=False)
        other = copy.deepcopy(self.service.settings['accounts']['ice-loop'])
        other.update(id='other', name='另一个公众号', preset='general', article_root=str(root/'other'), library_root='')
        self.service.settings['accounts']['other'] = other
        self.addCleanup(self.service.close)

    def test_background_engine_uses_explicit_account_without_switching_ui(self):
        _, cfg, store = self.service._app(account_id='other')
        self.addCleanup(store.close)
        self.assertEqual(cfg.profile['brand']['name'], '另一个公众号')
        self.assertEqual(str(cfg.article_root), self.service.settings['accounts']['other']['article_root'])
        self.assertEqual(self.service.settings['active_account_id'], 'ice-loop')

    def test_unknown_account_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '公众号配置不存在'):
            self.service._app(account_id='missing')

    def test_background_resume_uses_job_owner_and_frozen_profile(self):
        from tests.test_workflow import demo_spec
        engine, _, store = self.service._app(demo=True,account_id='other')
        try:
            job,_ = engine.create_job({**demo_spec(),'demo':True,'account_id':'other'})
        finally:
            store.close()
        self.service.settings['accounts']['other']['name'] = '已经修改的品牌名'
        _,cfg,connection = self.service._job_app(job,background=True)
        self.addCleanup(connection.close)
        self.assertEqual(cfg.profile['brand']['name'],'另一个公众号')
        self.assertEqual(str(cfg.article_root),self.service._account('other')['article_root'])
        with self.assertRaisesRegex(ValueError,'当前公众号没有该任务'):
            self.service._job_app(job)

    def test_worker_creates_owned_job_and_brand_without_switching_selected_account(self):
        from ice_agent.tasks import TaskQueue
        from ice_agent.tasks.worker import drain
        from tests.test_workflow import demo_spec
        real_app = self.service._app
        _, _, store = real_app()
        self.addCleanup(store.close)
        task = TaskQueue(store).enqueue('other','production',{'spec':{
            **demo_spec(),'account_id':'other','demo':True}})
        observed = []
        def app(**kwargs):
            engine,cfg,connection = real_app(**kwargs)
            if kwargs.get('demo'):
                def complete(job):
                    observed.append(cfg.profile['brand']['name'])
                    connection.update_job(job,state='completed',current_node='export')
                    return connection.get_job(job)
                engine.run = complete
            return engine,cfg,connection
        with patch.object(self.service,'_app',side_effect=app):
            result = drain(self.service)
        record = next(row for row in result['executed'] if row['task_id']==task['task_id'])
        article = store.get_article(store.get_job(record['job_id'])['article_id'])
        self.assertEqual(record['status'],'succeeded')
        self.assertEqual(article['spec']['account_id'],'other')
        self.assertEqual(observed,['另一个公众号'])
        self.assertEqual(self.service.settings['active_account_id'],'ice-loop')

    def test_completed_future_is_released_but_newer_run_is_not_removed(self):
        old,new = Future(),Future()
        self.service.running['fixture'] = old
        self.service._release_completed('fixture',old)
        self.assertNotIn('fixture',self.service.running)
        self.service.running['fixture'] = new
        self.service._release_completed('fixture',old)
        self.assertIs(self.service.running['fixture'],new)
        self.service._release_completed('fixture',new)

    def test_already_completed_future_callback_does_not_deadlock_start(self):
        ready = Future(); ready.set_result({'state':'completed'})
        fake_store = SimpleNamespace(get_job=lambda _: {'state':'queued'},close=lambda:None)
        with patch.object(self.service,'_job_app',return_value=(None,None,fake_store)), \
             patch.object(self.service.workers,'submit',return_value=ready):
            self.assertTrue(self.service._start('instant')['started'])
        self.assertNotIn('instant',self.service.running)

    def test_cancel_callback_can_reenter_lifecycle_guard(self):
        future = Future(); self.service.running['cancel'] = future
        future.add_done_callback(lambda completed: self.service._release_completed('cancel',completed))
        finished = threading.Event()
        def cancel():
            with self.service.guard:
                future.cancel()
            finished.set()
        thread = threading.Thread(target=cancel,daemon=True)
        thread.start()
        self.assertTrue(finished.wait(2),'同步取消回调不得与生命周期锁死锁')
        thread.join(timeout=1)
        self.assertNotIn('cancel',self.service.running)
