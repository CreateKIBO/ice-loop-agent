'use strict';
// Real Electron/IPC/Python/files. OS folder responses and shell.openPath are
// explicitly injected by a fixture-only main wrapper, never a release flag.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'export-fixture.json'),'utf8'));
const attempt=path.join(out,'export-attempts',path.basename(path.dirname(fixture.runtime))+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',runtime:fixture.runtime,evidence_dir:attempt,os_dialog_injected:true,shell_open_injected:true,checks:{},errors:[]};
const save=()=>{const body=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'export-native.json'),body);fs.writeFileSync(path.join(attempt,'result.json'),body);};
const assert=(name,ok)=>{report.checks[name]=Boolean(ok);save();if(!ok)throw Error(name+' failed');};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const observations=()=>fs.existsSync(fixture.dialog_observations)?JSON.parse(fs.readFileSync(fixture.dialog_observations,'utf8')):[];
const bundles=()=>fs.readdirSync(fixture.export_parent).filter(name=>name.startsWith('ICE-Loop-Export-')).map(name=>path.join(fixture.export_parent,name));
(async()=>{
 save();const session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.preload}),{call,evaluate,until}=session;report.startupMs=session.startupMs;
 const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({job_id:fixture.job,...params})})`);
 const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`;
 const click=async(text,scope='document')=>{
  for(let n=0;n<3;n++){
   await until(`(()=>{const b=${button(text,scope)};if(!b)return false;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
   const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const b=${button(text,scope)},r=b.getBoundingClientRect(),s={button:b,clicked:false};s.listener=()=>{s.clicked=true;};b.addEventListener('click',s.listener,{once:true,capture:true});window.__exportPointer=s;resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
   if(await evaluate(`(()=>{const s=window.__exportPointer;s.button.removeEventListener('click',s.listener,true);delete window.__exportPointer;return s.clicked;})()`))return;
  }throw Error('Pointer did not reach '+text);
 };
 const shot=async name=>{const image=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(image.data,'base64'));};
 const verifyFiles=(directory,mode)=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  assert(mode+'_has_exactly_text_and_image_directories',JSON.stringify(fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isDirectory()).sort())===JSON.stringify(['图片','文本'].sort()));
  assert(mode+'_manifest_matches_actual_files',Object.entries(manifest.files).every(([name,digest])=>hash(path.join(directory,name))===digest));
  const md=fs.readFileSync(path.join(directory,'文本/01-公众号正文.md'),'utf8').replace(/\r\n/g,'\n');
  const txt=fs.readFileSync(path.join(directory,'文本/02-公众号正文.txt'),'utf8').replace(/\r\n/g,'\n');
  const expectedOutput=fixture.output.replace(/\r\n/g,'\n').trimEnd();
  assert(mode+'_contains_real_run_output',md.includes(expectedOutput)&&txt.includes(expectedOutput)&&!md.includes('RUN_OUTPUT:'));
  assert(mode+'_plain_text_removes_markup_and_preserves_program',!txt.startsWith('# ')&&!txt.includes('```python')&&!txt.includes('**可执行的想象')&&txt.includes('print('));
  assert(mode+'_relative_images_exist',manifest.images.every(image=>md.includes('../'+image.file)&&fs.existsSync(path.join(directory,image.file))));
  const root=path.dirname(fixture.runtime),expected=new Set(fs.readdirSync(root).filter(name=>/^figure-/.test(name)).map(name=>hash(path.join(root,name))));
  assert(mode+'_copies_original_image_bytes',manifest.images.every(image=>expected.has(image.sha256)&&hash(path.join(directory,image.file))===image.sha256));
  assert(mode+'_manifest_mode_is_correct',manifest.mode===mode);
  return manifest;
 };
 try{
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await click('编辑正文');await until(`Boolean(document.querySelector('.tiptap h1'))`);
  assert('seed_passes_real_rules_evidence_and_image_checks',(await rpc('articles.delivery_snapshot')).blocking.length===0);
  await click('导出发布就绪包');await until(`document.body.innerText.includes('最终交付审阅')`);
  assert('unreviewed_ready_opens_review_before_directory_dialog',observations().length===0&&!(await rpc('articles.delivery_snapshot')).review.reviewed);
  await click('确认交付审阅');await until(`Boolean(${button('导出发布就绪包','document.querySelector("[role=dialog]")')})`);
  assert('confirmation_is_saved_by_actual_backend',(await rpc('articles.delivery_snapshot')).review.reviewed);
  await click('导出发布就绪包','document.querySelector("[role=dialog]")');await until(`document.body.innerText.includes('已取消导出')`);
  assert('directory_cancel_preserves_body_and_creates_no_bundle',bundles().length===0&&(await rpc('jobs.get')).body_hash===fixture.body_hash);
  assert('cancelled_dialog_used_expected_native_contract',observations()[0].canceled&&observations()[0].properties.includes('openDirectory'));
  await click('导出发布就绪包');await until(`document.body.innerText.includes('发布就绪包已导出')`);
  const readyDir=bundles()[0];report.ready_destination=readyDir;
  const ready=verifyFiles(readyDir,'ready');
  assert('ready_has_all_reviewed_images_and_no_pending_checks',ready.images.length===fixture.image_count&&!ready.checks.blocking.length&&!ready.checks.pending_placeholders&&!ready.checks.unmanaged_images.length);
  assert('ready_manifest_binds_saved_body',ready.body_sha256===fixture.body_hash);
  assert('success_receipt_shows_path_and_folder_action',await evaluate(`document.body.innerText.includes(${JSON.stringify(readyDir)})&&Boolean(${button('打开导出文件夹')})`));
  await click('打开导出文件夹');await until(`document.body.innerText.includes('发布就绪包已导出')`);
  assert('folder_action_only_opens_completed_export',observations().some(row=>row.kind==='shell-open'&&path.resolve(row.folder)===path.resolve(readyDir)));
  assert('unissued_export_path_cannot_be_opened',await evaluate(`window.ice.openExportFolder(${JSON.stringify(path.dirname(fixture.runtime))}).then(()=>false,()=>true)`));
  await shot('ready-export.png');
  await click('准备配图');await until(`Boolean(document.querySelector('.ice-asset-tabs'))`);await click('否决图片');
  await evaluate(`(()=>{const e=document.querySelector('[aria-label="否决图片原因"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'导出验收夹具：撤回该配图');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('确认否决图片');await until(`document.body.innerText.includes('已否决图片')`);await click('关闭配图工作台');
  const changed=await rpc('articles.delivery_snapshot');assert('changing_selected_image_expires_delivery_review',changed.review.stale&&!changed.review.reviewed&&changed.blocking.some(item=>item.kind==='image'));
  await click('导出发布就绪包');await until(`document.body.innerText.includes('最终交付审阅')`);
  assert('stale_ready_is_blocked_before_choosing_directory',observations().filter(row=>row.kind==='directory').length===2);
  await click('关闭审阅');await click('导出草稿包');await until(`document.body.innerText.includes('草稿包已导出')`);
  const draftDir=bundles().find(directory=>directory!==readyDir);report.draft_destination=draftDir;
  const draft=verifyFiles(draftDir,'draft');
  assert('draft_reports_actual_missing_image',draft.images.length===fixture.image_count-1&&draft.checks.missing_images.length===1&&draft.checks.pending_placeholders===1);
  assert('draft_warning_is_visible_in_result_receipt',await evaluate(`document.body.innerText.includes('此包仍是草稿')&&document.body.innerText.includes('没有已采纳且通过校验的图片')`));
  assert('no_staging_or_owner_markers_left',fs.readdirSync(fixture.export_parent).every(name=>!name.includes('-staging-'))&&bundles().every(directory=>!fs.existsSync(path.join(directory,'.ice-export-owner'))));
  assert('export_never_changes_saved_article',(await rpc('jobs.get')).body_hash===fixture.body_hash);
  for(const width of [1280,1024,800]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});assert('export_result_no_overflow_'+width,await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`));}
  await shot('draft-export.png');assert('no_javascript_errors',session.errors.length===0);
 }catch(error){report.errors.push(error.stack||String(error));try{await shot('failure.png');report.debug=await evaluate(`({text:document.body.innerText.slice(-5000)})`);}catch{}}
 finally{report.state='finished';report.success=!report.errors.length&&Object.values(report.checks).every(Boolean);save();await session.close();console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;}
})().catch(error=>{report.state='finished';report.success=false;report.errors.push(error.stack||String(error));save();console.error(error);process.exitCode=1;});
