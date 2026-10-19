'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'generation-fixture.json'),'utf8'));
const attempt=path.join(out,'generation-attempts',path.basename(fixture.root)+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',runtime:fixture.runtime,evidence_dir:attempt,window_metadata_seeded:true,cloud_calls:0,checks:{},errors:[]};
const save=()=>{const value=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'generation-native.json'),value);fs.writeFileSync(path.join(attempt,'result.json'),value);};
const assert=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
let session,call,evaluate,until;
const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
const clickSelector=async selector=>{
 await until(`(()=>{const e=${selector};if(!e||e.matches(':disabled'))return false;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
 const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const e=${selector},r=e.getBoundingClientRect();resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
};
const click=text=>clickSelector(`[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`);
const field=async(label,value)=>evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const shot=async name=>{const result=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(result.data,'base64'));};
const boot=()=>rpc('bootstrap');
(async()=>{
 save();try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});({call,evaluate,until}=session);
  await until(`Boolean(document.querySelector('#ice-account-select'))`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:2});await call('Input.dispatchKeyEvent',{type:'keyUp',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:2});
  await until(`Boolean(document.querySelector('.ice-generation-limits'))`);
  await clickSelector(`document.querySelector('.ice-generation-limits summary')`);
  assert('saved_output_and_endpoint_metadata_visible',await evaluate(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='4096'&&document.querySelector('.ice-generation-limits').innerText.includes('32,000')`));
  await field('qwen 最大输出 Token','6144');await click('保存输出设置');
  await until(`(async()=>(await window.ice.request('bootstrap')).settings.profiles[0].extra.max_output_tokens===6144)()`);
  assert('output_save_reaches_real_backend',(await boot()).settings.profiles[0].extra.max_output_tokens===6144);
  await field('qwen 最大输出 Token','9000');await click('保存输出设置');await until(`document.querySelector('.ice-generation-limits [role=alert]')?.innerText.includes('最大输出')`);
  assert('known_limit_rejects_without_overwriting_saved_value',(await boot()).settings.profiles[0].extra.max_output_tokens===6144&&await evaluate(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='9000'`));
  await click('完成');await until(`document.body.innerText.includes('模型或预算有未保存修改')`);await click('继续设置');
  assert('close_guard_keeps_unsaved_output',await evaluate(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='9000'`));
  await click('载入已保存输出设置');await until(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='6144'`);
  await field('qwen 最大输出 Token','4096');
  const prior=(await boot()).settings.profiles[0];
  await rpc('models.limits_save',{account_id:'ice-loop',provider:'qwen',limits_hash:prior.limits_hash,max_output_tokens:2048});
  await click('保存输出设置');await until(`document.querySelector('.ice-generation-limits [role=alert]')?.innerText.includes('已变化')`);
  assert('concurrent_save_is_rejected_and_input_kept',(await boot()).settings.profiles[0].extra.max_output_tokens===2048&&await evaluate(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='4096'`));
  await click('载入已保存输出设置');await until(`document.querySelector('[aria-label="qwen 最大输出 Token"]').value==='2048'`);
  await field('qwen 最大输出 Token','');await click('保存输出设置');await until(`(async()=>(await window.ice.request('bootstrap')).settings.profiles[0].extra.max_output_tokens===null)()`);
  assert('empty_value_restores_provider_default',(await boot()).settings.profiles[0].extra.max_output_tokens===null);
  for(const width of [1280,800]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});
   assert('settings_no_horizontal_overflow_'+width,await evaluate(`(()=>{const e=document.querySelector('[role=dialog]'),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1;})()`));
  }
  await shot('output-window-settings.png');
  await field('通义千问 模型 ID','new-offline-model');await click('保存模型');
  await until(`document.querySelector('.ice-generation-limits').innerText.includes('未知')`);
  assert('changing_model_invalidates_old_window_and_output',!(await boot()).settings.profiles[0].extra.model_window&&(await boot()).settings.profiles[0].extra.max_output_tokens===undefined);
  // The reserved .invalid host cannot receive a cloud request. Exercise the real
  // renderer -> IPC -> backend failure path; successful HTTP is covered separately.
  await click('读取模型窗口');
  await until(`document.querySelector('.ice-generation-limits [role=alert]')?.innerText.includes('域名解析失败')`,40000);
  assert('window_read_button_reaches_backend_and_preserves_unknown_on_dns_failure',!(await boot()).settings.profiles[0].extra.model_window);
  report.errors.push(...session.errors);assert('no_uncaught_renderer_errors',report.errors.length===0);
  report.state='finished';report.success=true;
 }catch(error){report.state='failed';report.success=false;report.errors.push(error.stack);if(session)try{await shot('failure.png');}catch{}throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({success:true,checks:Object.keys(report.checks).length,evidence_dir:attempt}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
