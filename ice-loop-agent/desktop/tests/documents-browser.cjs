// Real React StrictMode / Tiptap / Chrome with owned offline RPC data; not Electron IPC.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), ui = path.join(root, 'desktop/ui');
const parent = path.join(root, '.test-tmp/documents-browser'); fs.mkdirSync(parent, {recursive:true});
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = {scope:'Real UI / memory RPC, no native IPC, models or personal data',checks:{},errors:[]};
let server, browser, page;
async function check(name, action) {
  try { await action(); report.checks[name] = true; }
  catch(error) { report.checks[name] = error.stack; process.exitCode = 1; await page.screenshot({path:path.join(folder,name+'.png')}).catch(()=>{}); }
}
async function run() {
  esbuild.buildSync({stdin:{contents:`
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{DocumentEditor}from'./features/documents/DocumentEditor';import{documentStore}from'./app/uiState';
    import{LegacyArticleView}from'./features/documents/LegacyArticleView';
    import{accountStore,queryClient,flushAllDirty,dirtyStore,resetForAccountSwitch}from'./data/client';import{Toaster}from'./components/toast';
    import './styles/tokens.css';
    accountStore.set('owned');queryClient.setDefaultOptions({queries:{retry:false}});
    const content={schema:1,style:{theme:'clean',brandColor:'#2563eb',fontSize:16,lineHeight:1.75,paragraphSpacing:16},
      doc:{type:'doc',content:[{type:'paragraph',attrs:{id:'block-one'},content:[{type:'text',text:'原始正文'}]}]}};
    window.rows=Object.fromEntries(['doc-one','doc-two'].map(id=>[id,{document_id:id,title:id==='doc-one'?'第一篇':'第二篇',origin:'blank',
      generation_state:'none',meta:{},content:structuredClone(content),revision:2,content_hash:id,head_version_id:null,
      working_updated_at:'2026-11-05T00:00:00Z',unversioned_changes:false,deliveries:[],imports:[],publications:[]}]));
    window.calls=[];window.renderCalls=0;window.holdSave=false;window.conflictSave=false;window.failSave=false;
    const image={resource_id:'resource-owned',title:'测试图片',width:1,height:1,mime:'image/png',size:68,ok:true,
      preview:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII='};
    window.ice={pickDocumentImage:async()=>structuredClone(image),request:async(method,p)=>{
      window.calls.push({method,p:structuredClone(p)});const row=window.rows[p.document_id];
      if(method==='jobs.get')return{job:{job_id:'job-owned',state:'completed'},article:{topic:'旧任务标题'},body:'旧任务原正文',
        runs:{old:{run_id:'old',filename:'example.py',stdout:'历史输出',stderr:'',exit_code:0,verdict:'ok',duration_ms:1}}};
      if(method==='articles.editor_draft_get')return{draft:{content:'旧编辑器尚未成版的内容'}};
      if(method==='documents.get')return structuredClone(row);
      if(method==='documents.assist_list'){
        window.proposal??={proposal_id:'prop-owned',document_id:p.document_id,status:'ready',action:'rewrite',action_label:'改写',
          context:{targets:1,references:[],series:0},decision:{},created_at:row.working_updated_at,
          ops:[{op_id:'op1',kind:'replace',block_id:'block-one',before:structuredClone(row.content.doc.content[0]),
            before_text:'原始正文',after_text:'改写正文',after:[],reason:'测试',state:'ok'}]};
        return[structuredClone(window.proposal)];
      }
      if(method==='documents.save_working'){
        if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);
        if(window.failSave)throw Error('owned save failed');
        if(window.conflictSave||p.base_revision!==row.revision)return{conflict:true,document_id:p.document_id,message:'owned conflict',server:{revision:row.revision,content_hash:row.content_hash,content:structuredClone(row.content),updated_at:row.working_updated_at}};
        row.content=structuredClone(p.content);row.title=p.title??row.title;row.revision++;row.content_hash='saved-'+row.revision;
        return{document_id:p.document_id,revision:row.revision,content_hash:row.content_hash,saved_at:row.working_updated_at,unchanged:false,checkpoint:null};
      }
      if(method==='documents.render_delivery'){
        window.renderCalls++;
        return{document_id:p.document_id,version_id:'ver-'+row.revision,title:row.title,html:'<p>原始正文</p>',text:'原始正文',
          version_created_at:row.working_updated_at,content_hash:row.content_hash,delivery_hash:'delivery',images:[],issues:[],complete:true,style:row.content.style};
      }
      if(method==='documents.image_import_data'){if(window.holdImage)await new Promise(resolve=>window.releaseImage=resolve);return structuredClone(image);}
      if(method==='documents.image_view')return structuredClone(image);
      if(method==='publications.list')return[];
      if(method==='documents.versions')return[{version_id:'ver-original',producer:'user',created_at:row.working_updated_at,word_count:4,images:0,note:'原版本'}];
      if(method==='documents.import_original')return{import_id:p.import_id,original:'<p>完整原件</p><script>never execute()</script>'};
      if(method==='documents.commit_version')return{version_id:'ver-'+row.revision,created:true};
      if(method==='documents.create'){
        const id='doc-copy';window.rows[id]={...structuredClone(window.rows['doc-one']),document_id:id,revision:1,title:p.title};return structuredClone(window.rows[id]);
      }
      throw Error('Unexpected method '+method);
    }};
    window.flush=()=>flushAllDirty().then(()=>true,error=>error.message);window.isDirty=()=>dirtyStore.anyDirty();
    window.switchAccount=resetForAccountSwitch;window.openDoc=id=>documentStore.set(id);documentStore.set('doc-one');
    function Host(){const id=documentStore.use();return id==='legacy'?<LegacyArticleView jobId='job-owned'/>:id?<DocumentEditor key={id} documentId={id}/>:<button onClick={()=>documentStore.set('doc-one')}>重新打开</button>;}
    createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={queryClient}><Host/><Toaster/></QueryClientProvider></React.StrictMode>);
  `,resolveDir:path.join(ui,'src'),loader:'tsx'},bundle:true,outfile:path.join(folder,'app.js'),jsx:'automatic',logLevel:'silent'});
  server=http.createServer((req,res)=>{
    if(['/app.js','/app.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(folder,req.url.slice(1))));}
    else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script src="/app.js"></script>');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({executablePath:process.env.ICE_TEST_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  page=await browser.newPage({viewport:{width:1200,height:820}});page.setDefaultTimeout(5000);
  page.on('pageerror',e=>report.errors.push(e.message));
  const fresh=async()=>{await page.setViewportSize({width:1200,height:820});await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByLabel('文章标题',{exact:true}).waitFor();};
  await check('strict_mode_save_settles',async()=>{
    await fresh();await page.getByLabel('文章标题',{exact:true}).fill('StrictMode 保存');
    await page.waitForFunction(()=>window.rows['doc-one'].title==='StrictMode 保存');
    await page.waitForFunction(()=>!window.isDirty());await page.getByRole('status').filter({hasText:'已保存'}).waitFor();
  });
  await check('back_flushes_debounce',async()=>{
    await fresh();await page.getByLabel('文章标题',{exact:true}).fill('离开前保存');
    await page.getByRole('button',{name:'返回文章列表',exact:true}).click();await page.getByRole('button',{name:'重新打开',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.rows['doc-one'].title),'离开前保存');
  });
  await check('failed_save_blocks_back',async()=>{
    await fresh();await page.evaluate(()=>window.failSave=true);await page.getByLabel('文章标题',{exact:true}).fill('失败时留在这里');
    await page.getByRole('button',{name:'返回文章列表',exact:true}).click();
    await page.waitForFunction(()=>window.calls.some(c=>c.method==='documents.save_working'));
    assert.equal(await page.getByLabel('文章标题',{exact:true}).inputValue(),'失败时留在这里');
  });
  await check('delivery_preview_bounded',async()=>{
    await fresh();await page.getByRole('button',{name:'手机预览与交付',exact:true}).click();
    await page.getByLabel('公众号排版预览').waitFor();await page.waitForTimeout(500);
    assert.ok(await page.evaluate(()=>window.renderCalls<=2),'preview should not rebuild on its own state updates');
  });
  await check('stale_crash_cache_visible',async()=>{
    await fresh();await page.evaluate(()=>{const row=window.rows['doc-one'];localStorage.setItem('ice.doc.pending.owned.doc-one',JSON.stringify({content:row.content,title:'旧修订未确认的输入',base_revision:1,at:Date.now()}));});
    await page.reload();await page.getByRole('button',{name:'恢复这些修改',exact:true}).waitFor();
    await page.getByRole('button',{name:'恢复这些修改',exact:true}).click();
    await page.getByText('版本冲突：这篇文章在别处被保存过',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.rows['doc-one'].title),'第一篇');
    assert.equal(await page.getByLabel('文章标题',{exact:true}).inputValue(),'旧修订未确认的输入');
  });
  await check('inflight_edits_drained_before_back',async()=>{
    await fresh();await page.evaluate(()=>window.holdSave=true);
    await page.getByLabel('文章标题',{exact:true}).fill('第一笔在保存中');
    await page.waitForFunction(()=>typeof window.releaseSave==='function');
    await page.getByLabel('文章标题',{exact:true}).fill('保存期间的第二笔');
    await page.getByRole('button',{name:'返回文章列表',exact:true}).click();
    await page.evaluate(()=>{window.holdSave=false;window.releaseSave();});
    await page.getByRole('button',{name:'重新打开',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.rows['doc-one'].title),'保存期间的第二笔');
  });
  await check('conflict_blocks_delivery',async()=>{
    await fresh();await page.evaluate(()=>window.conflictSave=true);
    await page.getByLabel('文章标题',{exact:true}).fill('冲突中的修改');
    await page.getByRole('button',{name:'手机预览与交付',exact:true}).click();
    await page.getByText('版本冲突：这篇文章在别处被保存过',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.renderCalls),0);
  });
  await check('image_style_and_caption_survive_reopen',async()=>{
    await fresh();await page.getByRole('button',{name:'图片',exact:true}).click();
    await page.getByLabel('图注',{exact:true}).fill('真实图片图注');
    await page.getByLabel('图片宽度',{exact:true}).selectOption('60');
    await page.getByRole('button',{name:/一键排版$/}).click();
    await page.getByLabel('正文字号',{exact:true}).selectOption('18');
    await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.flush()),true);
    await page.getByRole('button',{name:'返回文章列表',exact:true}).click();
    await page.getByRole('button',{name:'重新打开',exact:true}).click();
    assert.equal(await page.getByLabel('图注',{exact:true}).inputValue(),'真实图片图注');
    assert.equal(await page.getByLabel('图片宽度',{exact:true}).inputValue(),'60');
    assert.equal(await page.locator('.ice-doc-prose').evaluate(el=>getComputedStyle(el).fontSize),'18px');
    await page.screenshot({path:path.join(folder,'editor-images.png')});
  });
  await check('latest_version_can_restore_working_edits',async()=>{
    await fresh();await page.getByLabel('文章标题',{exact:true}).fill('尚未成版');
    assert.equal(await page.evaluate(()=>window.flush()),true);
    await page.getByRole('button',{name:'历史版本',exact:true}).click();
    await page.getByRole('button',{name:'恢复到此版本',exact:true}).waitFor();
  });
  await check('original_import_visible_as_text',async()=>{
    await fresh();await page.evaluate(()=>{
      window.rows['doc-two'].imports=[{import_id:'imp-owned',kind:'html',created_at:'2026-11-05T00:00:00Z',report:{mode:'adapt',paragraphs:1,images:{total:1,imported:0,missing:[{alt:'缺图',reason:'未归档'}]},islands:[],styles:{ignored:{}},dropped:{script:1}}}];
      window.openDoc('doc-two');
    });
    await page.getByRole('button',{name:'查看导入报告与原件',exact:true}).click();
    await page.getByRole('button',{name:'查看原始内容',exact:true}).click();
    assert.match(await page.getByLabel('原始内容（只读）').innerText(),/<script>never execute\(\)<\/script>/);
    assert.equal(await page.locator('.ice-doc-side script').count(),0);
    await page.getByRole('button',{name:'从原件改为仅文字',exact:true}).click();
    await page.getByRole('button',{name:'确认重新转换',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='documents.reconvert')),false);
  });
  await check('narrow_controls_reachable',async()=>{
    await fresh();await page.setViewportSize({width:420,height:480});
    await page.getByRole('button',{name:/一键排版$/}).click();
    await page.getByLabel('行距',{exact:true}).selectOption('1.8');
    await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
    await page.locator('.ice-doc-side').waitFor({state:'detached'});
    await page.screenshot({path:path.join(folder,'editor-narrow.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'narrow editor must not overflow horizontally');
    await page.setViewportSize({width:1200,height:820});
  });
  await check('legacy_view_preserves_history_without_editor_actions',async()=>{
    await fresh();await page.evaluate(()=>window.openDoc('legacy'));
    await page.getByRole('heading',{name:'旧任务标题',exact:true}).waitFor();
    await page.getByLabel('实际运行记录',{exact:true}).locator('summary').click();
    await page.getByText('历史输出',{exact:true}).waitFor();
    await page.getByText('旧编辑器还留有工作草稿（未覆盖原正文）',{exact:true}).click();
    await page.getByText('旧编辑器尚未成版的内容',{exact:true}).waitFor();
    assert.equal(await page.locator('[contenteditable=true]').count(),0);
    assert.equal(await page.getByRole('button',{name:'保存新版本',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='articles.save'||c.method==='articles.editor_draft_save')),false);
  });
  await check('title_ime_confirmation_keeps_focus',async()=>{
    await fresh();const field=page.getByLabel('文章标题',{exact:true});await field.fill('中文标题');
    await field.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});
    assert.equal(await field.evaluate(el=>document.activeElement===el),true);
  });
  await check('proposal_format_change_stales_without_waiting_for_save',async()=>{
    await fresh();await page.getByRole('button',{name:/AI 助手$/}).click();
    await page.getByRole('button',{name:'采纳所选（1）',exact:true}).waitFor();
    await page.locator('.ice-doc-prose').click();await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');
    await page.getByRole('button',{name:'加粗 (Ctrl+B)',exact:true}).click();
    await page.getByText('已过期',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'采纳所选（0）',exact:true}).isDisabled(),true);
  });
  await check('image_batch_inserts_in_order_for_origin_account',async()=>{
    await fresh();await page.evaluate(()=>{
      const data=new DataTransfer();
      for(const name of ['first','second'])data.items.add(new File(['owned image'],name+'.png',{type:'image/png'}));
      document.querySelector('.ice-doc-prose').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
    });
    await page.waitForFunction(()=>document.querySelectorAll('.ice-doc-image').length===2);
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.method==='documents.image_import_data').map(c=>[c.p.account_id,c.p.name])),
      [['owned','first'],['owned','second']]);
    assert.equal(await page.evaluate(()=>window.flush()),true);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.rows['doc-one'].content).split('"type":"articleImage"').length-1),2);
  });
  await check('image_read_cancelled_on_account_switch',async()=>{
    await fresh();await page.evaluate(()=>{
      const NativeReader=window.FileReader;
      window.FileReader=class extends NativeReader{readAsDataURL(file){window.releaseRead=()=>super.readAsDataURL(file);}};
      const data=new DataTransfer();data.items.add(new File(['owned image'],'owned.png',{type:'image/png'}));
      document.querySelector('.ice-doc-prose').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
    });
    await page.waitForFunction(()=>typeof window.releaseRead==='function');
    await page.evaluate(()=>window.switchAccount('other-owned'));
    await page.getByRole('button',{name:'重新打开',exact:true}).waitFor();
    await page.evaluate(()=>window.releaseRead());await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='documents.image_import_data').length),0,
      'reading an old account file must not start an import after switching accounts');
  });
  await check('image_batch_stops_after_leaving_document',async()=>{
    await fresh();await page.evaluate(()=>{
      window.holdImage=true;const data=new DataTransfer();
      for(const name of ['first','second'])data.items.add(new File(['owned image'],name+'.png',{type:'image/png'}));
      document.querySelector('.ice-doc-prose').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
    });
    await page.waitForFunction(()=>typeof window.releaseImage==='function');
    await page.getByRole('button',{name:'返回文章列表',exact:true}).click();
    await page.getByRole('button',{name:'重新打开',exact:true}).waitFor();
    await page.evaluate(()=>{window.holdImage=false;window.releaseImage();});await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='documents.image_import_data').length),1,
      'only the already dispatched import may finish; later files must not import after leaving');
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='documents.save_working')),false);
  });
  assert.deepEqual(report.errors,[]);
}
run().catch(error=>{report.failure=error.stack;process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report},null,2));
});
