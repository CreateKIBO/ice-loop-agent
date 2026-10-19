'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'budget-fixture.json'),'utf8'));
const attempt=path.join(out,'budget-attempts',path.basename(path.dirname(fixture.runtime))+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',runtime:fixture.runtime,evidence_dir:attempt,ledger_fixture:fixture.ledger_entries,checks:{},errors:[]};
const save=()=>{const body=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'budget-native.json'),body);fs.writeFileSync(path.join(attempt,'result.json'),body);};
const assert=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
(async()=>{
 save();const session=await openNativeSession(repo,fixture.runtime),{call,evaluate,until}=session;report.startupMs=session.startupMs;
 const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`;
 const pointer=async expression=>{
  // A toast can expire between hit-testing and mouse-up. Retry only if the
  // target received no click; never repeat an action that actually fired.
  for(let n=0;n<3;n++){
   await until(`(()=>{const b=${expression};if(!b||b.matches(':disabled'))return false;b.scrollIntoView({block:'center',inline:'nearest'});const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
   const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const b=${expression},r=b.getBoundingClientRect(),s={button:b,clicked:false};s.listener=()=>{s.clicked=true;};b.addEventListener('click',s.listener,{once:true,capture:true});window.__budgetPointer=s;resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
   if(await evaluate(`(()=>{const s=window.__budgetPointer;s.button.removeEventListener('click',s.listener,true);delete window.__budgetPointer;return s.clicked;})()`))return;
  }
  throw Error('Target did not receive pointer click: '+expression);
 };
 const click=(text,scope='document')=>pointer(button(text,scope));
 const field=async(label,value)=>{
  await until(`Boolean(document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']')?.matches(':enabled'))`);
  await evaluate(`(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 };
 const shortcut=async(key,code,virtual)=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtual,nativeVirtualKeyCode:virtual,modifiers:2});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtual,nativeVirtualKeyCode:virtual,modifiers:2});};
 const open=async()=>{await shortcut(',','Comma',188);await until(`Boolean(document.querySelector('[aria-label="普通文章默认上限"]'))`);};
 const shot=async name=>{const data=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(data.data,'base64'));};
 const qwen='document.querySelector(\'section[aria-label="通义千问"]\')';
 const view=()=>rpc('budgets.get',{conversation_id:fixture.conversation});
 try{
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(`(async()=>Boolean((await window.ice.request('jobs.get',{job_id:${JSON.stringify(fixture.old_job)}})).pending_approval))()`);
  const priorWorkflow=await rpc('jobs.get',{job_id:fixture.old_job});
  assert('fixture_job_only_used_mock_adapter',priorWorkflow.invocations.length>0&&priorWorkflow.invocations.every(row=>row.adapter==='mock'));
  const initialInvocations=(await rpc('tools.diagnostics')).report.counts.model_invocations;
  report.initial_invocations=initialInvocations;report.workflow_mock_invocations=priorWorkflow.invocations.length;
  await pointer(`[...document.querySelectorAll('.ice-nav-row__main')].find(e=>e.innerText.includes(${JSON.stringify(fixture.title)}))`);
  await until(`Boolean(document.querySelector('textarea'))`);await open();
  await until(`document.querySelector('[aria-label="普通文章默认上限"]').value==='24'&&document.body.innerText.includes('当前会话已用2次')`);
  assert('global_budget_is_visible_without_scrolling_to_providers',await evaluate(`(()=>{const h=document.querySelector('[data-budget-heading]').getBoundingClientRect();return h.top>0&&h.bottom<innerHeight;})()`));
  assert('ledger_counts_success_and_failure_but_not_capability_mismatch',(await view()).conversation.used===2);
  await field('普通文章默认上限','');await click('保存全局预算');await until(`document.body.innerText.includes('普通文章与补图上限需为1–100')`);
  assert('empty_article_limit_is_rejected_without_writing',(await view()).max_model_calls===24);
  await field('普通文章默认上限','0');await click('保存全局预算');await until(`document.body.innerText.includes('0不能用来解除限制')`);
  assert('zero_article_limit_does_not_mean_unlimited',(await view()).max_model_calls===24);
  await field('普通文章默认上限','30');await field('补图任务默认上限','15');await field('会话模型调用上限','0');
  await click('完成');await until(`document.body.innerText.includes('模型或预算有未保存修改')`);await click('继续设置');
  assert('closing_settings_retains_all_three_unsaved_limits',await evaluate(`document.querySelector('[aria-label="普通文章默认上限"]').value==='30'&&document.querySelector('[aria-label="会话模型调用上限"]').value==='0'`));
  await shortcut('n','KeyN',78);await until(`document.body.innerText.includes('全局预算有未保存修改')`);
  assert('navigation_cannot_drop_unsaved_budget',(await rpc('chat.list')).length===1);
  await click('保存全局预算');await until(`document.body.innerText.includes('全局预算已保存')&&document.body.innerText.includes('当前会话已用2次 · 不限制')`);
  let current=await view();assert('all_three_defaults_are_saved_to_real_backend',current.max_model_calls===30&&current.max_image_model_calls===15&&current.max_chat_calls===0);
  assert('chat_unlimited_preserves_used_ledger_count',current.chat_unlimited&&current.conversation.used===2&&current.conversation.remaining===null);
  assert('budget_editing_did_not_call_any_model',(await rpc('tools.diagnostics')).report.counts.model_invocations===initialInvocations);
  const existing=await rpc('jobs.get',{job_id:fixture.old_job});assert('existing_article_keeps_its_original_budget',existing.job.limits.max_model_calls===24);
  const next=await rpc('jobs.create',{topic:'保存预算之后的新任务',series:'PY',episode:72,demo:true});
  assert('new_article_inherits_saved_default',(await rpc('jobs.get',{job_id:next.job_id})).job.limits.max_model_calls===30);
  await until(`(async()=>Boolean((await window.ice.request('jobs.get',{job_id:${JSON.stringify(next.job_id)}})).pending_approval))()`);
  const nextWorkflow=await rpc('jobs.get',{job_id:next.job_id});
  assert('new_demo_job_only_used_mock_adapter',nextWorkflow.invocations.length>0&&nextWorkflow.invocations.every(row=>row.adapter==='mock'));
  const expectedInvocations=initialInvocations+nextWorkflow.invocations.length;
  report.workflow_mock_invocations+=nextWorkflow.invocations.length;
  await shot('budget-saved.png');
  await field('普通文章默认上限','31');
  await rpc('budgets.save',{scope:'defaults',max_model_calls:42,max_image_model_calls:16,max_chat_calls:8});
  await click('保存全局预算');await until(`document.body.innerText.includes('全局预算已在别处修改')`);
  assert('stale_budget_save_preserves_local_input_and_server',await evaluate(`document.querySelector('[aria-label="普通文章默认上限"]').value==='31'`)&&(await view()).max_model_calls===42);
  await click('载入最新预算');await until(`document.body.innerText.includes('是否放弃预算修改')`);await click('保留预算修改');
  assert('reload_cancel_keeps_budget_input',await evaluate(`document.querySelector('[aria-label="普通文章默认上限"]').value==='31'`));
  await click('载入最新预算');await until(`document.body.innerText.includes('是否放弃预算修改')`);await click('放弃预算修改并载入');
  await until(`document.querySelector('[aria-label="普通文章默认上限"]').value==='42'`);
  assert('explicit_reload_gets_actual_latest_budget',await evaluate(`document.querySelector('[aria-label="补图任务默认上限"]').value==='16'&&document.querySelector('[aria-label="会话模型调用上限"]').value==='8'`));
  await click('完成');await until(`!document.querySelector('[role=dialog]')`);await open();
  await until(`document.querySelector('[aria-label="普通文章默认上限"]').value==='42'`);
  assert('saved_defaults_survive_modal_reopen',true);
  await field('通义千问 模型 ID','fixture-local-model');
  await rpc('models.save',{provider:'qwen',model_id:'fixture-external-model'});
  await field('普通文章默认上限','43');await click('保存全局预算');await until(`document.body.innerText.includes('全局预算已保存')`);
  assert('bootstrap_refresh_does_not_replace_model_input',await evaluate(`document.querySelector('[aria-label="通义千问 模型 ID"]').value==='fixture-local-model'`));
  await click('保存模型',qwen);await until(`document.body.innerText.includes('模型配置已在别处修改')`);
  assert('stale_model_save_is_refused',(await rpc('bootstrap')).settings.profiles.find(p=>p.provider==='qwen').model_id==='fixture-external-model');
  await click('放弃当前模型输入并载入',qwen);await until(`document.querySelector('[aria-label="通义千问 模型 ID"]').value==='fixture-external-model'`);
  await field('通义千问 模型 ID','fixture-saved-model');await click('保存模型',qwen);await until(`document.body.innerText.includes('通义千问模型已保存')`);
  assert('model_id_saves_without_probe_or_generation',(await rpc('bootstrap')).settings.profiles.find(p=>p.provider==='qwen').model_id==='fixture-saved-model');
  await field('通义千问 API Key','fixture-only-no-real-key');await click('保存 Key',qwen);
  await until(`document.querySelector('[aria-label="通义千问 API Key"]').value===''&&${qwen}.innerText.includes('可测试连接')`);
  assert('key_is_saved_through_real_encrypted_desktop_bridge',(await rpc('bootstrap')).settings.profiles.find(p=>p.provider==='qwen').has_key);
  await field('通义千问 API Key','fixture-replacement-not-saved');
  assert('probe_cannot_silently_use_old_key_while_new_key_is_typed',await evaluate(`[...${qwen}.querySelectorAll('button')].find(e=>e.innerText==='测试连接').disabled`));
  await click('完成');await until(`document.body.innerText.includes('模型或预算有未保存修改')`);await click('继续设置');
  assert('unsaved_key_is_retained_only_in_current_window',await evaluate(`document.querySelector('[aria-label="通义千问 API Key"]').value==='fixture-replacement-not-saved'&&![...Array(localStorage.length)].some((_,i)=>(localStorage.getItem(localStorage.key(i))||'').includes('fixture-replacement-not-saved'))`));
  await shortcut('n','KeyN',78);await until(`document.body.innerText.includes('通义千问设置有未保存修改')`);
  assert('unsaved_key_blocks_navigation',(await rpc('chat.list')).length===1);
  await click('完成');await click('放弃未保存设置并离开');await until(`!document.querySelector('[role=dialog]')`);await open();
  assert('discard_drops_unsaved_key_and_keeps_saved_model',await evaluate(`document.querySelector('[aria-label="通义千问 API Key"]').value===''&&document.querySelector('[aria-label="通义千问 模型 ID"]').value==='fixture-saved-model'`));
  for(const [width,height] of [[1280,900],[1024,768],[800,640]]){
   await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   assert('settings_fit_'+width,await evaluate(`(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()`));
  }
  await shot('budget-small-window.png');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await click('完成');await until(`!document.querySelector('[role=dialog]')`);await shortcut('n','KeyN',78);
  await until(`document.body.innerText.includes('讨论')`);assert('closing_settings_releases_all_navigation_guards',(await rpc('chat.list')).length===2);
  assert('settings_actions_did_not_make_model_requests',(await rpc('tools.diagnostics')).report.counts.model_invocations===expectedInvocations);
  assert('no_javascript_errors',session.errors.length===0);
 }catch(error){report.errors.push(error.stack||String(error));try{await shot('failure.png');report.debug=await evaluate(`({text:document.body.innerText.slice(-5000),fields:[...document.querySelectorAll('[role=dialog] input:not([type=password])')].map(e=>({label:e.getAttribute('aria-label'),value:e.value}))})`);}catch{}}
 finally{report.state='finished';report.success=!report.errors.length&&Object.values(report.checks).every(Boolean);save();await session.close();console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;}
})().catch(error=>{report.state='finished';report.success=false;report.errors.push(error.stack||String(error));save();console.error(error);process.exitCode=1;});
