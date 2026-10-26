'use strict';
// 批次C2（2026-10-21 后续工程）：工作草稿保存失败必须阻止切号与「返回对话」，
// 且账号/正文/输入全部保留；故障解除后同一用户动作完成。
// 语义区分：本旅程全程 articles.save（正文版本保存）不得发生——被阻断/被完成的是
// 工作草稿落盘（articles.editor_draft_save），前者不等于发布审批。
// C4 相关：面板动作失败文案标明被阻止的动作并保留原始诊断（CommandPalette 前缀）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; fault-injected draft saves; offline',checks:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'editor-switch-block-native.json'),JSON.stringify(report,null,2));
const rows=()=>fs.readFileSync(fixture.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const startedCount=method=>rows().filter(r=>r.method===method&&r.phase==='started').length;
const waitFor=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await wait(100);}throw Error('Evidence timeout');};
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={Enter:13,Escape:27,ArrowDown:40,ArrowUp:38,k:75,n:78};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  const fault=control=>fs.writeFileSync(fixture.fault,JSON.stringify(control));
  const typeInEditor=async marker=>{await evaluate(`(()=>{const e=document.querySelector('.ice-editor');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
    await call('Input.insertText',{text:marker});};
  const openEditor=async()=>{await evaluate(`[...document.querySelectorAll('li[data-job-id="job-kb-done"] button')].find(b=>b.innerText.trim()==='编辑正文')?.focus()`);
    await key('Enter');await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);};
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  const versionSave=()=>startedCount('articles.save');

  // ---------- 切号被阻断 ----------
  await openEditor();
  const marker1='阻断切号标记'+Date.now().toString(36);
  fault({fail:['articles.editor_draft_save']});
  await typeInEditor(marker1);
  await until(`[...document.querySelectorAll('button')].some(b=>b.closest('.ice-editor-bar'))`);
  await evaluate(`document.querySelector('#ice-account-select').focus()`);
  await key('ArrowDown'); // 真实键盘选择 B → change → flushAllDirty 先行
  await until(`document.body.innerText.includes('账号未切换')`);
  // 诊断默认折叠（不掩盖原始错误）；展开后才能在正文里看到“已取消切换”。
  await evaluate(`[...document.querySelectorAll('#ice-account-select~* button, .ice-nav button')].find(b=>b.innerText.trim()==='展开诊断')?.click()`);
  await until(`document.body.innerText.includes('已取消切换')`);
  check('blocked_switch_names_blocked_action',await evaluate(`document.body.innerText.includes('账号未切换')&&document.body.innerText.includes('已取消切换')`));
  check('blocked_switch_keeps_account',await evaluate(`document.querySelector('#ice-account-select')?.value`)===fixture.account_a);
  check('blocked_switch_keeps_editor_and_input',await evaluate(`Boolean(document.querySelector('.ice-editor'))&&document.querySelector('.ice-editor').innerText.includes(${JSON.stringify(marker1)})`));
  check('blocked_switch_never_calls_accounts_switch',startedCount('accounts.switch')===0);
  check('blocked_switch_never_saves_body_version',versionSave()===0);

  // ---------- 解除故障：同一动作（ArrowDown 选 B）完成 ----------
  fault({});
  await evaluate(`document.querySelector('#ice-account-select').focus()`);
  await key('ArrowDown');
  await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(fixture.account_b)}`);
  await until(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='B号独占会话')`);
  check('switch_completes_after_fault_clears',startedCount('accounts.switch')>=1);
  check('completes_without_body_version_save',versionSave()===0); // 全程只发生工作草稿落盘

  // ---------- 返回对话被阻断（真实命令面板动作） ----------
  await evaluate(`document.querySelector('#ice-account-select').focus()`);
  await key('ArrowUp'); // 切回 A
  await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(fixture.account_a)}`);
  await until(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='键盘验收会话1')`);
  await openEditor();
  const marker2='阻断返回标记'+Date.now().toString(36);
  fault({fail:['articles.editor_draft_save']});
  await typeInEditor(marker2);
  const saveBefore=startedCount('articles.editor_draft_save');
  await key('k',2);
  await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await call('Input.insertText',{text:'返回对话'});
  await key('Enter'); // 单次执行：flush 失败 → setActionError，面板不关闭
  await waitFor(()=>startedCount('articles.editor_draft_save')>saveBefore);
  await until(`Boolean(document.querySelector('[role="alert"]')?.textContent.includes('「返回对话」未执行'))`);
  check('palette_error_names_blocked_action',await evaluate(`[...document.querySelectorAll('[role="alert"]')].some(n=>n.textContent.includes('「返回对话」未执行'))`));
  check('palette_error_keeps_original_diagnostic',await evaluate(`[...document.querySelectorAll('[role="alert"]')].some(n=>n.textContent.includes('已取消切换'))`));
  check('blocked_back_keeps_palette_open',await evaluate(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`));
  check('blocked_back_keeps_editor_and_input',await evaluate(`Boolean(document.querySelector('.ice-editor'))&&document.querySelector('.ice-editor').innerText.includes(${JSON.stringify(marker2)})`));
  check('blocked_back_never_saves_body_version',versionSave()===0);

  // ---------- 解除故障：同一面板动作（Enter）完成 ----------
  fault({});
  await key('Enter'); // 面板未关、查询未变——同一动作重试
  // 本旅程未选中会话：返回后是欢迎页而非会话面板，因此断言编辑器与面板均已关闭。
  await until(`!document.querySelector('.ice-editor')&&!document.querySelector('[aria-label="搜索命令"]')`);
  check('back_to_chat_completes_after_fault_clears',await evaluate(`!document.querySelector('.ice-editor')`));
  const draft=JSON.parse(await evaluate(`window.ice.request('articles.editor_draft_get',${JSON.stringify({account_id:fixture.account_a,job_id:'job-kb-done'})}).then(r=>JSON.stringify(r))`));
  check('recovered_draft_persists_input',Boolean(draft.draft?.content?.includes(marker2)));
  check('recovery_never_wrote_body_version',versionSave()===0);

  check('no_renderer_exceptions',session.errors.length===0);
  fault({});
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
