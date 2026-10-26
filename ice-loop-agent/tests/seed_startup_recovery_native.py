"""Fresh controlled native startup failures; personal selection file always redirected."""
import json
from pathlib import Path
import runpy
import shutil
import sqlite3
from contextlib import closing

repo = Path(__file__).resolve().parents[1]
runpy.run_path(str(repo / 'tests/seed_backup_native.py'))
f = json.loads((repo / 'docs/上线准备/backup-fixture.json').read_text(encoding='utf-8'))
root, runtime = Path(f['root']), Path(f['runtime'])
# Original valid backup uses a deterministic owned name; never touch user archives.
f['package'] = str(root / 'base.zip')
for kind in ('future', 'checksum'):
    target = root / kind
    shutil.copytree(runtime, target)
    with closing(sqlite3.connect(target / 'app.db')) as db:
        if kind == 'future':
            db.execute('PRAGMA user_version=9999')
        else:
            db.execute("UPDATE schema_migrations SET checksum='native-drift' WHERE version=19")
        db.commit()
        db.execute('PRAGMA journal_mode=DELETE')
wrapper = root / 'startup-main.cjs'
wrapper.write_text(r"""'use strict';
const fs=require('node:fs'),path=require('node:path'),{app,dialog}=require('electron');
const project=PROJECT,selected=path.join(project,'.desktop-data-path.json'),redirect=path.join(__dirname,'selection.json');
const remap=value=>typeof value==='string'&&(value===selected||value.startsWith(selected+'.'))?redirect+value.slice(selected.length):value;
for(const name of ['existsSync','statSync','readFileSync','writeFileSync','unlinkSync']){const original=fs[name];fs[name]=function(file,...args){return original.call(fs,remap(file),...args);};}
const rename=fs.renameSync;fs.renameSync=(from,to)=>rename.call(fs,remap(from),remap(to));
const pick=(kind,options)=>{
 const file=path.join(__dirname,'startup-plan.json'),plan=JSON.parse(fs.readFileSync(file)),next=plan.shift();
 fs.appendFileSync(path.join(__dirname,'startup-dialogs.jsonl'),JSON.stringify({kind,title:options.title,message:options.message,detail:options.detail})+'\n');
 if(!next||next.kind!==kind)throw Error('Unexpected startup dialog '+kind+' '+options.title);
 if(next.title&&next.title!==options.title)throw Error('Unexpected startup dialog title '+options.title);
 fs.writeFileSync(file,JSON.stringify(plan));return next;
};
dialog.showOpenDialog=async(...args)=>pick('open',args.at(-1));
dialog.showMessageBox=async(...args)=>pick('message',args.at(-1));
dialog.showErrorBox=(title)=>{fs.writeFileSync(path.join(__dirname,'unexpected-error-box'),title);app.exit(2);};
app.relaunch=()=>fs.writeFileSync(path.join(__dirname,'relaunch-requested'),JSON.stringify({runtime_override:process.env.ICE_DESKTOP_RUNTIME??null}));
const recovery=require(path.join(project,'desktop/startup-recovery.cjs')),resolve=recovery.resolveWorkspace;
recovery.resolveWorkspace=options=>resolve({...options,fallback:path.join(__dirname,'fallback')});
require(path.join(project,'desktop/main.cjs'));
""".replace('PROJECT',json.dumps(str(repo))), encoding='utf-8')
f.update(entry=str(wrapper), synthetic_startup_faults=True, profile=str(root / '.ice-startup-recovery'))
(repo / 'docs/上线准备/startup-recovery-fixture.json').write_text(json.dumps(f, ensure_ascii=False, indent=2),encoding='utf-8')
print(json.dumps({'runtime':f['runtime'], 'entry':f['entry'], 'root':f['root']}))
