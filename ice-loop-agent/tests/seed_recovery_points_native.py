"""Owned pre-upgrade workspaces; selection/dialogs redirected, no user data."""
import json,runpy,sqlite3,sys,os
from contextlib import closing
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
runpy.run_path(str(repo/'tests/seed_backup_native.py'),run_name='__main__')
from tests.schema_fixtures import downgrade_to_19
from ice_agent.backup import restore_backup,inspect_backup,digest
f=json.loads((repo/'docs/上线准备/backup-fixture.json').read_text(encoding='utf-8'))
root=Path(f['root']);original=Path(f['runtime'])
package=root/'base.zip';summary=inspect_backup(package,temporary_root=root)
runtime=original
settings=json.loads((runtime/'settings.json').read_text(encoding='utf-8'))
# Real incompressible managed data keeps startup long enough to observe its UI.
file=Path(settings['article_root'])/'large-test-asset.bin';file.parent.mkdir(parents=True,exist_ok=True)
with file.open('wb') as stream:
    for _ in range(48):stream.write(os.urandom(1024*1024))
with closing(sqlite3.connect(runtime/'app.db')) as db:
    downgrade_to_19(db);db.commit();db.execute('PRAGMA journal_mode=DELETE')
cancelled=restore_backup(package,root/'auto-cancel',summary['package_hash'])
cancel_runtime=Path(cancelled['runtime_root'])
cancel_settings=json.loads((cancel_runtime/'settings.json').read_text(encoding='utf-8'))
import shutil
cancel_asset=Path(cancel_settings['article_root'])/'large-test-asset.bin';cancel_asset.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(file,cancel_asset)
with closing(sqlite3.connect(cancel_runtime/'app.db')) as db:
    downgrade_to_19(db);db.commit();db.execute('PRAGMA journal_mode=DELETE')
wrapper=runtime.parent/'recovery-points-main.cjs'
wrapper.write_text(r"""'use strict';
const fs=require('node:fs'),path=require('node:path'),{dialog}=require('electron');
const ownedRoot=OWNED_ROOT;
const project=PROJECT,selected=path.join(project,'.desktop-data-path.json'),redirect=path.join(ownedRoot,'selection.json');
const remap=v=>typeof v==='string'&&(v===selected||v.startsWith(selected+'.'))?redirect+v.slice(selected.length):v;
for(const name of ['existsSync','statSync','readFileSync','writeFileSync','unlinkSync']){const orig=fs[name];fs[name]=function(file,...args){return orig.call(fs,remap(file),...args);};}
const rename=fs.renameSync;fs.renameSync=(a,b)=>rename.call(fs,remap(a),remap(b));
const plan=()=>{const file=path.join(ownedRoot,'recovery-dialogs.json');const values=JSON.parse(fs.readFileSync(file));const next=values.shift();if(!next)throw Error('Unexpected recovery dialog');fs.writeFileSync(file,JSON.stringify(values));return next;};
dialog.showOpenDialog=async()=>plan();dialog.showMessageBox=async()=>plan();
const {StartupProgress}=require(path.join(project,'desktop/startup-progress.cjs'));
const accept=StartupProgress.prototype.accept;StartupProgress.prototype.accept=function(value){if(value?.kind==='startup.progress')fs.appendFileSync(path.join(ownedRoot,'startup-phases.jsonl'),JSON.stringify(value)+'\n');return accept.call(this,value);};
const show=StartupProgress.prototype.show;StartupProgress.prototype.show=async function(){await show.call(this);try{
 const view=this.view;
 const text=await view.webContents.executeJavaScript(`new Promise(resolve=>{let left=100;const ready=()=>{if(document.querySelector('.ice-startup h1')&&Number(getComputedStyle(document.querySelector('.ice-startup section')).opacity)>.99)requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(document.body.innerText)));else if(left-->0)setTimeout(ready,20);else resolve('missing startup');};ready();})`);
 fs.writeFileSync(path.join(ownedRoot,'startup-dom.txt'),text);
 fs.writeFileSync(path.join(ownedRoot,'startup-wait.png'),(await view.webContents.capturePage()).toPNG());
 if(fs.existsSync(path.join(ownedRoot,'cancel-startup-once')))await view.webContents.executeJavaScript(`document.querySelector('button').click()`);
 }catch(error){fs.writeFileSync(path.join(ownedRoot,'startup-capture-error.txt'),String(error.stack));}};
require(path.join(project,'desktop/main.cjs'));
""".replace('PROJECT',json.dumps(str(repo))).replace('OWNED_ROOT',json.dumps(str(root))),encoding='utf-8')
cancel_entry=cancel_runtime.parent/'recovery-points-main.cjs';shutil.copyfile(wrapper,cancel_entry)
f['cancel_entry']=str(cancel_entry)
(root/'recovery-dialogs.json').write_text('[]')
f.update(cancel_runtime=str(cancel_runtime),cancel_database_hash=digest(cancel_runtime/'app.db'),runtime=str(runtime),entry=str(wrapper),original_database_hash=digest(runtime/'app.db'),large_file=str(file),large_hash=digest(file))
(repo/'docs/上线准备/recovery-points-fixture.json').write_text(json.dumps(f,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'runtime':str(runtime),'root':str(root)}))
