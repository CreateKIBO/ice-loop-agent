import copy
import json
import unittest

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.errors import ModelError
from ice_agent.llm.router import LLMRequest
from ice_agent.supplements import create
from tests import REPO, temp_dir


class TestModelBudgets(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('budget-')
        self.s=DesktopService(REPO,self.root/'runtime',self.root/'articles')
        self.source=self.root/'original.md'
        self.body='# PY / 007 原稿标题\n\n不可自动改写的原正文。\n\n![图1：封面](待配图：生图)\n'
        self.source.write_text(self.body,encoding='utf-8')
        self.job=self.import_offline()

    def tearDown(self):
        self.s.close()

    def import_offline(self):
        engine,_,store=self.s._app(demo=True)
        try:return create(engine,store,self.s._account(),self.source)['job_id']
        finally:store.close()

    def data(self):return self.s.call('jobs.get',{'job_id':self.job})
    def budget(self):return self.s.call('budgets.get',{'job_id':self.job})['job']
    def params(self):
        data=self.data()
        return {'job_id':self.job,'figure_no':1,'account_id':'ice-loop',
                'content_hash':data['slots'][0]['content_hash'],'body_hash':data['body_hash']}
    def set_limit(self,maximum,**extra):
        return self.s.call('budgets.save',{'scope':'job','job_id':self.job,
            'limit':maximum,'limits_hash':self.budget()['limits_hash'],**extra})

    def test_real_router_legacy_zero_replans_without_changing_body_or_prompt(self):
        engine,_,store=self.s._job_app(self.job)
        try:
            limits=store.get_job(self.job)['limits'];limits.pop('max_image_model_calls')
            store.conn.execute('UPDATE jobs SET limits_json=? WHERE job_id=?',(json.dumps(limits),self.job));store.conn.commit()
        finally:store.close()
        self.assertTrue(self.budget()['legacy_budget'])
        before=self.data()['slots'][0]['prompt']
        original_body=self.data()['body']
        result=self.s.call('prompts.generate',self.params())
        self.assertTrue(result['prompt'].startswith('Edit image 1'))
        self.assertEqual(self.budget()['used'],1)
        self.assertFalse(self.budget()['legacy_budget'])
        self.assertEqual(self.data()['job']['limits']['max_model_calls'],0)
        self.assertEqual(self.data()['body'],original_body)
        self.assertEqual(self.data()['slots'][0]['prompt'],before)
        self.assertEqual(self.source.read_text(encoding='utf-8'),self.body)

    def test_limit_is_enforced_and_current_task_can_resume_after_increase(self):
        self.set_limit(1)
        self.s.call('prompts.generate',self.params())
        with self.assertRaises(ModelError) as caught:self.s.call('prompts.generate',self.params())
        self.assertEqual(caught.exception.code,'MODEL_BUDGET_EXCEEDED')
        self.assertEqual(self.budget()['used'],1)
        self.set_limit(2)
        self.s.call('prompts.generate',self.params())
        self.assertEqual(self.budget()['used'],2)
        self.assertEqual(self.budget()['remaining'],0)
        with self.assertRaisesRegex(ValueError,'已调用'):self.set_limit(1)

    def test_image_budget_cannot_enable_writer_or_normal_zero_budget(self):
        engine,_,store=self.s._job_app(self.job)
        try:
            with self.assertRaises(ModelError) as caught:
                engine.router.generate(LLMRequest(role='writer',node='draft',prompt='改写正文'),job_id=self.job,max_attempts=1)
            self.assertEqual(caught.exception.code,'IMAGE_ONLY_SCOPE')
            self.assertEqual(self.budget()['used'],0)
            normal,_=engine.create_job({'topic':'zero','series':'PY','episode':8},limits={'max_model_calls':0})
            with self.assertRaises(ModelError) as caught:
                engine.router.generate(LLMRequest(role='planner',node='image_prompts',prompt='test'),job_id=normal,max_attempts=1)
            self.assertEqual(caught.exception.code,'MODEL_BUDGET_EXCEEDED')
        finally:store.close()

    def test_defaults_are_visible_validated_and_do_not_rewrite_existing_limits(self):
        original=copy.deepcopy(self.s.settings['profiles'])
        self.s.call('budgets.save',{'scope':'defaults','max_model_calls':30,'max_image_model_calls':5})
        self.assertEqual(self.s.call('budgets.get')['max_image_model_calls'],5)
        self.assertEqual(self.s.settings['profiles'],original)
        self.assertEqual(self.budget()['limit'],12)
        other=self.import_offline()
        self.assertEqual(self.s.call('budgets.get',{'job_id':other})['job']['limit'],5)
        for value in (0,-1,True,1.5,'3',101):
            with self.assertRaises(ValueError):self.s.call('budgets.save',{'scope':'defaults','max_model_calls':value,'max_image_model_calls':5})
        self.assertEqual(self.s.settings['max_model_calls'],30)

    def test_account_stale_and_running_guards(self):
        for method,params in [('budgets.get',{}),('budgets.save',{'scope':'defaults','max_model_calls':24,'max_image_model_calls':12})]:
            with self.assertRaisesRegex(ValueError,'公众号已切换'):self.s.call(method,{**params,'account_id':'other'})
        old=self.budget()['limits_hash'];self.set_limit(4)
        with self.assertRaisesRegex(ValueError,'预算已变化'):
            self.s.call('budgets.save',{'scope':'job','job_id':self.job,'limit':5,'limits_hash':old})
        _,_,store=self.s._job_app(self.job)
        try:store.conn.execute('UPDATE jobs SET lease=? WHERE job_id=?',('test-busy',self.job));store.conn.commit()
        finally:store.close()
        with self.assertRaisesRegex(ValueError,'正在运行'):self.set_limit(6)
