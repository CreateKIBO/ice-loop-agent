"""Owned backup acceptance; OS picker responses and selection pointer redirected explicitly."""
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from PIL import Image
from ice_agent.backup import create_backup
from ice_agent.desktop_service import DesktopService
from ice_agent.paths import atomic_write_text
from ice_agent.tasks import TaskQueue
from tests.test_workflow import demo_spec

root=repo/'.test-tmp/release-backup'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"backup restore native acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
engine,_,store=service._app(demo=True)
try:
    spec={**demo_spec(),'account_id':'ice-loop','article_root':str(root/'articles'),'demo':True,'topic':'恢复验收文章'}
    job,article=engine.create_job(spec)
    body='# 恢复验收文章\n\n这是需要保留的原稿。\n'
    state=engine._load_state(job);state.update(integrated_md=body,final_title='恢复验收文章',runs={})
    engine._save_state(job,state);store.update_job(job,state='completed',current_node='export')
    queue=TaskQueue(store)
    bound=queue.enqueue('ice-loop','production',{'spec':spec},idempotency_key='native-bound')
    queue.bind_job(bound['task_id'],job,'ice-loop')
    unbound=queue.enqueue('ice-loop','production',{'spec':{**spec,'topic':'另一篇未创建文章'}},idempotency_key='native-unbound')
    store.conn.execute("UPDATE tasks SET state='paused',error_code='RESTORE_REVIEW'");store.conn.commit()
    image=root/'input.png';Image.new('RGB',(800,480),'#2448DB').save(image)
    resource=service.call('resources.import',{'file_path':str(image)})
    atomic_write_text(runtime/'credentials.json','{"fixture":"excluded fake secret, never a real Key"}')
    package=root/'base.zip';create_backup(runtime,service.settings,package)
    bad=root/'bad.zip'
    with zipfile.ZipFile(package) as source,zipfile.ZipFile(bad,'w',zipfile.ZIP_DEFLATED) as dest:
        manifest=json.loads(source.read('manifest.json'))
        for name in manifest['files']:
            content=b'not a sqlite database' if name=='runtime/app.db' else source.read(name)
            manifest['files'][name]={'size':len(content),'sha256':hashlib.sha256(content).hexdigest()}
            dest.writestr(name,content)
        dest.writestr('manifest.json',json.dumps(manifest))
    package=root/'native-saved.zip'
    plan=[{'kind':'save','canceled':True},{'kind':'save','canceled':False,'filePath':str(package)},
          {'kind':'open','canceled':True}, {'kind':'open','canceled':False,'filePaths':[str(bad)]},
          {'kind':'open','canceled':False,'filePaths':[str(package)]},
          {'kind':'open','canceled':True}, {'kind':'open','canceled':False,'filePaths':[str(root)]}]
    atomic_write_text(root/'dialog-plan.json',json.dumps(plan))
    atomic_write_text(root/'selection.json',json.dumps({'runtime_root':str(runtime)}))
    wrapper=root/'backup-main.cjs'
    atomic_write_text(wrapper,"""'use strict';
const fs=require('node:fs'),path=require('node:path'),{dialog}=require('electron');
const project=PROJECT,selected=path.join(project,'.desktop-data-path.json'),redirect=path.join(__dirname,'selection.json');
const remap=value=>typeof value==='string'&&(value===selected||value.startsWith(selected+'.'))?redirect+value.slice(selected.length):value;
for(const name of ['existsSync','readFileSync','writeFileSync','unlinkSync']){const original=fs[name];fs[name]=function(file,...args){return original.call(fs,remap(file),...args);};}
const rename=fs.renameSync;fs.renameSync=function(from,to){if(to===selected&&fs.existsSync(path.join(__dirname,'deny-selection')))throw Error('fixture selection write denied');return rename.call(fs,remap(from),remap(to));};
const pick=(kind,options)=>{const file=path.join(__dirname,'dialog-plan.json'),plan=JSON.parse(fs.readFileSync(file)),next=plan.shift();if(!next||next.kind!==kind)throw Error('Unexpected picker '+kind);fs.writeFileSync(file,JSON.stringify(plan));return next;};
dialog.showOpenDialog=async(_window,options)=>pick('open',options);
dialog.showSaveDialog=async(_window,options)=>pick('save',options);
require(path.join(project,'desktop/main.cjs'));
""".replace('PROJECT',json.dumps(str(repo))))
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(wrapper),'package':str(package),
             'job':job,'article':article,'resource':resource['resource_id'],'image_hash':resource['sha256'],
             'bound':bound['task_id'],'unbound':unbound['task_id'],'body':body,
             'os_dialog_injected':True,'selection_pointer_redirected':True}
    atomic_write_text(repo/'docs/上线准备/backup-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:
    store.close();service.close()
