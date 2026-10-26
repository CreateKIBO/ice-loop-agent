import json
import threading
import time
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.router import LLMResponse, RoleRouter
from tests import REPO, temp_dir


class CreativeChatTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir('chat-v13-')
        self.service = DesktopService(REPO, self.root)
        self.library = self.root / 'library'
        self.library.mkdir()
        self.account = self.service.call('bootstrap')['account']
        self.service.call('accounts.save', {'account': {**self.account, 'library_root': str(self.library)}})

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def call(self, method, **params):
        return self.service.call('chat.' + method, params)

    def wait(self, cid):
        for _ in range(200):
            value = self.call('get', conversation_id=cid)
            if not any(m['status'] == 'streaming' for m in value['messages']):
                return value
            time.sleep(.02)
        self.fail('reply did not finish')

    def generate(self, cid, **extra):
        data = {'reply': '已修改开头', 'title': '新的标题', 'body': '# 新的标题\n\n新开头。\n\n## 写在最后\n待核验。', 'prompts': ['Use case: editorial cover; 16:9; blue and warm white.']}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data, model_id='test')):
            self.call('send', conversation_id=cid, text='修改开头', mode='edit', **extra)
            return self.wait(cid)

    def test_real_router_preflight_receipt_persists_in_completed_message(self):
        from ice_agent.llm.capabilities import preset_profile
        from ice_agent.llm.transport import OpenAIChatTransport, ChatResult
        profile=preset_profile('bigmodel',profile_id='chat-count-fixture')
        profile.update(api_key_env='ICE_CHAT_COUNT_FAKE',status='verified')
        profile['extra']={'max_output_tokens':20,'context_window_override':{
            'base_url':profile['base_url'],'model_id':profile['model_id'],'context_window':100}}
        self.service.settings['profiles']={'bigmodel':profile}
        for route in self.service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
        cid=self.call('create')['conversation']['id']
        with patch.dict('os.environ',{'ICE_CHAT_COUNT_FAKE':'test-fake-only'}), \
             patch.object(OpenAIChatTransport,'count_tokens',return_value=10), \
             patch.object(OpenAIChatTransport,'chat',return_value=ChatResult(content='完整讨论回复',finish_reason='stop')):
            self.call('send',conversation_id=cid,text='讨论观点')
            message=self.wait(cid)['messages'][-1]
        self.assertEqual(message['status'],'completed')
        self.assertEqual(message['metadata']['input_preflight']['state'],'checked')
        self.assertEqual(message['metadata']['input_preflight']['input_tokens'],10)

    def test_token_overflow_keeps_blocked_receipt_and_never_calls_chat(self):
        from ice_agent.llm.capabilities import preset_profile
        from ice_agent.llm.transport import OpenAIChatTransport
        profile=preset_profile('bigmodel',profile_id='chat-overflow-fixture')
        profile.update(api_key_env='ICE_CHAT_COUNT_FAKE',status='verified')
        profile['extra']={'max_output_tokens':20,'context_window_override':{
            'base_url':profile['base_url'],'model_id':profile['model_id'],'context_window':100}}
        self.service.settings['profiles']={'bigmodel':profile}
        for route in self.service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
        cid=self.call('create')['conversation']['id']
        with patch.dict('os.environ',{'ICE_CHAT_COUNT_FAKE':'test-fake-only'}), \
             patch.object(OpenAIChatTransport,'count_tokens',return_value=95), \
             patch.object(OpenAIChatTransport,'chat') as chat:
            self.call('send',conversation_id=cid,text='讨论观点')
            message=self.wait(cid)['messages'][-1]
        self.assertEqual(message['status'],'failed')
        self.assertEqual(message['metadata']['input_preflight']['state'],'blocked')
        self.assertEqual(message['metadata']['input_preflight']['input_tokens'],95)
        chat.assert_not_called()

    def test_discussion_persists_without_article_and_restart(self):
        cid = self.call('create')['conversation']['id']
        before = self.service.call('drafts.list')
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('这里可以讨论观点。')):
            self.call('send', conversation_id=cid, text='讨论一个观点')
            value = self.wait(cid)
        self.assertFalse(value['candidates'])
        self.assertEqual(self.service.call('drafts.list'), before)
        self.assertEqual(self.service.call('jobs.list'), [])
        self.service.close()
        self.service = DesktopService(REPO, self.root)
        self.assertIn('观点', self.call('get', conversation_id=cid)['messages'][-1]['content'])

    def test_nested_library_recent_five_and_all_titles(self):
        for issue in range(1, 13):
            folder = self.library / 'PY' / f'{issue:03d}-title'
            folder.mkdir(parents=True)
            (folder / '01-公众号正文.md').write_text(f'# 标题{issue}\n\n正文{issue}', encoding='utf-8')
        self.assertEqual(len(self.service.call('library.list')), 12)
        self.assertIn('正文12', self.service.call('library.read', {'folder':'PY/012-title'})['body'])
        self.service.call('history.progress', {'series':'PY','episode':12})
        cid = self.call('create', series='PY')['conversation']['id']
        seen = []
        def generate(router, req, **kwargs):
            seen.append(req)
            return LLMResponse('ready')
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, text='下一期题目')
            self.wait(cid)
        self.assertEqual(len(seen[0].context['history']['history']), 5)
        self.assertEqual(len(seen[0].context['history']['known_titles']), 12)
        self.assertEqual(seen[0].context['history']['next_episode'], 13)
        with self.assertRaises(ValueError):
            self.service.call('library.read', {'folder':'../other'})

    def test_submit_and_approve_are_idempotent_and_source_untouched(self):
        folder = self.library / 'PY' / '001-source'; folder.mkdir(parents=True)
        file = folder / '01-公众号正文.md'; original = '# 原文\n\n原文内容'
        file.write_text(original, encoding='utf-8')
        source = self.call('sources')[0]
        cid = self.call('create', target={'type':'history','id':source['id']})['conversation']['id']
        c = self.generate(cid)['candidates'][0]
        pending = self.call('submit', candidate_id=c['id'], content_hash=c['content_hash'])
        self.assertEqual(self.call('submit', candidate_id=c['id'], content_hash=c['content_hash'])['status'], 'pending')
        self.assertEqual(self.service.call('drafts.list'), [])
        accepted = self.call('review', candidate_id=c['id'], content_hash=pending['content_hash'], decision='accepted', body='# 手工修改\n\n审阅时改稿', title='手工修改')
        self.call('review', candidate_id=c['id'], decision='accepted')
        self.assertEqual(len(self.service.call('drafts.list')), 1)
        self.assertEqual(file.read_text(encoding='utf-8'), original)
        self.assertEqual(self.call('get', conversation_id=cid)['current']['body'], '# 手工修改\n\n审阅时改稿')
        self.assertEqual(accepted['review']['target']['type'], 'draft')

    def test_draft_conflict_before_submit_and_before_approval(self):
        d = self.service.call('drafts.save', {'title':'旧稿','body':'# 旧稿\n正文'})
        cid = self.call('create', target={'type':'draft','id':d['draft_id']})['conversation']['id']
        c = self.generate(cid)['candidates'][0]
        self.service.call('drafts.save', {**d,'body':'# 人工修改\n新版本'})
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.call('submit', candidate_id=c['id'], content_hash=c['content_hash'])
        with self.assertRaisesRegex(ValueError, '文章已更新'):
            self.call('send', conversation_id=cid, candidate_id=c['id'], text='继续改',mode='edit')
        c = self.generate(cid)['candidates'][0]
        pending = self.call('submit', candidate_id=c['id'], content_hash=c['content_hash'])
        latest = self.service.call('drafts.get', {'draft_id':d['draft_id']})
        self.service.call('drafts.save', {**latest,'body':'# 再次修改\n保留'})
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.call('review', candidate_id=c['id'],content_hash=pending['content_hash'],decision='accepted')
        self.assertEqual(self.call('reviews')[0]['status'], 'pending')

    def test_old_pending_candidate_cannot_create_duplicate_draft_after_adoption(self):
        cid = self.call('create',series='PY')['conversation']['id']
        first = self.generate(cid)['candidates'][0]
        second = self.call('candidate_save',candidate_id=first['id'],content_hash=first['content_hash'],
                           title=first['title'],body=first['body']+'\n\n另一份意见')
        first = self.call('submit',candidate_id=first['id'],content_hash=first['content_hash'])
        second = self.call('submit',candidate_id=second['id'],content_hash=second['content_hash'])
        adopted = self.call('review',candidate_id=first['id'],content_hash=first['content_hash'],decision='accepted')
        with self.assertRaisesRegex(ValueError,'冲突'):
            self.call('review',candidate_id=second['id'],content_hash=second['content_hash'],decision='accepted')
        self.assertEqual(len(self.service.call('drafts.list')),1)
        linked = self.call('create',target=adopted['review']['target'])
        self.assertEqual(linked['conversation']['series'],'PY')

    def test_stop_discards_late_reply_and_can_continue(self):
        entered, release = threading.Event(), threading.Event()
        cid = self.call('create')['conversation']['id']
        def generate(router, req, **kwargs):
            entered.set(); release.wait(10)
            return LLMResponse('late', data={'reply':'late','title':'late','body':'# late','prompts':[]})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send',conversation_id=cid,text='write',mode='edit')
            self.assertTrue(entered.wait(5))
            with self.assertRaises(ValueError):
                self.call('send', conversation_id=cid,text='double')
            self.call('stop',conversation_id=cid)
            release.set()
            time.sleep(.1)
        self.assertFalse(self.call('get',conversation_id=cid)['candidates'])
        self.assertEqual(self.call('get',conversation_id=cid)['messages'][-1]['status'],'stopped')
        self.assertEqual(len(self.generate(cid)['candidates']),1)

    def test_account_isolation_reject_feedback_and_immutable_manual_candidate(self):
        cid = self.call('create')['conversation']['id']
        c = self.generate(cid)['candidates'][0]
        manual = self.call('candidate_save', candidate_id=c['id'], content_hash=c['content_hash'],title='手动标题',body='# 手动标题\n新内容')
        value = self.call('get',conversation_id=cid)
        self.assertEqual(len(value['candidates']),2)
        self.assertEqual(value['candidates'][-1]['body'],c['body'])
        pending = self.call('submit',candidate_id=manual['id'],content_hash=manual['content_hash'])
        self.call('review',candidate_id=manual['id'],content_hash=pending['content_hash'],decision='rejected',note='观点需要依据')
        self.assertIn('依据',self.call('get',conversation_id=cid)['messages'][-1]['content'])
        self.assertEqual(self.service.call('drafts.list'),[])
        values = {**self.account,'name':'Another','preset':'general'}
        values.pop('id')
        other = self.service.call('accounts.save', {'account':values})['account']
        self.assertEqual(self.call('list',account_id=other['id']),[])
        with self.assertRaises(ValueError):
            self.call('get',conversation_id=cid,account_id=other['id'])
        with self.assertRaises(ValueError):
            self.call('submit',candidate_id=manual['id'],account_id=other['id'])

    def test_fork_keeps_original_transcript_and_is_scoped(self):
        cid = self.call('create')['conversation']['id']
        first = self.generate(cid)
        fork = self.call('fork',conversation_id=cid,message_id=first['messages'][-1]['id'])
        self.assertNotEqual(fork['conversation']['id'],cid)
        self.assertEqual(len(fork['messages']),len(first['messages']))
        self.assertEqual(fork['candidates'][0]['body'],first['candidates'][0]['body'])
        self.assertNotEqual(fork['candidates'][0]['id'],first['candidates'][0]['id'])
        self.assertEqual(len(self.call('get',conversation_id=cid)['messages']),2)
        with self.assertRaises(ValueError):
            self.call('fork',conversation_id=cid,message_id='other-message')

    def test_assets_handoff_keeps_adopted_body_prompts_and_is_idempotent(self):
        cid = self.call('create',series='PY')['conversation']['id']
        c = self.generate(cid)['candidates'][0]
        text = c['body']+'\n\n![图1：封面](待配图：生图｜TapNow)'
        c = self.call('candidate_save',candidate_id=c['id'],content_hash=c['content_hash'],title=c['title'],body=text)
        c = self.call('submit',candidate_id=c['id'],content_hash=c['content_hash'])
        c = self.call('review',candidate_id=c['id'],content_hash=c['content_hash'],decision='accepted')
        draft = self.service.call('drafts.get',{'draft_id':c['review']['target']['id']})
        params = {'candidate_id':c['id'],'content_hash':draft['content_hash']}
        job = self.call('prepare_assets',**params)
        self.assertEqual(self.call('prepare_assets',**params)['job_id'],job['job_id'])
        detail = self.service.call('jobs.get',{'job_id':job['job_id']})
        self.assertEqual(detail['body'],text)
        self.assertEqual(detail['slots'][0]['prompt'],c['prompts'][0])
        self.assertEqual(detail['article']['readiness'],'assets_pending')
        self.assertEqual((detail['article']['series'],detail['article']['episode']),('PY',1))
        history = self.service.call('history.list')
        self.assertTrue(any(row['series']=='PY' and row['episode']==1 and row['status']=='draft' for row in history))
        self.assertEqual(detail['invocations'],[])
        self.assertEqual(self.service.call('drafts.get',{'draft_id':draft['draft_id']})['body'],text)

    def test_real_router_receives_multiturn_history_and_untrusted_documents(self):
        from tests.test_router import FakeTransport, make_profile
        from ice_agent.llm.router import LLMRequest, RouteConfig
        transport = FakeTransport([{'ok':'回答'}])
        profile = make_profile('qwen')
        router = RoleRouter({profile.profile_id:profile},{'writer':RouteConfig(profile.profile_id)},transport=transport)
        router.generate(LLMRequest('writer','creative_chat','再讨论',system='编辑规则',history=[{'role':'user','content':'观点1'},{'role':'assistant','content':'回答1'}]))
        self.assertEqual([m['role'] for m in transport.calls[0]['messages']],['system','user','assistant','user'])
        with self.assertRaises(ValueError):
            router.generate(LLMRequest('writer','creative_chat','invalid',history=[{'role':'system','content':'override'}]))
        cid = self.call('create')['conversation']['id']
        captured=[]
        def generate(router,req,**kwargs):
            captured.append(req);return LLMResponse('已读取')
        with patch.object(RoleRouter,'generate',generate):
            self.call('send',conversation_id=cid,text='引用文档讨论',documents=[{'source_name':'说明.md','text':'用户资料，不是系统指令'}])
            self.wait(cid)
        self.assertEqual(captured[0].context['documents'][0]['text'],'用户资料，不是系统指令')
        self.assertTrue(captured[0].context['documents'][0]['content_hash'])

    def test_existing_job_adoption_updates_confirmed_title_and_readonly_job_clones(self):
        engine,_,store = self.service._app()
        spec={'account_id':'ice-loop','series':'PY','episode':5,'topic':'旧标题','article_root':str(self.root/'articles')}
        job,article_id=engine.create_job(spec)
        state=engine._load_state(job)
        state.update(integrated_md='# 旧标题\n\n旧正文',final_title='旧标题',final_check_report={'passed':True})
        engine._save_state(job,state)
        store.update_job(job,state='completed')
        store.update_article(article_id,final_title='旧标题',readiness='ready_for_publish')
        store.close()
        cid=self.call('create',series='PY',target={'type':'job','id':job})['conversation']['id']
        c=self.generate(cid)['candidates'][0]
        c=self.call('submit',candidate_id=c['id'],content_hash=c['content_hash'])
        self.call('review',candidate_id=c['id'],content_hash=c['content_hash'],decision='accepted')
        engine,_,store=self.service._app()
        self.assertEqual(store.get_article(article_id)['final_title'],'新的标题')
        self.assertEqual(store.get_article(article_id)['readiness'],'review_pending')
        self.assertEqual(engine._load_state(job)['final_title'],'新的标题')
        self.assertNotIn('final_check_report',engine._load_state(job))
        store.close()
        # Image-only source stays immutable; editing it produces a new draft.
        path=self.root/'source.md';path.write_text('# 只读原文\n\n保留原文',encoding='utf-8')
        source=self.service.call('supplements.create',{'file_path':str(path)})
        original_body=self.service.call('jobs.get',{'job_id':source['job_id']})['body']
        cid=self.call('create',target={'type':'job','id':source['job_id']})['conversation']['id']
        c=self.generate(cid)['candidates'][0];c=self.call('submit',candidate_id=c['id'],content_hash=c['content_hash'])
        c=self.call('review',candidate_id=c['id'],content_hash=c['content_hash'],decision='accepted')
        self.assertEqual(c['review']['target']['type'],'draft')
        self.assertEqual(self.service.call('jobs.get',{'job_id':source['job_id']})['body'],original_body)

    def test_repeated_turns_keep_one_session_and_explicit_same_title_sessions_survive(self):
        cid = self.call('create', title='相同标题', request_id='create-first')['conversation']['id']
        again = self.call('create', title='相同标题', request_id='create-first')
        self.assertTrue(again['reused'])
        self.assertEqual(again['conversation']['id'], cid)
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('继续讨论')):
            for text in ('观点一', '观点二', '再修改观点'):
                self.call('send', conversation_id=cid, text=text)
                self.wait(cid)
        self.assertEqual(len(self.call('list')), 1)
        self.assertEqual(len(self.call('get', conversation_id=cid)['messages']), 6)
        other = self.call('create', title='相同标题', request_id='create-second')['conversation']['id']
        self.assertNotEqual(cid, other)
        self.assertEqual(len(self.call('list')), 2)
        with self.assertRaisesRegex(ValueError, '创建请求'):
            self.call('create', title='其他内容', request_id='create-first')

    def test_article_entry_reuses_active_target_without_merging_titles_or_archives(self):
        first = self.service.call('drafts.save', {'title': '同名草稿', 'body': '# 同名草稿\n甲'})
        second = self.service.call('drafts.save', {'title': '同名草稿', 'body': '# 同名草稿\n乙'})
        a = self.call('create', target={'type': 'draft', 'id': first['draft_id']}, reuse_target=True)
        b = self.call('create', target={'type': 'draft', 'id': first['draft_id']}, reuse_target=True)
        c = self.call('create', target={'type': 'draft', 'id': second['draft_id']}, reuse_target=True)
        self.assertEqual(a['conversation']['id'], b['conversation']['id'])
        self.assertTrue(b['reused'])
        self.assertNotEqual(a['conversation']['id'], c['conversation']['id'])
        self.call('update', conversation_id=a['conversation']['id'], archived=True)
        fresh = self.call('create', target={'type': 'draft', 'id': first['draft_id']}, reuse_target=True)
        self.assertNotEqual(fresh['conversation']['id'], a['conversation']['id'])
        # Empty-target conversations remain deliberately separate.
        x = self.call('create', title='普通讨论', reuse_target=True)
        y = self.call('create', title='普通讨论', reuse_target=True)
        self.assertNotEqual(x['conversation']['id'], y['conversation']['id'])

    def test_draft_generation_saves_only_on_confirmation_and_approval_updates_one_draft(self):
        cid = self.call('create', series='PY')['conversation']['id']
        data = {'reply': '初稿已完成，请审阅后决定是否保存', 'title': '初稿',
                'body': '# 初稿\n\n初稿正文。', 'prompts': [], 'questions': []}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data)):
            self.call('send', conversation_id=cid, text='将讨论整理为初稿', mode='draft')
            value = self.wait(cid)
        candidate = value['candidates'][0]
        self.assertEqual(self.service.call('drafts.list'), [])
        self.assertEqual(self.call('drafts'), [])
        saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        repeated = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        self.assertTrue(saved['created'])
        self.assertFalse(repeated['created'])
        self.assertEqual(saved['draft']['draft_id'], repeated['draft']['draft_id'])
        self.assertEqual(saved['candidate']['status'], 'draft')
        self.assertEqual(saved['candidate']['content_hash'], candidate['content_hash'])
        self.assertEqual(saved['candidate']['base'], candidate['base'])
        sidebar = self.call('drafts')[0]
        self.assertEqual((sidebar['status'], sidebar['conversation_id'], sidebar['series'], sidebar['episode']),
                         ('unapproved', cid, 'PY', 1))
        self.assertEqual(self.service.call('jobs.list'), [])
        self.assertEqual(self.call('reviews'), [])
        pending = self.call('submit', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        approved = self.call('review', candidate_id=candidate['id'], content_hash=pending['content_hash'],
                             decision='accepted', title='审阅后的标题', body='# 审阅后的标题\n\n确认正文')
        self.assertEqual(len(self.service.call('drafts.list')), 1)
        self.assertEqual(approved['review']['target']['id'], saved['draft']['draft_id'])
        self.assertEqual(self.call('get', conversation_id=cid)['current']['body'], '# 审阅后的标题\n\n确认正文')
        self.assertEqual(self.call('drafts')[0]['status'], 'accepted')
        self.assertEqual(self.service.call('jobs.list'), [])

    def test_saved_candidate_continues_from_current_draft_and_external_edits_are_protected(self):
        original = self.service.call('drafts.save', {'title': '旧稿', 'body': '# 旧稿\n\n保留旧稿'})
        cid = self.call('create', target={'type': 'draft', 'id': original['draft_id']})['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        with self.assertRaisesRegex(ValueError, '候选已变化'):
            self.call('save_draft', candidate_id=candidate['id'], content_hash='stale')
        self.assertEqual(self.service.call('drafts.get', {'draft_id': original['draft_id']})['body'], original['body'])
        sibling = self.call('candidate_save', candidate_id=candidate['id'], content_hash=candidate['content_hash'],
                            title=candidate['title'], body=candidate['body'] + '\n\n另一份意见')
        saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        self.assertEqual(saved['draft']['draft_id'], original['draft_id'])
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.call('submit', candidate_id=sibling['id'], content_hash=sibling['content_hash'])
        manual = self.call('candidate_save', candidate_id=candidate['id'], content_hash=candidate['content_hash'],
                           title=candidate['title'], body=candidate['body'] + '\n\n保存后继续修改')
        self.assertEqual(manual['base']['content_hash'], saved['draft']['content_hash'])
        next_version = self.generate(cid, candidate_id=candidate['id'])['candidates'][0]
        self.assertEqual(next_version['base']['id'], original['draft_id'])
        self.service.call('drafts.save', {**saved['draft'], 'body': '# 用户自行修改\n\n新内容'})
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.call('save_draft', candidate_id=manual['id'], content_hash=manual['content_hash'])
        self.assertTrue(self.call('get', conversation_id=cid)['candidates'][-1]['saved_draft']['changed'])
        self.assertEqual(self.service.call('drafts.get', {'draft_id': original['draft_id']})['body'], '# 用户自行修改\n\n新内容')
        self.assertEqual(len(self.service.call('drafts.list')), 1)

    def test_saving_history_candidate_keeps_original_and_drafts_are_account_scoped(self):
        folder = self.library / 'PY' / '001-source'; folder.mkdir(parents=True)
        source_file = folder / '01-公众号正文.md'
        source_file.write_text('# 原文\n\n已发布内容', encoding='utf-8')
        source = self.call('sources')[0]
        cid = self.call('create', target={'type': 'history', 'id': source['id']})['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        self.assertEqual(source_file.read_text(encoding='utf-8'), '# 原文\n\n已发布内容')
        self.assertEqual(saved['candidate']['status'], 'draft')
        pending = self.call('submit', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        accepted = self.call('review', candidate_id=candidate['id'], content_hash=pending['content_hash'],
                             decision='accepted', title='正式标题', body='# 正式标题\n\n审阅后的正文')
        self.assertEqual(accepted['review']['target']['id'], saved['draft']['draft_id'])
        self.assertEqual(len(self.service.call('drafts.list')), 1)
        self.assertEqual(source_file.read_text(encoding='utf-8'), '# 原文\n\n已发布内容')
        values = {**self.account, 'name': '其他公众号', 'preset': 'general'}; values.pop('id')
        other = self.service.call('accounts.save', {'account': values})['account']
        self.assertEqual(self.call('drafts', account_id=other['id']), [])
        with self.assertRaises(ValueError):
            self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'], account_id=other['id'])

    def test_questions_pause_without_candidate_and_answers_resume_same_session(self):
        folder = self.library / 'PY' / '001-reference'; folder.mkdir(parents=True)
        source_file = folder / '01-公众号正文.md'
        source_file.write_text('# 参考文章\n\n原参考内容', encoding='utf-8')
        source = self.call('sources')[0]
        cid = self.call('create', series='PY')['conversation']['id']
        questions = [{'id': 'audience', 'question': '这篇面向什么读者？', 'options': ['零基础', '已有基础']},
                     {'id': 'topic', 'question': '准备解决哪个问题？', 'options': []}]
        data = {'reply': '先确认两点', 'title': '', 'body': '', 'prompts': [], 'questions': questions}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data)):
            self.call('send', conversation_id=cid, text='帮我写一篇文章', mode='draft', references=[source['id']],
                      documents=[{'source_name': '需求.md', 'text': '需要保留练习和代码说明'}], selected_text='我的原始观点')
            paused = self.wait(cid)
        assistant = paused['messages'][-1]
        self.assertEqual(assistant['metadata']['progress']['phase'], 'awaiting_input')
        self.assertEqual(assistant['metadata']['questions'], questions)
        self.assertIn('准备解决哪个问题', assistant['content'])
        self.assertFalse(paused['candidates'])
        self.assertEqual(self.call('drafts'), [])
        # Reopening the application must not discard the request's documents.
        self.service.workers.shutdown(wait=True)
        self.service.close()
        self.service = DesktopService(REPO, self.root)
        source_file.write_text('# 参考文章\n\n用户后来修改的参考内容', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '全部问题'):
            self.call('send', conversation_id=cid, clarification_message_id=assistant['id'],
                      clarification_answers={'audience': '零基础'})
        other = self.call('create')['conversation']['id']
        with self.assertRaisesRegex(ValueError, '问题不存在'):
            self.call('send', conversation_id=other, clarification_message_id=assistant['id'],
                      clarification_answers={'audience': '零基础', 'topic': '循环'})
        captured = []
        def generate(router, req, **kwargs):
            captured.append(req)
            return LLMResponse('reply', data={'reply': '初稿完成', 'title': '循环', 'body': '# 循环\n\n介绍循环', 'prompts': [], 'questions': []})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, clarification_message_id=assistant['id'],
                      clarification_answers={'audience': '零基础', 'topic': 'for 和 while'}, references=[], documents=[], selected_text='')
            resumed = self.wait(cid)
        self.assertEqual(captured[0].context['mode'], 'draft')
        self.assertEqual(captured[0].context['clarification']['answers']['topic'], 'for 和 while')
        self.assertEqual(captured[0].context['clarification']['original_request'], '帮我写一篇文章')
        self.assertEqual(captured[0].context['documents'][0]['text'], '需要保留练习和代码说明')
        self.assertEqual(captured[0].context['selected_text'], '我的原始观点')
        self.assertIn('用户后来修改', captured[0].context['references'][0]['body'])
        self.assertTrue(captured[0].context['clarification']['context_changes'])
        self.assertTrue(resumed['messages'][1]['metadata']['answered_at'])
        self.assertEqual(len(resumed['candidates']), 1)
        self.assertEqual(len(self.call('list')), 2)
        self.assertEqual(self.call('drafts'), [])

    def test_freeform_answers_keep_pending_questions_and_mode_in_context(self):
        cid = self.call('create')['conversation']['id']
        data = {'reply': '需要确认', 'title': '', 'body': '', 'prompts': [],
                'questions': [{'id': 'reader', 'question': '面向什么读者？', 'options': ['零基础', '进阶']}]}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data)):
            self.call('send', conversation_id=cid, text='请写初稿', mode='draft'); self.wait(cid)
        captured = []
        def generate(router, req, **kwargs):
            captured.append(req)
            return LLMResponse('reply', data={'reply': '完成', 'title': '入门', 'body': '# 入门\n\n正文', 'prompts': []})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, text='给零基础在校学生写，讲变量')
            value = self.wait(cid)
        self.assertEqual(captured[0].context['mode'], 'draft')
        self.assertIn('零基础在校学生', captured[0].context['clarification']['freeform_answer'])
        self.assertEqual(captured[0].context['clarification']['questions'][0]['id'], 'reader')
        self.assertEqual(value['messages'][1]['metadata']['clarification_status'], 'answered')
        self.assertEqual(len(value['candidates']), 1)

    def test_progress_records_real_wait_receive_validate_and_stop(self):
        cid = self.call('create')['conversation']['id']
        waiting, streamed, release = threading.Event(), threading.Event(), threading.Event()
        def generate(router, req, **kwargs):
            waiting.set()
            self.assertTrue(streamed.wait(10))
            router.on_delta(req.node, '真实收到的片段')
            release.wait(10)
            return LLMResponse('完成')
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, text='讨论')
            self.assertTrue(waiting.wait(5))
            initial = self.call('get', conversation_id=cid)['messages'][-1]
            self.assertEqual(initial['metadata']['progress']['phase'], 'waiting_model')
            streamed.set()
            for _ in range(100):
                message = self.call('get', conversation_id=cid)['messages'][-1]
                if message['metadata']['progress']['phase'] == 'receiving':
                    break
                time.sleep(.02)
            self.assertEqual(message['metadata']['progress']['received_chars'], len('真实收到的片段'))
            self.call('stop', conversation_id=cid)
            release.set()
            stopped = self.wait(cid)['messages'][-1]
        self.assertEqual(stopped['status'], 'stopped')
        self.assertEqual(stopped['metadata']['progress']['phase'], 'stopped')
        self.assertFalse(self.call('get', conversation_id=cid)['candidates'])
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('完成')):
            self.call('send', conversation_id=cid, text='继续讨论')
            complete = self.wait(cid)['messages'][-1]
        phases = [item['phase'] for item in complete['metadata']['progress']['transitions']]
        self.assertEqual(phases, ['reading_context', 'queued', 'waiting_model', 'validating', 'ready'])

    def test_invalid_question_structure_fails_without_candidate_or_draft(self):
        cid = self.call('create')['conversation']['id']
        data = {'reply': '问题', 'title': '', 'body': '', 'prompts': [],
                'questions': [{'id': 'reader', 'question': '读者？', 'options': []},
                              {'id': 'reader', 'question': '重复标识？', 'options': []}]}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data)):
            self.call('send', conversation_id=cid, text='初稿', mode='draft')
            value = self.wait(cid)
        self.assertEqual(value['messages'][-1]['status'], 'failed')
        self.assertEqual(value['messages'][-1]['metadata']['progress']['phase'], 'failed')
        self.assertEqual(value['candidates'], [])
        self.assertEqual(self.call('drafts'), [])

    def test_second_clarification_keeps_first_answers_in_transcript_and_snapshot(self):
        cid = self.call('create')['conversation']['id']
        first = {'reply': '确认读者', 'title': '', 'body': '', 'prompts': [],
                 'questions': [{'id': 'reader', 'question': '读者是谁？', 'options': ['零基础', '进阶']}]}
        second = {'reply': '还需确认主题', 'title': '', 'body': '', 'prompts': [],
                  'questions': [{'id': 'topic', 'question': '写哪个主题？', 'options': []}]}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=first)):
            self.call('send', conversation_id=cid, text='写一篇初稿', mode='draft')
            first_message = self.wait(cid)['messages'][-1]
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=second)):
            self.call('send', conversation_id=cid, text='已填写以上问题', clarification_message_id=first_message['id'],
                      clarification_answers={'reader': '零基础在校学生'})
            pending = self.wait(cid)
        self.assertIn('零基础在校学生', pending['messages'][-2]['content'])
        second_message = pending['messages'][-1]
        self.assertEqual(second_message['metadata']['context_snapshot']['original_request'], '写一篇初稿')
        self.assertEqual(second_message['metadata']['context_snapshot']['answers_so_far'][0]['answer'], '零基础在校学生')
        captured = []
        def generate(router, req, **kwargs):
            captured.append(req)
            return LLMResponse('reply', data={'reply': '完成', 'title': '变量', 'body': '# 变量\n\n变量介绍', 'prompts': []})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, text='继续', clarification_message_id=second_message['id'],
                      clarification_answers={'topic': '变量与数据类型'})
            complete = self.wait(cid)
        self.assertTrue(any('零基础在校学生' in message['content'] for message in captured[0].history))
        self.assertEqual(captured[0].context['clarification']['previous_answers'][0]['answer'], '零基础在校学生')
        self.assertIn('变量与数据类型', captured[0].prompt)
        self.assertEqual(len(complete['candidates']), 1)
        self.assertEqual(len(self.call('list')), 1)

    def test_clarification_failed_retry_restores_answers_and_documents_after_reopen(self):
        cid = self.call('create')['conversation']['id']
        questions = {'reply': '先确认', 'title': '', 'body': '', 'prompts': [],
                     'questions': [{'id': 'reader', 'question': '面向什么读者？', 'options': []}]}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=questions)):
            self.call('send', conversation_id=cid, text='写Python初稿', mode='draft', selected_text='记得解释报错',
                      documents=[{'source_name': '要求.md', 'text': '正文需要练习'}])
            question = self.wait(cid)['messages'][-1]
        with patch.object(RoleRouter, 'generate', side_effect=RuntimeError('网络暂时不可用')):
            self.call('send', conversation_id=cid, text='确认', clarification_message_id=question['id'],
                      clarification_answers={'reader': '零基础学生'})
            failed = self.wait(cid)['messages'][-1]
        self.assertEqual(failed['status'], 'failed')
        self.assertTrue(self.call('get', conversation_id=cid)['messages'][1]['metadata']['answered_at'])
        self.service.workers.shutdown(wait=True); self.service.close()
        self.service = DesktopService(REPO, self.root)
        captured = []
        def generate(router, req, **kwargs):
            captured.append(req)
            return LLMResponse('reply', data={'reply': '完成', 'title': '变量', 'body': '# 变量\n\n正文', 'prompts': []})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, retry_message_id=failed['id'], references=[], documents=[], selected_text='')
            self.wait(cid)
        request = captured[0]
        self.assertEqual(request.context['mode'], 'draft')
        self.assertEqual(request.context['documents'][0]['text'], '正文需要练习')
        self.assertEqual(request.context['selected_text'], '记得解释报错')
        self.assertEqual(request.context['clarification']['answers']['reader'], '零基础学生')
        self.assertEqual(request.context['clarification']['original_request'], '写Python初稿')
        self.assertIn('零基础学生', request.prompt)
        other = self.call('create')['conversation']['id']
        with self.assertRaisesRegex(ValueError, '只能重试'):
            self.call('send', conversation_id=other, text='重试', retry_message_id=failed['id'])

    def test_fork_clarification_remaps_candidate_and_answers_only_new_session(self):
        cid = self.call('create')['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        questions = {'reply': '需要确认风格', 'title': '', 'body': '', 'prompts': [],
                     'questions': [{'id': 'tone', 'question': '希望什么语气？', 'options': ['轻松', '冷静']}]}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=questions)):
            self.call('send', conversation_id=cid, candidate_id=candidate['id'], text='修改文章', mode='edit')
            original = self.wait(cid)
        fork = self.call('fork', conversation_id=cid, message_id=original['messages'][-1]['id'])
        fork_cid = fork['conversation']['id']
        clone = fork['candidates'][0]
        question = fork['messages'][-1]
        self.assertNotEqual(clone['id'], candidate['id'])
        self.assertEqual(question['metadata']['prior_candidate_id'], clone['id'])
        self.assertEqual(question['metadata']['context_snapshot']['candidate_id'], clone['id'])
        self.assertEqual(question['metadata']['request_snapshot']['candidate_id'], clone['id'])
        data = {'reply': '完成', 'title': '新的标题', 'body': '# 新的标题\n\n修改后的正文', 'prompts': []}
        with patch.object(RoleRouter, 'generate', return_value=LLMResponse('reply', data=data)):
            self.call('send', conversation_id=fork_cid, clarification_message_id=question['id'],
                      clarification_answers={'tone': '冷静'})
            modified = self.wait(fork_cid)
        self.assertEqual(len(modified['candidates']), 2)
        self.assertEqual(len(self.call('get', conversation_id=cid)['candidates']), 1)
        self.assertFalse(self.call('get', conversation_id=cid)['messages'][-1]['metadata'].get('answered_at'))

    def test_fork_saved_candidate_uses_saved_base_and_does_not_duplicate_draft(self):
        cid = self.call('create', title='话题 · 分支 · 分支')['conversation']['id']
        initial = self.generate(cid)
        candidate = initial['candidates'][0]
        saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        fork = self.call('fork', conversation_id=cid, message_id=initial['messages'][-1]['id'])
        clone = fork['candidates'][0]
        self.assertEqual(fork['conversation']['title'], '话题 · 新方向')
        self.assertEqual(clone['base']['id'], saved['draft']['draft_id'])
        self.assertEqual(clone['base']['content_hash'], saved['draft']['content_hash'])
        self.assertNotIn('saved_draft', clone)
        self.assertEqual(len(self.service.call('drafts.list')), 1)
        updated = self.generate(fork['conversation']['id'], candidate_id=clone['id'])
        self.assertEqual(len(updated['candidates']), 2)
        self.assertEqual(len(self.service.call('drafts.list')), 1)

    def test_retry_protects_changed_source_and_explicit_current_choice_can_continue(self):
        draft = self.service.call('drafts.save', {'title': '原稿', 'body': '# 原稿\n\n原始正文'})
        cid = self.call('create', target={'type': 'draft', 'id': draft['draft_id']})['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        with patch.object(RoleRouter, 'generate', side_effect=RuntimeError('临时故障')):
            self.call('send', conversation_id=cid, candidate_id=candidate['id'], text='继续改稿', mode='edit')
            failed = self.wait(cid)['messages'][-1]
        latest = self.service.call('drafts.save', {**draft, 'body': '# 原稿\n\n人工新增的重要观点'})
        with self.assertRaisesRegex(ValueError, '文章已更新'):
            self.call('send', conversation_id=cid, retry_message_id=failed['id'])
        captured = []
        def generate(router, req, **kwargs):
            captured.append(req)
            return LLMResponse('reply', data={'reply': '完成', 'title': '原稿', 'body': '# 原稿\n\n保留人工新增的重要观点', 'prompts': []})
        with patch.object(RoleRouter, 'generate', generate):
            self.call('send', conversation_id=cid, retry_message_id=failed['id'], candidate_id=None,
                      text='基于最新版原稿继续，保留人工观点')
            value = self.wait(cid)
        self.assertIsNone(captured[0].context['candidate_article'])
        self.assertEqual(captured[0].context['target_article']['body'], latest['body'])
        self.assertEqual(value['candidates'][0]['base']['content_hash'], latest['content_hash'])
        self.assertEqual(self.service.call('drafts.get', {'draft_id': draft['draft_id']})['body'], latest['body'])

    def test_v13_upgrade_backups_database_and_preserves_conversations_and_drafts(self):
        import sqlite3
        cid = self.call('create', title='升级前的会话')['conversation']['id']
        draft = self.service.call('drafts.save', {'title': '旧版草稿', 'body': '# 旧版草稿\n\n需要保留'})
        self.service.workers.shutdown(wait=True)
        engine, cfg, store = self.service._app()
        store.conn.execute('DROP TABLE creative_candidate_saves')
        store.conn.execute('DROP TABLE creative_conversation_requests')
        store.conn.commit()
        backup = store.db_path.with_name('app-before-v1.4.db')
        store.close(); self.service.close()
        self.service = DesktopService(REPO, self.root)
        self.assertTrue(backup.exists())
        with sqlite3.connect(str(backup)) as db:
            self.assertEqual(db.execute('SELECT title FROM creative_conversations WHERE id=?', (cid,)).fetchone()[0], '升级前的会话')
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='creative_candidate_saves'").fetchone())
        self.assertEqual(self.call('get', conversation_id=cid)['conversation']['title'], '升级前的会话')
        self.assertEqual(self.service.call('drafts.get', {'draft_id': draft['draft_id']})['body'], '# 旧版草稿\n\n需要保留')

    def test_conversation_delete_restore_keeps_saved_draft_and_account_isolation(self):
        cid = self.call('create', title='可恢复会话')['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        deleted = self.call('delete', conversation_id=cid)
        self.assertTrue(deleted['conversation']['deleted'])
        self.assertTrue(deleted['conversation']['deleted_at'])
        self.assertEqual(self.call('list'), [])
        self.assertEqual(self.call('list', archived=True), [])
        self.assertEqual(len(self.call('list', deleted=True)), 1)
        self.assertEqual(self.call('drafts')[0]['conversation_id'], None)
        self.assertEqual(self.service.call('drafts.get', {'draft_id': saved['draft']['draft_id']})['body'], candidate['body'])
        self.assertEqual(self.call('delete', conversation_id=cid)['conversation']['deleted_at'], deleted['conversation']['deleted_at'])
        for method, values in (('send', {'text': '继续'}), ('update', {'title': '偷偷改名'})):
            with self.assertRaisesRegex(ValueError, '回收站'):
                self.call(method, conversation_id=cid, **values)
        values = {**self.account, 'name': '另一个账号', 'preset': 'general'}; values.pop('id')
        other = self.service.call('accounts.save', {'account': values})['account']
        self.assertEqual(self.call('list', deleted=True, account_id=other['id']), [])
        with self.assertRaisesRegex(ValueError, '没有这个会话'):
            self.call('restore', conversation_id=cid, account_id=other['id'])
        self.service.call('accounts.switch', {'account_id': self.account['id']})
        restored = self.call('restore', conversation_id=cid)
        self.assertFalse(restored['conversation']['deleted'])
        self.assertEqual(len(self.call('list')), 1)
        self.assertEqual(len(self.call('get', conversation_id=cid)['messages']), 2)
        self.assertEqual(len(self.call('get', conversation_id=cid)['candidates']), 1)

    def test_archiving_or_deleting_during_generation_blocks_late_candidate(self):
        for action in ('archive', 'delete'):
            with self.subTest(action=action):
                cid = self.call('create')['conversation']['id']
                entered, release = threading.Event(), threading.Event()
                def generate(router, req, **kwargs):
                    entered.set(); release.wait(60)
                    return LLMResponse('late', data={'reply': '完成', 'title': '迟到初稿', 'body': '# 迟到初稿\n\n正文', 'prompts': []})
                with patch.object(RoleRouter, 'generate', generate):
                    self.call('send', conversation_id=cid, text='生成初稿', mode='draft')
                    # 全量回归时机器负载高，等待后台线程启动的上限放宽到 30 秒；
                    # 断言语义不变（生成必须已启动）。
                    self.assertTrue(entered.wait(30))
                    if action == 'archive':
                        self.call('update', conversation_id=cid, archived=True)
                    else:
                        self.call('delete', conversation_id=cid)
                    release.set()
                    for _ in range(100):
                        if not self.service.chat_cancel:
                            break
                        time.sleep(.02)
                value = self.call('get', conversation_id=cid)
                self.assertEqual(value['messages'][-1]['status'], 'stopped')
                self.assertFalse(value['candidates'])
                with self.assertRaises(ValueError):
                    self.call('send', conversation_id=cid, text='继续')
                if action == 'archive':
                    self.call('update', conversation_id=cid, archived=False)
                else:
                    self.call('restore', conversation_id=cid)
                self.assertFalse(self.call('get', conversation_id=cid)['conversation']['deleted'])

    def test_deleted_target_is_not_reused_and_restore_preserves_previous_archive(self):
        draft = self.service.call('drafts.save', {'title': '已有草稿', 'body': '# 已有草稿\n\n正文'})
        target = {'type': 'draft', 'id': draft['draft_id']}
        cid = self.call('create', target=target, request_id='request-1', reuse_target=True)['conversation']['id']
        self.call('update', conversation_id=cid, archived=True)
        self.call('delete', conversation_id=cid)
        other = self.call('create', target=target, reuse_target=True)['conversation']['id']
        self.assertNotEqual(other, cid)
        with self.assertRaisesRegex(ValueError, '新请求'):
            self.call('create', target=target, request_id='request-1', reuse_target=True)
        restored = self.call('restore', conversation_id=cid)
        self.assertTrue(restored['conversation']['archived'])
        self.assertFalse(restored['conversation']['deleted'])
        self.assertEqual(len(self.call('list', archived=True)), 1)
        self.assertEqual(self.call('drafts')[0]['conversation_id'], other)
        self.call('restore', conversation_id=cid, archived=False)
        self.assertEqual(len(self.call('list')), 2)

    def test_worker_bootstrap_failure_is_failed_not_permanently_streaming(self):
        cid = self.call('create')['conversation']['id']
        original = self.service._app
        def app(*args, **kwargs):
            if threading.current_thread().name.startswith('ice-job'):
                raise RuntimeError('模型服务初始化失败')
            return original(*args, **kwargs)
        with patch.object(self.service, '_app', app):
            self.call('send', conversation_id=cid, text='初稿', mode='draft')
            value = self.wait(cid)
        message = value['messages'][-1]
        self.assertEqual(message['status'], 'failed')
        self.assertEqual(message['metadata']['error_code'], 'GENERATION_FAILED')
        self.assertIn('初始化失败', message['metadata']['error_message'])
        self.assertFalse(value['candidates'])

    def test_hidden_completed_task_cannot_be_edited_or_adopted_through_chat(self):
        engine, _, store = self.service._app()
        job_id, _ = engine.create_job({'account_id': 'ice-loop', 'series': 'PY', 'episode': 5,
                                       'topic': '已有任务', 'article_root': str(self.root / 'articles')})
        state = engine._load_state(job_id)
        state.update(integrated_md='# 已有任务\n\n保留原文', final_title='已有任务')
        engine._save_state(job_id, state)
        store.update_job(job_id, state='completed')
        store.close()
        cid = self.call('create', target={'type': 'job', 'id': job_id})['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        pending = self.call('submit', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        for method in ('jobs.archive', 'jobs.delete'):
            self.service.call(method, {'job_id': job_id})
            with self.assertRaisesRegex(ValueError, '先恢复任务'):
                self.call('send', conversation_id=cid, text='改稿', mode='edit')
            with self.assertRaisesRegex(ValueError, '先恢复任务'):
                self.call('review', candidate_id=candidate['id'], content_hash=pending['content_hash'], decision='accepted')
            self.assertEqual(self.call('get', conversation_id=cid)['current']['body'], '# 已有任务\n\n保留原文')
            self.assertEqual(self.call('reviews')[0]['status'], 'pending')
            self.service.call('jobs.restore', {'job_id': job_id})

    def test_hidden_asset_handoff_requires_restore_then_reuses_same_job(self):
        cid = self.call('create', series='PY')['conversation']['id']
        candidate = self.generate(cid)['candidates'][0]
        candidate = self.call('candidate_save', candidate_id=candidate['id'], content_hash=candidate['content_hash'],
                              title=candidate['title'], body=candidate['body']+'\n\n![图1：封面](待配图：生图｜TapNow)')
        pending = self.call('submit', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
        accepted = self.call('review', candidate_id=candidate['id'], content_hash=pending['content_hash'], decision='accepted')
        draft = self.service.call('drafts.get', {'draft_id': accepted['review']['target']['id']})
        values = {'candidate_id': candidate['id'], 'content_hash': draft['content_hash']}
        job = self.call('prepare_assets', **values)
        self.service.call('jobs.archive', {'job_id': job['job_id']})
        with self.assertRaisesRegex(ValueError, '先恢复任务'):
            self.call('prepare_assets', **values)
        self.service.call('jobs.restore', {'job_id': job['job_id']})
        again = self.call('prepare_assets', **values)
        self.assertFalse(again['created'])
        self.assertEqual(again['job_id'], job['job_id'])

    def test_v14_upgrade_backs_up_before_adding_conversation_recycle_bin(self):
        import sqlite3
        cid = self.call('create', title='升级前保留')['conversation']['id']
        self.service.workers.shutdown(wait=True)
        _, _, store = self.service._app()
        store.conn.execute('DROP TABLE creative_conversation_deletions')
        store.conn.commit()
        backup = store.db_path.with_name('app-before-v1.4.1.db')
        store.close(); self.service.close()
        self.service = DesktopService(REPO, self.root)
        self.assertTrue(backup.exists())
        with sqlite3.connect(str(backup)) as db:
            self.assertEqual(db.execute('SELECT title FROM creative_conversations WHERE id=?', (cid,)).fetchone()[0], '升级前保留')
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='creative_conversation_deletions'").fetchone())
        self.assertFalse(self.call('get', conversation_id=cid)['conversation']['deleted'])

    def test_real_compatible_http_stream_recovers_markdown_without_paid_or_repair_calls(self):
        import os
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from ice_agent.llm.transport import OpenAIChatTransport
        from tests.test_router import make_profile
        complete = '# 流式初稿\n\n' + ('这一段是保留全文的正文。\n\n' * 650) + '```python\nvalue = {"body":"不能被误提取的代码"}\n# 代码注释\n```\n\n## 写在最后\n末尾保留标记。'
        forms = [complete, '```markdown\n# 围栏初稿\n\n文章正文。\n\n## 写在最后\n结束。\n```',
                 '## 二级标题初稿\n\n完整内容。\n\n### 第二节\n结尾。',
                 json.dumps({'title': '兼容字段', 'content': {'markdown': '# 兼容字段\n\n正文。'}}, ensure_ascii=False)]
        # The last two responses exercise malformed output plus one bounded
        # repair, then a transport-truncated article. No remote account is used.
        script = [(text, 'stop') for text in forms] + [('普通观点回复', 'stop'),
                  ('没有文章标题或JSON', 'stop'), ('还是没有文章结构', 'stop'), ('# 不完整文章\n\n这一段没有完成', 'length')]
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(data)
                output, reason = script.pop(0)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream' if data.get('stream') else 'application/json')
                self.end_headers()
                if data.get('stream'):
                    for index in range(0, len(output), 220):
                        event = {'model': 'deepseek-compatible-local', 'choices': [{'delta': {'content': output[index:index+220]}, 'finish_reason': None}]}
                        self.wfile.write(('data: '+json.dumps(event, ensure_ascii=False)+'\n\n').encode('utf-8'))
                    event = {'choices': [{'delta': {}, 'finish_reason': reason}], 'usage': {'completion_tokens': 12}}
                    self.wfile.write(('data: '+json.dumps(event)+'\n\ndata: [DONE]\n\n').encode('utf-8'))
                else:
                    self.wfile.write(json.dumps({'model': 'deepseek-compatible-local', 'choices': [{'message': {'content': output}, 'finish_reason': reason}]}).encode('utf-8'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        profile = make_profile('deepseek', profile_id='local-http-editor', api_key_env='ICE_CHAT_LOCAL_TEST_KEY',
                               base_url=f'http://127.0.0.1:{server.server_port}/v1')
        self.service.settings['profiles'] = {'local-http-editor': {**profile.__dict__}}
        self.service.settings['routes']['writer'] = {'primary': 'local-http-editor', 'fallbacks': [], 'thinking_policy': 'prefer_on'}
        original = self.service._app
        def app(*args, **kwargs):
            engine, cfg, store = original(*args, **kwargs)
            engine.router.transport = OpenAIChatTransport(allow_loopback_http=True)
            return engine, cfg, store
        try:
            with patch.dict(os.environ, {'ICE_CHAT_LOCAL_TEST_KEY': 'fake-local-key'}), patch.object(self.service, '_app', app):
                for index, form in enumerate(forms):
                    cid = self.call('create')['conversation']['id']
                    before = len(requests)
                    self.call('send', conversation_id=cid, text='请生成完整初稿', mode='draft')
                    value = self.wait(cid)
                    self.assertEqual(value['messages'][-1]['status'], 'completed', value['messages'][-1]['content'])
                    self.assertEqual(len(value['candidates']), 1)
                    self.assertEqual(len(requests)-before, 1, 'Valid Markdown must not incur a JSON-repair call')
                    candidate = value['candidates'][0]
                    self.assertTrue(candidate['body'].startswith('# '))
                    if index == 0:
                        self.assertEqual(candidate['body'], complete)
                        self.assertGreater(len(candidate['body']), 8000)
                        self.assertIn('末尾保留标记', candidate['body'])
                    saved = self.call('save_draft', candidate_id=candidate['id'], content_hash=candidate['content_hash'])
                    self.assertEqual(saved['draft']['body'], candidate['body'])
                    self.assertIn('本轮必须返回JSON对象', requests[-1]['messages'][0]['content'])
                    self.assertEqual(requests[-1]['response_format'], {'type': 'json_object'})
                    self.assertEqual(requests[-1]['thinking'], {'type': 'enabled'})
                cid = self.call('create')['conversation']['id']
                self.call('send', conversation_id=cid, text='讨论一个观点', mode='discuss')
                self.assertEqual(self.wait(cid)['candidates'], [])
                cid = self.call('create')['conversation']['id']
                self.call('send', conversation_id=cid, text='初稿', mode='draft')
                failed = self.wait(cid)
                self.assertEqual(failed['messages'][-1]['status'], 'failed')
                self.assertEqual(failed['messages'][-1]['metadata']['error_code'], 'SCHEMA_INVALID')
                self.assertTrue(failed['messages'][-1]['metadata']['response_excerpt'])
                self.assertEqual(failed['candidates'], [])
                _, _, store = self.service._app()
                try:
                    self.assertTrue(store.conn.execute("SELECT 1 FROM model_invocations WHERE status='SCHEMA_INVALID'").fetchone())
                finally:
                    store.close()
                cid = self.call('create')['conversation']['id']
                before = len(requests)
                self.call('send', conversation_id=cid, text='初稿', mode='draft')
                failed = self.wait(cid)
                self.assertEqual(failed['messages'][-1]['status'], 'failed')
                self.assertEqual(failed['messages'][-1]['metadata']['error_code'], 'RESPONSE_INCOMPLETE')
                self.assertEqual(failed['candidates'], [])
                self.assertEqual(len(requests)-before, 1)
                self.assertEqual(script, [])
        finally:
            server.shutdown(); server.server_close(); thread.join(2)
