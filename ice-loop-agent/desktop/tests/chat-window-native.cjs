'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'chat-window-fixture.json'),'utf8'));
const attempt=path.join(out,'chat-window-attempts',path.basename(path.dirname(fixture.runtime))+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const result={fixture,attempt,checks:{},samples:[],errors:[]};let session;
function check(name,value){result.checks[name]=Boolean(value);if(!value)throw Error('Failed: '+name);}
const expr=value=>JSON.stringify(value);
(async()=>{
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});
  const {evaluate,call,until}=session;
  const press=async selector=>{
   await until(`Boolean(${selector})`);
   const point=await evaluate(`(()=>{const e=${selector};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
   for(const type of ['mouseMoved','mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
  };
  const click=(label,scope='document')=>press(`[...${scope}.querySelectorAll('button')].find(e=>!e.disabled&&e.innerText.trim()===${expr(label)})`);
  const choose=async title=>evaluate(`document.querySelector('button[title='+CSS.escape(${expr(title)})+']').click()`);
  const sample=async stage=>{await call('HeapProfiler.collectGarbage');const heap=await call('Runtime.getHeapUsage'),dom=await call('Memory.getDOMCounters');
   const processMemory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'sample-owned-memory.ps1'),'-RootProcessId',String(session.pid)],{cwd:repo,encoding:'utf8',windowsHide:true}));
   const row={stage,used_js_heap:heap.usedSize,nodes:dom.nodes,listeners:dom.jsEventListeners,processMemory};result.samples.push(row);console.log(JSON.stringify(row));};
  const scroll=async bottom=>{const point=await evaluate(`(()=>{const n=document.querySelector('.ice-chat-log'),r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
   await call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:bottom?300000:-300000});await wait(300);};
  await until(`Boolean(document.querySelector('button[title="短会话对照"]'))`);await choose('短会话对照');
  await until(`document.querySelector('[data-chat-window-size]')?.dataset.chatWindowSize==='20'`);await sample('short');
  const started=Date.now();await choose('长会话压力验收');
  await until(`document.querySelector('[data-chat-window-size]')?.dataset.chatWindowSize==='40'`);
  result.open_ms=Date.now()-started;
  await until(`document.querySelectorAll('[aria-label="初稿候选"]').length===3`);
  await wait(500);await sample('long-warm');
  check('bounded_message_window',await evaluate(`document.querySelector('[data-chat-window-size]').dataset.chatWindowSize==='40'`));
  check('virtual_dom_not_all_messages',await evaluate(`document.querySelectorAll('[data-message-id]').length>0&&document.querySelectorAll('[data-message-id]').length<12`));
  await until(`(()=>{const n=document.querySelector('.ice-chat-log');return n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`);
  check('starts_at_latest',true);
  check('latest_candidates_bounded',await evaluate(`document.querySelectorAll('[aria-label="初稿候选"]').length===3&&document.body.innerText.includes('候选稿 119')`));
  await click('更早的消息');await until(`Boolean(document.querySelector('[data-message-id="long-1920"]'))`);
  check('older_page_correct',await evaluate(`document.body.innerText.includes('正在阅读历史')&&!document.querySelector('[data-message-id="long-1999"]')`));
  await scroll(false);const before=await evaluate(`document.querySelector('.ice-chat-log').scrollTop`);
  // Append to the fixture DB, never to personal data; no model worker involved.
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
   "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',('long-new',sys.argv[2],'assistant','## 新增回复\\nLONG_NEW_REPLY','completed','{}','2026-10-16T12:00:00Z'));c.commit();c.close()",
   path.join(fixture.runtime,'app.db'),fixture.conversation],{cwd:repo,env:session.env,windowsHide:true});
  await until(`document.querySelector('.ice-jump-latest')?.innerText.includes('1 条回复有更新')`,20000);
  check('new_reply_preserves_history_page_and_scroll',await evaluate(`Boolean(document.querySelector('[data-message-id="long-1920"]'))&&Math.abs(document.querySelector('.ice-chat-log').scrollTop-${before})<4`));
  await click('更新的消息');await until(`Boolean(document.querySelector('[data-message-id="long-1960"]'))`);
  check('forward_page_correct',true);
  await click('回到最新',`document.querySelector('[aria-label="历史消息翻页"]')`);
  await until(`!document.body.innerText.includes('正在阅读历史')`);await until(`Boolean(document.querySelector('[data-message-id="long-new"]'))`);
  check('return_to_live_tail',true);
  await click('更早的候选稿');await until(`document.body.innerText.includes('候选稿 116')`);
  check('old_candidate_accessible',await evaluate(`!document.body.innerText.includes('候选稿 119')&&document.querySelectorAll('[aria-label="初稿候选"]').length===3`));
  await click('保存为草稿',`document.querySelector('[aria-label="初稿候选"]')`);
  await until(`document.querySelector('[aria-label="初稿候选"]')?.innerText.includes('已保存草稿')`);
  check('historical_candidate_save_still_works',await evaluate(`window.ice.request('chat.drafts',{}).then(rows=>rows.some(r=>r.title==='候选稿 116'))`));
  await click('最近候选稿',`document.querySelector('[aria-label="会话候选稿"] .ice-chat-history')`);await until(`document.body.innerText.includes('候选稿 119')`);
  check('return_latest_candidates',true);
  await scroll(false);await until(`Boolean(document.querySelector('[data-message-id="long-1961"]'))`);
  const liveTop=await evaluate(`document.querySelector('.ice-chat-log').scrollTop`);
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
   "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',('long-new-live',sys.argv[2],'assistant','## 实时新增\\nLONG_LIVE_REPLY','completed','{}','2026-10-16T12:00:00Z'));c.commit();c.close()",
   path.join(fixture.runtime,'app.db'),fixture.conversation],{cwd:repo,env:session.env,windowsHide:true});
  await until(`document.querySelector('.ice-jump-latest')?.innerText.includes('1 条回复有更新')`,20000);
  check('live_tail_pins_reading_row_when_window_advances',await evaluate(`Boolean(document.querySelector('[data-message-id="long-1961"]'))&&Math.abs(document.querySelector('.ice-chat-log').scrollTop-${liveTop})<4`));
  await click('复制代码',`document.querySelector('[data-message-id="long-1961"]')`);
  await until(`document.querySelector('[aria-label="复制代码"]')?.innerText.includes('已复制')`);
  check('virtual_message_code_copy',true);
  await press(`document.querySelector('.ice-jump-latest button')`);
  await until(`Boolean(document.querySelector('[data-message-id="long-new-live"]'))`);
  check('live_tail_unpins_at_latest',true);
  // Access the beginning directly through the same bounded public API, then UI
  // page back several windows to stress cache release without 50 identical clicks.
  check('oldest_history_still_available',await evaluate(`window.ice.request('chat.get',{conversation_id:${expr(fixture.conversation)},message_limit:40,candidate_limit:1,after_message_id:'long-0'}).then(r=>r.messages[0].id==='long-1'&&r.messages.length===40)`));
  for(let index=0;index<10;index++){
   const old=await evaluate(`document.querySelector('[data-chat-window-size]').innerText`);
   await click('更早的消息');await until(`document.querySelector('[data-chat-window-size]')?.innerText!==${expr(old)}&&Boolean(document.querySelector('[data-message-id]'))`);
   await wait(100);
  }
  await sample('history-10-pages');
  check('history_cache_not_accumulating_dom',await evaluate(`document.querySelectorAll('[data-message-id]').length<12&&document.querySelectorAll('[data-chat-window-size]').length===1`));
  await click('回到最新',`document.querySelector('[aria-label="历史消息翻页"]')`);await until(`!document.body.innerText.includes('正在阅读历史')`);await scroll(true);
  await sample('returned-live');
  const warm=result.samples.find(s=>s.stage==='long-warm'),returned=result.samples.at(-1);
  result.post_history_heap_growth=returned.used_js_heap-warm.used_js_heap;
  check('bounded_heap_after_history',result.post_history_heap_growth<8*1024*1024);
  check('bounded_dom_after_history',returned.nodes<10000&&returned.nodes-warm.nodes<1500);
  // Existing unsent input survives virtual scroll and history transitions.
  await evaluate(`(()=>{const n=document.querySelector('textarea[aria-label="消息输入"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'LONG_UNSENT');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await choose('短会话对照');await until(`document.querySelector('[data-chat-window-size]')?.dataset.chatWindowSize==='20'`);
  await choose('长会话压力验收');await until(`document.querySelector('textarea[aria-label="消息输入"]')?.value==='LONG_UNSENT'`);
  check('composer_preserved',true);
  await until(`document.querySelector('[data-chat-window-size]')?.dataset.chatWindowSize==='40'`);
  await until(`(()=>{const n=document.querySelector('.ice-chat-log');return n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`);
  for(const width of [500,800,1024]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(200);
   check('no_horizontal_overflow_'+width,await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
   await until(`(()=>{const n=document.querySelector('.ice-chat-log');return n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`);
   check('latest_follow_survives_resize_'+width,true);
  }
  for(const height of [600,1000]){
   await call('Emulation.setDeviceMetricsOverride',{width:1024,height,deviceScaleFactor:1,mobile:false});
   await until(`(()=>{const n=document.querySelector('.ice-chat-log');return n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`);
   check('latest_follow_survives_height_'+height,true);
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});await wait(300);
  const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,'long-conversation.png'),Buffer.from(shot.data,'base64'));
  const observed=fs.readFileSync(fixture.observed,'utf8').trim().split('\n').map(JSON.parse);result.transport=observed;
  check('every_ui_request_bounded',observed.every(r=>r.limit>=1&&r.limit<=40&&r.messages<=40&&r.candidates<=3));
  check('payload_reduction_over_95_percent',fixture.comparison.bounded.bytes<fixture.comparison.legacy.bytes*0.05);
  check('no_javascript_errors',session.errors.length===0);result.success=true;
 }catch(error){result.errors.push(error.stack);result.success=false;try{if(session){result.failureGeometry=await session.evaluate(`(()=>{const n=document.querySelector('.ice-chat-log');return n?{height:n.scrollHeight,top:n.scrollTop,viewport:n.clientHeight,rows:[...n.querySelectorAll('[data-message-id]')].map(e=>({id:e.dataset.messageId,height:e.offsetHeight})),alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.innerText)}:null;})()`);const shot=await session.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,'failure.png'),Buffer.from(shot.data,'base64'));}}catch{}}
 finally{if(session){result.errors.push(...session.errors);await session.close();}fs.writeFileSync(path.join(attempt,'result.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(out,'chat-window-native.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({success:result.success,checks:result.checks,errors:result.errors,attempt}));if(!result.success)process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
