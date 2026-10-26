"""Full-message provider counting and output reservation; no live cloud."""
import unittest
import json
import gzip
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from ice_agent.domain.store import Store
from ice_agent.llm.errors import ContextLengthError, ModelBudgetExceeded, ModelError, ParamUnsupportedError
from ice_agent.llm.admission import TokenCountCache, counter_supported
from ice_agent.llm.transport import OpenAIChatTransport, EndpointRejected
from ice_agent.llm.http_io import request_control
from ice_agent.llm.router import LLMRequest, RoleRouter, RouteConfig, request_messages
from tests import REPO, temp_dir
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import ModelProfile
from ice_agent.llm.limits import bound_window
from tests.test_router import FakeTransport, make_profile


class CountingTransport(FakeTransport):
    def __init__(self, tokens=95):
        super().__init__([{'ok':'{}'} for _ in range(4)])
        self.tokens=tokens
        self.count_calls=[]

    def count_tokens(self, base_url, api_key, model, messages, *, timeout=15):
        self.count_calls.append({'model':model,'messages':messages,'timeout':timeout})
        return self.tokens


class TokenAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.profile=make_profile('bigmodel')
        self.profile.extra={'max_output_tokens':20,'model_window':{
            'base_url':self.profile.base_url.rstrip('/'),'model_id':self.profile.model_id,'context_window':100}}
        self.transport=CountingTransport()
        self.store=Store(temp_dir('token-admission-')/'test.db');self.addCleanup(self.store.close)
        self.router=RoleRouter({'p':self.profile},{'writer':RouteConfig('p')},store=self.store,transport=self.transport)
        self.req=LLMRequest('writer','draft','write',system='full system',history=[{'role':'user','content':'old question'}],schema={'type':'object','fields':{}})

    def test_input_plus_output_overflow_is_blocked_before_generation_budget(self):
        with self.assertRaises(ContextLengthError):self.router.generate(self.req)
        self.assertEqual(self.transport.calls,[])
        self.assertEqual(len(self.transport.count_calls),1)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)

    def test_counter_receives_exact_generation_messages_and_schema(self):
        self.transport.tokens=10
        self.req.schema=None
        self.router.generate(self.req)
        self.assertEqual(self.transport.count_calls[0]['messages'],request_messages(self.req))
        self.assertEqual(self.transport.count_calls[0]['messages'],self.transport.calls[0]['messages'])

    def test_exhausted_budget_never_sends_even_token_count_request(self):
        with patch.object(self.store,'get_job',return_value={'limits':{'max_model_calls':0},'workflow':'article_v1'}):
            with self.assertRaises(ModelBudgetExceeded):self.router.generate(self.req,job_id='job-out-of-budget')
        self.assertEqual(self.transport.count_calls,[])
        self.assertEqual(self.transport.calls,[])

    def test_exact_window_boundary_and_ledger_report(self):
        self.transport.tokens=80
        response=self.router.generate(self.req)
        self.assertEqual(response.input_preflight['state'],'checked')
        self.assertEqual(response.input_preflight['input_tokens'],80)
        record=json.loads(self.store.conn.execute('SELECT usage_json FROM model_invocations').fetchone()[0])
        self.assertEqual(record['input_preflight']['output_reserved'],20)

    def test_cache_revalidates_new_output_reservation_without_retaining_content(self):
        self.transport.tokens=80
        self.router.generate(self.req)
        self.profile.extra['max_output_tokens']=21
        with self.assertRaises(ContextLengthError):self.router.generate(self.req)
        self.assertEqual(len(self.transport.count_calls),1)
        self.assertEqual(len(self.transport.calls),1)
        raw=repr(self.router._token_cache._rows)
        self.assertNotIn('full system',raw)
        self.assertNotIn('old question',raw)
        self.assertNotIn('test-key',raw)

    def test_key_rotation_invalidates_cached_count(self):
        self.transport.tokens=10
        self.router.generate(self.req)
        with patch.dict('os.environ',{'ICE_TEST_KEY':'changed-secret-only-for-tests'}):self.router.generate(self.req)
        self.assertEqual(len(self.transport.count_calls),2)

    def test_unknown_window_or_provider_default_output_is_incomplete(self):
        self.transport.tokens=10
        self.profile.extra.pop('max_output_tokens')
        response=self.router.generate(self.req)
        self.assertEqual(response.input_preflight['state'],'incomplete')
        self.assertNotIn('max_tokens',self.transport.calls[0]['extra_body'])

    def test_required_missing_fields_refuses_before_any_provider_request(self):
        self.profile.extra.update(token_check='required')
        self.profile.extra.pop('model_window')
        with self.assertRaises(ParamUnsupportedError):self.router.generate(self.req)
        self.assertEqual(self.transport.count_calls,[])
        self.assertEqual(self.transport.calls,[])

    def test_unsupported_model_or_proxy_is_not_guessed_and_required_fails_closed(self):
        for field,value in [('model_id','glm-5.3-flash'),('base_url','https://proxy.example/api/paas/v4')]:
            with self.subTest(field=field):
                original=getattr(self.profile,field);setattr(self.profile,field,value)
                self.assertFalse(counter_supported(self.profile))
                self.profile.extra['token_check']='required'
                with self.assertRaises(ParamUnsupportedError):self.router.generate(self.req)
                setattr(self.profile,field,original)
        self.assertEqual(self.transport.count_calls,[])

    def test_auto_unknown_and_explicit_off_are_not_reported_as_passed(self):
        self.profile.extra['token_check']='off'
        self.assertEqual(self.router.generate(self.req).input_preflight['state'],'disabled')
        self.profile.extra['token_check']='auto';self.profile.model_id='unknown-new-model'
        self.assertEqual(self.router.generate(self.req).input_preflight['state'],'unsupported')
        self.assertEqual(self.transport.count_calls,[])

    def test_only_configured_fallback_can_recover_overflow(self):
        self.router.profiles['fallback']=make_profile('qwen')
        self.router.routes['writer'].fallbacks=['fallback']
        response=self.router.generate(self.req)
        self.assertTrue(response.fell_back)
        self.assertEqual([call['model'] for call in self.transport.calls],[self.router.profiles['fallback'].model_id])
        self.assertEqual(len(self.transport.count_calls),1)

    def test_strict_primary_cannot_be_bypassed_by_unchecked_fallback(self):
        self.profile.extra['token_check']='required'
        fallback=make_profile('qwen');fallback.extra['token_check']='off'
        self.router.profiles['fallback']=fallback;self.router.routes['writer'].fallbacks=['fallback']
        with self.assertRaises(ParamUnsupportedError):self.router.generate(self.req)
        self.assertEqual(self.transport.calls,[])

    def test_format_repair_uses_its_own_count_and_budget(self):
        self.transport.tokens=10
        self.transport.script=[{'ok':'broken json'},{'ok':'{}'}]
        self.router.generate(self.req)
        self.assertEqual(len(self.transport.count_calls),2)
        self.assertEqual(self.transport.count_calls[1]['messages'],self.transport.calls[1]['messages'])

    def test_cancellation_during_count_does_not_generate_or_cache(self):
        stopped=threading.Event();self.router.cancelled=stopped.is_set
        def count(*args,**kwargs):stopped.set();return 10
        with patch.object(self.transport,'count_tokens',side_effect=count):
            with self.assertRaises(ModelError) as raised:self.router.generate(self.req)
        self.assertEqual(raised.exception.code,'CANCELLED')
        self.assertEqual(self.transport.calls,[])
        self.assertEqual(len(self.router._token_cache._rows),0)

    def test_cache_is_bounded_and_expires(self):
        cache=TokenCountCache()
        with patch('ice_agent.llm.admission.time.monotonic',return_value=0):
            for index in range(100):cache.put(str(index),index)
            self.assertEqual(len(cache._rows),32)
            self.assertIsNone(cache.get('0'))
            self.assertEqual(cache.get('99'),99)
        with patch('ice_agent.llm.admission.time.monotonic',return_value=301):self.assertIsNone(cache.get('99'))

    def test_invalid_deadline_never_sends_count_or_generation(self):
        for timeout in (0, -1, True, float('inf'), float('nan'), '1'):
            with self.subTest(timeout=timeout):
                self.req.timeout=timeout
                with self.assertRaises(ParamUnsupportedError):self.router.generate(self.req)
        self.assertEqual(self.transport.count_calls,[])
        self.assertEqual(self.transport.calls,[])


