"""Real loopback faults: headers/body stalls, cancellation, deadlines and bytes."""
import gzip
import json
import socket
import socketserver
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.llm.errors import ModelError,IncompleteResponseError,RequestTimeoutError
from ice_agent.llm.http_io import request_control,scheduler
from ice_agent.llm.http_backend import configured_proxy
from ice_agent.llm.router import LLMRequest,RoleRouter,RouteConfig
from ice_agent.llm.transport import OpenAIChatTransport,_SSEReader,MAX_SSE_EVENT_BYTES
from tests import REPO,temp_dir
from tests.test_router import make_profile


class NetworkFixture(unittest.TestCase):
    def setUp(self):
        self.arrived=threading.Event();self.disconnected=threading.Event();self.requests=[]
        self.first_delivered=threading.Event();self.first_before_tail=False
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def do_GET(self):self.do_POST()
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')))
                owner.requests.append(self.path);owner.arrived.set()
                mode=self.path.split('/')[1]
                try:
                    if mode!='headers':
                        self.send_response(200)
                        self.send_header('Content-Type','application/json' if mode in ('json','gzip','gzip-bomb') else 'text/event-stream')
                        if mode in ('gzip','gzip-bomb'):self.send_header('Content-Encoding','gzip')
                        self.send_header('Connection','close');self.end_headers();self.wfile.flush()
                    if mode in ('headers','silent','partial','json'):
                        if mode=='partial':self.wfile.write(b'data: {"choices":');self.wfile.flush()
                        if mode=='json':self.wfile.write(b'{');self.wfile.flush()
                        self.connection.settimeout(5)
                        if self.connection.recv(1)==b'':owner.disconnected.set()
                    elif mode=='heartbeat':
                        for _ in range(100):self.wfile.write(b': ping\n\n');self.wfile.flush();time.sleep(.025)
                    elif mode=='oversized':
                        self.wfile.write(b'data: ')
                        for _ in range(256):self.wfile.write(b'x'*16384);self.wfile.flush()
                    elif mode=='gzip':
                        raw=json.dumps({'choices':[{'message':{'content':'完整压缩回复'},'finish_reason':'stop'}]},ensure_ascii=False).encode()
                        self.wfile.write(gzip.compress(raw));self.wfile.flush()
                    elif mode=='gzip-bomb':
                        # Streaming compression never allocates a giant server-side string.
                        import zlib
                        compressor=zlib.compressobj(wbits=31)
                        for _ in range(256):self.wfile.write(compressor.compress(b'x'*65536))
                        self.wfile.write(compressor.flush());self.wfile.flush()
                    else:
                        for text in ('第一段。','第二段。'):
                            payload='data: '+json.dumps({'choices':[{'delta':{'content':text}}]},ensure_ascii=False)+'\n\n'
                            encoded=payload.encode()
                            # Split multibyte UTF8 and SSE delimiters across writes.
                            for start in range(0,len(encoded),7):self.wfile.write(encoded[start:start+7]);self.wfile.flush()
                            if mode=='incremental' and text=='第一段。':owner.first_before_tail=owner.first_delivered.wait(.75)
                        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError,socket.timeout,OSError):
                    owner.disconnected.set()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.transport=OpenAIChatTransport(allow_loopback_http=True)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(3)
        self.assertFalse(self.thread.is_alive())
        for _ in range(100):
            if scheduler().active==0:break
            time.sleep(.01)
        self.assertEqual(scheduler().active,0)

    def call(self,mode,**kwargs):
        return self.transport.chat(self.base+'/'+mode,'fake-local-only','fixture-model',[{'role':'user','content':'test'}],**kwargs)

    def test_cancel_closes_socket_before_headers_and_while_waiting_for_body(self):
        for mode in ('headers','silent','partial'):
            with self.subTest(mode=mode):
                self.arrived.clear();self.disconnected.clear()
                token=threading.Event();result={}
                def generate():
                    try:
                        with request_control(token.is_set):self.call(mode,stream=True,timeout=10)
                    except ModelError as exc:result['code']=exc.code
                worker=threading.Thread(target=generate);worker.start()
                self.assertTrue(self.arrived.wait(3))
                started=time.monotonic();token.set();worker.join(2)
                self.assertFalse(worker.is_alive());self.assertLess(time.monotonic()-started,1.5)
                self.assertEqual(result['code'],'CANCELLED');self.assertTrue(self.disconnected.wait(1))

    def test_deadline_includes_headers_silent_partial_and_nonstreamed_body(self):
        for mode,stream in (('headers',True),('silent',True),('partial',True),('json',False),('heartbeat',True)):
            with self.subTest(mode=mode):
                started=time.monotonic()
                with self.assertRaises(RequestTimeoutError):self.call(mode,stream=stream,timeout=.3)
                self.assertLess(time.monotonic()-started,1.5)

    def test_valid_stream_is_incremental_utf8_complete_and_callback_stays_in_caller(self):
        caller=threading.get_ident();callbacks=[]
        def received(text):
            callbacks.append((text,threading.get_ident()));self.first_delivered.set()
        result=self.call('incremental',stream=True,on_delta=received)
        self.assertEqual(result.content,'第一段。第二段。')
        self.assertEqual(callbacks,[('第一段。',caller),('第二段。',caller)])
        self.assertTrue(self.first_before_tail)

    def test_oversized_sse_event_is_rejected_before_unbounded_line_read(self):
        with self.assertRaisesRegex(IncompleteResponseError,'单个流式事件'):self.call('oversized',stream=True)

    def test_compressed_json_is_supported(self):
        self.assertEqual(self.call('gzip').content,'完整压缩回复')

    def test_compressed_response_cannot_bypass_decoded_size_bound(self):
        with self.assertRaisesRegex(IncompleteResponseError,'字节大小'):self.call('gzip-bomb')

    def test_router_cancellation_records_one_call_and_never_falls_back(self):
        root=temp_dir('network-budget-');store=Store(root/'app.db');self.addCleanup(store.close)
        primary=make_profile('qwen');primary.base_url=self.base+'/silent'
        backup=make_profile('qwen','backup');backup.base_url=self.base+'/valid'
        router=RoleRouter({'a':primary,'b':backup},{'writer':RouteConfig('a',['b'])},store=store,transport=self.transport)
        router.cancelled=self.arrived.is_set
        with self.assertRaises(ModelError) as caught:router.generate(LLMRequest('writer','draft','test',stream=True,timeout=3))
        self.assertEqual(caught.exception.code,'CANCELLED')
        self.assertEqual(len(self.requests),1)
        self.assertEqual(store.conn.execute('SELECT status FROM model_invocations').fetchone()[0],'CANCELLED')

    def test_total_deadline_does_not_retry_same_model_and_configured_fallback_is_complete(self):
        store=Store(temp_dir('network-fallback-')/'app.db');self.addCleanup(store.close)
        first=make_profile('qwen');first.base_url=self.base+'/partial'
        backup=make_profile('qwen','backup');backup.base_url=self.base+'/valid'
        router=RoleRouter({'a':first,'b':backup},{'writer':RouteConfig('a',['b'])},store=store,transport=self.transport)
        result=router.generate(LLMRequest('writer','draft','test',stream=True,timeout=.5))
        self.assertTrue(result.fell_back);self.assertEqual(result.text,'第一段。第二段。')
        self.assertEqual(self.requests,['/partial/chat/completions','/valid/chat/completions'])
        self.assertEqual([row[0] for row in store.conn.execute('SELECT status FROM model_invocations ORDER BY rowid')],['MODEL_TIMEOUT','ok'])

    def test_repeated_requests_do_not_accumulate_network_workers_or_connections(self):
        for _ in range(12):self.assertEqual(self.call('valid',stream=True).finish_reason,'stop')
        self.assertEqual(len([t for t in threading.enumerate() if t.name=='ice-http-io']),1)
        self.assertLessEqual(len([t for t in threading.enumerate() if t.name.startswith('ice-http-dns')]),2)
        self.assertEqual(scheduler().active,0)

    def test_desktop_stop_frees_real_network_worker_without_saving_partial(self):
        self._desktop_stop(close=False)

    def test_desktop_close_signals_and_frees_active_chat(self):
        self._desktop_stop(close=True)

    def _desktop_stop(self,*,close):
        root=temp_dir('network-desktop-')
        service=DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(service.close)
        service.accounts_save({'account':{**service._account(),'library_root':''}})
        profile=service.settings['profiles']['qwen']
        profile.update(base_url=self.base+'/partial',model_id='fixture-model',api_key_env='ICE_STOP_FAKE_KEY')
        service.settings['profiles']={'qwen':profile}
        for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
        cid=service.call('chat.create',{'series':'PY'})['conversation']['id']
        with patch.dict('os.environ',{'ICE_STOP_FAKE_KEY':'fake-local-only'}),patch('ice_agent.llm.router.OpenAIChatTransport',return_value=self.transport):
            service.call('chat.send',{'conversation_id':cid,'mode':'draft','text':'生成初稿'})
            self.assertTrue(self.arrived.wait(3))
            started=time.monotonic()
            if close:service.close()
            else:self.assertTrue(service.call('chat.stop',{'conversation_id':cid})['ok'])
            for _ in range(200):
                with service.chat_guard:pending=bool(service.chat_cancel)
                if not pending:break
                time.sleep(.01)
            self.assertFalse(pending);self.assertLess(time.monotonic()-started,2)
            self.assertTrue(self.disconnected.wait(1))
        result=service.call('chat.get',{'conversation_id':cid})
        self.assertEqual(result['messages'][-1]['status'],'stopped')
        self.assertEqual(result['candidates'],[])
        self.assertEqual(service.call('chat.drafts'),[])
        store=Store(service.runtime/'app.db')
        try:self.assertEqual(store.conn.execute('SELECT status FROM model_invocations').fetchone()[0],'CANCELLED')
        finally:store.close()

    def test_service_close_cancels_metadata_get_with_outer_request_control(self):
        root=temp_dir('network-window-close-');service=DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(service.close)
        profile=service.settings['profiles']['qwen'];profile.update(base_url=self.base+'/json',api_key_env='ICE_GET_FAKE_KEY')
        boot=service.bootstrap({});params={'account_id':'ice-loop','provider':'qwen','limits_hash':boot['settings']['profiles'][0]['limits_hash']}
        result={}
        def read():
            try:service.call('models.window_refresh',params)
            except ModelError as exc:result['code']=exc.code
        with patch.dict('os.environ',{'ICE_GET_FAKE_KEY':'fake-local-only'}),patch('ice_agent.llm.transport.OpenAIChatTransport',return_value=self.transport):
            worker=threading.Thread(target=read);worker.start();self.assertTrue(self.arrived.wait(3))
            service.close();worker.join(2);self.assertFalse(worker.is_alive())
        self.assertEqual(result['code'],'CANCELLED');self.assertTrue(self.disconnected.wait(1))

    def test_tls_handshake_wait_is_cancellable(self):
        arrived=threading.Event();closed=threading.Event()
        class TLSWait(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(3)
                self.request.recv(65536);arrived.set()
                try:
                    while self.request.recv(65536):pass
                    closed.set()
                except OSError:closed.set()
        server=socketserver.ThreadingTCPServer(('127.0.0.1',0),TLSWait);server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        token=threading.Event();result={}
        def run():
            try:
                with request_control(token.is_set):self.transport.chat(f'https://127.0.0.1:{server.server_address[1]}','fake','fixture',[],timeout=5)
            except ModelError as exc:result['code']=exc.code
        worker=threading.Thread(target=run);worker.start()
        try:
            self.assertTrue(arrived.wait(3));token.set();worker.join(2)
            self.assertFalse(worker.is_alive());self.assertEqual(result['code'],'CANCELLED');self.assertTrue(closed.wait(1))
        finally:token.set();server.shutdown();server.server_close();thread.join(3);worker.join(3)

    def test_blocked_dns_does_not_block_caller_cancellation_or_spawn_per_request_threads(self):
        arrived=threading.Event();release=threading.Event();token=threading.Event();result={}
        original=socket.getaddrinfo
        def blocked(host,*args,**kwargs):
            if host=='network-fixture.invalid':arrived.set();release.wait(3);return original('127.0.0.1',*args,**kwargs)
            return original(host,*args,**kwargs)
        def run():
            try:
                with request_control(token.is_set):self.transport.chat('https://network-fixture.invalid','fake','fixture',[],timeout=5)
            except ModelError as exc:result['code']=exc.code
        with patch('socket.getaddrinfo',side_effect=blocked):
            worker=threading.Thread(target=run);worker.start()
            try:
                self.assertTrue(arrived.wait(3));token.set();worker.join(2)
                self.assertFalse(worker.is_alive());self.assertEqual(result['code'],'CANCELLED')
                self.assertLessEqual(len([t for t in threading.enumerate() if t.name.startswith('ice-http-dns')]),2)
            finally:release.set();worker.join(3)


class TestSSEBounds(unittest.TestCase):
    def test_nested_controls_preserve_outer_cancellation(self):
        with request_control(lambda:True),request_control(lambda:False),self.assertRaises(ModelError) as caught:
            OpenAIChatTransport().chat('https://network-fixture.invalid','fake','fixture',[])
        self.assertEqual(caught.exception.code,'CANCELLED')

    def test_configured_proxy_and_port_bypass_are_preserved(self):
        with patch('urllib.request.getproxies',return_value={'https':'http://proxy.invalid:8080'}),patch('urllib.request.proxy_bypass',return_value=False):
            self.assertEqual(configured_proxy('https://api.example:8443/v1'),'http://proxy.invalid:8080')
        with patch('urllib.request.proxy_bypass',return_value=True) as bypass:
            self.assertIsNone(configured_proxy('https://api.example:8443/v1'))
            bypass.assert_called_once_with('api.example:8443')

    def test_multiline_json_events_and_usage(self):
        parser=_SSEReader()
        parser.feed(b'data: {"choices":\ndata: [{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":4}}\n\ndata: [DONE]\n\n')
        self.assertEqual(parser.result().content,'ok');self.assertEqual(parser.usage,{'prompt_tokens':4})

    def test_event_limit_counts_utf8_bytes(self):
        parser=_SSEReader()
        with self.assertRaises(IncompleteResponseError):
            for _ in range(100):parser.feed(('中'*10000).encode())
        self.assertLessEqual(len(parser.buffer),MAX_SSE_EVENT_BYTES+30000)

    def test_malformed_structures_fail_as_model_errors(self):
        for event in ([],{'choices':{}},{'choices':[None]},{'choices':[{'delta':{'content':[1]}}]},
                      {'choices':[{'delta':{'content':'\ud800'}}]}):
            with self.subTest(event=event),self.assertRaises(ModelError):
                parser=_SSEReader();parser.feed(('data: '+json.dumps(event)+'\n\n').encode());parser.result()


if __name__=='__main__':unittest.main()
