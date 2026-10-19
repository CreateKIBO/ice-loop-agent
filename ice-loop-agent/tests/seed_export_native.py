"""Owned export integration fixture; OS directory dialog responses are injected."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4
from PIL import Image

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.paths import atomic_write_text
from ice_agent.export.markdown_content import run_text
from tests.test_workflow import demo_spec

root=repo/'.test-tmp/release-export'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"native export integration acceptance; OS dialogs injected"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):os.environ.pop(key,None)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
engine,_,store=service._app(demo=True)
try:
    job,article=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop'})
    result=engine.run(job,auto_approver=lambda scope,payload:('approve','offline export fixture only',None))
    assert result['state']=='completed',result
    for index,slot in enumerate(store.article_slots(article)):
        suffix,fmt=[('.png','PNG'),('.jpg','JPEG'),('.webp','WEBP')][index%3]
        file=root/f'figure-{slot["figure_no"]}{suffix}'
        Image.new('RGB',(640,360),(36+index*15,72,180)).save(file,fmt)
        engine.import_asset(job,slot['figure_no'],file,accept=True)
    state=engine._load_state(job)
    run_id='run-export-fixture'
    record=next(iter(state['runs'].values()))
    state['runs'][run_id]=dict(record)
    state['integrated_md']+='\n\n<!--RUN_OUTPUT:'+run_id+'-->\n'
    engine._save_state(job,state)
    # The demo leaves its arithmetic claim qualified; exercise the real manual
    # verification API for this known fixture rather than bypassing ready rules.
    for claim in store.article_claims(article):
        if claim['status']!='verified':
            assert claim['text']=='九九乘法表按 1×1 到 9×9 计共 45 个算式',claim['text']
            assert sum(range(1,10))==45
            service.call('claims.verify',{'job_id':job,'claim_id':claim['claim_id'],
                'url':'https://docs.python.org/3/library/functions.html#sum',
                'evidence':'本地验收夹具实际计算sum(range(1,10))为45。Python官方sum说明对可迭代对象进行求和，故三角乘法表行数之和为45。'})
    snapshot=service.call('articles.delivery_snapshot',{'job_id':job})
    atomic_write_text(root/'snapshot.json',json.dumps(snapshot,ensure_ascii=False,indent=2))
    print('fixture='+str(root))
    assert not snapshot['blocking'],snapshot['blocking']
    parent=root/'exports';parent.mkdir()
    plan=root/'dialog-plan.json'
    atomic_write_text(plan,json.dumps([{'canceled':True,'filePaths':[]},
        {'canceled':False,'filePaths':[str(parent)]},{'canceled':False,'filePaths':[str(parent)]}]))
    preload=root/'export-dialog-fixture.cjs'
    atomic_write_text(preload,"""'use strict';
if(process.type==='browser'){
 const fs=require('node:fs'),path=require('node:path'),{dialog,shell}=require('electron');
 const plan=path.join(__dirname,'dialog-plan.json'),record=path.join(__dirname,'dialog-observations.json');
 const add=value=>{const rows=fs.existsSync(record)?JSON.parse(fs.readFileSync(record,'utf8')):[];rows.push(value);fs.writeFileSync(record,JSON.stringify(rows,null,2));};
 dialog.showOpenDialog=async(_window,options)=>{const choices=JSON.parse(fs.readFileSync(plan,'utf8')),choice=choices.shift();if(!choice)throw Error('Unexpected extra directory dialog');fs.writeFileSync(plan,JSON.stringify(choices));add({kind:'directory',title:options.title,properties:options.properties,canceled:choice.canceled});return choice;};
 shell.openPath=async folder=>{add({kind:'shell-open',folder});return '';};
}
"""+'require('+json.dumps(str(repo/'desktop/main.cjs'))+');\n')
    fixture={'runtime':str(runtime),'job':job,'article':article,'preload':str(preload),'export_parent':str(parent),
        'body_hash':snapshot['body_hash'],'output':run_text(record),'image_count':len(store.article_slots(article)),
        'dialog_observations':str(root/'dialog-observations.json'),'os_dialog_injected':True,'shell_open_injected':True}
    atomic_write_text(repo/'docs/上线准备/export-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps({key:value for key,value in fixture.items() if key!='output'},ensure_ascii=False))
finally:store.close();service.close()
