import copy
import json
import unittest
import zipfile
from dataclasses import asdict
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import new_id,now_iso,sha256_json
from ice_agent.editorial_topics import parse_text,read_document
from ice_agent.llm.router import LLMResponse,RoleRouter,RouteConfig
from ice_agent.workflow.nodes import node_title_workshop,node_outline,node_draft,node_article_review,_with_article_title
from tests import REPO,temp_dir
from tests.test_router import FakeTransport,make_profile


class TestEditorialTopics(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('editorial-');self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles')
        account=self.service.call('bootstrap')['account']
        self.service.call('accounts.save',{'account':{**account,'library_root':''}})
        profile=make_profile('qwen');self.service.settings['profiles']={'qwen':asdict(profile)}
        self.service.settings['routes']['planner']=asdict(RouteConfig(profile.profile_id))
    def tearDown(self):self.service.close()
    def context(self,**params):return self.service.call('planning.context',{'series':'PY',**params})
    def history(self,series,episode,title=None,body=None,status='published'):
        _,_,store=self.service._app()
        try:
            identifier=new_id('history');store.conn.execute('INSERT INTO publication_history VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (identifier,'ice-loop',identifier,series,episode,title or f'{series}历史标题{episode:03}',body or f'# {episode}\n\n正文内容{episode}',status,'2026-10-01' if status=='published' else '',1,now_iso()))
            store.conn.commit();return identifier
        finally:store.close()
    def preview(self,text=None):
        return self.service.call('outlines.preview',{'text':text or '# 栏目选题大纲\n## PY · Python 从0到1\n### 第011期：用项目串起基础\n内容要点：练习之前的概念。\n### 第100期：回顾自己的作品\n','source_name':'测试大纲'})
    def save(self,preview,**extra):
        return self.service.call('outlines.save',{'text':extra.pop('text','# 栏目选题大纲\n## PY · Python 从0到1\n### 第011期：用项目串起基础\n内容要点：练习之前的概念。\n### 第100期：回顾自己的作品\n'),
            'source_name':'测试大纲','rows':preview['rows'],'preview_hash':preview['preview_hash'],'base_hash':preview['base_hash'],**extra})
    def confirm(self,mode='outline',title=None):
        topic=self.service.call('outlines.match',{'series':'PY','episode':11})['topic'] if mode=='outline' else None
        fields={'series':'PY','episode':11,'topic':title or (topic['title'] if topic else '我自己的最终标题'),'title_mode':mode}
        result=self.service.call('planning.confirm',{'fields':fields,'context_hash':self.context()['context_hash'],
            'outline_topic_id':topic['topic_id'] if topic else None,'outline_topic_hash':topic['content_hash'] if topic else None})
        return fields,result

    def test_history_has_five_preceding_bodies_and_all_column_titles_over_sixty(self):
        for episode in range(1,71):self.history('PY',episode,body='# 标题\n'+'正文'*2100+f'正文尾部{episode}')
        self.history('JV',100,title='另一个栏目的标题');self.history('',None,title='未分类标题')
        context=self.context()
        self.assertEqual(context['next_episode'],71);self.assertEqual(context['title_history_count'],70)
        self.assertEqual([row['episode'] for row in context['history']],[70,69,68,67,66])
        self.assertTrue(all(row['series']=='PY' for row in context['known_titles']))
        self.assertIn('正文尾部70',context['history'][0]['body_excerpt'])
        self.assertEqual(context['known_titles'][-1]['title'],'PY历史标题001')

    def test_selected_issue_uses_its_preceding_five_with_published_preferred(self):
        for episode in range(1,16):self.history('PY',episode)
        self.history('PY',10,title='另一个未发布版本',body='重复草稿正文',status='draft')
        context=self.context(episode=12)
        self.assertEqual([row['episode'] for row in context['history']],[11,10,9,8,7])
        self.assertEqual(context['history'][1]['status'],'published')
        self.assertNotIn('重复草稿正文',context['history'][1]['body_excerpt'])

    def test_other_column_changes_do_not_invalidate_current_column_context(self):
        self.history('PY',1);before=self.context()['context_hash'];self.history('JV',2)
        self.assertEqual(self.context()['context_hash'],before)
        self.history('PY',2);self.assertNotEqual(self.context()['context_hash'],before)

    def test_model_receives_all_titles_and_full_preceding_content_for_issue_eleven(self):
        for episode in range(1,71):self.history('PY',episode,body='正文'+('甲'*4000)+f'尾部{episode}')
        data={'analysis':'根据此前五篇递进','recommended':0,'candidates':[{'title':'新标题'+str(i),'topic':'新的角度','core_benefit':'读者收益','next_episode_plan':'阶段作品','reason':'衔接之前内容','source_ids':[]} for i in range(3)]}
        transport=FakeTransport([{'ok':json.dumps(data,ensure_ascii=False)}])
        with patch('ice_agent.llm.router.OpenAIChatTransport',return_value=transport):
            self.service.call('planning.propose',{'fields':{'series':'PY','episode':11,'topic':''},'context_hash':self.context()['context_hash']})
        prompt=transport.calls[0]['messages'][-1]['content']
        self.assertIn('PY历史标题001',prompt);self.assertIn('PY历史标题070',prompt)
        self.assertIn('尾部10',prompt);self.assertNotIn('尾部11',prompt)

    def test_library_index_no_longer_silently_stops_at_500_entries(self):
        from pathlib import Path
        root=self.root/'library';folder=root/'zz-文章';folder.mkdir(parents=True)
        (folder/'01-公众号正文.md').write_text('# PY/011 实际文章\n\n正文',encoding='utf-8')
        account=self.service._account();self.service.call('accounts.save',{'account':{**account,'library_root':str(root)}})
        actual_iter=Path.iterdir
        def entries(path):return iter([root/f'empty-{i:03}' for i in range(500)]+[folder]) if path==root else actual_iter(path)
        with patch.object(Path,'iterdir',entries):context=self.context()
        self.assertEqual(len(context['known_titles']),1);self.assertEqual(context['known_titles'][0]['episode'],11)

    def test_outline_example_parse_and_more_than_ten_entries(self):
        example=self.service.call('outlines.list')['example'];parsed=parse_text(example,self.service._account())
        self.assertEqual(parsed['errors'],[]);self.assertTrue(any(row['episode']==100 for row in parsed['rows']))
        text='## PY\n'+'\n'.join(f'### 第{i}期：计划题目{i}' for i in range(1,26))
        preview=self.preview(text);self.save(preview,text=text)
        result=self.service.call('outlines.match',{'series':'PY','episode':11})
        self.assertEqual(len(result['available']),25);self.assertEqual(result['topic']['title'],'计划题目11')
        self.assertEqual(self.context()['last_published_episode'],0);self.assertEqual(self.service.call('jobs.list'),[])

    def test_explicit_codes_chinese_headings_and_tables(self):
        text='PY/001 让代码运行\n要点：真实运行\n## Java 打怪升级\n| 期号 | 标题 | 读者收益 |\n|---|---|---|\n| 第11期 | 完成一个小项目 | 做成自己的作品 |'
        parsed=parse_text(text,self.service._account())
        self.assertEqual(parsed['errors'],[]);self.assertEqual([(row['series'],row['episode']) for row in parsed['rows']],[('PY',1),('JV',11)])

    def test_ambiguous_series_and_duplicate_issues_are_visible_then_editable(self):
        text='第11期：无栏目题目\nPY/011 同一期另一个标题'
        preview=self.preview(text);self.assertTrue(preview['errors'])
        preview['rows'][0]['series']='JV';self.save(preview,text=text)
        self.assertEqual(len(self.service.call('outlines.list')['rows']),2)

    def test_overwrite_requires_explicit_confirmation_and_is_transactional(self):
        self.save(self.preview());before=self.service.call('outlines.list')['rows']
        preview=self.preview();preview['rows'][0]['title']='修改后的项目标题'
        preview['rows'].insert(0,{'series':'PY','episode':12,'title':'先写一条新题目'})
        with self.assertRaisesRegex(ValueError,'确认覆盖'):self.save(preview)
        self.assertEqual(self.service.call('outlines.list')['rows'],before)
        self.save(preview,replace_existing=True);self.assertEqual(len(self.service.call('outlines.list')['rows']),3)

    def test_stale_preview_modified_source_and_stale_edit_rejected(self):
        preview=self.preview();self.save(preview)
        with self.assertRaisesRegex(ValueError,'变化'):self.save(preview)
        current=self.preview()
        with self.assertRaises(ValueError):self.save(current,text='## PY\n第12期：另一份文档')
        row=self.service.call('outlines.list')['rows'][0]
        self.service.call('outlines.update',{**row,'title':'更新过的标题'})
        with self.assertRaisesRegex(ValueError,'变化'):self.service.call('outlines.update',{**row,'title':'过期修改'})

    def test_account_isolation_for_import_match_update_and_selection(self):
        self.save(self.preview());row=self.service.call('outlines.list')['rows'][0]
        self.service.call('accounts.save',{'account':{'name':'另一个公众号','audience':'读者','columns':[{'code':'PY','name':'自己的栏目'}]}})
        self.assertEqual(self.service.call('outlines.list')['rows'],[])
        self.assertIsNone(self.service.call('outlines.match',{'series':'PY','episode':11})['topic'])
        with self.assertRaises(ValueError):self.service.call('outlines.update',{**row,'title':'越界修改'})
        with self.assertRaises(ValueError):self.service.call('outlines.list',{'account_id':'ice-loop'})

    def test_outline_title_is_edited_confirmed_and_never_regenerated_by_title_workshop(self):
        self.save(self.preview());fields,confirmation=self.confirm(title='我编辑后的项目题目')
        with patch.object(self.service,'_start',return_value={'started':False}),patch.object(RoleRouter,'generate') as model:
            result=self.service.call('jobs.create',{**confirmation,'spec':fields});model.assert_not_called()
        engine,_,store=self.service._job_app(result['job_id'])
        try:
            state=engine._load_state(result['job_id']);state['integrated_md']='# 模型临时标题\n\n正文内容'
            ctx=engine._make_ctx(store.get_job(result['job_id']),store.get_article(result['article_id']),state)
            def only_summary(request,**kwargs):
                self.assertEqual(request.node,'abstract');return LLMResponse(text='',data={'abstract':'这是摘要。'})
            with patch.object(engine.router,'generate',side_effect=only_summary) as model:
                node_title_workshop(ctx)
            self.assertEqual(model.call_count,1);self.assertEqual(state['final_title'],fields['topic'])
            self.assertTrue(state['integrated_md'].startswith('# '+fields['topic']))
            approval=store.conn.execute("SELECT * FROM approvals WHERE job_id=? AND scope='final_title'",(result['job_id'],)).fetchone()
            self.assertEqual(approval['status'],'approved');self.assertEqual(approval['decided_by'],'desktop-user')
            self.assertNotIn('total',state['titles_table'][0])
            def writing(request,**kwargs):
                self.assertTrue(request.context['title_selection']['locked'])
                return LLMResponse(text='# 模型另拟标题\n\n```python\n# 不改代码注释\nprint(1)\n```',data={'working_title':'模型另拟标题','sections':[{'h2':'一、开始'}]})
            with patch.object(engine.router,'generate',side_effect=writing),patch.object(ctx,'ensure_approval') as approval_gate:
                node_outline(ctx);node_draft(ctx)
            self.assertEqual(approval_gate.call_args.args[1]['working_title'],fields['topic'])
            self.assertTrue(state['draft_md'].startswith('# '+fields['topic']))
            self.assertIn('# 不改代码注释',state['draft_md'])
            state['runs']={};state['integrated_md']='# '+fields['topic']+'\n\n待修订正文'
            failing={'passed':False,'report':{'blocking':[{'message':'完善正文'}],'warnings':[]}}
            passing={'passed':True,'report':{'blocking':[],'warnings':[]}}
            with patch('ice_agent.workflow.nodes._run_rules',side_effect=[failing,passing]),patch.object(engine.router,'generate',side_effect=[LLMResponse(text='# 审校试图换题\n\n已修订正文'),LLMResponse(text='',data={'blocking':[],'warnings':[]})]):
                node_article_review(ctx)
            self.assertTrue(state['integrated_md'].startswith('# '+fields['topic']))
        finally:store.close()

    def test_locked_title_preserves_code_and_literal_backslashes(self):
        text='```python\n# 这是代码注释\n```\n\n# 原标题\n\n正文'
        changed=_with_article_title(text,r'认识 C:\\作品')
        self.assertIn('# 这是代码注释',changed);self.assertIn(r'# 认识 C:\\作品',changed)
        self.assertEqual(_with_article_title('只有正文','已确认标题'),'# 已确认标题\n\n只有正文')

    def test_manual_title_needs_no_outline_and_cannot_call_planner(self):
        fields,confirmation=self.confirm(mode='manual')
        with patch.object(RoleRouter,'generate') as model:
            with self.assertRaisesRegex(ValueError,'无需AI'):self.service.call('planning.propose',{'fields':fields,'context_hash':self.context()['context_hash']})
            with patch.object(self.service,'_start',return_value={'started':False}):result=self.service.call('jobs.create',{**confirmation,'spec':fields})
            model.assert_not_called()
        self.assertTrue(self.service.call('jobs.get',{'job_id':result['job_id']})['article']['spec']['title_selection']['locked'])

    def test_changed_outline_invalidates_confirmation_before_task_creation(self):
        self.save(self.preview());fields,confirmation=self.confirm()
        row=self.service.call('outlines.match',{'series':'PY','episode':11})['topic']
        self.service.call('outlines.update',{**row,'title':'计划已经修改'})
        with self.assertRaisesRegex(ValueError,'更新'):self.service.call('jobs.create',{**confirmation,'spec':fields})
        self.assertEqual(self.service.call('jobs.list'),[])

    def test_forged_locked_title_without_confirmation_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'先.*确认'):
            self.service.call('jobs.create',{'spec':{'series':'PY','episode':11,'topic':'未经确认标题','title_mode':'manual','title_selection':{'locked':True}}})

    def test_word_paragraphs_tables_and_revision_rejection(self):
        xml='''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>PY/011 一个项目题目</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>期号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>标题</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>栏目</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>一个回顾题目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>PY</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'''
        file=self.root/'outline.docx'
        with zipfile.ZipFile(file,'w') as archive:archive.writestr('word/document.xml',xml)
        result=read_document(file);parsed=parse_text(result['text'],self.service._account())
        self.assertEqual([row['episode'] for row in parsed['rows']],[11,100]);self.assertEqual(parsed['errors'],[])
        with zipfile.ZipFile(file,'w') as archive:archive.writestr('word/document.xml',xml.replace('<w:r>','<w:ins><w:r>').replace('</w:r>','</w:r></w:ins>'))
        with self.assertRaisesRegex(ValueError,'修订'):read_document(file)

    def test_word_entities_duplicate_main_part_and_limits_are_rejected(self):
        file=self.root/'bad.docx'
        with zipfile.ZipFile(file,'w') as archive:archive.writestr('word/document.xml','<!DOCTYPE x [<!ENTITY e "a">]><x>&e;</x>')
        with self.assertRaises(ValueError):read_document(file)
        with self.assertRaises(ValueError):parse_text('x'*400001,self.service._account())
        text='## PY\n'+'\n'.join(f'第{i}期：题目{i}' for i in range(1,1002))
        with self.assertRaisesRegex(ValueError,'1000'):self.preview(text)

    def test_topic_schedules_and_source_snapshot_survive_backup_restore(self):
        self.save(self.preview());package=self.service.call('backup.create',{'file_path':str(self.root/'backup.zip')})
        restored=self.service.call('backup.restore',{'file_path':package['file_path'],'destination':str(self.root/'restored'),'package_hash':package['package_hash']})
        from pathlib import Path
        service=DesktopService(REPO,Path(restored['runtime_root']))
        try:self.assertEqual(service.call('outlines.match',{'series':'PY','episode':100})['topic']['title'],'回顾自己的作品')
        finally:service.close()


if __name__=='__main__':unittest.main()
