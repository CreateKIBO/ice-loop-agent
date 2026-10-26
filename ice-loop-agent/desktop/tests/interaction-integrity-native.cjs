'use strict';
// Independent acceptance: single activation, real checkpoints, original image, no cloud.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'interaction-lists-fixture.json'),'utf8'));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-interaction-lists'));
assert.ok(fs.existsSync(path.join(f.root,'.test-owner.json'))&&f.trace&&f.assets,'Reseed current interaction fixture');
const report={state:'running',runtime:f.runtime,checks:{},activations:0,scope:'source Electron; real engine checkpoints; offline; one activation per action'};
const save=()=>fs.writeFileSync(path.join(out,'interaction-integrity-native.json'),JSON.stringify(report,null,2));
const rows=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const settled=method=>rows(f.trace).filter(r=>r.method===method&&r.phase==='resolved');
const requests=method=>rows(f.trace).filter(r=>r.method===method&&r.phase==='started');
const fault=control=>fs.writeFileSync(f.fault,JSON.stringify(control));
const waitFor=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await wait(100);}throw Error('Evidence timeout '+fn.toString());};
(async()=>{
 let s;
 try {
  s=await openNativeSession(repo,f.runtime,{entryPath:f.entry});const {evaluate,call,until}=s;
  const check=(name,ok)=>{report.checks[name]=Boolean(ok);save();assert.ok(ok,name);};
  const key=async(name,modifiers=0)=>{
    const vk={Enter:13,Escape:27,Tab:9,k:75,'+':187,'-':189,'0':48}[name];
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:name,windowsVirtualKeyCode:vk,modifiers,...(name==='Enter'?{text:'\r'}:name.length===1&&!modifiers?{text:name}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,windowsVirtualKeyCode:vk,modifiers});
  };
  const button=(label,scope='document')=>`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)}&&!b.disabled)`;
  const activate=async expression=>{await until(`Boolean(${expression})`);await evaluate(`(${expression}).scrollIntoView({block:'nearest'});(${expression}).focus()`);check('focused_'+(++report.activations),await evaluate(`document.activeElement===(${expression})`));await key('Enter');};
  const jobButton=(id,label)=>button(label,`document.querySelector('li[data-job-id="${id}"]')`);
  const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({account_id:f.account_a,...params})})`);
  // Use a newly seeded runtime; persisted preferences are intentional within that runtime.

  await until(`Boolean(document.querySelector('li[data-job-id="job-kb-done"]'))`);
  // Same-tick repeated undo must not replay a write before React commits disabled state.
  await activate(`document.querySelector('[aria-label^="归档「键盘验收会话3」"]')`);
  await until(`!document.querySelector('button[title="键盘验收会话3"]')`);
  const undo=`[...document.querySelectorAll('.ice-toast')].find(t=>t.innerText.includes('已归档会话')).querySelector('.ice-toast__action')`;
  const undoBefore=requests('chat.update').length;
  fault({delayMs:{'chat.update':250}});
  await evaluate(`${undo}.click();${undo}.click();${undo}.click()`);
  await until(`Boolean(document.querySelector('button[title="键盘验收会话3"]'))`);
  report.undo_write_count=requests('chat.update').length-undoBefore;
  check('rapid_undo_action_writes_once',report.undo_write_count===1);
  fault({});
  // A valid running snapshot tests stop-before-archive without a nondeterministic worker lease.
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE jobs SET state='running' WHERE job_id='job-kb-running'\");c.commit();c.close()",path.join(f.runtime,'app.db')],{cwd:repo,env:s.env,windowsHide:true});
  await until(`[...document.querySelectorAll('li[data-job-id="job-kb-running"] .ice-badge')].some(e=>e.innerText==='进行中')`);
  const stopBefore=settled('jobs.stop').length, archiveBefore=settled('jobs.archive').length;
  await activate(jobButton('job-kb-running','归档'));
  await until(`!document.querySelector('li[data-job-id="job-kb-running"]')`);
  check('running_archive_single_activation_stops_once',settled('jobs.stop').length===stopBefore+1);
  check('running_archive_single_activation_archives_once',settled('jobs.archive').length===archiveBefore+1);
  const order=rows(f.trace).filter(r=>r.phase==='resolved'&&['jobs.stop','jobs.archive'].includes(r.method));
  check('stop_resolves_before_archive',order.at(-2)?.method==='jobs.stop'&&order.at(-1)?.method==='jobs.archive');
  const resumeBefore=settled('jobs.resume').length;
  await activate(jobButton('job-kb-paused','续跑'));
  await waitFor(()=>settled('jobs.resume').length===resumeBefore+1);
  await until(`![...document.querySelectorAll('li[data-job-id="job-kb-paused"] .ice-badge')].some(e=>e.innerText==='已暂停')`);
  const resumed=await rpc('jobs.get',{job_id:'job-kb-paused'});
  check('resume_advances_real_checkpoint',!['paused','failed'].includes(resumed.job.state));
  // Editor is entered using its actual button, not a palette or direct store bypass.
  await activate(jobButton('job-kb-done','编辑正文'));
  await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  check('editor_opens_real_article',await evaluate(`document.querySelector('.ice-editor').innerText.length>100`));
  const updateBefore=requests('chat.update').length;
  fault({fail:['articles.editor_draft_save']});
  await evaluate(`(()=>{const e=document.querySelector('.ice-editor');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);})()`);await call('Input.insertText',{text:'独立验收未保存标记XYZ'});
  const navArchive=`document.querySelector('[aria-label^="归档「键盘验收会话2」"]')`;
  const draftBefore=requests('articles.editor_draft_save').length;
  await activate(navArchive);
  await waitFor(()=>requests('articles.editor_draft_save').length>draftBefore);
  await until(`Boolean(document.querySelector('[title="键盘验收会话2"]').closest('.ice-nav-row').parentElement.querySelector('[role="alert"]'))`);
  await activate(button('展开诊断',`document.querySelector('[title="键盘验收会话2"]').closest('.ice-nav-row').parentElement`));
  check('failed_flush_explains_cancelled_navigation',await evaluate(`document.body.innerText.includes('已取消切换')`));
  check('failed_flush_blocks_archive_write',requests('chat.update').length===updateBefore);
  check('failed_flush_keeps_row_and_input',await evaluate(`Boolean(document.querySelector('button[title="键盘验收会话2"]'))&&document.querySelector('.ice-editor').innerText.includes('独立验收未保存标记XYZ')`));
  fault({});await activate(navArchive);
  await waitFor(()=>settled('chat.update').length>0);
  const draft=await rpc('articles.editor_draft_get',{job_id:'job-kb-done'});
  check('recovered_flush_persists_actual_editor_input',draft.draft?.content.includes('独立验收未保存标记XYZ'));
  // Dirty recovery drafts do not promote the article. Explicit save permits image operations.
  await activate(button('保存新版本'));await until(`document.querySelector('.ice-editor-bar')?.innerText.includes('正文已加载')||document.querySelector('.ice-editor-bar')?.innerText.includes('已保存')`);
  await activate(button('准备配图'));await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const thumb=`document.querySelector('[data-candidate-id="${f.assets.selected}"] .ice-asset-thumb')`;
  await activate(thumb);await until(`document.querySelector('.ice-image-canvas img')?.naturalWidth===2400`);
  check('viewer_initial_focus_inside_top_dialog',await evaluate(`Array.from(document.querySelectorAll('[role="dialog"]')).at(-1).contains(document.activeElement)`));
  for(let n=0;n<12;n++)await key('Tab');
  check('viewer_tab_stays_inside_top_dialog',await evaluate(`Array.from(document.querySelectorAll('[role="dialog"]')).at(-1).contains(document.activeElement)`));
  await evaluate(`document.querySelector('.ice-image-viewport').focus()`);await key('+');
  const larger=await evaluate(`parseFloat(document.querySelector('.ice-image-canvas img').style.width)`);
  await key('-');check('viewer_keyboard_zoom_changes_pixels',await evaluate(`parseFloat(document.querySelector('.ice-image-canvas img').style.width)<${larger}`));
  await key('0');check('viewer_zero_restores_fit',await evaluate(`document.querySelector('.ice-image-viewport').dataset.fit==='true'`));
  await key('Escape');await until(`!document.querySelector('.ice-image-viewport')`);
  check('viewer_escape_keeps_asset_workspace',await evaluate(`Boolean(document.querySelector('.ice-asset-tabs'))`));
  check('viewer_escape_returns_thumbnail_focus',await evaluate(`document.activeElement===(${thumb})`));
  const reviewBefore=settled('assets.review').length, getBefore=requests('jobs.get').length;
  fault({fail:['jobs.get']});
  await activate(button('审核并采纳',`document.querySelector('[data-candidate-id="${f.assets.pending}"]')`));
  await until(`document.body.innerText.includes('已审核并采纳图片已完成，列表刷新失败')`);
  check('image_accept_writes_once_before_refresh_error',settled('assets.review').length===reviewBefore+1);
  fault({});
  const retry=button('重试刷新',`[...document.querySelectorAll('.ice-toast')].find(t=>t.innerText.includes('已审核并采纳图片已完成'))`);
  const readRetryBefore=requests('jobs.get').length;
  await activate(retry);await waitFor(()=>requests('jobs.get').length>readRetryBefore);
  await until(`document.querySelector('[data-candidate-id="${f.assets.pending}"]')?.dataset.selected==='true'`);
  check('image_retry_does_not_repeat_accept',settled('assets.review').length===reviewBefore+1);
  check('image_retry_did_read_and_changed_selected_candidate',requests('jobs.get').length>getBefore);
  await activate(button('关闭配图工作台'));await until(`!document.querySelector('.ice-asset-tabs')`);
  // Browser pass-through, overlay detach/reattach same WebContents, then actual close.
  await activate(button('网页工作台'));await until(`Boolean(document.querySelector('.ice-browser-region'))`);
  const browser=()=>rows(f.observed).filter(r=>['ice:browser-show','ice:browser-hide'].includes(r.channel));
  await waitFor(()=>browser().some(r=>r.channel==='ice:browser-show'&&r.ids.length));
  const before=browser().filter(r=>r.channel==='ice:browser-show').at(-1).ids;
  report.browser_ids_before=before;
  // Real mouse selects host chrome: native child focus is outside the renderer shortcut scope.
  const pt=await evaluate(`(()=>{const q=document.querySelector('[aria-label="内嵌网页地址"]').getBoundingClientRect();return {x:q.x+20,y:q.y+10}})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...pt,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...pt,button:'left',clickCount:1});
  await key('k',2);await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await waitFor(()=>browser().at(-1)?.channel==='ice:browser-hide'&&browser().at(-1).ids.length===before.length-1);
  check('palette_detaches_real_browser_view',true);
  await key('Escape');await until(`!document.querySelector('[aria-label="搜索命令"]')`);
  await waitFor(()=>browser().at(-1)?.channel==='ice:browser-show');
  check('overlay_restores_same_webcontents_id',JSON.stringify(browser().at(-1).ids)===JSON.stringify(before));
  await activate(button('关闭并释放网页'));await until(`!document.querySelector('.ice-browser-region')`);
  check('browser_close_handler_resolves',rows(f.trace).some(r=>r.channel==='ice:browser-command'&&r.phase==='resolved'));
  check('browser_close_removes_embedded_target',!(await s.getTargets()).some(t=>t.type==='page'&&t.url.startsWith('https://app.tapnow.media')));
  check('no_renderer_exceptions',s.errors.length===0);report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;try{report.screenText=await s?.evaluate('document.body.innerText');}catch{}}
 finally{fault({});if(s)await s.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,error:report.error}));process.exitCode=report.state==='finished'?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
