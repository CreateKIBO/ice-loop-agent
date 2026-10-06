import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.execution.plan import execution_plan,execution_hash
from ice_agent.workflow.nodes import node_verify_code,UserActionRequired,NodeFailed
from tests import REPO,temp_dir


class TestExecutionReview(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('execution-review-');self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles')
        self.engine,_,self.store=self.service._app(demo=True)
        self.job,self.article=self.engine.create_job({'series':'PY','episode':111,'topic':'验证示例输入','approve_local_exec':False,'demo':True})
    def tearDown(self):self.store.close();self.service.close()
    def prepare(self,body,inputs=None,approved=False):
        state=self.engine._load_state(self.job);state.update(series='PY',draft_md=body)
        state['spec']['stdin_by_filename']=inputs or {}
        if approved:state['execution_approval']=execution_hash(state)
        self.engine._save_state(self.job,state);self.store.update_job(self.job,state='awaiting_user',current_node='verify_code')
        return state
    def ctx(self,state):return self.engine._make_ctx(self.store.get_job(self.job),self.store.get_article(self.article),state)

    def test_existing_approved_job_with_missing_input_is_distinguished(self):
        self.prepare('```python\nname=input("姓名：")\nprint(name)\n```\n',approved=True)
        data=self.service.call('jobs.get',{'job_id':self.job})
        self.assertTrue(data['execution']['approved']);self.assertEqual(data['execution']['status'],'needs_input')
        self.assertEqual(data['execution']['missing_inputs'],['demo_1.py'])
        with self.assertRaisesRegex(ValueError,'填写'):
            self.service.call('execution.approve',{'job_id':self.job,'content_hash':data['execution_hash']})
        self.assertTrue(self.service.call('jobs.get',{'job_id':self.job})['execution']['approved'])

    def test_input_save_and_approve_are_one_action_then_real_run_once(self):
        self.prepare('```python\nname=input("姓名：")\nprint("你好",name)\n```\n')
        data=self.service.call('jobs.get',{'job_id':self.job})
        params={'job_id':self.job,'content_hash':data['execution_hash'],'stdin_by_filename':{'demo_1.py':'小冰'}}
        with patch.object(self.service,'_start',return_value={'started':False}):self.service.call('execution.approve',params)
        state=self.engine._load_state(self.job);node_verify_code(self.ctx(state))
        self.assertIn('你好 小冰',state['runs']['run-1']['stdout'])
        run_id=state['runs']['run-1']['run_id']
        with patch.object(self.engine.runner,'run_python') as run:
            node_verify_code(self.ctx(state));run.assert_not_called()
        self.assertEqual(state['runs']['run-1']['run_id'],run_id)
        duplicate=self.service.call('execution.approve',params)
        self.assertTrue(duplicate['already_approved'])

    def test_all_inputs_preflight_before_any_code_runs(self):
        state=self.prepare('```python\nprint(1)\n```\n```python\nx=input()\nprint(x)\n```',approved=True)
        with patch.object(self.engine.runner,'run_python') as run:
            with self.assertRaisesRegex(UserActionRequired,'demo_2.py'):node_verify_code(self.ctx(state))
            run.assert_not_called()

    def test_comment_and_string_input_names_do_not_require_stdin(self):
        state=self.prepare('```python\n# input() 只是注释\nprint("input(")\n```')
        self.assertEqual(execution_plan(state)['missing_inputs'],[])

    def test_failed_run_is_preserved_and_previous_success_is_not_replayed(self):
        state=self.prepare('```python\nprint("第一段通过")\n```\n```python\n1/0\n```',approved=True)
        with self.assertRaises(NodeFailed):node_verify_code(self.ctx(state))
        saved=self.engine._load_state(self.job);self.assertEqual(len(saved['runs']),2)
        self.assertIn('ZeroDivisionError',saved['runs']['run-2']['stderr'])
        first=saved['runs']['run-1']['run_id']
        with patch.object(self.engine.runner,'run_python',wraps=self.engine.runner.run_python) as run:
            with self.assertRaises(NodeFailed):node_verify_code(self.ctx(saved))
            self.assertEqual(run.call_count,1)
        self.assertEqual(first,saved['runs']['run-1']['run_id'])

    def test_stale_input_approval_and_other_account_are_rejected(self):
        self.prepare('```python\nprint(1)\n```');data=self.service.call('jobs.get',{'job_id':self.job})
        self.service.call('execution.inputs',{'job_id':self.job,'content_hash':data['execution_hash'],'stdin_by_filename':{'demo_1.py':'2'}})
        with self.assertRaisesRegex(ValueError,'变化'):self.service.call('execution.approve',{'job_id':self.job,'content_hash':data['execution_hash']})
        data=self.service.call('jobs.get',{'job_id':self.job})
        self.service.call('accounts.save',{'account':{'name':'另一个公众号','audience':'读者'}})
        with self.assertRaisesRegex(ValueError,'当前公众号'):self.service.call('execution.approve',{'job_id':self.job,'content_hash':data['execution_hash']})

    def test_duplicate_java_filenames_have_independent_input_keys(self):
        source='import java.util.Scanner;\npublic class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in);System.out.println(s.nextLine()); }}'
        state=self.prepare('```java\n'+source+'\n```\n```java\n'+source+'\n```')
        plan=execution_plan(state);self.assertEqual(plan['missing_inputs'],['code_1_Main.java','code_2_Main.java'])

    def test_blank_line_is_valid_input_and_source_change_invalidates_approval(self):
        state=self.prepare('```python\nx=input()\nprint(repr(x))\n```',{'demo_1.py':'\n'},True)
        self.assertEqual(execution_plan(state)['missing_inputs'],[])
        state['draft_md']=state['draft_md'].replace('repr(x)','x.upper()')
        self.assertFalse(execution_plan(state)['approved'])