class TokenCountHttpTests(unittest.TestCase):
    def setUp(self):
        self.posts=[];self.mode='ok';self.arrived=threading.Event();self.closed=threading.Event()
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.posts.append((self.path,body));is_count=self.path.endswith('/tokenizer')
                if (owner.mode=='hold' and is_count) or (owner.mode=='deadline' and not is_count):
                    owner.arrived.set();self.connection.settimeout(3)
                    try:
                        if not self.connection.recv(1):owner.closed.set()
                    except OSError:pass
                    return
                raw=json.dumps({'usage':{'total_tokens':10,'prompt_tokens':7,'image_tokens':3}}).encode() if is_count else json.dumps({'choices':[{'message':{'content':'complete'},'finish_reason':'stop'}]}).encode()
                code=200
                if is_count:
                    if owner.mode=='bad':raw=b'{"usage":{"total_tokens":true}}'
                    if owner.mode=='large':raw=b'x'*16385
                    if owner.mode=='gzip':raw=gzip.compress(b'x'*100000)
                    if owner.mode=='redirect':code=302
                    if owner.mode=='auth':code=401;raw=b'{"error":"fake-count-key-must-not-echo"}'
                self.send_response(code)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw)))
                if owner.mode=='gzip':self.send_header('Content-Encoding','gzip')
                if code==302:self.send_header('Location',owner.base+'/forbidden')
                self.end_headers()
                try:self.wfile.write(raw)
                except ConnectionError:pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.base='http://127.0.0.1:'+str(self.server.server_port)+'/v4'
        thread=threading.Thread(target=self.server.serve_forever,daemon=True);thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.transport=OpenAIChatTransport(allow_loopback_http=True)

    def test_real_http_counts_same_multimodal_messages(self):
        messages=[{'role':'system','content':'instructions'},{'role':'user','content':[{'type':'text','text':'all titles and five bodies'},{'type':'image_url','image_url':{'url':'data:image/png;base64,AA=='}}]}]
        self.assertEqual(self.transport.count_tokens(self.base,'fake-count-key','glm-5.3',messages),10)
        self.assertEqual(self.posts,[('/v4/tokenizer',{'model':'glm-5.3','messages':messages})])

    def test_malformed_count_and_oversized_plain_or_compressed_response_are_rejected(self):
        for mode in ('bad','large','gzip'):
            with self.subTest(mode=mode):
                self.mode=mode
                with self.assertRaises(ModelError):self.transport.count_tokens(self.base,'fake-count-key','glm-5.3',[])

    def test_no_redirect_or_auth_body_leak(self):
        for mode in ('redirect','auth'):
            with self.subTest(mode=mode):
                self.mode=mode
                with self.assertRaises(ModelError) as error:self.transport.count_tokens(self.base,'fake-count-key-must-not-echo','glm-5.3',[])
                self.assertNotIn('fake-count-key-must-not-echo',str(error.exception))
        self.assertFalse(any('/forbidden' in path for path,_ in self.posts))

    def test_default_transport_still_rejects_loopback(self):
        with self.assertRaises(EndpointRejected):OpenAIChatTransport().count_tokens(self.base,'fake-key','glm-5.3',[])
        self.assertEqual(self.posts,[])

    def test_cancel_count_closes_actual_socket(self):
        self.mode='hold';stopped=threading.Event();errors=[]
        def run():
            try:
                with request_control(stopped.is_set):self.transport.count_tokens(self.base,'fake-key','glm-5.3',[],timeout=10)
            except ModelError as exc:errors.append(exc)
        thread=threading.Thread(target=run);thread.start()
        self.assertTrue(self.arrived.wait(3));stopped.set();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(errors[0].code,'CANCELLED');self.assertTrue(self.closed.wait(2))

    def test_count_and_generation_share_one_request_deadline(self):
        owner=self
        budgets={}
        class LocalTransport(OpenAIChatTransport):
            def __init__(self):super().__init__(allow_loopback_http=True)
            def count_tokens(self,base_url,*args,**kwargs):
                budgets['count']=kwargs['timeout']
                value=super().count_tokens(owner.base,*args,**kwargs)
                # Consume a known part of the attempt without relying on a 250ms scheduling race.
                time.sleep(.2)
                return value
            def chat(self,base_url,*args,**kwargs):
                budgets['generation']=kwargs['timeout']
                return super().chat(owner.base,*args,**kwargs)
        profile=make_profile('bigmodel');profile.extra={'max_output_tokens':20,'model_window':{'base_url':profile.base_url,'model_id':profile.model_id,'context_window':100}}
        router=RoleRouter({'p':profile},{'writer':RouteConfig('p')},transport=LocalTransport())
        self.mode='deadline';started=time.monotonic()
        # Generation deliberately waits for the client to close; it cannot finish before the deadline.
        with self.assertRaises(ModelError) as error:router.generate(LLMRequest('writer','draft','deadline',timeout=2),max_attempts=1)
        self.assertEqual(error.exception.code,'MODEL_TIMEOUT');self.assertLess(time.monotonic()-started,4)
        self.assertTrue(self.arrived.is_set(), 'generation must reach the real local server')
        self.assertTrue(self.closed.wait(2), 'deadline must close the generation socket')
        self.assertLessEqual(budgets['generation'],budgets['count']-.19,
                             'generation must receive the remaining budget, not a fresh timeout')
        self.assertEqual([path for path,_ in self.posts],['/v4/tokenizer','/v4/chat/completions'])



