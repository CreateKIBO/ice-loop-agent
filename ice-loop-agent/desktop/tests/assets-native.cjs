'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const imagesOnly=process.argv.includes('--images-only');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'assets-fixture.json'),'utf8'));
const attempt=path.join(out,'assets-attempts',path.basename(path.dirname(fixture.runtime))+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',scope:imagesOnly?'images/editor/delivery; live TapNow skipped':'full assets and live embedded TapNow',skipped:imagesOnly?['live_tapnow_browser']:[],checks:{},errors:[],runtime:fixture.runtime,evidence_dir:attempt},save=()=>{const text=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'assets-native.json'),text);fs.writeFileSync(path.join(attempt,'result.json'),text);};
const assert=(name,ok)=>{report.checks[name]=Boolean(ok);save();if(!ok)throw Error(name+' failed');};
async function targetEvaluation(target,expression){
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned remote target timeout')),8000);ws.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.id!==1)return;clearTimeout(timer);r.error?reject(Error(r.error.message)):resolve(r.result?.result?.value);});ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});}finally{ws.close();}
}
(async()=>{
 save();const session=await openNativeSession(repo,fixture.runtime),{call,evaluate,until}=session;report.startupMs=session.startupMs;
 const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({job_id:fixture.job,...params})})`);
 const boot=await rpc('bootstrap');
 assert('backend_uses_selected_workspace',path.resolve(boot.runtime_root)===path.resolve(fixture.runtime));
 const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`;
 const click=async(text,scope='document')=>{await until(`Boolean(${button(text,scope)})`);await evaluate(`${button(text,scope)}.click()`);};
 const type=async(label,value)=>{await until(`Boolean(document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']')?.matches(':enabled'))`);await evaluate(`(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 const selectSlot=async number=>{await until(`Boolean([...document.querySelectorAll('.ice-asset-tabs button')].find(e=>e.innerText.startsWith('图'+${number}+' ·')&&!e.disabled))`);await evaluate(`[...document.querySelectorAll('.ice-asset-tabs button')].find(e=>e.innerText.startsWith('图'+${number}+' ·')).click()`);};
 const original=async()=>{await until(`Boolean(document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.selected)})+'] img'))`);await evaluate(`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.selected)})+'] .ice-asset-thumb').click()`);await until(`document.querySelector('.ice-image-canvas img')?.naturalWidth===2400`);await evaluate(`window.__openedOriginalUrls.push(document.querySelector('.ice-image-canvas img').src)`);};
 const shot=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(r.data,'base64'));};
 try{
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(`Boolean(${button('编辑正文')})`);await click('编辑正文');await until(`Boolean(document.querySelector('.tiptap h1'))`);
  await evaluate(`(()=>{window.__imageUrls=new Set();window.__openedOriginalUrls=[];const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=value=>{const url=create(value);window.__imageUrls.add(url);return url;};URL.revokeObjectURL=url=>{window.__imageUrls.delete(url);revoke(url);};})()`);
  await click('准备配图');await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);assert('assets_open_in_new_workbench',await evaluate(`location.href.startsWith('ice://app/ui/')`));
  await original();assert('original_pixels_instead_of_thumbnail',await evaluate(`document.querySelector('.ice-image-canvas img').naturalWidth===2400&&document.querySelector('.ice-image-canvas img').src.startsWith('blob:')`));
  await click('原始大小 100%');assert('original_size_scrolls_for_detail',await evaluate(`document.querySelector('.ice-image-viewport').scrollWidth>document.querySelector('.ice-image-viewport').clientWidth`));
  await click('适应窗口');await wait(100);assert('fit_image_inside_viewport',await evaluate(`document.querySelector('.ice-image-viewport').scrollWidth<=document.querySelector('.ice-image-viewport').clientWidth+1`));await shot('original-viewer.png');
  await call('Emulation.setDeviceMetricsOverride',{width:800,height:900,deviceScaleFactor:1,mobile:false});await wait(200);
  assert('fit_recalculates_after_resize',await evaluate(`document.querySelector('.ice-image-viewport').scrollWidth<=document.querySelector('.ice-image-viewport').clientWidth+1`));
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await wait(200);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(`!document.querySelector('.ice-image-viewport')`);assert('escape_closes_only_original_view',await evaluate(`Boolean(document.querySelector('.ice-asset-tabs'))&&window.__openedOriginalUrls.every(url=>!window.__imageUrls.has(url))`));
  for(let i=0;i<6;i++){await original();await click('关闭原图');await until(`window.__openedOriginalUrls.every(url=>!window.__imageUrls.has(url))`);}assert('repeated_original_views_release_all_urls',true);
  const candidateScope=`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.pending)})+']')`;
  await click('审核并采纳',candidateScope);await until(`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.pending)})+']')?.innerText.includes('当前采用')`);
  assert('candidate_review_reaches_backend',(await rpc('jobs.get')).slots.find(s=>s.figure_no===fixture.cover).selected_candidate===fixture.pending);
  await click('否决图片',candidateScope);await type('否决图片原因','内容不符合本篇');await click('确认否决图片',candidateScope);
  await until(`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.pending)})+']')?.innerText.includes('已否决')`);
  assert('reject_clears_selected_image',!(await rpc('jobs.get')).slots.find(s=>s.figure_no===fixture.cover).selected_candidate);
  await click('审核并采纳',`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.selected)})+']')`);
  await until(`document.querySelector('[data-candidate-id='+CSS.escape(${JSON.stringify(fixture.selected)})+']')?.innerText.includes('当前采用')`);
  await selectSlot(fixture.real);
  assert('multiple_runs_require_source_selection',await evaluate(`Boolean([...document.querySelectorAll('button')].find(e=>e.innerText==='生成图${fixture.real}真实截图')?.disabled)`));
  await evaluate(`document.querySelector('[aria-label="真实运行截图"] input[type=checkbox]').click()`);await click('生成图'+fixture.real+'真实截图');
  await until(`document.querySelector('[role=dialog]')?.innerText.includes('真实运行截图已生成')||document.querySelector('[data-candidate-id]')?.innerText.includes('真实运行截图')`,45000);
  const captured=await rpc('jobs.get'),real=captured.slots.find(s=>s.figure_no===fixture.real),selected=real.candidates.find(c=>c.candidate_id===real.selected_candidate);
  assert('real_screenshot_imported_and_selected',real.valid&&selected?.source==='run_capture');
  const captureEvent=captured.events.filter(e=>e.event_type==='asset.captured').map(e=>typeof e.payload==='string'?JSON.parse(e.payload):e.payload).find(e=>e.candidate_id===selected.candidate_id);
  assert('screenshot_has_actual_run_source_hashes',Boolean(captureEvent?.runs?.length)&&captureEvent.runs.every(r=>Object.values(captured.runs).some(actual=>actual.run_id===r.run_id&&actual.code_sha256===r.code_sha256&&actual.output_sha256===r.output_sha256)));
  assert('capture_intermediate_removed',fs.readdirSync(path.join(fixture.runtime,'screenshots')).every(name=>!name.startsWith('execution-')));
  await selectSlot(fixture.generative);await type('当前图位生图提示词','Use case: native-reviewed layout; brand #2448DB; text exactly LOOP.');await click('关闭配图工作台');
  await until(`document.body.innerText.includes('提示词尚未保存')`);await click('继续编辑提示词');assert('prompt_close_guard_preserves_input',await evaluate(`document.querySelector('[aria-label="当前图位生图提示词"]').value.includes('native-reviewed')`));
  await click('保存提示词');await until(`document.body.innerText.includes('提示词已保存，已有图片保留')`);
  assert('prompt_saved_to_actual_slot',(await rpc('jobs.get')).slots.find(s=>s.figure_no===fixture.generative).prompt.includes('native-reviewed'));
  await click('调整本篇预算');await type('本篇模型调用上限','0');await click('保存本篇预算');await until(`document.body.innerText.includes('不能低于已用次数')`);
  assert('zero_article_budget_rejected',(await rpc('budgets.get')).job.limit===20);
  await type('本篇模型调用上限','30');await click('保存本篇预算');await until(`document.body.innerText.includes('本篇调用：9/30')`);
  assert('article_budget_edit_keeps_usage',(await rpc('budgets.get')).job.used===9&&(await rpc('budgets.get')).job.limit===30);
  await click('从资源库选图');await until(`document.body.innerText.includes('共 17 张')||Boolean(${button('下一页资源')})`);await click('下一页资源');assert('resources_beyond_first_page_accessible',true);
  await type('搜索配图资源','循环图解资源');await until(`document.querySelector('.ice-asset-cards')?.innerText.includes('循环图解资源')`);await click('采用此资源');
  await until(`document.body.innerText.includes('资源已复制到图位并采纳')`);assert('resource_reuse_binds_real_slot',(await rpc('jobs.get')).slots.find(s=>s.figure_no===fixture.generative).valid);
  if(!imagesOnly){
  await click('打开内嵌 TapNow');await until(`document.body.innerText.includes('内嵌网页工作台')`);
  let remote;for(let i=0;i<50;i++){remote=(await session.getTargets()).find(t=>t.type==='page'&&t.url.startsWith('https://app.tapnow.media'));if(remote)break;await wait(200);}
  assert('tapnow_is_native_view_inside_agent',Boolean(remote));
  const remoteState=await targetEvaluation(remote,'({width:innerWidth,height:innerHeight,ipc:typeof window.ice,node:typeof require})');
  const box=await evaluate(`(()=>{const r=document.querySelector('.ice-browser-region').getBoundingClientRect(),d=[...document.querySelectorAll('[role=dialog]')].find(e=>e.innerText.includes('内嵌网页工作台'));return {width:r.width,height:r.height,bottom:r.bottom,dialogBottom:d.getBoundingClientRect().bottom};})()`);
  assert('native_webview_fits_visible_region',Math.abs(remoteState.width-Math.floor(box.width))<=2&&Math.abs(remoteState.height-Math.floor(box.height))<=2&&box.bottom<box.dialogBottom-35);
  assert('remote_site_has_no_app_ipc_or_node',remoteState.ipc==='undefined'&&remoteState.node==='undefined');
  const beforeHeight=box.height;await click('展开操作说明');await wait(300);const after=await targetEvaluation(remote,'innerHeight');assert('collapsible_chrome_resizes_webview',after<beforeHeight);
  await click('关闭并释放网页');await until(`!document.querySelector('.ice-browser-region')`);
  await wait(300);assert('release_closes_only_remote_page',!(await session.getTargets()).some(t=>t.id===remote.id));assert('article_workbench_retained',await evaluate(`Boolean(document.querySelector('.ice-asset-tabs'))`));
  }
  for(const width of [1280,1024,800]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(150);assert('assets_no_page_overflow_'+width,await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`));}await shot('assets-workspace.png');
  await click('关闭配图工作台');await until(`window.__imageUrls.size===0`);assert('leaving_assets_releases_thumbnails_and_originals',true);
  await evaluate(`[...document.querySelectorAll('.ice-editor-bar button')].find(e=>e.innerText.trim().startsWith('交付审阅')).click()`);await until(`document.body.innerText.includes('最终交付审阅')`);assert('delivery_snapshot_reflects_new_images',(await rpc('articles.delivery_snapshot')).figures.filter(f=>f.valid).length>=3);
  const missing=(await rpc('articles.delivery_snapshot')).figures.find(f=>!f.valid);
  if(missing){await click('准备图'+missing.figure_no);await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);assert('delivery_fix_targets_correct_slot',await evaluate(`document.querySelector('.ice-asset-tabs [aria-pressed=true]').innerText.startsWith('图${missing.figure_no} ·')`));}
  assert('no_app_javascript_errors',session.errors.length===0);report.success=true;
 }catch(error){report.success=false;report.errors.push(error.stack);try{report.screenText=await evaluate('document.body.innerText');await shot('failure.png');}catch{}}
 finally{report.errors.push(...session.errors);await session.close();report.state='finished';save();console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;}
})().catch(error=>{report.state='finished';report.success=false;report.errors.push(error.stack);save();console.error(error);process.exitCode=1;});
