'use strict';
// Real renderer/IPC/engine/ZIP/SQLite. Only OS picker choices and the global
// workspace selection file are redirected by a fixture-owned main wrapper.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'backup-fixture.json'),'utf8'));
const attempt=path.join(out,'backup-attempts',path.basename(f.root)+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',runtime:f.runtime,evidence_dir:attempt,os_dialog_injected:true,selection_pointer_redirected:true,checks:{},errors:[]};
const save=()=>{const body=JSON.stringify(report,null,2);fs.writeFileSync(path.join(attempt,'result.json'),body);fs.writeFileSync(path.join(out,'backup-native.json'),body);};
const assert=(name,ok)=>{report.checks[name]=Boolean(ok);save();if(!ok)throw Error(name+' failed');};
const digest=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const personalSelection=path.join(repo,'.desktop-data-path.json'),personalBefore=digest(personalSelection);
let session,call,evaluate,until;
const start=async(runtime,useWorkspaceSelection=false,entryPath=f.entry)=>{
 session=await openNativeSession(repo,runtime,{entryPath,useWorkspaceSelection});({call,evaluate,until}=session);
 await until(`Boolean(document.querySelector('#ice-account-select'))`);
};
const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({account_id:'ice-loop',...params})})`);
const clickSelector=async selector=>{
 await until(`(()=>{const e=${selector};if(!e||e.matches(':disabled'))return false;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
 const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const e=${selector},r=e.getBoundingClientRect();resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
};
const button=text=>`[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`;
const click=text=>clickSelector(button(text));
const shot=async name=>{const value=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(value.data,'base64'));};
const idle=()=>until(`document.querySelector('.ice-backup')?.getAttribute('aria-busy')==='false'`);
(async()=>{
 save();try{
  await start(f.runtime);await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await click('编辑正文');await until(`Boolean(document.querySelector('.tiptap p'))`);
  const addition='备份前刚刚编辑的内容，也必须保留。';
  await evaluate(`(()=>{const e=document.querySelector('.tiptap p');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  await call('Input.insertText',{text:addition});
  await click('备份与恢复');await idle();
  assert('new_workbench_has_direct_backup_entry',await evaluate(`Boolean(document.querySelector('[role=dialog] .ice-backup'))`));
  assert('all_publications_and_excluded_credentials_are_explained',await evaluate(`document.querySelector('[role=dialog]').innerText.includes('所有公众号')&&document.querySelector('.ice-backup').innerText.includes('API Key')`));
  await until(`document.querySelector('.ice-backup')?.innerText.includes(${JSON.stringify(f.runtime)})`);
  assert('current_runtime_and_suspended_queue_are_real',(await rpc('backup.queue')).total===2);
  await click('创建完整备份');await idle();assert('cancelled_save_creates_no_backup',!fs.existsSync(f.package));
  await click('创建完整备份');await until(`document.querySelector('.ice-backup')?.innerText.includes('备份已保存并通过校验')`);await idle();
  assert('saved_receipt_and_database_check_are_visible',fs.existsSync(f.package)&&await evaluate(`document.querySelector('.ice-backup').innerText.includes('已校验 · schema')&&document.querySelector('.ice-backup').innerText.includes(${JSON.stringify(f.package)})`));
  const draft=await rpc('articles.editor_draft_get',{job_id:f.job});
  assert('backup_flushes_latest_editor_working_draft',draft.draft.content.includes(addition));
  await click('选择备份并校验');await idle();assert('cancelled_inspection_creates_no_review',!await evaluate(`Boolean(document.querySelector('[aria-label="备份恢复预览"]'))`));
  await click('选择备份并校验');await until(`document.querySelector('.ice-backup')?.innerText.includes('数据库或配置无法读取')`);await idle();
  assert('corrupt_database_is_rejected_before_restore_picker',!await evaluate(`Boolean(document.querySelector('[aria-label="备份恢复预览"]'))`));
  await click('选择备份并校验');await until(`Boolean(document.querySelector('[aria-label="备份恢复预览"]'))`);await idle();
  assert('restore_needs_user_confirmation',await evaluate(`[...document.querySelectorAll('button')].find(e=>e.innerText==='恢复到新目录').disabled`));
  for(const width of [1280,800]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   assert('backup_dialog_no_horizontal_overflow_'+width,await evaluate(`(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1;})()`));
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await shot('backup-preview.png');
  await clickSelector(`document.querySelector('.ice-backup__confirm input')`);await click('恢复到新目录');await idle();
  assert('cancelled_destination_preserves_review_and_original_runtime',await evaluate(`Boolean(document.querySelector('[aria-label="备份恢复预览"]'))`)&&JSON.parse(fs.readFileSync(path.join(f.root,'selection.json'))).runtime_root===f.runtime);
  fs.writeFileSync(path.join(f.root,'deny-selection'),'owned selection failure fixture');
  await click('恢复到新目录');await until(`document.querySelector('.ice-backup')?.innerText.includes('目录切换尚未完成')`);await idle();
  const restoredDirs=fs.readdirSync(f.root).filter(n=>n.startsWith('ice-restored-'));
  assert('failed_selection_does_not_discard_or_repeat_restored_data',restoredDirs.length===1&&JSON.parse(fs.readFileSync(path.join(f.root,'selection.json'))).runtime_root===f.runtime);
  const restoredRuntime=path.join(f.root,restoredDirs[0],'runtime');report.restored_runtime=restoredRuntime;save();
  assert('failed_selection_gives_truthful_recovery_path_and_retry',await evaluate(`document.querySelector('[aria-label="恢复结果"]').innerText.includes(${JSON.stringify(restoredRuntime)})&&Boolean(${button('重试切换目录')})`));
  fs.unlinkSync(path.join(f.root,'deny-selection'));await click('重试切换目录');await until(`Boolean(${button('保存当前修改并重启')})`);await idle();
  assert('retry_selects_existing_restored_runtime',JSON.parse(fs.readFileSync(path.join(f.root,'selection.json'))).runtime_root===restoredRuntime&&fs.readdirSync(f.root).filter(n=>n.startsWith('ice-restored-')).length===1);
  await click('关闭');await until(`!document.querySelector('[role=dialog]')`);await click('备份与恢复');await idle();
  assert('close_reopen_retains_restore_receipt',await evaluate(`Boolean(${button('保存当前修改并重启')})`));await shot('backup-restored.png');
  assert('current_engine_stays_on_original_until_restart',(await rpc('backup.queue')).runtime_root===f.runtime);
  report.errors.push(...session.errors);await session.close();session=null;
  const restartEntry=path.join(path.dirname(restoredRuntime),'owned-restart-main.cjs');
  fs.writeFileSync(restartEntry,'require('+JSON.stringify(f.entry)+');\n');
  await start(restoredRuntime,true,restartEntry);await click('备份与恢复');await idle();
  assert('restart_makes_suspended_work_discoverable',await evaluate(`document.body.innerText.includes('2 项恢复的制作任务等待确认')`));
  await until(`document.querySelector('.ice-backup')?.innerText.includes(${JSON.stringify(restoredRuntime)})`);
  await wait(4200);
  const pending=await rpc('backup.queue');assert('real_restart_uses_restored_selection_without_starting_tasks',pending.runtime_root===restoredRuntime&&pending.total===2);
  const document=await rpc('jobs.get',{job_id:f.job}),restoredDraft=await rpc('articles.editor_draft_get',{job_id:f.job});
  assert('restart_preserves_article_and_last_working_draft',document.body===f.body&&restoredDraft.draft.content.includes(addition));
  const preview=await rpc('resources.preview',{resource_id:f.resource,original:true});
  assert('restored_managed_image_bytes_match_original',crypto.createHash('sha256').update(Buffer.from(preview.data_url.split(',')[1],'base64')).digest('hex')===f.image_hash);
  assert('credentials_and_validation_scratch_are_absent',!fs.existsSync(path.join(restoredRuntime,'credentials.json'))&&!fs.existsSync(path.join(f.root,restoredDirs[0],'checked.db')));
  await clickSelector(`[...document.querySelectorAll('.ice-backup__task')].find(e=>e.innerText.includes('恢复验收文章')).querySelector('button')`);await idle();
  await until(`document.querySelector('.ice-backup')?.innerText.includes('有 1 项恢复后暂停的任务')`);
  assert('user_continuation_leaves_other_task_paused',(await rpc('backup.queue')).tasks[0].task_id===f.unbound);
  const jobs=await rpc('jobs.list');assert('continuation_reuses_original_article_without_duplicate_job',jobs.length===1&&jobs[0].job_id===f.job);
  const taskStates=()=>{
   const result=require('node:child_process').spawnSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
    'import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);print(json.dumps(dict(db.execute("SELECT task_id,state FROM tasks"))));db.close()',path.join(restoredRuntime,'app.db')],{env:session.env,encoding:'utf8',windowsHide:true});
   if(result.status!==0)throw Error(result.stderr);return JSON.parse(result.stdout);
  };
  let finalTasks;
  for(let n=0;n<15;n++){finalTasks=taskStates();if(finalTasks[f.bound]==='succeeded')break;await wait(500);}
  assert('continued_queue_reaches_success_and_keeps_other_task_paused',finalTasks[f.bound]==='succeeded'&&finalTasks[f.unbound]==='paused');
  report.restored_tasks=finalTasks;
  assert('all_expected_picker_calls_consumed',JSON.parse(fs.readFileSync(path.join(f.root,'dialog-plan.json'))).length===0);
  assert('personal_workspace_selection_is_untouched',digest(personalSelection)===personalBefore);
  report.errors.push(...session.errors);assert('no_uncaught_renderer_errors',report.errors.length===0);report.state='finished';report.success=true;
 }catch(error){report.state='failed';report.success=false;report.errors.push(error.stack);if(session)try{await shot('failure.png');}catch{}throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({success:true,checks:Object.keys(report.checks).length,evidence_dir:attempt}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
