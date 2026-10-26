'use strict';
// 批次C3（2026-10-21 后续工程）：原图/缩略图租约的真实释放与迟到响应。
// - 原图使用授权ice流、缩略图使用blob；释放以页内真实 <img src=url>
//   前后对照证明（关闭前 alive、关闭后 rejected），不做字符串推断；
// - 切换图位后，旧图位的缩略图租约全部释放；
// - 原图读取被延迟（ipc-observer fault responseDelayMs）期间经命令面板「返回对话」关闭
//   整个配图面板：迟到响应送达后不得重建已关闭的原图（无画布、无弹窗）。
// 全程真实引擎检查点与真实图片候选（seed 经 engine.import_asset 导入的 PNG）。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; authorized original streams and thumbnail blob leases; delayed late response',checks:{},leases:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'image-lease-native.json'),JSON.stringify(report,null,2));
const rows=()=>fs.readFileSync(fixture.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const waitFor=async fn=>{const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await wait(120);}throw Error('Evidence timeout');};
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={Enter:13,Escape:27,k:75};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  const fault=control=>fs.writeFileSync(fixture.fault,JSON.stringify(control));
  const activate=async expression=>{await until(`Boolean(${expression})`);await evaluate(`(${expression}).scrollIntoView({block:'nearest'});(${expression}).focus()`);await key('Enter');};
  // 与产品一致的租约探针：页面自身用 <img src=blob:> 消费租约；fetch 会受
  // connect-src 限制（活租约也被拒），不能作为判据。onload=alive / onerror=rejected。
  const blobState=async urls=>JSON.parse(await evaluate(`Promise.all(${JSON.stringify(urls)}.map(u=>new Promise(res=>{const i=new Image();i.onload=()=>res('alive');i.onerror=()=>res('rejected');i.src=u;}))).then(r=>JSON.stringify(r))`));
  const thumbUrls=()=>evaluate(`JSON.stringify([...document.querySelectorAll('.ice-asset-thumb img')].map(i=>i.src).filter(s=>s.startsWith('blob:')))`);

  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
  await activate(`[...document.querySelectorAll('li[data-job-id="job-kb-done"] button')].find(b=>b.innerText.trim()==='编辑正文')`);
  await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await activate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存新版本')`);
  await until(`document.querySelector('.ice-editor-bar')?.innerText.includes('已保存')||document.querySelector('.ice-editor-bar')?.innerText.includes('正文已加载')`);
  await activate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='准备配图')`);
  await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  const slotCount=await evaluate(`document.querySelectorAll('.ice-asset-tabs button').length`);
  report.leases.slotCount=slotCount;

  // ---------- 原图：打开 → Image onload → Esc 关闭 → Image onerror ----------
  const thumbSel=`document.querySelector('[data-candidate-id="${fixture.assets.selected}"] .ice-asset-thumb')`;
  const thumbImgSel=`document.querySelector('[data-candidate-id="${fixture.assets.selected}"] .ice-asset-thumb img')`;
  await until(`Boolean(${thumbImgSel})`);
  await activate(thumbSel);
  await until(`document.querySelector('.ice-image-canvas img')?.naturalWidth===2400`);
  const originalUrl=await evaluate(`document.querySelector('.ice-image-canvas img').src`);
  const aliveAt=await evaluate(`performance.now()`);
  const alive=await blobState([originalUrl]);
  report.leases.original={urlPrefix:originalUrl.slice(0,24),aliveAt:Math.round(aliveAt),alive};
  check('original_stream_alive_while_open',alive[0]==='alive');
  const closedAt=await evaluate(`performance.now()`);
  await key('Escape');
  await until(`!document.querySelector('.ice-image-canvas')`);
  const revoked=await blobState([originalUrl]);
  const confirmedAt=await evaluate(`performance.now()`);
  Object.assign(report.leases.original,{closedAt:Math.round(closedAt),revoked,confirmedAt:Math.round(confirmedAt)});
  check('close_viewer_revokes_original_lease',revoked[0]==='rejected');

  // ---------- 切换图位：旧图位缩略图租约全部释放 ----------
  if(slotCount>=2){
    const before=JSON.parse(await thumbUrls());
    check('thumbs_held_live_leases',before.length>=1&&(await blobState(before)).every(s=>s==='alive'));
    const firstTab=`[...document.querySelectorAll('.ice-asset-tabs button')][0]`;
    const secondTab=`[...document.querySelectorAll('.ice-asset-tabs button')][1]`;
    await evaluate(`(${secondTab}).click()`);
    await until(`(${secondTab}).getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-candidate-id="${fixture.assets.selected}"]')`);
    const after=await blobState(before);
    report.leases.thumbnailsAfterFigureSwitch=after;
    check('switch_figure_releases_thumbnail_leases',after.every(s=>s==='rejected'));
    await evaluate(`(${firstTab}).click()`);
    await until(`(${firstTab}).getAttribute('aria-pressed')==='true'&&Boolean(${thumbImgSel})`);
  }else{
    check('fixture_has_multiple_figures',false);
  }

  // ---------- 迟到响应不重建已关闭的原图 ----------
  // 精确等待“原图那一条”：以打开前已 started 的 id 为界，等待其中出现
  // elapsed_ms≥3500 的 resolved（延迟 4000ms 只会落在它身上）；不数其他缩略图。
  const startedIds=new Set(rows().filter(r=>r.channel==='ice:original-image-open'&&r.phase==='started').map(r=>r.id));
  const initialReleaseIds=new Set(rows().filter(r=>r.channel==='ice:original-image-release'&&r.phase==='resolved').map(r=>r.id));
  fault({responseDelayMs:{'ice:original-image-open':4000}});
  await activate(thumbSel);
  await until(`Boolean(document.querySelector('.ice-asset-loading'))`);
  check('late_case_original_pending',true);
  await key('k',2); // 命令面板叠加于原图弹窗之上
  await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await call('Input.insertText',{text:'返回对话'});
  await key('Enter');
  await until(`!document.querySelector('.ice-asset-tabs')&&!document.querySelector('[aria-label="搜索命令"]')`);
  check('late_case_panel_and_viewer_unmounted',await evaluate(`!document.querySelector('[role="dialog"]')&&!document.querySelector('.ice-image-canvas')`));
  const unmountedWall=Date.now();
  let lateRow=null;
  await waitFor(()=>{const hit=rows().find(r=>r.channel==='ice:original-image-open'&&r.phase==='resolved'&&r.elapsed_ms>=3500&&!startedIds.has(r.id));
    if(hit){lateRow=hit;return true;}return false;});
  const landedAt=await evaluate(`performance.now()`);
  await wait(700);
  check('late_response_does_not_rebuild_original',await evaluate(`!document.querySelector('.ice-image-canvas')&&!document.querySelector('[role="dialog"]')`));
  await waitFor(()=>rows().some(r=>r.channel==='ice:original-image-release'&&r.phase==='resolved'&&!initialReleaseIds.has(r.id)));
  check('late_response_releases_main_original_capability',true);
  report.leases.lateResponse={requestId:lateRow.id,elapsedMs:lateRow.elapsed_ms,
    wallWaitMs:Date.now()-unmountedWall,landedAt:Math.round(landedAt),rebuilt:false};
  fault({});

  check('no_renderer_exceptions',session.errors.length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
