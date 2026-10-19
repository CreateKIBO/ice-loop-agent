import copy
import json
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService, HEAVY_METHODS
from ice_agent.domain.store import Store
from ice_agent.domain.types import ModelProfile
from ice_agent.llm.errors import ModelError, ParamUnsupportedError
from ice_agent.llm.limits import output_limit, window_metadata
from ice_agent.llm.router import LLMRequest, RoleRouter, RouteConfig
from ice_agent.llm.transport import OpenAIChatTransport, EndpointRejected
from ice_agent.llm.adapters import make_adapter
from tests import REPO, temp_dir
from tests.test_router import FakeTransport, make_profile


class TestModelLimits(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('model-limits-')
        self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.fake_key=patch.dict('os.environ',{'ICE_WINDOW_KEY':'fake-window-key-only'});self.fake_key.start();self.addCleanup(self.fake_key.stop)
        self.service.settings['profiles']['qwen']['api_key_env']='ICE_WINDOW_KEY'

    def params(self):
        profile=next(p for p in self.service.bootstrap({})['settings']['profiles'] if p['provider']=='qwen')
        return {'account_id':'ice-loop','provider':'qwen','limits_hash':profile['limits_hash']}

    def refresh(self,rows=None):
        profile=self.service.settings['profiles']['qwen']
        if rows is None:rows=[{'id':profile['model_id'],'context_window':32000,'max_output_tokens':8192,'credential':'must-not-persist'}]
        with patch.object(OpenAIChatTransport,'models',return_value=rows):
            return self.service.call('models.window_refresh',self.params())

    def save(self,value,**kwargs):
        return self.service.call('models.limits_save',{**self.params(),'max_output_tokens':value,**kwargs})

    def test_window_is_exact_model_bound_sanitized_and_not_capability_proof(self):
        status=self.service.settings['profiles']['qwen']['status']
        result=self.refresh()
        profile=self.service.settings['profiles']['qwen']
        window=profile['extra']['model_window']
        self.assertEqual((window['context_window'],window['max_output_tokens']),(32000,8192))
        self.assertNotIn('credential',json.dumps(window))
        self.assertEqual(profile['status'],status)
        self.assertIsNotNone(result['settings']['profiles'][0]['limits_hash'])

    def test_missing_duplicate_and_invalid_window_values_remain_unknown(self):
        profile=self.service.settings['profiles']['qwen'];mid=profile['model_id']
        for rows,expected in (([{'id':'other','context_window':99999}],'model_not_listed'),
                              ([{'id':mid},{'id':mid}],'ambiguous_model'),
                              ([{'id':mid,'context_window':True,'max_output_tokens':'8000'}],'unknown')):
            with self.subTest(rows=rows):
                self.refresh(rows)
                window=self.service.settings['profiles']['qwen']['extra']['model_window']
                self.assertEqual(window['state'],expected)
                self.assertNotIn('context_window',window)

    def test_output_persists_and_provider_default_is_explicit(self):
        self.refresh();self.save(4096)
        service=DesktopService(REPO,self.service.runtime,self.root/'articles',auto_consumer=False)
        self.addCleanup(service.close)
        self.assertEqual(output_limit(ModelProfile(**service.settings['profiles']['qwen'])),4096)
        self.save(None)
        self.assertIsNone(output_limit(ModelProfile(**self.service.settings['profiles']['qwen'])))

    def test_invalid_output_never_changes_settings(self):
        self.refresh()
        for value in (0,-1,True,'4096',1.5,1000001,8193):
            with self.subTest(value=value):
                before=copy.deepcopy(self.service.settings);disk=self.service.settings_file.read_bytes()
                with self.assertRaises(ParamUnsupportedError):self.save(value)
                self.assertEqual(self.service.settings,before);self.assertEqual(self.service.settings_file.read_bytes(),disk)

    def test_stale_or_foreign_requests_are_rejected(self):
        old=self.params();self.save(1024)
        for extra in (old,{'account_id':'foreign'},{'limits_hash':None}):
            with self.subTest(extra=extra),self.assertRaises(ValueError):self.save(512,**extra)

    def test_model_or_endpoint_change_clears_old_window_and_output(self):
        for update in ({'model_id':'next-model'},{'model_id':'next-model','base_url':'https://different.example/v1'}):
            self.refresh();self.save(1024)
            self.service.call('models.save',{'provider':'qwen',**update})
            extra=self.service.settings['profiles']['qwen']['extra']
            self.assertNotIn('model_window',extra);self.assertNotIn('max_output_tokens',extra)

    def test_late_metadata_cannot_replace_changed_model(self):
        params=self.params()
        def delayed(*args,**kwargs):
            self.service.call('models.save',{'provider':'qwen','model_id':'changed-during-get'})
            return [{'id':'changed-during-get','context_window':99999}]
        with patch.object(OpenAIChatTransport,'models',side_effect=delayed),self.assertRaisesRegex(ValueError,'已变化'):
            self.service.call('models.window_refresh',params)
        self.assertNotIn('model_window',self.service.settings['profiles']['qwen'].get('extra',{}))

    def test_late_metadata_is_rejected_after_account_switch(self):
        first=self.service._account()
        other={key:value for key,value in first.items() if key!='id'}
        aid=self.service.accounts_save({'account':{**other,'name':'另一个测试账号','preset':'general','library_root':''}})['saved_account_id']
        self.service.call('accounts.switch',{'account_id':first['id']})
        def delayed(*args,**kwargs):
            self.service.call('accounts.switch',{'account_id':aid})
            return []
        params=self.params()
        with patch.object(OpenAIChatTransport,'models',side_effect=delayed),self.assertRaisesRegex(ValueError,'公众号已切换'):
            self.service.call('models.window_refresh',params)
        self.assertNotIn('model_window',self.service.settings['profiles']['qwen'].get('extra',{}))

    def test_snapshot_carries_output_settings_and_metadata_get_is_heavy(self):
        self.refresh();self.save(2048)
        engine,_,store=self.service._app()
        try:
            snapshot=engine.router.snapshot
            profile=self.service.settings['profiles']['qwen']
            self.assertEqual(snapshot['profiles'][profile['profile_id']]['extra']['max_output_tokens'],2048)
            self.save(4096)
            self.assertEqual(snapshot['profiles'][profile['profile_id']]['extra']['max_output_tokens'],2048)
        finally:store.close()
        self.assertIn('models.window_refresh',HEAVY_METHODS);self.assertIn('models.catalog',HEAVY_METHODS)

    def test_limits_are_sent_to_all_production_adapters(self):
        for adapter in ('qwen','deepseek','kimi','bigmodel','ark','minimax'):
            with self.subTest(adapter=adapter):
                profile=make_profile(adapter);profile.extra={'max_output_tokens':6144}
                transport=FakeTransport()
                make_adapter(profile,transport).chat([{'role':'user','content':'test'}])
                self.assertEqual(transport.calls[0]['extra_body']['max_tokens'],6144)

    def test_invalid_frozen_output_is_rejected_before_budget_or_transport(self):
        store=Store(self.root/'budget.db');self.addCleanup(store.close)
        profile=make_profile('qwen');profile.extra={'max_output_tokens':0}
        transport=FakeTransport()
        router=RoleRouter({'p':profile},{'writer':RouteConfig('p')},store=store,transport=transport)
        with self.assertRaises(ParamUnsupportedError):router.generate(LLMRequest('writer','draft','p'))
        self.assertEqual(transport.calls,[])
        self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)


