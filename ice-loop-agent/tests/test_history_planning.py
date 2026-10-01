import json
import unittest
from dataclasses import asdict
from datetime import date
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse, RoleRouter, RouteConfig
from tests import REPO, temp_dir
from tests.test_router import FakeTransport, make_profile


class TestHistoryPlanning(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('history-')
        self.service=DesktopService(REPO,self.root,self.root/'articles')
        self.library=self.root/'library';self.library.mkdir()
        account=self.service.call('bootstrap')['account']
        self.service.call('accounts.save',{'account':{**account,'library_root':str(self.library)}})
        profile=make_profile('qwen')
        self.service.settings['profiles']={'qwen':asdict(profile)}
        self.service.settings['routes']['planner']=asdict(RouteConfig(profile.profile_id))

    def tearDown(self):
        self.service.close()

    def source(self, episode=2, series='PY', folder='009-旧文章'):
        directory=self.library/folder;directory.mkdir(exist_ok=True)
        body='# 记住一个变量\n\n上一篇 PY/001 学过代码，文件夹编号不等于期号。\n\n## 动手练习\n写一份小冰的个人介绍。\n\n## 写在最后\n下一篇会用 input 接收输入。'
        (directory/'01-公众号正文.md').write_text(body,encoding='utf-8')
        (directory/'00-阅读入口.md').write_text(f'# {series}/{episode:03d} 变量\n',encoding='utf-8')
        return directory/'01-公众号正文.md'

    def publish(self,row,episode=None):
        return self.service.call('history.update',{**row,'episode':episode or row['episode'],'status':'published','published_at':date.today().isoformat()})

    def context(self,series='PY'):
        return self.service.call('planning.context',{'series':series})

    def fields(self,**extra):
        return {'topic':'','series':'PY','episode':self.context()['next_episode'],**extra}

    def proposals(self,reference=None):
        return {'analysis':'变量之后衔接 input，避免重复已讲内容。','recommended':0,'candidates':[
            {'title':title,'topic':'输入与字符串格式化','core_benefit':'做一个可交互的小作品','next_episode_plan':'条件判断',
             'reason':'衔接上篇预告','source_ids':[reference] if reference else []}
            for title in ['让程序听见你的回答','把输入变成一句欢迎语','用 input 做个问答程序']]}

    def propose(self,data=None):
        fields=self.fields()
        with patch.object(RoleRouter,'generate',return_value=LLMResponse(text='',data=data or self.proposals(),model_id='fake-model')):
            return self.service.call('planning.propose',{'fields':fields,'context_hash':self.context()['context_hash']})

    def confirmed(self,proposal=None):
        fields=self.fields(topic='我修改后的交互标题',content_angle='给新同学做一个欢迎程序',core_benefit='真实读者收益')
        confirmation=self.service.call('planning.confirm',{'fields':fields,'context_hash':self.context()['context_hash'],'plan_id':proposal['plan_id'] if proposal else None})
        return fields,confirmation

    def test_draft_is_not_publication_and_folder_number_is_not_episode(self):
        self.source()
        row=self.service.call('history.list')[0]
        self.assertEqual((row['series'],row['episode'],row['status']),('PY',2,'draft'))
        self.assertEqual(self.context()['next_episode'],1)
        self.assertEqual(self.context()['previous_exercise'],'')

    def test_published_progress_column_scope_and_real_previous_sections(self):
        self.source()
        row=self.service.call('history.list')[0];self.publish(row)
        context=self.context()
        self.assertEqual(context['next_episode'],3)
        self.assertIn('小冰',context['previous_exercise'])
        self.assertIn('input',context['previous_preview'])
        self.assertEqual(self.context('JV')['next_episode'],1)

    def test_baseline_ignores_drafts_and_missing_previous_body_is_not_fabricated(self):
        self.source(episode=9)
        self.service.call('history.progress',{'series':'PY','episode':5})
        self.assertEqual(self.context()['next_episode'],6)
        self.assertEqual(self.context()['previous_exercise'],'')
        self.publish(self.service.call('history.list')[0],episode=2)
        self.assertEqual(self.context()['previous_exercise'],'')
        self.assertEqual(self.context()['next_episode'],6)

    def test_published_body_snapshot_and_stale_edit_protection(self):
        file=self.source();row=self.service.call('history.list')[0];self.publish(row)
        context=self.context();file.write_text('# 修改后的草稿\n不是已发布内容',encoding='utf-8')
        self.assertEqual(self.context()['context_hash'],context['context_hash'])
        with self.assertRaisesRegex(ValueError,'变化'):
            self.publish(row)

    def test_account_isolation(self):
        self.source();self.service.call('history.progress',{'series':'PY','episode':5})
        account=self.service.call('accounts.save',{'account':{'name':'另一个账号','audience':'读者','columns':[{'code':'PY','name':'新栏目'}]}})['account']
        self.assertEqual(self.context()['next_episode'],1)
        self.assertEqual(self.service.call('history.list'),[])
        self.service.call('accounts.switch',{'account_id':'ice-loop'})
        self.assertEqual(self.context()['next_episode'],6)
        with self.assertRaises(ValueError):self.service.call('planning.context',{'series':'PY','account_id':account['id']})

    def test_planner_reads_actual_titles_body_and_preview_with_no_seed(self):
        self.source();row=self.service.call('history.list')[0];self.publish(row)
        transport=FakeTransport([{'ok':json.dumps(self.proposals(row['history_id']),ensure_ascii=False)}])
        with patch('ice_agent.llm.router.OpenAIChatTransport',return_value=transport):
            result=self.service.call('planning.propose',{'fields':self.fields(),'context_hash':self.context()['context_hash']})
        prompt=transport.calls[0]['messages'][-1]['content']
        for fragment in ['记住一个变量','个人介绍','input','published']:self.assertIn(fragment,prompt)
        self.assertEqual(len(result['candidates']),3)
        self.assertEqual(self.service.call('jobs.list'),[])

    def test_fake_history_reference_and_duplicate_title_rejected(self):
        with self.assertRaisesRegex(ValueError,'不存在'):self.propose(self.proposals('fake-id'))
        data=self.proposals();data['candidates'][1]['title']=data['candidates'][0]['title']
        with self.assertRaisesRegex(ValueError,'重复'):self.propose(data)

    def test_unconfigured_planner_never_falls_back_to_mock(self):
        with patch('ice_agent.config.resolve_credential',return_value=None),patch.object(RoleRouter,'generate') as model:
            with self.assertRaises(ValueError):self.service.call('planning.propose',{'fields':self.fields(),'context_hash':self.context()['context_hash']})
            model.assert_not_called()

    def test_progress_change_invalidates_proposal_and_confirmation(self):
        proposal=self.propose();fields=self.fields(topic='新标题')
        self.service.call('history.progress',{'series':'PY','episode':4})
        with self.assertRaisesRegex(ValueError,'更新'):self.service.call('planning.confirm',{'fields':fields,'plan_id':proposal['plan_id'],'context_hash':proposal['context_hash']})

    def test_confirmed_edited_title_uses_audited_gate_without_model_call(self):
        fields,confirmation=self.confirmed(self.propose())
        with patch.object(self.service,'_start',return_value={'started':False}),patch.object(RoleRouter,'generate') as model:
            result=self.service.call('jobs.create',{**confirmation,'spec':fields})
            model.assert_not_called()
            duplicate=self.service.call('jobs.create',{**confirmation,'spec':fields})
        self.assertEqual(result['job_id'],duplicate['job_id'])
        detail=self.service.call('jobs.get',{'job_id':result['job_id']})
        self.assertEqual(detail['article']['spec']['topic'],fields['topic'])
        self.assertEqual(detail['article']['spec']['article_history']['next_episode'],1)
        engine,_,store=self.service._job_app(result['job_id'])
        try:
            approval=store.conn.execute("SELECT * FROM approvals WHERE job_id=?",(result['job_id'],)).fetchone()
            self.assertEqual((approval['status'],approval['decided_by']),('approved','desktop-user'))
            self.assertEqual(json.loads(approval['payload'])['working_title'],fields['topic'])
            # Resume reaches the real next node with the edited title, no topic request.
            def stop_after_topic(request,**kwargs):
                self.assertNotEqual(request.node,'topic')
                raise RuntimeError('offline stop before further model calls')
            with patch.object(engine.router,'generate',side_effect=stop_after_topic):engine.run(result['job_id'])
            self.assertEqual(store.get_article(result['article_id'])['working_title'],fields['topic'])
            self.assertEqual(engine._load_state(result['job_id'])['selected_direction']['核心角度'],fields['content_angle'])
        finally:store.close()

    def test_changed_fields_forged_hash_and_stale_history_block_creation(self):
        fields,confirmation=self.confirmed()
        for params in ({**confirmation,'confirmation_hash':'forged','spec':fields},{**confirmation,'spec':{**fields,'topic':'变更标题'}}):
            with self.assertRaisesRegex(ValueError,'确认'):self.service.call('jobs.create',params)
        self.service.call('history.progress',{'series':'PY','episode':3})
        with self.assertRaisesRegex(ValueError,'更新'):self.service.call('jobs.create',{**confirmation,'spec':fields})
        self.assertEqual(self.service.call('jobs.list'),[])

    def test_history_limits_and_date_validation(self):
        self.source();row=self.service.call('history.list')[0]
        with self.assertRaises(ValueError):self.service.call('history.update',{**row,'status':'published','published_at':'2099-01-01'})
        for episode in [-1,True,10000]:
            with self.assertRaises(ValueError):self.service.call('history.progress',{'series':'PY','episode':episode})
        self.service.call('history.progress',{'series':'PY','episode':9999})
        self.assertIsNone(self.context()['next_episode'])
