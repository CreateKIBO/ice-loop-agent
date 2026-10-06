import copy
import unittest
from unittest.mock import patch

from PIL import Image

from ice_agent.automation import delivery_hash
from ice_agent.cli import build_app
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse
from tests import REPO,temp_dir
from tests.test_workflow import demo_spec


class TestPreparation(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('auto-');self.engine,self.cfg,self.store=build_app(self.root/'articles',self.root/'runtime',provider='mock',allow_local_exec=True)
    def tearDown(self):self.store.close()

    def test_auto_prepares_once_and_requires_final_human_review(self):
        spec=demo_spec();spec['production_mode']='auto_prepare'
        job,article=self.engine.create_job(spec);result=self.engine.run(job)
        self.assertEqual(result['state'],'completed',result.get('pause_reason'))
        rows=self.store.conn.execute('SELECT scope,status,decided_by FROM approvals WHERE job_id=?',(job,)).fetchall()
        self.assertEqual([r['scope'] for r in rows],['topic','outline','final_title','asset_plan'])
        self.assertTrue(all(r['status']=='approved' and r['decided_by']=='auto:preparation' for r in rows))
        invocations=self.store.job_invocations(job);self.assertEqual(sum(r['node_key']=='image_prompts' for r in invocations),1)
        self.engine.run(job);self.assertEqual(len(self.store.job_invocations(job)),len(invocations))
        image=self.root/'image.png';Image.new('RGB',(100,80),'#2448DB').save(image)
        for slot in self.store.article_slots(article):self.engine.import_asset(job,slot['figure_no'],image)
        self.engine.refinalize(job);self.assertEqual(self.store.get_article(article)['readiness'],'review_pending')
        state=self.engine._load_state(job);state['delivery_review']=delivery_hash(state,self.store.article_slots(article));self.engine._save_state(job,state)
        self.engine.refinalize(job);self.assertEqual(self.store.get_article(article)['readiness'],'ready_for_publish')
        self.engine.import_asset(job,1,image);self.engine.refinalize(job)
        self.assertEqual(self.store.get_article(article)['readiness'],'review_pending')

    def test_auto_does_not_approve_new_host_code(self):
        spec=demo_spec();spec.update(production_mode='auto_prepare',approve_local_exec=False)
        job,_=self.engine.create_job(spec);result=self.engine.run(job)
        self.assertEqual(result['state'],'awaiting_user');self.assertEqual(result['current_node'],'verify_code')
        count=len(self.store.job_invocations(job));self.engine.run(job)
        self.assertEqual(len(self.store.job_invocations(job)),count)
        self.assertEqual(self.engine._load_state(job).get('runs',{}),{})

    def test_one_click_creation_analyzes_history_and_freezes_mode(self):
        service=DesktopService(REPO,self.root/'service',self.root/'service-articles')
        def generate(router,request,**kwargs):
            self.assertEqual(request.node,'history_planning');self.assertIn('known_titles',request.context['article_history'])
            return LLMResponse(text='',data={'analysis':'接续已学概念','recommended':1,'candidates':[
                {'title':title,'topic':'练习循环的实际应用','core_benefit':'完成独立小练习','next_episode_plan':'列表','reason':'内容递进','source_ids':[]}
                for title in ('从循环开始练习','让循环解决一个小问题','检查循环结束的条件')]},model_id='fixture')
        try:
            from tests.test_router import make_profile
            from dataclasses import asdict
            profile=make_profile('qwen',profile_id='qwen-default');service.settings['profiles']['qwen']=asdict(profile)
            with patch('ice_agent.llm.router.RoleRouter.generate',new=generate),patch.object(service,'_start',return_value={'started':False}):
                result=service.call('jobs.create',{'account_id':'ice-loop','spec':{'series':'PY','episode':1,'topic':'','production_mode':'auto_prepare','title_mode':'ai'}})
            data=service.call('jobs.get',result)
            self.assertEqual(data['article']['topic'],'让循环解决一个小问题')
            self.assertEqual(data['article']['spec']['production_mode'],'auto_prepare')
            self.assertIn('article_history',data['article']['spec'])
            self.assertIsNone(data['pending_approval'])
        finally:service.close()

    def test_docker_auto_inputs_are_bound_to_the_isolated_execution_manifest(self):
        from ice_agent.execution.plan import execution_plan
        from ice_agent.workflow.nodes import node_verify_code,UserActionRequired
        spec=demo_spec();spec.update(production_mode='auto_prepare',approve_local_exec=False,execution_mode='docker',container_images={'python':'python:3.12-slim','java':'eclipse-temurin:17-jdk'})
        job,article=self.engine.create_job(spec);state=self.engine._load_state(job)
        state['draft_md']='# 输入示例\n\n```python\nname=input("名字：")\nprint(name)\n```\n'
        state['series']='PY';initial=copy.deepcopy(state)
        ctx=self.engine._make_ctx(self.store.get_job(job),self.store.get_article(article),state)
        key=execution_plan(state)['missing_inputs'][0]
        def isolated(spec,reviewed=False):
            self.assertTrue(reviewed);self.assertEqual(spec.execution_mode,'docker');self.assertEqual(spec.stdin_events,['小冰\n'])
            raise RuntimeError('isolated runner reached')
        with patch.object(ctx,'generate',return_value=LLMResponse(text='',data={'inputs':[{'stdin_key':key,'stdin':'小冰'}]})),patch.object(ctx.runner,'run_python',side_effect=isolated):
            with self.assertRaisesRegex(RuntimeError,'isolated runner reached'):node_verify_code(ctx)
        self.assertTrue(execution_plan(state)['approved'])
        ctx.state=initial
        with patch.object(ctx,'generate',return_value=LLMResponse(text='',data={'inputs':[{'stdin_key':'invented','stdin':'x'}]})),patch.object(ctx.runner,'run_python') as runner:
            with self.assertRaises(UserActionRequired):node_verify_code(ctx)
            runner.assert_not_called()

    def test_invalid_image_plan_cache_can_be_retried(self):
        from dataclasses import asdict
        from ice_agent.workflow.nodes import node_asset_plan,NodeFailed,ApprovalPause
        spec=demo_spec();spec['production_mode']='auto_prepare'
        job,article=self.engine.create_job(spec);self.assertEqual(self.engine.run(job)['state'],'completed')
        state=self.engine._load_state(job)
        state['model_candidates']['image_prompts']=asdict(LLMResponse(text='',data={'figures':[{'figure_no':999,'layout':'wrong','exact_text':[]}]}))
        ctx=self.engine._make_ctx(self.store.get_job(job),self.store.get_article(article),state)
        with self.assertRaises(NodeFailed):node_asset_plan(ctx)
        self.assertNotIn('image_prompts',ctx.state['model_candidates'])
        calls=len(self.store.job_invocations(job))
        try:node_asset_plan(ctx)
        except ApprovalPause:pass
        self.assertIn('image_prompts',ctx.state['model_candidates'])
        self.assertEqual(len(self.store.job_invocations(job)),calls+1)


if __name__=='__main__':unittest.main()
