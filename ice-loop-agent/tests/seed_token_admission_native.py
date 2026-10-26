"""Real chat/router/settings fixtures; provider count and completion are offline doubles."""
import json, os, sys, time
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.transport import OpenAIChatTransport, ChatResult
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-token-admission'/uuid4().hex[:12];runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"offline token settings and chat receipt acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    service.accounts_save({'account':{**service._account(),'library_root':''}})
    profile=preset_profile('bigmodel',profile_id='offline-token-fixture')
    profile.update(api_key_env='ICE_TOKEN_NATIVE_FAKE',status='verified')
    profile['extra']={'max_output_tokens':20,'token_check':'required','context_window_override':{
        'base_url':profile['base_url'],'model_id':profile['model_id'],'context_window':100,'source':'user'}}
    service.settings['profiles']={'bigmodel':profile}
    for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
    conversation=service.call('chat.create',{'title':'Token 预检回执验收'})['conversation']['id']
    def wait_reply():
        for _ in range(300):
            result=service.call('chat.get',{'conversation_id':conversation})
            if not any(row['status']=='streaming' for row in result['messages']):return result
            time.sleep(.02)
        raise RuntimeError('fixture chat did not settle')
    with patch.dict(os.environ,{'ICE_TOKEN_NATIVE_FAKE':'fake-never-real'}),patch.object(OpenAIChatTransport,'count_tokens',return_value=10),patch.object(OpenAIChatTransport,'chat',return_value=ChatResult(content='本条回复已完成输入加输出预留的离线契约核验。',finish_reason='stop')):
        service.call('chat.send',{'conversation_id':conversation,'text':'讨论文章观点'})
        first=wait_reply()['messages'][-1]
        assert first['metadata']['input_preflight']['state']=='checked'
    with patch.dict(os.environ,{'ICE_TOKEN_NATIVE_FAKE':'fake-never-real'}),patch.object(OpenAIChatTransport,'count_tokens',return_value=95),patch.object(OpenAIChatTransport,'chat') as completion:
        service.call('chat.send',{'conversation_id':conversation,'text':'继续讨论另一个观点'})
        blocked=wait_reply()['messages'][-1]
        assert blocked['metadata']['input_preflight']['state']=='blocked'
        completion.assert_not_called()
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    entry=root/'token-main.cjs'
    atomic_write_text(entry,"const {app}=require('electron');app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));process.env.ICE_TOKEN_NATIVE_FAKE='fake-never-real';require("+json.dumps(str(repo/'desktop/main.cjs'))+");")
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(entry),'conversation':conversation,'completed_message':first['id'],'blocked_message':blocked['id'],'scope':'real router and persistence; count/chat offline doubles; no cloud'}
    atomic_write_text(repo/'docs/上线准备/token-admission-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:
    service.workers.shutdown(wait=True)
    service.close()
