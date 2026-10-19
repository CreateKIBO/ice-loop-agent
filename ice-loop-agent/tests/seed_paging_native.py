"""Owned realistic large-catalogue fixture with IPC metadata-only observations."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.llm.capabilities import preset_profile
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-paging'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"editorial paging and history memory acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    first=service._account();service.accounts_save({'account':{**first,'library_root':''}})
    account={k:v for k,v in first.items() if k!='id'}
    account.update(preset='general',name='纸间观察 · 长期排期',audience='日常观察的读者',library_root='',article_root=str(root/'observations'),
        columns=[{'code':'OBS','name':'观察手记'},{'code':'LAB','name':'实践记录'}])
    aid=service.accounts_save({'account':account})['saved_account_id']
    store=Store(runtime/'app.db')
    try:
        topic_rows=[(f'paging-topic-{i}',aid,'OBS',i,f'观察排期 {i:04}', '内容角度'*40,'读者收益'*200,'预告说明'*200,'独占长期样本','2026-10-18') for i in range(1,2001)]
        store.conn.executemany('INSERT INTO editorial_topics VALUES (?,?,?,?,?,?,?,?,?,?)',topic_rows)
        for i in range(1,1501):
            identifier=f'paging-history-{i:04}'
            body=f'# 观察历史 {i:04}\n\n'+'真实资料的独占样本。'*1000+f'\n\n正文尾部 {i:04}\n'
            store.conn.execute('INSERT INTO publication_history VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (identifier,aid,identifier,'OBS',i,f'观察历史 {i:04}',body,'published' if i<=1490 else 'draft','2026-10-01' if i<=1490 else '',1,'2026-10-18'))
        store.conn.execute('INSERT INTO editorial_topics VALUES (?,?,?,?,?,?,?,?,?,?)',('paging-lab-topic',aid,'LAB',2000,'其他栏目不能混入','','','','样本','2026-10-18'))
        store.conn.commit()
    finally:store.close()
    profile=preset_profile('mock',profile_id='paging-offline-fixture')
    profile.update(api_key_env='ICE_PAGING_FAKE_KEY',status='verified',model_id='offline-paging-only')
    service.settings['profiles']={'offline':profile}
    for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    wrapper=root/'paging-main.cjs'
    atomic_write_text(wrapper,"""'use strict';
process.env.ICE_PAGING_FAKE_KEY='fixture-only-never-a-real-key';
const fs=require('node:fs'),path=require('node:path'),{ipcMain}=require('electron');
const register=ipcMain.handle.bind(ipcMain),file=path.join(__dirname,'ipc-observations.jsonl');
ipcMain.handle=(channel,handler)=>register(channel,channel==='ice:request'?async(event,method,params)=>{
 const start=Date.now();const result=await handler(event,method,params);
 if(['outlines.list','outlines.match','outlines.save','history.list','history.get','planning.context'].includes(method)){
  const row={method,params,elapsed_ms:Date.now()-start,bytes:Buffer.byteLength(JSON.stringify(result)),rows:Array.isArray(result)?result.length:result.rows?.length,
   topic:result.topic?{series:result.topic.series,episode:result.topic.episode}:null,available:result.available?.length,history:result.history?.length,titles:result.known_titles?.length};
  fs.appendFileSync(file,JSON.stringify(row)+'\\n');
 }return result;
}:handler);
require(MAIN);
""".replace('MAIN',json.dumps(str(repo/'desktop/main.cjs'))))
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(wrapper),'account_id':aid,'topics':2000,'history':1500,
        'observations':str(root/'ipc-observations.jsonl'),'observation_only':True}
    atomic_write_text(repo/'docs/上线准备/paging-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
