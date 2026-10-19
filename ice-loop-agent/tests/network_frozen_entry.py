"""Fixed-loopback packaged probe; never accepts arbitrary endpoints or keys."""
import json,os,sys,threading,time
sys.stdout.reconfigure(encoding='utf-8')
from ice_agent.domain.types import ModelProfile
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.router import RoleRouter,RouteConfig,LLMRequest
from ice_agent.llm.transport import OpenAIChatTransport
from ice_agent.llm.http_io import scheduler
from ice_agent.llm.errors import ModelError

port=int(sys.argv[1]);mode=sys.argv[2]
assert 0<port<65536 and mode in ('valid','cancel','timeout','tls')
os.environ['ICE_FROZEN_FAKE_KEY']='fake-local-only'
profile=preset_profile('qwen',profile_id='frozen-local-only')
profile.update(base_url=f'http://127.0.0.1:{port}/{mode}',api_key_env='ICE_FROZEN_FAKE_KEY',model_id='local-fixture')
if mode=='tls':
    tls_port=int(sys.argv[3]);assert 0<tls_port<65536
    profile['base_url']=f'https://127.0.0.1:{tls_port}'
router=RoleRouter({'p':ModelProfile(**profile)},{'writer':RouteConfig('p')},transport=OpenAIChatTransport(allow_loopback_http=True))
token=threading.Event();router.cancelled=token.is_set
if mode!='valid':
    saved=router.profiles['p'].base_url
    router.profiles['p'].base_url=f'http://127.0.0.1:{port}/valid'
    router.generate(LLMRequest('writer','draft','warm up local components',stream=True,timeout=10))
    router.profiles['p'].base_url=saved
timer=threading.Timer(.3,token.set) if mode in ('cancel','tls') else None
if timer:timer.start()
started=time.monotonic();result={}
try:
    response=router.generate(LLMRequest('writer','draft','fixed local probe',stream=True,timeout=.35 if mode=='timeout' else 10))
    result={'text':response.text,'finish_reason':response.finish_reason,'code':'ok'}
except ModelError as exc:result={'code':exc.code}
finally:
    if timer:timer.cancel();timer.join()
result.update(elapsed_ms=round((time.monotonic()-started)*1000,2),active_requests=scheduler().active,frozen=bool(getattr(sys,'frozen',False)),warmup_excluded=mode!='valid')
print(json.dumps(result,ensure_ascii=False))
assert result['code']=={'valid':'ok','cancel':'CANCELLED','tls':'CANCELLED','timeout':'MODEL_TIMEOUT'}[mode] and result['active_requests']==0
