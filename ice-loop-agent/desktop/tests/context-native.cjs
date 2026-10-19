'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'context-fixture.json'),'utf8'));
const attempt=path.join(out,'context-attempts',path.basename(fixture.root)+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',offline_model:true,runtime:fixture.runtime,evidence_dir:attempt,checks:{},errors:[]};
const save=()=>{const value=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'context-native.json'),value);fs.writeFileSync(path.join(attempt,'result.json'),value);};
const assert=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
let session,call,evaluate,until;
const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({account_id:fixture.account_id,...params})})`);
const clickSelector=async selector=>{
 await until(`(()=>{const e=${selector};if(!e||e.matches(':disabled'))return false;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
 const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const e=${selector},r=e.getBoundingClientRect();resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
};
const click=text=>clickSelector(`[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`);
const field=async(label,value)=>evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');const setter=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const shot=async name=>{const image=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(image.data,'base64'));};
(async()=>{
 save();try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});({call,evaluate,until}=session);
  await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(fixture.account_id)}`);
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:950,deviceScaleFactor:1,mobile:false});
  await click('选题与排期');await until(`document.querySelector('[aria-label="本期期号"]')?.value==='1491'`);
  assert('next_issue_follows_1490_published_articles',true);
  const context=await rpc('planning.context',{series:'OBS'});
  report.before_characters=JSON.stringify(context).length;
  assert('old_gate_reproduced_by_same_history_alone',report.before_characters>180000);
  assert('full_history_remains_1500_titles_and_five_bodies',context.known_titles.length===1500&&context.history.length===5&&context.history[4].body_excerpt.includes('正文尾部 1486'));
  await field('确认本期标题','第一千四百九十一次观察');
  await field('本期内容要点','承接前五篇全文和全部历史标题，不重复旧选题。');
  await click('确认并带入对话');await until(`!document.querySelector('[role=dialog]')&&document.querySelector('[aria-label="消息输入"]')?.value.includes('第1491期')`);
  await click('发送');await until(`Boolean(document.querySelector('[aria-label="初稿候选"]'))`,40000);
  const cid=(await rpc('chat.list'))[0].id,chat=await rpc('chat.get',{conversation_id:cid});
  const candidate=chat.candidates[0],reply=chat.messages.filter(row=>row.role==='assistant').at(-1),manifest=reply.metadata.input_manifest;
  report.manifest=manifest;report.conversation_id=cid;
  assert('real_router_generated_candidate_with_confirmed_title_and_issue',reply.status==='completed'&&candidate.title==='第一千四百九十一次观察'&&candidate.body.startsWith('# 第一千四百九十一次观察')&&candidate.base.episode===1491);
  assert('initial_actual_message_with_system_history_schema_fits_local_limit',manifest.text_characters<=180000&&manifest.limit_kind==='local_text_characters');
  assert('receipt_proves_complete_title_table_and_five_bodies',manifest.history_sources[0].title_count===1500&&manifest.history_sources[0].full_body_count===5&&manifest.history_sources[0].encoding==='title-table/v1');
  await clickSelector(`document.querySelector('.ice-context-receipt summary')`);
  assert('receipt_is_openable_and_explains_token_distinction',await evaluate(`document.querySelector('.ice-context-receipt').open&&document.querySelector('.ice-context-receipt').innerText.includes('Token')`));
  for(const width of [1280,800]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});
   assert('chat_has_no_horizontal_overflow_'+width,await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.ice-context-receipt')].every(e=>e.scrollWidth<=e.clientWidth+1)`));
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:950,deviceScaleFactor:1,mobile:false});await shot('long-history-draft.png');
  await click('保存为草稿');await until(`document.body.innerText.includes('已保存草稿')`);
  const saved=await rpc('chat.drafts');
  assert('saved_draft_uses_1491_and_does_not_start_job',saved.some(row=>row.title===candidate.title&&row.episode===1491)&&(await rpc('jobs.list')).length===0);
  report.errors.push(...session.errors);assert('no_uncaught_renderer_errors',report.errors.length===0);
  report.state='finished';report.success=true;
 }catch(error){report.state='failed';report.success=false;report.errors.push(error.stack);if(session)try{await shot('failure.png');}catch{}throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({success:true,checks:Object.keys(report.checks).length,evidence_dir:attempt}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
