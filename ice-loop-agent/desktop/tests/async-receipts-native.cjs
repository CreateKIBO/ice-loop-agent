'use strict';
// 批次C（2026-10-20 交互验收补齐）：真实异步回执与故障恢复。
// 写入成功 → 后续读取失败 → 警告明确"写成功" → 重试只读恢复；写次数=1；账号固定；
// 快速点击/切账号/慢响应晚到；DOM 级脱敏（含截断边界）。
// 图片采纳走同一 mutate→refreshAfterWrite 代码路径，但需带图夹具，本轮登记未覆盖（Node 级
// 已有真实 QueryClient 的 refetch throwOnError 回归）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; real writes via real RPC; fault-injected reads; offline',checks:{},skipped:[],runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'async-receipts-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const KEY_CODES={Tab:9,Enter:13,Escape:27,ArrowDown:40,ArrowUp:38,' ':32};
  const key=async(keyName,modifiers=0)=>{const code=KEY_CODES[keyName]??keyName.toUpperCase().charCodeAt(0);
    const activation=keyName==='Enter'?String.fromCharCode(13):keyName===' '?' ':undefined;
    const common={key:keyName,modifiers,windowsVirtualKeyCode:code};
    await call('Input.dispatchKeyEvent',{type:'keyDown',...common,...(activation!==undefined?{text:activation}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',...common});};
  const setFault=rules=>fs.writeFileSync(fixture.fault,JSON.stringify(rules));
  const rows=()=>fs.readFileSync(fixture.observed,'utf8').trim().split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const countOk=(method,account)=>rows().filter(r=>r.method===method&&r.ok&&(!account||r.account===account)).length;
  const toastWith=text=>`[...document.querySelectorAll('.ice-toast')].find(t=>t.innerText.includes(${JSON.stringify(text)}))`;
  const traces=()=>fs.existsSync(fixture.trace)?fs.readFileSync(fixture.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const waitTrace=async fn=>{const end=Date.now()+12000;while(Date.now()<end){if(fn())return;await wait(100);}throw Error('Trace condition not met');};
  const retryRefresh=async(label,methods)=>{
    const before=Object.fromEntries(methods.map(method=>[method,traces().filter(r=>r.method===method&&r.phase==='started').length]));
    await evaluate(`(()=>{const toast=[...document.querySelectorAll('.ice-toast')].filter(t=>t.innerText.includes(${JSON.stringify(label)})).at(-1);const button=toast?.querySelector('.ice-toast__action');if(!button||button.disabled)throw Error('Retry button unavailable');window.__retryToast=toast;button.click();})()`);
    await waitTrace(()=>methods.every(method=>traces().filter(r=>r.method===method&&r.phase==='started').length>before[method]));
    await until(`!window.__retryToast.isConnected`);
  };


  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);

  // ---------- C9/C10 会话重命名：写成功 → 读失败 → 警告 → 重试只读 ----------
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话2')?.click()`);
  await until(`Boolean(document.querySelector('[data-chat-pane]'))`);await wait(600);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重命名')?.click()`);
  await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
  await evaluate(`document.querySelector('#ice-conversation-title').focus()`);
  await call('Input.insertText',{text:'重命名回执验收'});
  setFault({fail:['chat.get','chat.list']});
  const renameWrites=countOk('chat.update');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存名称')?.click()`);
  await until(`Boolean(${toastWith('会话重命名已完成，列表刷新失败')})`);
  check('rename_warns_refresh_failure_after_write',true);
  check('rename_wrote_once',countOk('chat.update')===renameWrites+1);
  setFault({});
  await retryRefresh('会话重命名已完成，列表刷新失败',['chat.get','chat.list']);
  await until(`!document.querySelector('.ice-toast--warning')`);
  await wait(800);
  check('rename_retry_is_read_only',countOk('chat.update')===renameWrites+1);
  check('rename_title_visible',await evaluate(`[...document.querySelectorAll('button')].some(b=>b.title==='重命名回执验收')||document.body.innerText.includes('重命名回执验收')`));

  // ---------- C9/C10 保存草稿（候选→draft）：写1次 + 读败警告 + 重试只读 ----------
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话1')?.click()`);
  await until(`Boolean(document.querySelector('[aria-label="会话候选稿"]'))`);
  const saveBtn=`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存为草稿')`;
  setFault({fail:['chat.get','chat.drafts']});
  const draftWrites=countOk('chat.save_draft');
  await evaluate(`${saveBtn}.click()`);
  await until(`Boolean(${toastWith('保存草稿已完成，列表刷新失败')})`);
  check('save_draft_warns_refresh_failure',true);
  check('save_draft_wrote_once',countOk('chat.save_draft')===draftWrites+1);
  // chat.save_draft 不携带 account_id（后端按当前活跃公众号执行）；账号固定体现为：
  // 写入期间 UI 活跃账号保持 A，且请求日志中不存在指向 B 的写。
  check('save_draft_write_account_fixed',await evaluate(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_a)}`)
    &&!rows().some(r=>r.method==='chat.save_draft'&&r.account===fixture.account_b));
  setFault({});
  await retryRefresh('保存草稿已完成，列表刷新失败',['chat.get','chat.drafts']);
  await until(`!document.querySelector('.ice-toast--warning')`);
  await wait(900);
  check('save_draft_retry_read_only',countOk('chat.save_draft')===draftWrites+1);
  check('chat_view_recovered_after_retry',await evaluate(`Boolean(document.querySelector('[aria-label="会话候选稿"]'))&&![...document.querySelectorAll('[role="alert"]')].some(n=>n.innerText.includes('会话加载失败'))`));

  // ---------- C10 提交审阅（写1次；故障持续时仍保留可重试提示） ----------
  setFault({fail:['chat.get']});
  const submitWrites=countOk('chat.submit');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='提交审阅')?.click()`);
  await until(`Boolean(${toastWith('提交审阅已完成，列表刷新失败')})`);
  check('submit_warns_refresh_failure',countOk('chat.submit')===submitWrites+1);
  // 故障持续：点重试刷新 → 警告仍在（可重试提示保留，不自动重放写）
  await retryRefresh('提交审阅已完成，列表刷新失败',['chat.get']);
  await until(`Boolean(${toastWith('提交审阅已完成，列表刷新失败')})`);
  check('persistent_fault_keeps_retry_hint',countOk('chat.submit')===submitWrites+1);
  setFault({});
  await retryRefresh('提交审阅已完成，列表刷新失败',['chat.get']);
  // 重试后以结果断言：不再出现新的写 + 会话视图从读取失败中恢复（toast 本身有自动过期）。
  await wait(1500);
  check('submit_retry_read_only',countOk('chat.submit')===submitWrites+1);
  // 故障移除后，视图经重试/轮询自愈（等待有语义：读取恢复，非盲等）。
  await until(`![...document.querySelectorAll('[role="alert"]')].some(n=>n.innerText.includes('会话加载失败'))`,20000);
  check('submit_view_recovered',true);

  // ---------- C11 快速连点：写仍1次 ----------
  setFault({fail:['chat.get']});
  const rapidWrites=countOk('chat.update');
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='重命名回执验收')?.click()`);
  await until(`Boolean(document.querySelector('[data-chat-pane]'))`);await wait(600);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重命名')?.click()`);
  await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
  await evaluate(`document.querySelector('#ice-conversation-title').focus()`);
  await call('Input.insertText',{text:'2'});
  const saveBtnSel=`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存名称')`;
  await evaluate(`${saveBtnSel}.click();${saveBtnSel}.click();${saveBtnSel}.click()`);
  await wait(1200);
  check('rapid_clicks_write_once',countOk('chat.update')===rapidWrites+1);
  // Delay an already-computed A response, not a B request or execution before switch.
  setFault({responseDelayMs:{'chat.list':1500}});
  const priorIds=new Set(traces().map(r=>r.id));
  await evaluate(`${toastWith('会话重命名已完成，列表刷新失败')}.querySelector('.ice-toast__action').click()`);
  await waitTrace(()=>traces().some(r=>!priorIds.has(r.id)&&r.method==='chat.list'&&r.account===fixture.account_a&&r.phase==='handler_returned'));
  const lateA=traces().find(r=>!priorIds.has(r.id)&&r.method==='chat.list'&&r.account===fixture.account_a&&r.phase==='handler_returned');
  await evaluate(`document.querySelector('#ice-account-select').focus()`);await key('ArrowDown');
  await until(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_b)}`);
  await waitTrace(()=>traces().some(r=>r.id===lateA.id&&r.phase==='resolved'));
  check('late_a_request_proven_in_flight',lateA.account===fixture.account_a);
  await until(`Boolean([...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='B号独占会话'))`);
  check('late_a_response_does_not_leak_into_b',await evaluate(`![...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title.startsWith('键盘验收会话'))`));
  check('b_rows_present',await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='B号独占会话')`));
  setFault({});
  await evaluate(`document.querySelector('#ice-account-select').focus()`);await key('ArrowUp');
  await until(`document.querySelector('#ice-account-select').value===${JSON.stringify(fixture.account_a)}`);
  await until(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title.startsWith('键盘验收会话'))`);

  // ---------- C12 DOM 级脱敏（含截断边界） ----------
  // 未知异常 + 假凭据：经会话重命名触发（fault errorMessage 携带明显假凭据）
  const fakeKey='sk-FAKEKEY1234567890abcdef';
  const longPad='X'.repeat(280);
  setFault({fail:['chat.update'],errorMessage:`[NETWORK] 保存失败 ${longPad} api_key="fake-secret-456" ${fakeKey}`});
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title.startsWith('键盘验收会话'))?.click()`);
  await until(`Boolean(document.querySelector('[data-chat-pane]'))`);await wait(600);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重命名')?.click()`);
  await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
  await evaluate(`document.querySelector('#ice-conversation-title').focus()`);
  await call('Input.insertText',{text:'脱敏'});
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存名称')?.click()`);
  await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
  const domText=await evaluate(`document.body.innerText`);
  check('dom_never_shows_fake_key',!domText.includes(fakeKey)&&!domText.includes('fake-secret-456'));
  // 未展开时显示映射标题（码在折叠诊断里）；网络错误映射为"网络连接失败"。
  check('dom_shows_mapped_title',domText.includes('网络连接失败'));
  // 展开诊断后仍脱敏（凭据在 300 字符截断边界附近，先脱敏后截断）
  for(let attempt=0;attempt<2;attempt++){
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='展开诊断')?.click()`);
    const end=Date.now()+2000;while(Date.now()<end){if(await evaluate(`document.body.innerText.includes('[NETWORK]')`))break;await wait(200);}
    if(await evaluate(`document.body.innerText.includes('[NETWORK]')`))break;
  }
  await until(`document.body.innerText.includes('[NETWORK]')`);
  const expandedNow=await evaluate(`document.body.innerText`);
  check('diagnostic_redacts_boundary_secret',!expandedNow.includes(fakeKey)&&!expandedNow.includes('fake-secret-456'));
  check('diagnostic_keeps_code',expandedNow.includes('[NETWORK]'));
  setFault({});
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='取消')?.click()`).catch(()=>{});
  await key('Escape');await wait(300);
  report.additional_coverage='interaction-integrity-native.cjs verifies image accept, failed refresh, real retry and unchanged write count';

  check('no_renderer_exceptions',session.errors.length===0);
  report.errors=session.errors;report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,skipped:report.skipped.length}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