class TestMetadataTransport(unittest.TestCase):
    def setUp(self):
        self.requests=[]
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                owner.requests.append(self.path)
                mode=self.path.split('/')[1]
                code=200;raw=json.dumps({'data':[{'id':'local-model','context_window':32000,'max_output_tokens':4096}]}).encode()
                if mode=='large':raw=b'x'*2_000_001
                if mode=='invalid':raw=b'[]'
                if mode=='auth':code=401;raw=b'{"error":"fake-window-key-only"}'
                if mode=='redirect':code=302
                self.send_response(code)
                if code==302:self.send_header('Location',owner.base+'/forbidden/models')
                self.send_header('Content-Length',str(len(raw)));self.end_headers()
                try:self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            def do_POST(self):
                owner.posted=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                raw=json.dumps({'model':'local-model','choices':[{'message':{'content':'完整测试结果'},'finish_reason':'stop'}]}).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.transport=OpenAIChatTransport(allow_loopback_http=True)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def test_actual_http_metadata_and_bounded_invalid_responses(self):
        self.assertEqual(self.transport.models(self.base+'/ok','fake-window-key-only')[0]['context_window'],32000)
        for mode in ('large','invalid'):
            with self.subTest(mode=mode),self.assertRaises(ParamUnsupportedError):self.transport.models(self.base+'/'+mode,'fake-window-key-only')

    def test_redirect_never_forwards_and_errors_do_not_echo_keys(self):
        with self.assertRaises(EndpointRejected):self.transport.models(self.base+'/redirect','fake-window-key-only')
        self.assertEqual(self.requests,['/redirect/models'])
        with self.assertRaises(ModelError) as caught:self.transport.models(self.base+'/auth','fake-window-key-only')
        self.assertNotIn('fake-window-key-only',str(caught.exception))

    def test_embedded_credentials_query_and_fragment_fail_before_network(self):
        for suffix in ('?key=secret','#fragment'):
            with self.assertRaises(EndpointRejected):self.transport.models(self.base+'/ok'+suffix,'fake')
        with self.assertRaises(EndpointRejected):self.transport.models(self.base.replace('http://','http://user:secret@')+'/ok','fake')
        self.assertEqual(self.requests,[])

    def test_service_metadata_and_output_reach_real_http_without_generation_on_get(self):
        root=temp_dir('model-window-http-')
        service=DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(service.close)
        profile=service.settings['profiles']['qwen']
        profile.update(base_url=self.base+'/ok',model_id='local-model',api_key_env='ICE_WINDOW_HTTP_KEY')
        service.settings['profiles']={'qwen':profile}
        for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
        current=next(row for row in service.bootstrap({})['settings']['profiles'] if row['provider']=='qwen')
        with patch.dict('os.environ',{'ICE_WINDOW_HTTP_KEY':'fake-local-only'}),patch('ice_agent.llm.transport.OpenAIChatTransport',return_value=self.transport):
            service.call('models.window_refresh',{'account_id':'ice-loop','provider':'qwen','limits_hash':current['limits_hash']})
            self.assertFalse(hasattr(self,'posted'))
            current=next(row for row in service.bootstrap({})['settings']['profiles'] if row['provider']=='qwen')
            service.call('models.limits_save',{'account_id':'ice-loop','provider':'qwen','limits_hash':current['limits_hash'],'max_output_tokens':2048})
            engine,_,store=service._app()
            try:
                self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],0)
                engine.router.transport=self.transport
                result=engine.router.generate(LLMRequest('writer','draft','本地协议测试'))
                self.assertEqual(result.text,'完整测试结果')
                self.assertEqual(self.posted['max_tokens'],2048)
                self.assertEqual(store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],1)
            finally:store.close()


if __name__=='__main__':unittest.main()
