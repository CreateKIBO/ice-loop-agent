'use strict';
// Real UI/IPC journeys; fresh offline fixture; scripted clipboard, never the user's clipboard.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openNativeSession,wait}=require('./native-session.cjs');
const {scriptedClipboard}=require('./scripted-clipboard.cjs');
const sha=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'reading-upgrade-fixture.json'),'utf8'));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-interaction-lists'));
assert(fs.existsSync(path.join(f.root,'.test-owner.json')));
const evidence=path.join(repo,'.test-tmp/codex-copy-reading-20261025',Date.now().toString(36));fs.mkdirSync(evidence,{recursive:true});
const report={state:'running',runtime:f.runtime,evidenceDir:evidence,scope:'source Electron; offline real SQLite/service; CDP keyboard and explicit DOM clicks; main-process in-memory clipboard adapter',checks:{},errors:[]};
const save=()=>{for(const file of [path.join(out,'reading-upgrade-native.json'),path.join(evidence,'result.json')])fs.writeFileSync(file,JSON.stringify(report,null,2));};
let s;
const originalFault=fs.readFileSync(f.fault,'utf8');
const fault=value=>fs.writeFileSync(f.fault,JSON.stringify(value));
(async()=>{try{
 const copy=scriptedClipboard(repo,f);s=await openNativeSession(repo,f.runtime,{entryPath:copy.entry});report.clipboardOutcomes=copy.results;const {evaluate:e,call,until}=s;
 const check=(name,value)=>{report.checks[name]=Boolean(value);save();assert(value,name);};
 const btn=text=>`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`;
 const click=async expression=>{await until(`Boolean(${expression})`);await e(`(${expression}).click()`);};
 const rpc=(method,params={})=>e(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({account_id:f.account_a,...params})})`);
 const setSelect=async(selector,value)=>{await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);};
 const shot=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));};
 const trace=()=>fs.existsSync(f.trace)?fs.readFileSync(f.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const count=method=>trace().filter(row=>row.method===method&&row.phase==='resolved').length;
 const waitCount=async(method,before,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(count(method)>before)return;await wait(100);}throw Error('Missing settled request '+method);};
 await until(`document.querySelectorAll('.ice-nav-row__main').length>=4`);
 // Set A through real controls; B has not mounted yet. Avoid a reload/context race.
 const aKey='ice.ui.jobview.v1.'+f.account_a,bKey='ice.ui.jobview.v1.'+f.account_b;
 await e(`localStorage.setItem(${JSON.stringify(bKey)},JSON.stringify({statusFilter:'paused',compact:true}));`);
 await setSelect('[aria-label="任务状态筛选"]','mine');
 await e(`document.querySelector('[aria-label="任务列表紧凑视图"]').click()`);
 await until(`document.querySelector('[aria-label="任务列表紧凑视图"]')?.checked===true`);
 const beforeWrites=trace().filter(r=>r.phase==='started'&&/^(chat\.(update|create|save_draft|submit)|articles\.(save|editor_draft_save)|jobs\.(archive|delete|restore|resume|stop)|downloads\.(bind|discard)|prompts\.(save|generate))$/.test(r.method||''));
 await until(`!document.querySelector('[data-job-id="${f.jobs.completed}"]')`);
 check('mine_hides_completed',await e(`!document.querySelector('[data-job-id="${f.jobs.completed}"]')`));
 await shot('task-before-reset');await click(btn('恢复默认视图'));
 await until(`Boolean(document.querySelector('[data-job-id="${f.jobs.completed}"]'))`);
 check('reset_defaults_and_feedback',await e(`document.querySelector('[aria-label="任务状态筛选"]').value==='all'&&!document.querySelector('[aria-label="任务列表紧凑视图"]').checked&&document.body.textContent.includes('已恢复默认视图')`));
 check('reset_focus_stays_local',await e(`document.activeElement===document.querySelector('[aria-label="任务状态筛选"]')`));
 check('reset_other_account_untouched',await e(`JSON.parse(localStorage.getItem(${JSON.stringify(bKey)})).statusFilter==='paused'`));
 check('reset_zero_write_rpc',trace().filter(r=>r.phase==='started'&&/^(chat\.(update|create|save_draft|submit)|articles\.(save|editor_draft_save)|jobs\.(archive|delete|restore|resume|stop)|downloads\.(bind|discard)|prompts\.(save|generate))$/.test(r.method||'')).length===beforeWrites.length);
 await shot('task-after-reset');
 await setSelect('#ice-account-select',f.account_b);
 await until(`document.querySelector('[aria-label="任务状态筛选"]')?.value==='paused'`);
 check('account_b_own_prefs_and_no_a_reset_notice',await e(`document.querySelector('[aria-label="任务列表紧凑视图"]').checked&&!document.body.textContent.includes('已恢复默认视图')`));
 await setSelect('#ice-account-select',f.account_a);
 await until(`document.querySelector('[aria-label="任务状态筛选"]')?.value==='all'`);
 // B6: the live candidate window, then a failed background read and recovery.
 // A new latest object alone never remounted a stable candidate ID. The pane's
 // full-screen error branch did: it discarded both card and historical-page state.
 await click(`document.querySelector('button[title="键盘验收会话1"]')`);
 const liveId='candidate-expand-reading-recent-5';
 const live=`document.getElementById(${JSON.stringify(liveId)})`;
 await click(live);await click(btn('Markdown 原文'));
 await until(`Boolean(document.querySelector('.ice-candidate-reader pre'))`);
 await e(`void(window.__liveExpand=${live});void(window.__liveBody=document.querySelector('.ice-candidate-reader pre').textContent)`);
 const liveState=`window.__liveExpand===${live}&&window.__liveExpand.isConnected&&${live}.getAttribute('aria-expanded')==='true'&&document.querySelector('.ice-candidate-reader pre')?.textContent===window.__liveBody`;
 const livePoll=count('chat.get');await waitCount('chat.get',livePoll);await wait(200);
 check('latest_candidate_survives_successful_poll',await e(liveState));
 const failedBefore=trace().filter(row=>row.method==='chat.get'&&row.phase==='rejected').length;
 fault({fail:['chat.get']});
 await until(`document.body.textContent.includes('会话刷新失败')`);
 check('background_chat_read_really_failed',trace().filter(row=>row.method==='chat.get'&&row.phase==='rejected').length>failedBefore);
 check('latest_candidate_survives_failed_poll',await e(liveState));
 fs.writeFileSync(f.fault,originalFault);
 const recoveryPoll=count('chat.get');await waitCount('chat.get',recoveryPoll);await wait(200);
 check('latest_candidate_source_survives_recovery',await e(liveState));
 // 目标一（2026-10-26 本轮）：对照弹窗在真实 Electron IPC 下复验 CR/CRLF。
 // 组合当前页 recent-3（仅 CR）与 recent-5（CRLF）：原文逐字符、视觉换行语义、
 // 实际目录滚动、打开期间宽→窄→宽重排、Escape 关闭焦点返回触发按钮。
 const pairIds=[f.compare_cr_candidate,f.compare_candidates[1]];
 for(const id of pairIds){
  await click(`[...document.getElementById('candidate-expand-${id}').parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='加入对照')`);
 }
 await e(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='打开对照')?.focus()`);
 await click(btn('打开对照'));
 const cdialog=`document.querySelector('[role="dialog"]')`;
 await until(`Boolean(${cdialog})&&Boolean(${cdialog}.querySelector('.ice-dialog-body > div'))`);
 const flexRoot=`${cdialog}.querySelector('.ice-dialog-body > div')`;
 const paneCR=`${flexRoot}.children[0]`,paneCRLF=`${flexRoot}.children[1]`;
 const pairBodies=await rpc('chat.get',{conversation_id:f.conversations[0]});
 const bodyCR=pairBodies.candidates.find(c=>c.id===pairIds[0]).body;
 const bodyCRLF=pairBodies.candidates.find(c=>c.id===pairIds[1]).body;
 check('compare_cr_body_has_lone_cr',bodyCR.includes('\r')&&!bodyCR.includes('\r\n'));
 check('compare_crlf_body_is_crlf',bodyCRLF.includes('\r\n'));
 for(const [pane,body,name] of [[paneCR,bodyCR,'cr'],[paneCRLF,bodyCRLF,'crlf']]){
  await click(`[...${pane}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Markdown 原文')`);
  await until(`Boolean(${pane}.querySelector('pre'))`);
  check('compare_'+name+'_source_exact_bytes',await e(`${pane}.querySelector('pre').textContent===${JSON.stringify(body)}`));
  check('compare_'+name+'_visual_break_semantics',await e(`${pane}.querySelector('pre').querySelectorAll('br').length${name==='cr'?'>0':'===0'}`));
  await click(`${pane}.querySelector('button[aria-label="复制此份原文"]')`);
  await until(`${pane}.querySelector('button[aria-label="复制此份原文"]')?.textContent.includes('此份已复制')`);
  check('compare_'+name+'_copy_exact',copy.rows().at(-1)?.ok&&copy.rows().at(-1)?.sha256===sha(body));
 }
 // CR 栏阅读视图目录实际滚动到 tail-section，另一栏保持不动（真实 IPC 取数）。
 await click(`[...${paneCR}.querySelectorAll('button')].find(b=>b.textContent.trim()==='阅读预览')`);
 await until(`Boolean(${paneCR}.querySelector('.ice-markdown'))`);
 await click(`[...${paneCR}.querySelectorAll('button')].find(b=>b.textContent.startsWith('目录（'))`);
 await until(`Boolean(${paneCR}.querySelector('nav'))`);
 await e(`void(window.__crScroll=[...${paneCR}.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px'));void(window.__crOther=[...${paneCRLF}.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px'));window.__crScroll.scrollTop=0;`);
 await click(`[...${paneCR}.querySelectorAll('nav button')].find(b=>b.textContent==='tail-section')`);
 let crToc=null;
 {const end=Date.now()+4000;while(Date.now()<end){crToc=await e(`(()=>{const n=window.__crScroll;const t=[...n.querySelector('.ice-markdown').children].filter(c=>/^H[1-6]$/.test(c.tagName)).find(c=>c.textContent.trim()==='tail-section');return t?{scroll:n.scrollTop,offset:t.getBoundingClientRect().top-n.getBoundingClientRect().top,other:window.__crOther.scrollTop}:null;})()`);if(crToc&&crToc.scroll>30&&crToc.offset>=0&&crToc.offset<40&&crToc.other===0)break;await wait(120);}}
 check('compare_cr_reading_toc_scrolls_own_pane',Boolean(crToc&&crToc.scroll>30&&crToc.offset>=0&&crToc.offset<40&&crToc.other===0));
 // 打开期间宽→窄→宽：断点订阅应独立于聊天重渲染及时重排（有界收敛，几何用两栏根节点）。
 const paneBox=async pane=>e(`(()=>{const r=${pane}.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom};})()`);
 const w0=await paneBox(paneCR),w1=await paneBox(paneCRLF);
 check('compare_native_wide_side_by_side',w1.left>=w0.right-1&&Math.abs(w0.top-w1.top)<2);
 await call('Emulation.setDeviceMetricsOverride',{width:800,height:900,deviceScaleFactor:1,mobile:false});
 {const end=Date.now()+4000;while(Date.now()<end){const a=await paneBox(paneCR),b=await paneBox(paneCRLF);if(b.top>=a.bottom-1&&Math.abs(a.left-b.left)<2)break;await wait(100);}}
 const n0=await paneBox(paneCR),n1=await paneBox(paneCRLF);
 check('compare_native_narrow_stacks',n1.top>=n0.bottom-1&&Math.abs(n0.left-n1.left)<2);
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
 {const end=Date.now()+4000;while(Date.now()<end){const a=await paneBox(paneCR),b=await paneBox(paneCRLF);if(b.left>=a.right-1&&Math.abs(a.top-b.top)<2)break;await wait(100);}}
 const r0=await paneBox(paneCR),r1=await paneBox(paneCRLF);
 check('compare_native_restore_side_by_side',r1.left>=r0.right-1&&Math.abs(r0.top-r1.top)<2);
 await call('Emulation.clearDeviceMetricsOverride');
 report.compareEnv=await e(`({visibility:document.visibilityState,focused:document.hasFocus(),innerWidth:innerWidth})`);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',windowsVirtualKeyCode:27});
 await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',windowsVirtualKeyCode:27});
 await until(`!${cdialog}`);
 check('compare_native_close_focus_returns',await e(`document.activeElement===[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='打开对照')`));
 // Historical candidate via real paging; each wait fails rather than silently returning false.
 // 2026-10-25 候选对照轮：seed 增加了更多历史候选（同题对照稿），分页深度变化——
 // 逐页向前翻直到目标候选出现（有界：最多 8 页），不再假设一次到位。
 for(let page=0;page<8;page++){
   await until(`document.querySelectorAll('[id^="candidate-expand-"]').length>0`);
   if(await e(`Boolean(document.getElementById('candidate-expand-${f.candidate}'))`))break;
   const older=btn('更早的候选稿');
   if(!await e(`Boolean(${older})`))break;
   await click(older);await wait(400);
 }
 await until(`Boolean(document.getElementById('candidate-expand-${f.candidate}'))`);
 // 诊断：当前候选区状态（Paging 失败时留证）
 const expand=`document.getElementById('candidate-expand-${f.candidate}')`;
 await e(`void(window.__expand=${expand})`);await click(expand);
 await until(`document.querySelector('.ice-candidate-reader .ice-markdown h1')?.textContent==='候选阅读验收'`);
 check('reading_semantics_and_literal_html',await e(`Boolean(document.querySelector('.ice-candidate-reader table'))&&Boolean(document.querySelector('.ice-candidate-reader blockquote'))&&document.querySelector('.ice-candidate-reader').textContent.includes('<script>')&&!window.__unsafeExecuted`));
 await shot('candidate-reading');await click(btn('Markdown 原文'));
 await until(`Boolean(document.querySelector('.ice-candidate-reader pre'))`);
 check('source_is_full_original',await e(`document.querySelector('.ice-candidate-reader pre').textContent===${JSON.stringify(f.candidate_body)}`));
 check('character_count_labels_not_tokens',await e(`document.querySelector('.ice-candidate-reader').textContent.includes('非 Token/字数/费用')`));
 await click(btn('复制全文'));await until(`document.querySelector('button[aria-label="复制全文"]')?.textContent.includes('已复制')`);
 check('copy_entire_source_not_summary_or_rendering',copy.rows().at(-1)?.ok&&copy.rows().at(-1)?.sha256===sha(f.candidate_body)&&copy.rows().at(-1)?.length===f.candidate_body.length);
 await shot('candidate-source');const polls=count('chat.get');await waitCount('chat.get',polls);await wait(200);
 check('same_expanded_card_and_source_after_real_poll',await e(`window.__expand===${expand}&&${expand}.getAttribute('aria-expanded')==='true'&&document.querySelector('.ice-candidate-reader pre').textContent===${JSON.stringify(f.candidate_body)}`));
 fault({fail:['chat.get']});await until(`document.body.textContent.includes('会话刷新失败')`);
 check('historical_candidate_survives_failed_live_poll',await e(`window.__expand===${expand}&&${expand}.getAttribute('aria-expanded')==='true'&&document.querySelector('.ice-candidate-reader pre')?.textContent===${JSON.stringify(f.candidate_body)}`));
 fs.writeFileSync(f.fault,originalFault);
 const historicalRecovery=count('chat.get');await waitCount('chat.get',historicalRecovery);await wait(200);
 check('historical_page_and_source_survive_live_recovery',await e(`window.__expand===${expand}&&${expand}.getAttribute('aria-expanded')==='true'&&document.querySelector('.ice-candidate-reader pre')?.textContent===${JSON.stringify(f.candidate_body)}`));
 await click(btn('保存为草稿'));await until(`document.body.textContent.includes('已保存为草稿')`);
 const saved=await rpc('chat.get',{conversation_id:f.conversations[0],before_candidate_id:'reading-recent-0',candidate_limit:3});
 check('save_keeps_candidate_source_and_draft_semantics',saved.candidates.find(c=>c.id===f.candidate)?.body===f.candidate_body&&saved.candidates.find(c=>c.id===f.candidate)?.status==='draft');
 check('saved_draft_in_sidebar',(await rpc('chat.drafts')).some(row=>row.conversation_id===f.conversations[0]));
 // Repeat reset immediately before opening: its feedback timer must still be
 // active while the editor and lazy workspace mount. Keep real polling enabled.
 await e(`document.querySelector('[aria-label="任务列表紧凑视图"]').click()`);
 await until(`document.querySelector('[aria-label="任务列表紧凑视图"]')?.checked===true`);
 await click(btn('恢复默认视图'));
 const editorBtn=`[...document.querySelectorAll('[data-job-id="${f.jobs.completed}"] button')].find(b=>b.textContent.trim()==='编辑正文')`;
 await until(`Boolean(${editorBtn})`);await e(`(${editorBtn}).focus()`);
 check('editor_keyboard_target_focused',await e(`document.activeElement===${editorBtn}`));
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13,text:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13});
 await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
 await e(`document.querySelector('.ice-editor').focus()`);await call('Input.insertText',{text:'原生阅读验收正文 '});
 check('editor_body_changed_before_save',await e(`document.querySelector('.ice-editor').textContent.includes('原生阅读验收正文')`));
 const saves=count('articles.save');await click(btn('保存新版本'));await waitCount('articles.save',saves);
 await until(`Boolean(${btn('保存新版本')})`);
 await until(`Boolean(${btn('准备配图')})`);await click(btn('准备配图'));await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
 await e(`void(window.__tabs=document.querySelector('.ice-asset-tabs'))`);
 const taskPoll=count('jobs.list');await waitCount('jobs.list',taskPoll,25000);await wait(3000);
 check('asset_workspace_stable_after_reset_and_keyboard',await e(`window.__tabs===document.querySelector('.ice-asset-tabs')`));
 const refs=`document.querySelector('[aria-label="品牌参考图"]')`;
 await until(`Boolean(${refs})`);
 check('references_initially_folded_with_count',await e(`${refs}.querySelector('[aria-expanded]').getAttribute('aria-expanded')==='false'&&${refs}.textContent.includes('按上传顺序')&&${refs}.querySelectorAll('img').length===0`));
 await e(`window.__revoked=[];const originalRevoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revoked.push(url);originalRevoke(url);};`);
 await click(`${refs}.querySelector('[aria-expanded]')`);
 // Electron 弹窗内缩略图带 loading="lazy"：先滚动进入视口（等价用户滚动查看）再等待完成。
 await e(`[...${refs}.querySelectorAll('li')].forEach(n=>n.scrollIntoView({block:'center'}))`);
 await until(`${refs}.querySelectorAll('img').length>=2&&[...${refs}.querySelectorAll('img')].every(n=>n.complete&&n.naturalWidth>0)`);
 const names=await e(`[...${refs}.querySelectorAll('li')].map(n=>({heading:n.querySelector('strong').textContent,name:n.querySelector('p').textContent}))`);
 check('reference_order_and_roles',names.length===2&&names[0].heading.includes('图片 1')&&names[0].heading.includes('编辑底图')&&names[1].heading.includes('品牌身份参考'));
 await click(`${refs}.querySelector('button[aria-label^="复制文件名（图片"]')`);await until(`${refs}.querySelector('button[aria-label^="复制文件名（图片"]')?.textContent.includes('文件名已复制')`);
 check('copy_exact_reference_filename',copy.rows().at(-1)?.ok&&copy.rows().at(-1)?.sha256===sha(names[0].name));
 const urls=await e(`[...${refs}.querySelectorAll('img')].map(n=>n.src)`);
 await shot('references-expanded');await click(`${refs}.querySelector('[aria-expanded]')`);
 check('fold_releases_reference_leases',await e(`${refs}.querySelectorAll('img').length===0&&${JSON.stringify(urls)}.every(url=>window.__revoked.includes(url))`));
 for(const width of [500,800,1280]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});await wait(200);
   check('assets_no_horizontal_overflow_'+width,await e(`document.documentElement.scrollWidth<=innerWidth+2&&[...document.querySelectorAll('[role="dialog"]')].every(n=>n.scrollWidth<=n.clientWidth+2)`));
   await shot('references-folded-'+width);
 }
 await call('Emulation.clearDeviceMetricsOverride');
 check('reduced_motion_honored',await e(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
 await click(btn('关闭配图工作台'));await until(`!document.querySelector('.ice-asset-tabs')`);
 check('no_renderer_errors',s.errors.length===0);report.state='finished';
}catch(error){report.state='failed';report.error=String(error.stack||error);if(s){report.errors=s.errors;report.body=await s.evaluate('document.body.innerText').catch(()=>null);}}
finally{fs.writeFileSync(f.fault,originalFault);if(s)await s.close();save();}
console.log(JSON.stringify({state:report.state,checks:report.checks,error:report.error,evidence}));process.exitCode=report.state==='finished'?0:1;
})();
