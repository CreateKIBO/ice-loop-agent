"""Confirmed issue/title handoff to real creative requests and saved drafts."""
import json
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.domain.types import new_id, now_iso
from ice_agent.llm.router import LLMResponse, RoleRouter
from tests import REPO, temp_dir


class TestEditorialConversation(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('editorial-chat-')
        self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        account=self.service._account()
        self.service.call('accounts.save',{'account':{**account,'library_root':''}})
        self.seen=[]

    def context(self,episode=None):
        return self.service.call('planning.context',{'account_id':'ice-loop','series':'PY',**({'episode':episode} if episode else {})})

    def confirm(self,episode=11,mode='manual',title='我确认的本期标题',**extra):
        return self.service.call('planning.confirm',{'account_id':'ice-loop','context_hash':self.context(episode)['context_hash'],
            'fields':{'series':'PY','episode':episode,'topic':title,'title_mode':mode},**extra})

    def create(self,plan,**extra):
        return self.service.call('chat.create',{'account_id':'ice-loop','series':'PY','request_id':'explicit-issue',
            'editorial_plan':plan,**extra})['conversation']['id']

    def reply(self,cid,text='生成本期文章',mode='draft',**extra):
        def generate(_router,request,**_kwargs):
            self.seen.append(request)
            data={'reply':'初稿待审阅','title':'模型自行改过的标题','body':'# 模型自行改过的标题\n\n真实候选正文。\n\n```python\n# 示例注释保留\nprint(1)\n```\n','prompts':[]}
            return LLMResponse(json.dumps(data,ensure_ascii=False),data=data)
        with patch.object(RoleRouter,'generate',generate):
            self.service.call('chat.send',{'conversation_id':cid,'account_id':'ice-loop','mode':mode,'text':text,**extra})
            for _ in range(200):
                result=self.service.call('chat.get',{'conversation_id':cid,'account_id':'ice-loop'})
                if not any(m['status']=='streaming' for m in result['messages']):
                    self.assertNotEqual(result['messages'][-1]['status'],'failed',result['messages'][-1])
                    return result
                time.sleep(.02)
        self.fail('creative request did not finish')

    def test_confirmed_issue_survives_later_progress_and_locks_initial_title(self):
        self.service.call('history.progress',{'series':'PY','episode':10})
        cid=self.create(self.confirm())
        self.service.call('history.progress',{'series':'PY','episode':70})
        result=self.reply(cid)
        req=self.seen[-1]
        self.assertEqual(req.context['history']['reference_episode'],11)
        self.assertEqual(req.context['confirmed_editorial']['fields']['topic'],'我确认的本期标题')
        candidate=result['candidates'][0]
        self.assertEqual(candidate['title'],'我确认的本期标题')
        self.assertTrue(candidate['body'].startswith('# 我确认的本期标题\n'))
        self.assertIn('# 示例注释保留',candidate['body'])
        self.assertEqual(candidate['base']['episode'],11)
        saved=self.service.call('chat.save_draft',{'candidate_id':candidate['id'],'content_hash':candidate['content_hash']})
        self.assertEqual(saved['draft']['title'],'我确认的本期标题')
        draft=self.service.call('chat.drafts',{})[0]
        self.assertEqual(draft['episode'],11)
        self.assertEqual(self.service.call('jobs.list'),[])

    def test_same_request_is_idempotent_and_cannot_be_reused_for_another_plan(self):
        plan=self.confirm()
        cid=self.create(plan)
        self.assertEqual(self.create(plan),cid)
        self.service.call('history.progress',{'series':'PY','episode':90})
        self.assertEqual(self.create(plan),cid)  # acknowledged retries keep their identity
        with self.assertRaisesRegex(ValueError,'创建请求已用于'):
            self.create(self.confirm(episode=91))
        self.assertEqual(len(self.service.call('chat.list')),1)

    def test_stale_history_or_plan_confirmation_is_refused_before_creation(self):
        plan=self.confirm()
        self.service.call('history.progress',{'series':'PY','episode':10})
        with self.assertRaisesRegex(ValueError,'历史或发布进度'):
            self.create(plan)
        self.assertEqual(self.service.call('chat.list'),[])
        plan=self.confirm()
        with self.assertRaisesRegex(ValueError,'确认已变化'):
            self.create({**plan,'confirmation_hash':'changed'})
        with self.assertRaisesRegex(ValueError,'栏目与会话'):
            self.create(plan,series='JV')

    def test_old_conversations_without_selection_keep_automatic_next_issue(self):
        self.service.call('history.progress',{'series':'PY','episode':12})
        cid=self.service.call('chat.create',{'series':'PY'})['conversation']['id']
        result=self.reply(cid)
        self.assertEqual(result['candidates'][0]['base']['episode'],13)
        self.assertEqual(result['candidates'][0]['title'],'模型自行改过的标题')

    def test_outline_mutation_between_confirmation_and_creation_is_refused(self):
        text='## PY\n### 第011期：大纲原题\n内容要点：前文衔接。'
        preview=self.service.call('outlines.preview',{'text':text})
        self.service.call('outlines.save',{'text':text,'rows':preview['rows'],'source_name':preview['source_name'],
            'base_hash':preview['base_hash'],'preview_hash':preview['preview_hash']})
        row=self.service.call('outlines.match',{'series':'PY','episode':11})['topic']
        plan=self.confirm(mode='outline',title='我修改后的大纲标题',outline_topic_id=row['topic_id'],outline_topic_hash=row['content_hash'])
        self.service.call('outlines.update',{**row,'title':'大纲在别处更新'})
        with self.assertRaisesRegex(ValueError,'大纲题目已变化'):
            self.create(plan)
        self.assertEqual(self.service.call('chat.list'),[])

    def test_second_turn_uses_prior_candidate_without_identity_conflict(self):
        cid=self.create(self.confirm())
        result=self.reply(cid)
        next_result=self.reply(cid,mode='edit',candidate_id=result['candidates'][0]['id'])
        self.assertEqual(len(next_result['candidates']),2)
        self.assertTrue(all(c['base']['episode']==11 for c in next_result['candidates']))

    def test_progress_cas_and_stale_account_cannot_overwrite_current_publication(self):
        context=self.context()
        self.service.call('history.progress',{'account_id':'ice-loop','series':'PY','episode':5,'context_hash':context['context_hash']})
        with self.assertRaisesRegex(ValueError,'别处变化'):
            self.service.call('history.progress',{'account_id':'ice-loop','series':'PY','episode':1,'context_hash':context['context_hash']})
        with self.assertRaisesRegex(ValueError,'公众号已切换'):
            self.service.call('history.progress',{'account_id':'foreign','series':'PY','episode':1})
        self.assertEqual(self.context()['last_published_episode'],5)

    def test_explicit_issue_has_five_preceding_full_bodies_and_all_titles(self):
        store=Store(self.service.runtime/'app.db')
        try:
            for issue in range(1,71):
                store.conn.execute('INSERT INTO publication_history VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    (new_id('history'),'ice-loop',f'fixture:{issue}','PY',issue,f'完整历史标题{issue}',f'# 第{issue}篇\n完整正文尾部{issue}',
                     'published','2026-10-01',1,now_iso()))
            store.conn.commit()
        finally:store.close()
        cid=self.create(self.confirm())
        self.reply(cid)
        history=self.seen[-1].context['history']
        self.assertEqual([r['episode'] for r in history['history']],[10,9,8,7,6])
        self.assertEqual(len(history['known_titles']),70)
        self.assertIn('完整正文尾部10',history['history'][0]['body_excerpt'])

    def test_late_read_and_write_requests_for_another_account_are_rejected(self):
        for method in ('history.list','history.get','history.update','history.progress'):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError,'公众号已切换'):
                self.service.call(method,{'account_id':'another-account','series':'PY','episode':3})

    def test_manual_title_cannot_inject_additional_markdown_headings(self):
        for title in ('标题\n# 另一个标题','标题\r另一个标题','标题\x00空字符'):
            with self.subTest(title=repr(title)), self.assertRaisesRegex(ValueError,'单行文字'):
                self.confirm(title=title)
        self.assertEqual(self.service.call('chat.list'),[])
