"""Owned synthetic fixture for GLM interaction acceptance; no cloud or personal data."""
import json, os, sys
from pathlib import Path
from uuid import uuid4
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
root=repo/'.test-tmp/release-glm-review'/uuid4().hex[:12]
runtime=root/'runtime'; runtime.mkdir(parents=True)
(root/'.test-owner.json').write_text('{"purpose":"GLM interaction review"}',encoding='utf-8')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    cid=service.call('chat.create',{'title':'GLM交互验收长会话'})['conversation']['id']
    small=service.call('chat.create',{'title':'GLM交互验收短会话'})['conversation']['id']
    _,_,store=service._app()
    try:
        for i in range(2000):
            text=f'## 验收消息 {i}\n\n'+('用于检验查找、消息测量与滚动保持的合成段落。\n\n'*25)
            if i in (1960,1970,1980,1990): text+='\nREVIEW_NEEDLE\n'
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',(f'review-{i}',cid,'assistant',text,'completed','{}','2026-10-20T00:00:00Z'))
        for i in range(8):
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',(f'review-short-{i}',small,'assistant',f'短会话对照 {i}','completed','{}','2026-10-20T00:00:00Z'))
        store.conn.execute("INSERT INTO agent_runs (run_id,account_id,conversation_id,trigger,status,created_at) VALUES (?,?,?,?,?,?)", ('review-poll-run','ice-loop',cid,'synthetic','running','2026-10-20T00:00:00Z'))
        store.conn.commit()
        store.append_stream_event('chat:'+cid,'ice-loop','tool.started',{'tool':'synthetic_fixture'})
    finally: store.close()
    observed=root/'browser-ipc.jsonl'
    entry=root/'review-main.cjs'
    entry.write_text("const fs=require('node:fs');const {app,ipcMain,BrowserWindow}=require('electron');"
        "app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));"
        "const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(...args)=>{"
        "const result=await fn(...args);if(channel.startsWith('ice:browser-')){const owner=BrowserWindow.getAllWindows()[0];"
        "const ids=owner?.contentView.children.map(v=>v.webContents.id)||[];"
        f"fs.appendFileSync({json.dumps(str(observed))},JSON.stringify({{channel,ids}})+'\\n');}}"
        "if(channel==='ice:request'&&['events.poll','agent.runs_list'].includes(args[1])){"
        f"fs.appendFileSync({json.dumps(str(observed))},JSON.stringify({{method:args[1],latest:result.latest||0}})+'\\n');}}return result;}});"
        f"require({json.dumps(str(repo/'desktop/main.cjs'))});",encoding='utf-8')
    fixture={'root':str(root),'runtime':str(runtime),'conversation':cid,'small':small,'entry':str(entry),'observed':str(observed)}
    path=repo/'docs/上线准备/glm-review-fixture.json'
    path.write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(fixture,ensure_ascii=False))
finally: service.close()
