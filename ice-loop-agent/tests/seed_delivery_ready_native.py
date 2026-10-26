"""Real ready-delivery fixture; reuses export fixture without bypassing domain gates."""
import json,runpy,sys
from pathlib import Path
from PIL import Image
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
runpy.run_path(str(repo/'tests/seed_export_native.py'),run_name='__main__')
from ice_agent.desktop_service import DesktopService
from ice_agent.paths import atomic_write_text
f=json.loads((repo/'docs/上线准备/export-fixture.json').read_text(encoding='utf-8'))
root=Path(f['runtime']).parent
s=DesktopService(repo,Path(f['runtime']),root/'articles',auto_consumer=False)
try:
    e,_,st=s._job_app(f['job'])
    try:
        first=st.article_slots(f['article'])[0]
        p=root/'figure-alternate.png';Image.new('RGB',(640,360),'#38A675').save(p)
        candidate=e.import_asset(f['job'],first['figure_no'],p,accept=False)
        f['alternate']={'candidate':candidate['candidate_id'],'figure':first['figure_no']}
    finally:st.close()
finally:s.close()
f['root']=str(root);f['account_a']='ice-loop'
f['fault']=str(root/'delivery-fault.json');atomic_write_text(Path(f['fault']),'{}')
f['trace']=str(root/'delivery-trace.jsonl');f['observed']=str(root/'delivery-observed.jsonl')
f['entry']=str(root/'delivery-entry.cjs')
atomic_write_text(Path(f['entry']),
    "const {app,ipcMain,BrowserWindow}=require('electron');"
    "app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));"
    +f"require({json.dumps(str(repo/'desktop/tests/ipc-observer.cjs'))}).observeIpc({{ipcMain,BrowserWindow,observed:{json.dumps(f['observed'])},trace:{json.dumps(f['trace'])},fault:{json.dumps(f['fault'])}}});"
    +f"require({json.dumps(f['preload'])});")
atomic_write_text(repo/'docs/上线准备/delivery-ready-fixture.json',json.dumps(f,ensure_ascii=False,indent=2))
print(json.dumps({'runtime':f['runtime'],'job':f['job'],'os_dialog_injected':True}))
