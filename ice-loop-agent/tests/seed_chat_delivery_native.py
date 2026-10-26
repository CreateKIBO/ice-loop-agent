"""Owned chat delivery/clarification fixtures. Offline mock, real SQLite and IPC."""
import copy,json,os,sys,time
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.router import RoleRouter,LLMResponse
from ice_agent.paths import atomic_write_text
root=repo/'.test-tmp/release-chat-delivery'/uuid4().hex[:12];runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"chat acceptance and editable clarification native test"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
def wait(cid):
    for _ in range(200):
        result=service.call('chat.get',{'conversation_id':cid})
        if not any(row['status']=='streaming' for row in result['messages']):return result
        time.sleep(.05)
    raise AssertionError('seed reply did not settle')
try:
    aid=service._account()['id'];profile=preset_profile('mock',profile_id='delivery-offline')
    profile.update(status='verified',api_key_env='')
    service.settings['profiles']={'offline':profile};service.settings['max_chat_calls']=1
    for route in service.settings['routes'].values():route.update(primary='delivery-offline',fallbacks=[])
    cases={}
    for key,title in [('rapid','发送连点验收'),('lost','回执丢失验收'),('reload','重启核对验收'),('cancel','排队取消验收'),('switch','跨号发送验收'),('question','澄清初稿验收'),('failed','失败重试验收'),('budget','预算回执验收')]:
        cases[key]=service.call('chat.create',{'title':title,'series':'PY'})['conversation']['id']
    question={'reply':'请确认两个关键问题，原始要求会保留。','title':'','body':'','prompts':[],'questions':[
        {'id':'reader','question':'这篇文章面向哪类读者？','options':['零基础读者','有编程基础的读者']},
        {'id':'example','question':'你希望使用什么案例？','options':['九九乘法表','倒计时']} ]}
    with patch.object(RoleRouter,'generate',return_value=LLMResponse('reply',data=question)):
        service.call('chat.send',{'conversation_id':cases['question'],'text':'请为新手写一篇完整循环入门文章，保留练习。','mode':'draft','request_id':'seed-question'});wait(cases['question'])
    with patch.object(RoleRouter,'generate',side_effect=RuntimeError('测试故障 api_key=DO_NOT_SHOW_DELIVERY_SECRET')):
        service.call('chat.send',{'conversation_id':cases['failed'],'text':'保留原要求，失败后重试初稿','mode':'draft','request_id':'seed-failed'});wait(cases['failed'])
    service.call('chat.send',{'conversation_id':cases['budget'],'text':'占用这次会话的唯一调用','request_id':'seed-budget'});wait(cases['budget'])
    original=service._account();other={k:copy.deepcopy(v) for k,v in original.items() if k!='id'}
    other.update(name='交付验收B号',article_root=str(root/'other-articles'),library_root='')
    bid=service.accounts_save({'account':other})['saved_account_id']
    other_cid=service.call('chat.create',{'title':'B号独占会话'})['conversation']['id']
    service.call('accounts.switch',{'account_id':aid})
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    observed=root/'requests.jsonl';trace=root/'invocations.jsonl';fault=root/'fault.json';fault.write_text('{}')
    entry=root/'chat-delivery-main.cjs'
    entry.write_text("const {app,ipcMain,BrowserWindow}=require('electron');app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));"+
        "require("+json.dumps(str(repo/'desktop/tests/ipc-observer.cjs'))+").observeIpc({ipcMain,BrowserWindow,observed:"+json.dumps(str(observed))+",trace:"+json.dumps(str(trace))+",fault:"+json.dumps(str(fault))+"});require("+json.dumps(str(repo/'desktop/main.cjs'))+");",encoding='utf-8')
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(entry),'observed':str(observed),'trace':str(trace),'fault':str(fault),'account_a':aid,'account_b':bid,'other_conversation':other_cid,'cases':cases,'offline':True}
    (repo/'docs/上线准备/chat-delivery-fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'runtime':str(runtime),'root':str(root)}))
finally:service.close()
