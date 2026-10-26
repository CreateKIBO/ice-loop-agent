"""Owned realistic image plus local-only heavy webpage; no cloud traffic."""
from pathlib import Path
import hashlib,json,os,runpy,sys
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo))
runpy.run_path(str(repo/'tests/seed_interaction_lists_native.py'),run_name='__main__')
from ice_agent.desktop_service import DesktopService
from PIL import Image
f=json.loads((repo/'docs/上线准备/interaction-lists-fixture.json').read_text(encoding='utf-8'))
root=Path(f['root']);image=root/'large-rgb.png'
with Image.frombytes('RGB',(3000,2000),os.urandom(3000*2000*3)) as source:source.save(image,format='PNG')
service=DesktopService(repo,Path(f['runtime']),root/'articles',auto_consumer=False)
try:
 engine,_,store=service._job_app(f['jobs']['completed'])
 try:
  asset=engine.import_asset(f['jobs']['completed'],f['assets']['figure'],image,accept=True)
  f['assets']['large']=asset['candidate_id']
 finally:store.close()
finally:service.close()
f['large_image']={'path':str(image),'bytes':image.stat().st_size,'sha256':hashlib.sha256(image.read_bytes()).hexdigest(),'width':3000,'height':2000}
entry=Path(f['entry']);text=entry.read_text(encoding='utf-8')
# Replace blanket cancellation with a builtin HTTPS protocol fixture. This never opens a socket.
old="app.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true})));"
html="""<!doctype html><meta charset=utf-8><title>离线画布准备中</title><h1>Offline canvas fixture</h1><script>
window.fixturePixels=new Uint8Array(24*1024*1024);window.fixturePixels.fill(31);
for(let n=0;n<2;n++){const c=document.createElement('canvas');c.width=c.height=2048;const ctx=c.getContext('2d');ctx.fillStyle=n?'#2448DB':'#F3F2ED';ctx.fillRect(0,0,2048,2048);document.body.append(c);}
document.title='离线画布已就绪';window.fixtureReady=true;
</script>"""
replacement="app.on('session-created',s=>{s.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(d,cb)=>cb({cancel:!['app.tapnow.media','mp.weixin.qq.com'].includes(new URL(d.url).hostname)}));s.protocol.handle('https',req=>new Response("+json.dumps(html,ensure_ascii=False)+",{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;\"}}));});"
assert old in text
stats=root/'original-grants.json';f['original_stats']=str(stats)
instrument="const imageClass=require("+json.dumps(str(repo/'desktop/original-images.cjs'))+").OriginalImages;for(const name of ['open','release','clear']){const original=imageClass.prototype[name];imageClass.prototype[name]=async function(...args){try{return await original.apply(this,args);}finally{require('node:fs').writeFileSync("+json.dumps(str(stats))+",JSON.stringify({active:this.size,opening:this.opening}));}};}"
entry.write_text(instrument+text.replace(old,replacement),encoding='utf-8')
(repo/'docs/上线准备/memory-workflow-fixture.json').write_text(json.dumps(f,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'memory_fixture':str(root),'image_bytes':image.stat().st_size}))
