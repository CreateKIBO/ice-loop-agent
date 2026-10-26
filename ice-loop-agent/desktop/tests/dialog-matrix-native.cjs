'use strict';
// 批次B（2026-10-20 交互验收补齐）：弹窗键盘矩阵 + 帮助跳转 + 浏览器让位 + IME/reduced-motion。
// 复用 interaction-lists 夹具（跑前重新 seed）。真实 CDP 键盘；矩阵面板：
// 命令面板/模型设置/帮助/公众号资料/选题排期/重命名/草稿查看/备份。
// 已知边界：图片查看器与编辑器内子面板需要带图位/正文的任务夹具，本轮登记未覆盖。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; CDP keyboard; Radix dialogs; offline',checks:{},skipped:[],runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'dialog-matrix-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  // One Escape must close the active layer. Retrying would hide dropped input.
  const escCloses=async(selector)=>{await key('Escape');await until(`!document.querySelector(${JSON.stringify(selector)})`);};
  const waitData=async(predicate)=>{const end=Date.now()+15000;while(Date.now()<end){if(predicate())return;await wait(100);}throw Error('IPC evidence timeout');};
  // 原生 WebContentsView 抢占键盘焦点后，主 UI 收不到全局快捷键（真实边界）；
  // 真实点击左栏搜索框把键盘焦点还给 renderer（与用户点侧栏一致）。
  const reclaimFocus=async()=>{const r=JSON.parse(await evaluate(`(()=>{const b=document.querySelector('[aria-label="搜索会话或草稿"]');const q=b.getBoundingClientRect();return JSON.stringify({x:q.left+q.width/2,y:q.top+q.height/2});})()`));
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x,y:r.y,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x,y:r.y,button:'left',clickCount:1});
    await wait(300);};
  const VK={Tab:9,Enter:13,Escape:27,ArrowDown:40,ArrowUp:38,' ':32,k:75,',':188};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    const activation=keyName==='Enter'?String.fromCharCode(13):keyName===' '?' ':undefined;
    const common={key:keyName,modifiers,windowsVirtualKeyCode:code};
    await call('Input.dispatchKeyEvent',{type:'keyDown',...common,...(activation!==undefined?{text:activation}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',...common});};
  const metrics=()=>fs.readFileSync(fixture.observed,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);

  // ---------- B5 弹窗键盘矩阵 ----------
  // 通用矩阵：初始焦点在弹窗内；Tab×8 焦点不逃逸；Esc 关闭；焦点返回触发元素。
  const matrix=async(name,open,closeSelector,triggerMark)=>{
    await open();
    await until(`Boolean(document.querySelector('[role="dialog"]'))`);
    check(name+'_initial_focus_inside',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
    for(let i=0;i<8;i++)await key('Tab');
    check(name+'_tab_trap_keeps_focus',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
    await key('Escape');
    await until(`!document.querySelector(${JSON.stringify(closeSelector)})`);
    check(name+'_esc_closes',true);
    check(name+'_focus_returns_to_trigger',await evaluate(triggerMark));
  };
  // 1) 命令面板（Ctrl+K）：先聚焦左栏搜索框，Esc 后焦点应返回该触发元素
  await evaluate(`document.querySelector('[aria-label="搜索会话或草稿"]')?.focus()`);
  await key('k',2);await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  check('palette_initial_focus_input',await evaluate(`document.activeElement?.getAttribute('aria-label')==='搜索命令'`));
  for(let i=0;i<6;i++)await key('Tab');
  check('palette_focus_stays_in_dialog',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  await key('Escape');
  await until(`!document.querySelector('[aria-label="搜索命令"]')`);
  check('palette_esc_returns_focus',await evaluate(`document.activeElement?.getAttribute('aria-label')==='搜索会话或草稿'`));
  // 2) 模型设置（Ctrl+,）
  await key(',',2);
  await until(`Boolean(document.querySelector('[aria-label="普通文章默认上限"]'))`);
  check('settings_initial_focus',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  for(let i=0;i<8;i++)await key('Tab');
  check('settings_tab_trap',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  await key('Escape');await wait(200); // dirty guard 弹层（无输入则直接关）
  await until(`!document.querySelector('[aria-label="普通文章默认上限"]')`);
  check('settings_esc_flow',true);
  // 3) 帮助（左栏按钮，键盘 Tab 到达）
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='使用帮助')?.focus()`);
  await key('Enter');await until(`Boolean(document.querySelector('[aria-label="搜索帮助"]'))`);
  check('help_initial_focus_search',await evaluate(`document.activeElement?.getAttribute('aria-label')==='搜索帮助'`));
  for(let i=0;i<8;i++)await key('Tab');
  check('help_tab_trap',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  await escCloses('[aria-label="搜索帮助"]');
  check('help_esc_closes_and_focus_returns',await evaluate(`document.activeElement?.innerText?.includes('使用帮助')`));
  // 4) 公众号与品牌 5) 选题与排期 6) 备份与恢复
  for(const [name,label] of [['publication','公众号与品牌'],['editorial','选题与排期'],['backup','备份与恢复']]){
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)})?.focus()`);
    await key('Enter');
    await until(`Boolean(document.querySelector('[role="dialog"]'))`);
    check(name+'_initial_focus_inside',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
    for(let i=0;i<8;i++)await key('Tab');
    check(name+'_tab_trap',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
    await key('Escape');await wait(250);
    // 备份可能有确认层；编辑排期/资料无 dirty 时直接关
    await until(`[...document.querySelectorAll('[role="dialog"]')].length===0`);
    check(name+'_esc_closes',true);
  }
  // 7) 重命名会话（编辑子面板 1）8) 草稿查看（编辑子面板 2）
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话2')?.click()`);
  await until(`Boolean(document.querySelector('[data-chat-pane]'))`);
  await until(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重命名'&&!b.disabled))`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重命名')?.focus()`);
  await key('Enter');await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
  check('rename_initial_focus_input',await evaluate(`document.activeElement?.id==='ice-conversation-title'||document.querySelector('[role="dialog"]')?.contains(document.activeElement)`));
  await evaluate(`document.querySelector('#ice-conversation-title').focus()`);
  await call('Input.insertText',{text:'键盘重命名'});
  await key('Escape');await until(`!document.querySelector('#ice-conversation-title')`);
  check('rename_esc_discards_and_closes',await evaluate(`![...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='键盘重命名')`));
  await evaluate(`[...document.querySelectorAll('.ice-nav-list button')].find(b=>b.title==='键盘验收候选稿')?.focus()||0`);
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收候选稿')?.click()`);
  await until(`Boolean(document.querySelector('[role="dialog"]'))`);
  check('draft_dialog_open',true);
  for(let i=0;i<8;i++)await key('Tab');
  check('draft_tab_trap',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  await key('Escape');await until(`[...document.querySelectorAll('[role="dialog"]')].length===0`);
  check('draft_esc_closes',true);

  // ---------- B6 帮助跳转（4 目标）+ 脏输入保留 ----------
  // 设置内改脏 → 开帮助（叠层）→ Esc 只关帮助 → 设置仍在且输入保留
  await key(',',2);await until(`Boolean(document.querySelector('[aria-label="普通文章默认上限"]'))`);
  const budgetInput='[aria-label="普通文章默认上限"]';
  await evaluate(`document.querySelector(${JSON.stringify(budgetInput)}).focus()`);
  await call('Input.insertText',{text:'77'});
  const dirtyValue=await evaluate(`document.querySelector(${JSON.stringify(budgetInput)}).value`);
  await key('k',2);await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`); // 命令面板叠层于设置上
  // DOM insertion precedes Radix's passive highest-layer listener registration.
  // Wait for actual input focus and one rendered frame, then press Escape only once.
  await until(`document.activeElement?.getAttribute('aria-label')==='搜索命令'`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))`);
  check('layered_palette_owns_focus_before_escape',await evaluate(`document.activeElement?.getAttribute('aria-label')==='搜索命令'`));
  await key('Escape');await until(`!document.querySelector('[aria-label="搜索命令"]')`);
  check('layered_esc_keeps_settings_mounted',await evaluate(`document.querySelector(${JSON.stringify(budgetInput)})?.value===${JSON.stringify(dirtyValue)}`));
  // 帮助 4 跳转：模型设置/选题排期/公众号资料(identity,history)
  const jump=async(helpLabel,expect)=>{
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='使用帮助')?.click()`);
    await until(`Boolean(document.querySelector('[aria-label="搜索帮助"]'))`);
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()===${JSON.stringify(helpLabel)})?.click()`);
    await until(`!document.querySelector('[aria-label="搜索帮助"]')`);
    await until(expect);
  };
  // 先放弃设置未保存修改（走确认层），再测跳转
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='完成')?.click()`);
  await until(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='放弃未保存设置并离开'))`);
  check('settings_dirty_guard_prompts',true);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='继续设置')?.click()`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='完成')?.click()`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='放弃未保存设置并离开')?.click()`);
  await until(`!document.querySelector(${JSON.stringify(budgetInput)})`);
  check('settings_dirty_discard_flow',true);
  await jump('打开模型与 Key 设置',`Boolean(document.querySelector('[aria-label="普通文章默认上限"]'))`);
  check('jump_model_settings',true);
  await key('Escape');await wait(200);
  await until(`!document.querySelector('[aria-label="普通文章默认上限"]')`);
  await jump('打开选题与排期',`document.body.innerText.includes('确认并带入对话')||Boolean(document.querySelector('[aria-label="搜索预设期题"]'))`);
  check('jump_editorial',true);
  await key('Escape');await wait(300);await until(`[...document.querySelectorAll('[role="dialog"]')].length===0`);
  // 排障页两个资料跳转
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='使用帮助')?.click()`);
  await until(`Boolean(document.querySelector('[aria-label="搜索帮助"]'))`);
  // Identity link is on the guide tab; do not pretend this exercises troubleshooting.
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='打开公众号与品牌')?.click()`);
  await until(`!document.querySelector('[aria-label="搜索帮助"]')`);
  await until(`Boolean(document.querySelector('[role="dialog"]'))`);
  check('jump_publication_identity',await evaluate(`[...document.querySelectorAll('[role="tab"][data-state="active"]')].some(t=>t.innerText==='账号与读者')`));
  await key('Escape');await wait(250);await until(`[...document.querySelectorAll('[role="dialog"]')].length===0`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='使用帮助').click()`);
  await until(`Boolean(document.querySelector('[aria-label="搜索帮助"]'))`);
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(t=>t.innerText.includes('常见问题排障')).focus()`);
  await key('Enter');
  await until(`[...document.querySelectorAll('[role="tab"][data-state="active"]')].some(t=>t.innerText==='常见问题排障')`);
  await until(`Boolean([...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='打开历史与目录'))`);
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='打开历史与目录').click()`);
  await until(`!document.querySelector('[aria-label="搜索帮助"]')`);
  await until(`[...document.querySelectorAll('[role="tab"][data-state="active"]')].some(t=>t.innerText==='历史与目录')`);
  check('jump_publication_history_selects_actual_tab',true);
  check('jump_history_focus_stays_in_destination',await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`));
  await key('Escape');await until(`[...document.querySelectorAll('[role="dialog"]')].length===0`);
  report.stage='B5/B6 finished';save();

  // ---------- B7 Actual native browser view: detach/restore identity and release ----------
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='网页工作台').click()`);
  await until(`Boolean(document.querySelector('.ice-browser-region'))`);
  const browserRows=()=>metrics().filter(r=>['ice:browser-show','ice:browser-hide'].includes(r.channel));
  await waitData(()=>browserRows().some(r=>r.channel==='ice:browser-show'&&r.ids.length));
  const shown=browserRows().filter(r=>r.channel==='ice:browser-show').at(-1);
  check('browser_region_mounted_with_real_view',shown.ids.length>0);
  const pt=await evaluate(`(()=>{const r=document.querySelector('[aria-label="内嵌网页地址"]').getBoundingClientRect();return {x:r.x+20,y:r.y+10}})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...pt,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...pt,button:'left',clickCount:1});
  await key('k',2);await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await waitData(()=>browserRows().at(-1)?.channel==='ice:browser-hide'&&browserRows().at(-1).ids.length===shown.ids.length-1);
  check('palette_overlay_detaches_browser',true);
  await call('Input.insertText',{text:'快捷键与操作帮助'});await key('Enter');
  await until(`Boolean(document.querySelector('[aria-label="搜索帮助"]'))`);
  await key('Escape');await until(`!document.querySelector('[aria-label="搜索帮助"]')`);
  check('help_esc_over_browser',true);
  await waitData(()=>browserRows().at(-1)?.channel==='ice:browser-show');
  check('browser_restores_same_webcontents',JSON.stringify(browserRows().at(-1).ids)===JSON.stringify(shown.ids));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='关闭并释放网页').click()`);
  await until(`!document.querySelector('.ice-browser-region')`);
  check('browser_release_removes_remote_target',!(await session.getTargets()).some(t=>t.type==='page'&&t.url.startsWith('https://app.tapnow.media')));

  // ---------- B8 IME 与 reduced-motion ----------
  // Composer：合成 isComposing Enter 不发送（真实会话内）
  await evaluate(`[...document.querySelectorAll('.ice-nav-row__main')].find(b=>b.title==='键盘验收会话2')?.click()`);
  await until(`Boolean(document.querySelector('textarea[aria-label="消息输入"]'))`);
  await evaluate(`document.querySelector('textarea[aria-label="消息输入"]').focus()`);
  await call('Input.insertText',{text:'IME组词内容'});
  await evaluate(`document.querySelector('textarea[aria-label="消息输入"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}))`);
  await wait(600);
  check('ime_composing_does_not_send',await evaluate(`!document.querySelector('.ice-message')||![...document.querySelectorAll('.ice-message')].some(m=>m.innerText.includes('IME组词内容'))`));
  check('ime_input_preserved',await evaluate(`document.querySelector('textarea[aria-label="消息输入"]').value.includes('IME组词内容')`));
  // 命令面板 IME：isComposing Enter 不执行选项（浏览器视图刚释放，先真实点击主 UI 夺回键盘焦点）
  await reclaimFocus();
  await key('k',2);await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await evaluate(`document.querySelector('[aria-label="搜索命令"]').focus()`);
  await call('Input.insertText',{text:'新建会话'});
  await evaluate(`document.querySelector('[aria-label="搜索命令"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true,cancelable:true}))`);
  await wait(400);
  check('ime_palette_enter_does_not_execute',await evaluate(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`));
  await key('Escape');await until(`!document.querySelector('[aria-label="搜索命令"]')`);
  // reduced-motion：native-session 已设 emulated reduce；断言动画实际停止（非字符串）
  const motion=await evaluate(`(()=>{const probe=document.createElement('div');probe.className='ice-skeleton';document.body.append(probe);const s=getComputedStyle(probe);const r={skeletonAnimation:s.animationName};probe.remove();return JSON.stringify(r);})()`);
  report.reduced_motion_evidence=JSON.parse(motion);
  check('reduced_motion_disables_skeleton_animation',JSON.parse(motion).skeletonAnimation==='none');
  report.additional_coverage='interaction-integrity-native.cjs verifies image viewer and editor flush with this real-checkpoint fixture';

  check('no_renderer_exceptions',session.errors.length===0);
  report.errors=session.errors;report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;try{report.focusAtFailure=await session.evaluate(`({active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.querySelector('h2')?.textContent)})`);}catch{}}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,skipped:report.skipped.length}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