class TokenSettingsTests(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('token-settings-')
        self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)

    def params(self):
        profile=next(p for p in self.service.bootstrap({})['settings']['profiles'] if p['provider']=='bigmodel')
        return {'account_id':'ice-loop','provider':'bigmodel','limits_hash':profile['limits_hash'],'max_output_tokens':20}

    def save(self,**extra):return self.service.call('models.limits_save',{**self.params(),**extra})
    def profile(self):return ModelProfile(**self.service.settings['profiles']['bigmodel'])

    def test_manual_window_and_policy_persist_and_clear(self):
        self.save(context_window=100,token_check='required')
        reloaded=DesktopService(REPO,self.service.runtime,self.root/'articles',auto_consumer=False);self.addCleanup(reloaded.close)
        profile=ModelProfile(**reloaded.settings['profiles']['bigmodel'])
        self.assertEqual(bound_window(profile)['context_window'],100)
        self.assertEqual(profile.extra['token_check'],'required')
        self.save(context_window=None,token_check='auto')
        self.assertNotIn('context_window_override',self.profile().extra)

    def test_invalid_policy_or_window_never_changes_saved_settings(self):
        for value in [True,0,-1,2**31,'100',[],{}]:
            with self.subTest(value=value):
                before=self.service.settings_file.read_bytes()
                with self.assertRaises(ValueError):self.save(context_window=value)
                self.assertEqual(self.service.settings_file.read_bytes(),before)
        for value in [True,None,'guess',[],{}]:
            with self.subTest(policy=value),self.assertRaises(ParamUnsupportedError):self.save(token_check=value)

    def test_manual_window_is_scoped_and_cleared_by_model_change(self):
        self.save(context_window=100)
        self.service.call('models.save',{'provider':'bigmodel','model_id':'new-glm-model'})
        self.assertNotIn('context_window_override',self.profile().extra)
        self.assertFalse(next(p for p in self.service.bootstrap({})['settings']['profiles'] if p['provider']=='bigmodel')['token_count_supported'])

    def test_refresh_keeps_explicit_manual_window_as_priority(self):
        self.save(context_window=100)
        from ice_agent.llm.limits import window_metadata
        profile=self.service.settings['profiles']['bigmodel']
        profile['extra']['model_window']=window_metadata(profile,[{'id':profile['model_id'],'context_window':200,'max_output_tokens':80}])
        self.assertEqual(bound_window(self.profile())['context_window'],100)
        self.assertEqual(bound_window(self.profile())['max_output_tokens'],80)
        self.save(context_window=None)
        self.assertEqual(bound_window(self.profile())['context_window'],200)

    def test_stale_save_and_foreign_account_do_not_overwrite(self):
        old=self.params();self.save(context_window=100,token_check='required')
        with self.assertRaisesRegex(ValueError,'已变化'):self.service.call('models.limits_save',{**old,'context_window':1000})
        with self.assertRaisesRegex(ValueError,'切换'):self.save(account_id='other-account',context_window=1000)
        self.assertEqual(bound_window(self.profile())['context_window'],100)

    def test_snapshot_freezes_manual_limit_and_policy(self):
        self.save(context_window=100,token_check='required')
        engine,_,store=self.service._app()
        try:snapshot=engine.router.snapshot
        finally:store.close()
        self.save(context_window=200,token_check='off')
        frozen=snapshot['profiles'][self.profile().profile_id]['extra']
        self.assertEqual(frozen['context_window_override']['context_window'],100)
        self.assertEqual(frozen['token_check'],'required')

    def test_output_reservation_cannot_already_exhaust_manual_window(self):
        before=self.service.settings_file.read_bytes()
        with self.assertRaises(ParamUnsupportedError):self.save(context_window=20)
        self.assertEqual(self.service.settings_file.read_bytes(),before)
