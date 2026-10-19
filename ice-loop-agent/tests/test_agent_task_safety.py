"""Agent task tool must create executable work without approving generated code."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch

from ice_agent.agent.registry import AgentContext,ToolExecutor
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue
from tests import REPO,temp_dir


class TestAgentTaskBoundary(unittest.TestCase):
    def setUp(self):
        root = temp_dir('agent-task-boundary-')
        self.service = DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.account = self.service._account()
        self.factory = lambda: Store(self.service.runtime/'app.db')
        self.ctx = AgentContext(account_id=self.account['id'],account=self.account,
            service=self.service,store_factory=self.factory,run_id='test-tool-boundary')
        self.executor = ToolExecutor()
        self.spec = {'series':'PY','episode':25,'topic':'真实任务边界测试'}

    def create(self,**extra):
        return self.executor.execute(self.ctx,'create_production_task',{'kind':'production','payload':{'spec':self.spec},**extra})

    def test_unsupported_kind_is_rejected_instead_of_left_queued_forever(self):
        with self.assertRaises(ValueError): self.create(kind='export')

    def test_missing_or_wrong_account_spec_never_enters_queue(self):
        for payload in ({},{'spec':{}},{'spec':{**self.spec,'account_id':'other'}},
                        {'spec':self.spec,'account_id':'other'}):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError): self.create(payload=payload)
        store = self.factory()
        try: self.assertEqual(TaskQueue(store).list_for_account(self.account['id']),[])
        finally: store.close()

    def test_model_cannot_approve_host_execution_change_owner_or_forge_history(self):
        malicious = {**self.spec,'demo':True,'approve_local_exec':True,
            'article_root':str(self.service.runtime/'model-chosen'),
            'execution_mode':'docker','container_images':{'python':'model-chosen:latest'},
            'target_words':[1,999999],'article_history':{'fabricated':True},
            'publication_confirmation':{'actor':'desktop-user'},'title_selection':{'locked':True}}
        result = self.create(payload={'spec':malicious})
        store = self.factory()
        try: spec = TaskQueue(store).get(result['task_id'])['payload']['spec']
        finally: store.close()
        self.assertFalse(spec['approve_local_exec'])
        self.assertFalse(spec['demo'])
        self.assertEqual(spec['account_id'],self.account['id'])
        self.assertEqual(spec['article_root'],self.account['article_root'])
        self.assertEqual(spec['target_words'],self.account['words_range'])
        self.assertNotIn('publication_confirmation',spec)
        self.assertNotIn('title_selection',spec)
        self.assertNotIn('fabricated',spec.get('article_history',{}))
        self.assertNotEqual(spec['container_images'].get('python'),'model-chosen:latest')
        from ice_agent.execution.plan import execution_plan
        plan = execution_plan({'spec':spec,'draft_md':'# Example\n\n```python\nprint(1)\n```'})
        self.assertFalse(plan['approved'],'tool-created article code must await user approval')

    def test_valid_production_is_idempotent_and_supports_episode_above_ten(self):
        first = self.create(idempotency_key='same-task')
        second = self.create(idempotency_key='same-task')
        self.assertEqual(first['task_id'],second['task_id'])
        store = self.factory()
        try:
            task = TaskQueue(store).get(first['task_id'])
            self.assertEqual(task['payload']['spec']['episode'],25)
            self.assertEqual(task['kind'],'production')
        finally: store.close()

    def test_prepare_execution_closes_its_second_connection_on_failure(self):
        engine,_,store = self.service._app(demo=True)
        try: job,_ = engine.create_job({**self.spec,'account_id':self.account['id'],'demo':True})
        finally: store.close()
        connection = SimpleNamespace(close=Mock())
        broken = SimpleNamespace(_load_state=Mock(side_effect=RuntimeError('fixture failure')))
        with patch.object(self.service,'_job_app',return_value=(broken,None,connection)):
            with self.assertRaises(RuntimeError):
                self.executor.execute(self.ctx,'prepare_execution',{'job_id':job})
        connection.close.assert_called_once()
