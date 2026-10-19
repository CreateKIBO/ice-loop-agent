'use strict';
// Offline model fixture, real preload/backend, real program execution after UI approval.
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'workflow-review-fixture.json'),'utf8'));
const attempt=path.join(out,'workflow-review-attempts',path.basename(path.dirname(fixture.runtime)));
fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',checks:{},errors:[],runtime:fixture.runtime};
const save=()=>{const json=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'workflow-review-native.json'),json);fs.writeFileSync(path.join(attempt,'result.json'),json);};
const assert=(name,ok)=>{report.checks[name]=Boolean(ok);save();if(!ok)throw Error(name+' failed');};
(async()=>{
 save();const session=await openNativeSession(repo,fixture.runtime),{evaluate,call,until}=session;report.startupMs=session.startupMs;save();
 // A gate can arrive before its engine lease is released. Test the same
 // interactable state the user sees, without bypassing the disabled guard.
 const click=async(text,scope='document.querySelector("[role=dialog]")')=>{
  await until(`Boolean([...(${scope}?.querySelectorAll('button')??[])].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled')))`);
  return evaluate(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)});if(!b||b.matches(':disabled'))throw Error('Button unavailable: '+${JSON.stringify(text)});b.click();})()`);
 };
 const input=async(label,value)=>{
  await until(`Boolean(document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']')?.matches(':enabled'))`);
  return evaluate(`(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e||e.matches(':disabled'))throw Error('Input unavailable: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 };
 const rpc=(method,params)=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const open=async job=>{await until(`Boolean(document.querySelector('[data-job-id='+CSS.escape(${JSON.stringify(job)})+']'))`);await evaluate(`(()=>{const row=document.querySelector('[data-job-id='+CSS.escape(${JSON.stringify(job)})+']');const b=[...row.querySelectorAll('button')].find(e=>e.innerText==='审阅此步');if(!b)throw Error('Review entry missing');b.click();})()`);await until(`Boolean(document.querySelector('[aria-label="选题 2 标题"]'))`);};
 const shot=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});const data=Buffer.from(r.data,'base64');fs.writeFileSync(path.join(out,name),data);fs.writeFileSync(path.join(attempt,name),data);};
 try{
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await open(fixture.main);
  assert('review_available_without_switching_ui',true);
  assert('candidate_html_is_inert',await evaluate(`!window.__REVIEW_XSS&&!document.querySelector('.ice-task-review script,.ice-task-review img')`));
  await input('选题 2 标题','读懂循环的边界与输入');
  await evaluate(`document.querySelector('input[name="review-topic"][value="1"]').click()`);
  await click('关闭');await until(`document.body.innerText.includes('有修改尚未保存')`);await click('继续编辑');
  assert('close_guard_preserves_candidate_edit',await evaluate(`document.querySelector('[aria-label="选题 2 标题"]').value==='读懂循环的边界与输入'`));
  await click('仅保存修改');await until(`document.body.innerText.includes('方案修改已保存')`);
  assert('save_does_not_advance_gate',(await rpc('jobs.get',{job_id:fixture.main})).pending_approval.scope==='topic');
  assert('selection_survives_save',await evaluate(`document.querySelector('input[name="review-topic"][value="1"]').checked`));
  await shot('workflow-review-topic.png');
  await click('确认并继续');await until(`Boolean(document.querySelector('[aria-label="章节 1 标题"]'))`,45000);
  assert('selected_topic_reaches_engine',(await rpc('jobs.get',{job_id:fixture.main})).article.working_title==='读懂循环的边界与输入');
  await input('章节 1 标题','一、先观察循环与输入');await click('保存修改并继续');
  await until(`Boolean(document.querySelector('[aria-label="审阅代码与示例输入"]'))`,45000);
  const before=await rpc('jobs.get',{job_id:fixture.main});
  assert('outline_edit_persisted',before.outline.sections[0].h2==='一、先观察循环与输入');
  // Replace one fixture program through the actual reviewed code-edit RPC. It
  // must invalidate approval and show a new input manifest in the new UI.
  await rpc('execution.code_save',{job_id:fixture.main,content_hash:before.execution_hash,sources:{'1':{language:'python',source:'# 接收本次审阅中明确填写的输入\nage = int(input("请输入年龄: "))\n# 把读到的值写入真实输出\nprint(f"AGE_FROM_UI={age}")\n'}}});
  await click('刷新状态');await until(`document.querySelector('.ice-task-review__code')?.innerText.includes('AGE_FROM_UI')`);
  const manifest=await rpc('jobs.get',{job_id:fixture.main}),key=manifest.execution.blocks[0].stdin_key;
  assert('execution_requires_explicit_review',await evaluate(`(()=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(e=>e.innerText==='确认运行并继续');return b.disabled;})()`));
  await input(key+' 示例输入','21');
  await evaluate(`(()=>{const label=[...document.querySelectorAll('[role=dialog] label')].find(e=>e.innerText.includes('我已审阅以上源码'));label.querySelector('input').click();})()`);
  await shot('workflow-review-execution.png');
  await click('确认运行并继续');await until(`Boolean(document.querySelector('[aria-label="标题 2"]'))`,60000);
  const ran=await rpc('jobs.get',{job_id:fixture.main});
  assert('actual_program_used_user_input',Object.values(ran.runs).some(run=>run.stdout.includes('AGE_FROM_UI=21')&&run.stdin_events.includes('21\n')&&run.exit_code===0));
  assert('rpc_request_never_became_stdin',Object.values(ran.runs).every(run=>!run.stderr.includes('"method"')&&!run.stdout.includes('jobs.list')));
  assert('runtime_cleanup_recorded',Object.values(ran.runs).every(run=>run.runtime.workspace_cleanup==='removed_owned_workspace'));
  await input('标题 2','循环与输入：从读懂到跑通');
  await evaluate(`document.querySelectorAll('input[name="review-title"]')[1].click()`);
  await click('保存修改并继续');await until(`Boolean(document.querySelector('[aria-label="确认配图计划"]'))`,45000);
  await click('确认并继续');await until(`document.querySelector('[role=dialog]')?.innerText.includes('制作完成')`,45000);
  const done=await rpc('jobs.get',{job_id:fixture.main});
  assert('all_four_gates_advance_same_job',done.job.state==='completed'&&done.article.final_title==='循环与输入：从读懂到跑通');
  assert('approval_gates_are_not_recreated',done.events.filter(e=>e.event_type==='approval.required').length===4);
  assert('new_ui_preserved',await evaluate(`location.href.startsWith('ice://app/ui/')`));
  await shot('workflow-review-complete.png');await click('关闭');
  await open(fixture.stale);await input('选题 2 标题','保留这份尚未保存的修改');
  await evaluate(`(async()=>{const r=await window.ice.request('jobs.get',{job_id:${JSON.stringify(fixture.stale)}});const a=r.pending_approval;await window.ice.request('approvals.edit',{job_id:${JSON.stringify(fixture.stale)},approval_id:a.approval_id,content_hash:a.content_hash,payload:{...a.payload,working_title:'另一个窗口更新的方案'}})})()`);
  await click('仅保存修改');await until(`document.querySelector('[role=dialog]')?.innerText.includes('候选已变化')`);
  assert('stale_hash_failure_preserves_input',await evaluate(`document.querySelector('[aria-label="选题 2 标题"]').value==='保留这份尚未保存的修改'`));
  assert('stale_hash_does_not_approve',(await rpc('jobs.get',{job_id:fixture.stale})).pending_approval.scope==='topic');
  await click('关闭');await click('放弃修改并关闭');
  await open(fixture.stale);assert('reopen_reads_fresh_candidate',await evaluate(`document.querySelector('[aria-label="工作标题"]').value==='另一个窗口更新的方案'`));await click('关闭');
  await open(fixture.reject);await click('否决此步');await input('否决原因','选题需要更聚焦');await click('否决并停止');
  await until(`document.querySelector('[role=dialog]')?.innerText.includes('已中断')`,30000);
  const rejected=await rpc('jobs.get',{job_id:fixture.reject});
  assert('reject_stops_workflow',rejected.job.state==='failed'&&rejected.job.pause_reason.includes('选题需要更聚焦')&&Object.keys(rejected.runs).length===0);
  await click('关闭');
  await evaluate(`(()=>{const row=document.querySelector('[data-job-id='+CSS.escape(${JSON.stringify(fixture.cancel)})+']');[...row.querySelectorAll('button')].find(e=>e.innerText==='审阅代码与输入').click();})()`);
  await until(`Boolean(document.querySelector('[aria-label="审阅代码与示例输入"]'))`);
  await evaluate(`(()=>{const label=[...document.querySelectorAll('[role=dialog] label')].find(e=>e.innerText.includes('我已审阅以上源码'));label.querySelector('input').click();})()`);
  await click('确认运行并继续');
  const startDeadline=Date.now()+15000;
  while(!fs.existsSync(fixture.cancel_marker)&&Date.now()<startDeadline)await wait(100);
  assert('native_program_really_started',fs.existsSync(fixture.cancel_marker));
  const stopStarted=Date.now();await click('暂停制作');
  await until(`(async()=>{const r=await window.ice.request('jobs.get',{job_id:${JSON.stringify(fixture.cancel)}});return r.job.state==='paused'&&!r.job.lease&&Object.values(r.runs).some(run=>run.verdict==='cancelled');})()`,8000);
  report.stopLatencyMs=Date.now()-stopStarted;
  assert('native_pause_did_not_wait_for_timeout',report.stopLatencyMs<8000);
  const stopped=await rpc('jobs.get',{job_id:fixture.cancel});
  assert('native_pause_retains_partial_evidence',Object.values(stopped.runs).some(run=>run.stdout.includes('NATIVE_PROGRAM_STARTED')&&run.runtime.cancelled==='true'&&run.runtime.workspace_cleanup==='removed_owned_workspace'));
  assert('native_pause_does_not_advance',stopped.job.current_node==='verify_code'&&!stopped.events.some(e=>e.event_type==='step.started'&&(typeof e.payload==='string'?JSON.parse(e.payload):e.payload)?.node==='integrate_evidence'));
  await until(`document.querySelector('[role=dialog]')?.innerText.includes('已停止运行')`);
  await shot('workflow-review-paused.png');
  for(const width of [1280,1024,800]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(150);assert('review_no_overflow_'+width,await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));}
  assert('no_javascript_errors',session.errors.length===0);report.success=true;
 }catch(error){report.success=false;report.errors.push(error.stack);try{report.screenText=await evaluate('document.body.innerText');await shot('workflow-review-native-failure.png');}catch{}}
 finally{report.errors.push(...session.errors);await session.close();report.state='finished';save();console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;}
})().catch(error=>{report.state='finished';report.success=false;report.errors.push(error.stack);save();console.error(error);process.exitCode=1});
