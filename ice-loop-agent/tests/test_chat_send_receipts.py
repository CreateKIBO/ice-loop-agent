"""Exactly-once acceptance and honest retry receipts; no real model calls."""
import threading
import json
import unittest
from unittest.mock import patch
from tests import test_creative_chat as fixtures
from ice_agent.llm.router import RoleRouter,LLMResponse

class TestChatSendReceipts(unittest.TestCase):
    setUp=fixtures.CreativeChatTests.setUp
    tearDown=fixtures.CreativeChatTests.tearDown
    call=fixtures.CreativeChatTests.call
    wait=fixtures.CreativeChatTests.wait

    def test_same_request_returns_same_message_after_reply_finishes(self):
        cid=self.call('create')['conversation']['id']
        params={'conversation_id':cid,'text':'讨论下一期','request_id':'same-key'}
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('观点')) as generate:
            first=self.call('send',**params);self.wait(cid)
            second=self.call('send',**params);self.wait(cid)
        self.assertEqual(first['message_id'],second['message_id'])
        self.assertTrue(second['replayed'])
        self.assertFalse(second['started'])
        self.assertEqual(generate.call_count,1)
        self.assertEqual(len(self.call('get',conversation_id=cid)['messages']),2)

    def test_pending_request_replay_does_not_hit_streaming_gate(self):
        cid=self.call('create')['conversation']['id'];release=threading.Event()
        def blocked(*args,**kwargs):
            release.wait(5);return LLMResponse('完整回复')
        with patch.object(RoleRouter,'generate',side_effect=blocked) as generate:
            try:
                first=self.call('send',conversation_id=cid,text='待生成',request_id='pending-key')
                second=self.call('send',conversation_id=cid,text='待生成',request_id='pending-key')
                self.assertEqual(first['message_id'],second['message_id'])
            finally:release.set();self.wait(cid)
        self.assertEqual(generate.call_count,1)

    def test_same_key_different_payload_is_explicit_conflict(self):
        cid=self.call('create')['conversation']['id']
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('观点')):
            self.call('send',conversation_id=cid,text='原请求',request_id='conflict');self.wait(cid)
            with self.assertRaisesRegex(ValueError,'冲突'):
                self.call('send',conversation_id=cid,text='另一份内容',request_id='conflict')

    def test_readonly_lookup_cannot_send_or_create_a_message(self):
        cid=self.call('create')['conversation']['id'];params={'conversation_id':cid,'request_id':'lookup','text':'原需求'}
        with patch.object(RoleRouter,'generate') as generate:
            self.assertEqual(self.call('receipt',**params),{'accepted':False,'found':False})
            self.assertEqual(self.call('get',conversation_id=cid)['messages'],[])
            generate.assert_not_called()

    def test_cancel_unaccepted_request_prevents_a_late_send(self):
        cid=self.call('create')['conversation']['id'];params={'conversation_id':cid,'request_id':'cancel-pending','text':'不要开始'}
        with patch.object(RoleRouter,'generate') as generate:
            self.assertTrue(self.call('cancel_send',**params)['cancelled'])
            self.assertTrue(self.call('send',**params)['cancelled'])
            self.assertTrue(self.call('receipt',**params)['cancelled'])
            self.assertEqual(self.call('get',conversation_id=cid)['messages'],[])
            generate.assert_not_called()
        with self.assertRaisesRegex(ValueError,'冲突'):
            self.call('send',**{**params,'text':'不同内容'})

    def test_accepted_request_cancel_stops_only_its_own_reply(self):
        cid=self.call('create')['conversation']['id'];release=threading.Event()
        def blocked(*args,**kwargs):release.wait(5);return LLMResponse('原回复')
        params={'conversation_id':cid,'text':'尚在生成','request_id':'stop-accepted'}
        with patch.object(RoleRouter,'generate',side_effect=blocked):
            try:
                accepted=self.call('send',**params)
                stopped=self.call('cancel_send',**params)
                self.assertTrue(stopped['accepted']);self.assertEqual(stopped['message_id'],accepted['message_id'])
                self.assertEqual(stopped['status'],'stopped')
            finally:release.set();self.wait(cid)
        self.assertEqual(self.call('receipt',**params)['status'],'stopped')

    def test_launch_failure_is_an_accepted_retryable_message(self):
        cid=self.call('create')['conversation']['id'];params={'conversation_id':cid,'text':'继续保留这个需求','request_id':'launch-fail'}
        with patch.object(self.service.workers,'submit',side_effect=RuntimeError('closed worker')):
            accepted=self.call('send',**params)
        self.assertTrue(accepted['accepted']);self.assertFalse(accepted['started'])
        self.assertEqual(accepted['status'],'failed')
        self.assertEqual(self.call('send',**params)['message_id'],accepted['message_id'])
        self.assertEqual(len(self.call('get',conversation_id=cid)['messages']),2)
        self.assertEqual(self.service.chat_cancel,{})

    def test_receipt_insert_failure_rolls_back_both_messages(self):
        import sqlite3
        cid=self.call('create')['conversation']['id']
        _,_,store=self.service._app()
        store.conn.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON creative_send_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END")
        store.conn.commit();store.close()
        with patch.object(RoleRouter,'generate') as generate:
            with self.assertRaisesRegex(sqlite3.IntegrityError,'test receipt failure'):
                self.call('send',conversation_id=cid,text='不能只存一半',request_id='rollback')
            generate.assert_not_called()
        self.assertEqual(self.call('get',conversation_id=cid)['messages'],[])

    def test_same_key_is_isolated_by_conversation_and_account(self):
        import copy
        a=self.call('create')['conversation']['id'];b=self.call('create')['conversation']['id']
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('回复')):
            first=self.call('send',conversation_id=a,text='请求',request_id='shared');self.wait(a)
            second=self.call('send',conversation_id=b,text='请求',request_id='shared');self.wait(b)
        self.assertNotEqual(first['message_id'],second['message_id'])
        account=copy.deepcopy(self.account);account.pop('id');account.update(name='另一公众号',article_root=str(self.root/'other-output'),library_root='')
        aid=self.service.accounts_save({'account':account})['saved_account_id']
        c=self.call('create')['conversation']['id']
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('另一个回复')):
            third=self.call('send',conversation_id=c,text='请求',request_id='shared');self.wait(c)
        self.assertNotEqual(third['message_id'],first['message_id'])
        with self.assertRaisesRegex(ValueError,'没有这个会话'):
            self.call('receipt',conversation_id=a,text='请求',request_id='shared',account_id=aid)

    def test_replay_precedes_budget_and_works_after_restart(self):
        from ice_agent.domain.store import Store
        from ice_agent.desktop_service import DesktopService
        from tests import REPO
        cid=self.call('create')['conversation']['id'];params={'conversation_id':cid,'request_id':'after-restart','text':'只生成一次'}
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('完整回复')):
            first=self.call('send',**params);self.wait(cid)
        with patch.object(Store,'conversation_invocation_count',return_value=1000):
            self.assertEqual(self.call('send',**params)['message_id'],first['message_id'])
        self.service.close();self.service=DesktopService(REPO,self.root,auto_consumer=False)
        with patch.object(RoleRouter,'generate') as generate:
            self.assertEqual(self.call('send',**params)['message_id'],first['message_id'])
            generate.assert_not_called()

    def test_retry_retains_handselected_citations_profile_and_original_text(self):
        from ice_agent.knowledge import import_source
        file=self.root/'source.md';file.write_text('# 重试引用标记ABC12\n\n重要依据。',encoding='utf-8')
        _,_,store=self.service._app()
        source=import_source(store,'ice-loop',file)
        chunk=store.conn.execute('SELECT chunk_id,chunk_hash FROM knowledge_chunks WHERE source_id=?',(source['source_id'],)).fetchone();store.close()
        profile=next(iter(self.service.settings['profiles'].values()))['profile_id']
        cid=self.call('create')['conversation']['id']
        with patch.object(RoleRouter,'generate',side_effect=RuntimeError('测试生成失败')):
            first=self.call('send',conversation_id=cid,text='结合资料讨论',request_id='retry-original',profile_id=profile,citations=[{'chunk_id':chunk['chunk_id'],'hash':chunk['chunk_hash']}]);self.wait(cid)
        requests=[]
        def generate(router,req,**kwargs):requests.append((req,router.routes['writer'].primary));return LLMResponse('重新完成')
        with patch.object(RoleRouter,'generate',generate):
            self.call('send',conversation_id=cid,retry_message_id=first['message_id'],request_id='retry-new');self.wait(cid)
        self.assertEqual(requests[0][0].prompt,'结合资料讨论')
        self.assertIn('重试引用标记ABC12',requests[0][0].context['context_pack'])
        self.assertEqual(requests[0][1],profile)

    def test_clarification_answer_receipt_is_replayable_after_question_is_marked_answered(self):
        cid=self.call('create')['conversation']['id']
        question={'reply':'需要确认','title':'','body':'','prompts':[],'questions':[{'id':'reader','question':'面向谁？','options':['初学者','进阶']} ]}
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('reply',data=question)):
            self.call('send',conversation_id=cid,text='写初稿',mode='draft');original=self.wait(cid)['messages'][-1]
        params={'conversation_id':cid,'clarification_message_id':original['id'],'clarification_answers':{'reader':'初学者'},'request_id':'answers-once'}
        answer={'reply':'初稿完成','title':'入门','body':'# 入门\n\n正文','prompts':[]}
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('reply',data=answer)) as generate:
            first=self.call('send',**params);self.wait(cid)
            replay=self.call('send',**params);self.wait(cid)
        self.assertEqual(first['message_id'],replay['message_id']);self.assertEqual(generate.call_count,1)
        self.assertEqual(len(self.call('get',conversation_id=cid)['candidates']),1)

    def test_long_transcript_reads_only_bounded_bodies_without_changing_recent_history(self):
        import tracemalloc
        from ice_agent.creative_chat import CreativeChat
        cid=self.call('create')['conversation']['id']
        self.service._consumer_stop.set()
        if self.service._consumer_thread:self.service._consumer_thread.join(timeout=3)
        _,_,store=self.service._app()
        self.addCleanup(store.close)
        body='A'*32000
        store.conn.executemany('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
            [(f'bounded-{i}',cid,'user' if i%2==0 else 'assistant',f'{i:04d}:'+body,'completed','{}','2026-10-25T00:00:00Z') for i in range(1000)])
        store.conn.commit()
        tracemalloc.start()
        try:
            transcript,manifest=CreativeChat(self.service)._history_with_summary(store,'ice-loop',cid)
            _,peak=tracemalloc.get_traced_memory()
        finally:tracemalloc.stop()
        self.assertEqual(len(transcript),20)
        self.assertTrue(transcript[0]['content'].startswith('0980:'))
        self.assertTrue(transcript[-1]['content'].startswith('0999:'))
        (self.root/'history-memory.json').write_text(json.dumps({'history_messages':1000,'body_characters':32000,'peak_python_bytes':peak,'returned_messages':len(transcript),'model_calls':0}),encoding='utf-8')
        self.assertLess(peak,4*1024*1024,f'writer history materialized unused bodies: {peak}')
        self.assertIsNone(manifest)

    def _clarification_context_case(self):
        import copy
        from ice_agent.knowledge import import_source
        profile=copy.deepcopy(next(iter(self.service.settings['profiles'].values())))
        profile['profile_id']='clarification-override'
        self.service.settings['profiles']['clarification-override']=profile
        file=self.root/'clarification-source.md'
        file.write_text('# 澄清继续引用标记XYZ45\n\n文章的关键依据。',encoding='utf-8')
        _,_,store=self.service._app()
        source=import_source(store,'ice-loop',file)
        chunk=store.conn.execute('SELECT chunk_id,chunk_hash FROM knowledge_chunks WHERE source_id=?',(source['source_id'],)).fetchone()
        store.close()
        cid=self.call('create')['conversation']['id']
        question={'reply':'请确认','title':'','body':'','prompts':[],'questions':[{'id':'reader','question':'面向谁？','options':['初学者']}]}
        with patch.object(RoleRouter,'generate',return_value=LLMResponse('reply',data=question)):
            self.call('send',conversation_id=cid,text='使用资料写初稿',mode='draft',profile_id='clarification-override',citations=[{'chunk_id':chunk['chunk_id'],'hash':chunk['chunk_hash']}])
            original=self.wait(cid)['messages'][-1]
        return cid,original,chunk

    def test_repeated_clarification_retains_selected_model_and_citations(self):
        cid,original,_=self._clarification_context_case();requests=[]
        question={'reply':'请选案例','title':'','body':'','prompts':[],'questions':[{'id':'example','question':'用什么案例？','options':['倒计时']}]}
        complete={'reply':'完成','title':'标题','body':'# 标题\n\n正文','prompts':[]}
        def generate(router,req,**kwargs):
            requests.append((req,router.routes['writer'].primary))
            return LLMResponse('reply',data=question if len(requests)==1 else complete)
        with patch.object(RoleRouter,'generate',generate):
            self.call('send',conversation_id=cid,clarification_message_id=original['id'],clarification_answers={'reader':'初学者'})
            second=self.wait(cid)['messages'][-1]
            self.call('send',conversation_id=cid,clarification_message_id=second['id'],clarification_answers={'example':'倒计时'})
            final=self.wait(cid)
        self.assertEqual(len(requests),2)
        for req,profile in requests:
            self.assertEqual(profile,'clarification-override')
            self.assertIn('澄清继续引用标记XYZ45',req.context['context_pack'])
            self.assertEqual(req.context['clarification']['original_request'],'使用资料写初稿')
        self.assertTrue(any(answer.get('answer')=='初学者' for answer in requests[1][0].context['clarification']['previous_answers']))
        self.assertEqual(len(final['candidates']),1)

    def test_stale_clarification_citation_requires_reselection_or_explicit_clear(self):
        cid,original,chunk=self._clarification_context_case()
        _,_,store=self.service._app()
        store.conn.execute('UPDATE knowledge_chunks SET chunk_hash=? WHERE chunk_id=?',('b'*64,chunk['chunk_id']))
        store.conn.commit();store.close()
        params={'conversation_id':cid,'clarification_message_id':original['id'],'clarification_answers':{'reader':'初学者'}}
        with patch.object(RoleRouter,'generate') as generate:
            with self.assertRaisesRegex(ValueError,'引文来源已更新'):
                self.call('send',**params)
            generate.assert_not_called()
        unchanged=self.call('get',conversation_id=cid)
        self.assertEqual(len(unchanged['messages']),2)
        self.assertEqual(unchanged['messages'][-1]['metadata']['clarification_status'],'pending')
        requests=[]
        def generate(router,req,**kwargs):
            requests.append((req,router.routes['writer'].primary))
            return LLMResponse('reply',data={'reply':'完成','title':'标题','body':'# 标题\n\n正文','prompts':[]})
        with patch.object(RoleRouter,'generate',generate):
            self.call('send',**params,citations=[]);self.wait(cid)
        self.assertNotIn('context_pack',requests[0][0].context)
        self.assertEqual(requests[0][1],'clarification-override')
