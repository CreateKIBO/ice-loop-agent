// Existing Node Playwright + Python document engine. Owned fixture; Chrome rendering does not certify Electron IPC.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');
const python=process.env.ICE_TEST_PYTHON||path.join(root,'.test-tmp/cont-opt-python/bin/python');
let browser;
async function run(){
  const seeded=JSON.parse(execFileSync(python,['-c',`
import json
from pathlib import Path
from tests.test_v3_longimage import LongFixture
f=LongFixture();f.setUp()
try:
    detail=f.docs.get({'document_id':f.document_id})
    content={'schema':1,'doc':{'type':'doc','content':[
      {'type':'heading','attrs':{'level':2},'content':[{'type':'text','text':f'第{i}节'}]} if i%3==0 else
      {'type':'paragraph','content':[{'type':'text','text':'正文内容。'*40}]} for i in range(40)]},'style':{}}
    saved=f.docs.save_working({'document_id':f.document_id,'base_revision':detail['revision'],'content':content})
    version=f.docs.commit_version({'document_id':f.document_id,'base_revision':saved['revision']})['version_id']
    html=f.docs.long_image_page({'document_id':f.document_id,'version_id':version,'width':375})['html']
    (f.root/'page.html').write_text(html)
    print(json.dumps({'folder':str(f.root),'runtime':str(f.runtime),'document_id':f.document_id,'version_id':version}))
finally:f.tearDown()
  `],{cwd:root,encoding:'utf8'}));
  browser=await chromium.launch({executablePath:process.env.ICE_TEST_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const page=await browser.newPage({viewport:{width:375,height:800},deviceScaleFactor:2});
  const requests=[];page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});
  await page.goto(pathToFileURL(path.join(seeded.folder,'page.html')).href);
  const total=await page.evaluate(()=>document.documentElement.scrollHeight);
  assert.ok(total>3000);const segments=[];
  for(let y=0;y<total;y+=800){
    const top=Math.min(y,Math.max(0,total-800));await page.evaluate(top=>window.scrollTo(0,top),top);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    segments.push({y:top,png_base64:(await page.screenshot()).toString('base64')});
  }
  assert.deepEqual(requests,[]);
  fs.writeFileSync(path.join(seeded.folder,'segments.json'),JSON.stringify({total,segments,...seeded}));
  const composed=JSON.parse(execFileSync(python,['-c',`
import json,sys
from pathlib import Path
from types import SimpleNamespace
from PIL import Image
from ice_agent.domain.store import Store
from ice_agent.documents.service import DocumentService
meta=json.loads(Path(sys.argv[1]).read_text())
store=Store(Path(meta['runtime'])/'app.db')
try:
    docs=DocumentService(SimpleNamespace(runtime=Path(meta['runtime'])),store,{'id':'acct-a'})
    result=docs.long_image_compose({'document_id':meta['document_id'],'version_id':meta['version_id'],
       'width':375,'total_height':meta['total'],'slice_height':1200,'segments':meta['segments'],
       'destination':str(Path(meta['folder'])/'chrome-export')})
    manifest=json.loads((Path(result['destination'])/'manifest.json').read_text())
    assert manifest['version_id']==meta['version_id']
    assert manifest['pixel_width']==750 and manifest['pixel_height']==meta['total']*2
    assert sum(s['height'] for s in manifest['slices'])==meta['total']*2
    assert len(manifest['slices'])>2
    print(json.dumps({'version_id':manifest['version_id'],'pixel_width':manifest['pixel_width'],
       'pixel_height':manifest['pixel_height'],'slices':len(manifest['slices'])}))
finally:store.close()
  `,path.join(seeded.folder,'segments.json')],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}));
  const report={scope:'Chrome rendered frozen version → Python stitch/slices, no Electron',...composed,css_height:total,segments:segments.length,external_requests:requests.length};
  fs.writeFileSync(path.join(seeded.folder,'chrome-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder:seeded.folder,...report},null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();});
