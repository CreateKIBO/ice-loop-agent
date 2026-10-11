import unittest
from unittest.mock import patch
from ice_agent.execution.runner import CodeRunner,ExecutionError
from ice_agent.execution.plan import execution_hash
from ice_agent.domain.types import RunSpec
from ice_agent.llm.adapters import make_adapter
from ice_agent.llm.capabilities import preset_profile
from ice_agent.domain.types import ModelProfile
from tests import test_execution_review

class TestCodeEdit(test_execution_review.TestExecutionReview):
    def test_expected_error_is_explicit_and_keeps_real_traceback(self):
        state=self.prepare('# 标题\n\n```python\nprint(1 / 0)\n```\n')
        with patch.object(self.service,'_start',return_value={'started':True}):self.service.execution_approve({'job_id':self.job,'content_hash':execution_hash(state),'expected_failures':{'1':True}})
        from ice_agent.workflow.nodes import node_verify_code
        fresh=self.engine._load_state(self.job);node_verify_code(self.ctx(fresh))
        self.assertEqual(fresh['runs']['run-1']['verdict'],'expected_failure_ok');self.assertIn('ZeroDivisionError',fresh['runs']['run-1']['stderr'])
    def test_task_policy_change_clears_approval_and_stale_request(self):
        state=self.prepare('# 标题\n\n```python\nprint(1)\n```\n',approved=True)
        self.service.execution_policy_save({'job_id':self.job,'content_hash':execution_hash(state),'mode':'docker','images':{'python':'python:3.12-slim','java':'eclipse-temurin:17-jdk'}})
        fresh=self.engine._load_state(self.job);self.assertNotIn('execution_approval',fresh);self.assertEqual(fresh['spec']['execution_mode'],'docker')
        with self.assertRaises(ValueError):self.service.execution_approve({'job_id':self.job,'content_hash':execution_hash(state)})
    def test_edit_clears_permission_runs_new_source(self):
        state=self.prepare('# 标题\n\n```python\nprint(1 / 0)\n```\n',approved=True)
        result=self.service.call('execution.code_save',{'job_id':self.job,'content_hash':execution_hash(state),'sources':{'1':{'language':'python','source':'print("修正成功")'}}})
        self.assertFalse(result['execution']['approved']);self.assertIn('修正成功',result['execution']['blocks'][0]['source'])
        fresh=self.engine._load_state(self.job)
        with patch.object(self.service,'_start',return_value={'started':True}):self.service.execution_approve({'job_id':self.job,'content_hash':execution_hash(fresh)})
        from ice_agent.workflow.nodes import node_verify_code
        fresh=self.engine._load_state(self.job);node_verify_code(self.ctx(fresh));self.assertEqual(fresh['runs']['run-1']['stdout'].replace('\r\n','\n'),'修正成功\n')
    def test_mark_display_only_code_as_text(self):
        state=self.prepare('# 标题\n\n```html\n<h1>说明</h1>\n```\n',approved=True)
        result=self.service.execution_code_save({'job_id':self.job,'content_hash':execution_hash(state),'sources':{'1':{'language':'text','source':'<h1>说明</h1>'}}})
        self.assertEqual(result['execution']['blocks'],[])
    def test_mode_changes_invalidate_approval(self):
        state=self.prepare('# 标题\n```python\nprint(1)\n```',approved=True);old=execution_hash(state)
        state['spec']['execution_mode']='docker';state['spec']['container_images']={'python':'python:3.12-slim'}
        self.assertNotEqual(old,execution_hash(state))
    def test_minimax_native_and_hosted_endpoint_snapshots(self):
        profile=ModelProfile(**preset_profile('minimax'));adapter=make_adapter(profile)
        self.assertEqual(adapter.default_extra_body(),{'reasoning_split':True});self.assertEqual(adapter.thinking_extra_body('required_off'),{'thinking':{'type':'disabled'}})
        updated=self.service.models_save({'provider':'minimax','model_id':'MiniMax-M2.7','base_url':'https://api.minimax.io/v1','service':'minimax-overseas','region':'international'})
        row=next(r for r in updated['settings']['profiles'] if r['provider']=='minimax')
        self.assertEqual(row['capabilities']['thinking'],'unknown');self.assertEqual(row['service'],'minimax-overseas')
    def test_docker_missing_never_falls_back(self):
        runner=CodeRunner(self.root,allow_local_reviewed=True)
        with patch('ice_agent.execution.runner.shutil.which',return_value=None),self.assertRaises(ExecutionError):runner.run_python(RunSpec(language='python',source='print(1)',filename='demo.py',execution_mode='docker',container_image='python:3.12-slim'),reviewed=True)
