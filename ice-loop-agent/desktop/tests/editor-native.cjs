'use strict';
// Real renderer, preload and Python RPC. Delay saves with a lock on our fixture DB only.
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'editor-fixture.json'),'utf8'));
const result={state:'running',checks:{},errors:[],runtime:fixture.runtime};
fs.writeFileSync(path.join(out,'editor-native.json'),JSON.stringify(result,null,2));
const assert=(name,value)=>{result.checks[name]=Boolean(value);if(!value)throw Error(name+' failed');};
(async()=>{
 const session=await openNativeSession(repo,fixture.runtime),{evaluate,call,until}=session;
 const click=text=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})()`);
 const backToChat=async()=>{await click('← 返回对话');await until(`!document.querySelector('.ice-editor-bar')`);};
 const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({job_id:fixture.job,...params})})`);
 const source=()=>evaluate(`document.querySelector('.cm-content')?.innerText`);
 const replace=async text=>{
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
  if(text)await call('Input.insertText',{text});
  else{await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}
 };
 let locker;
 try{
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await until(`Boolean([...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='编辑正文'))`);
  await until(`document.body.innerText.includes('需要你的处理')`);
  assert('waiting_state_readable_in_task_card',true);
  await evaluate(`[...document.querySelectorAll('summary')].find(e=>e.innerText==='查看需要处理的内容').click()`);
  await click('复制原因');await until(`document.querySelector('[aria-label="复制原因"]')?.innerText.includes('已复制')`);
  assert('waiting_reason_can_expand_and_copy',true);
  await click('编辑正文');await until(`Boolean(document.querySelector('.tiptap h1'))`);
  const initialShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'editor-native-rich.png'),Buffer.from(initialShot.data,'base64'));
  await click('源模式');await until(`Boolean(document.querySelector('.cm-content'))`);
  const submitted='# 编辑验收\n\nSUBMITTED',newer='# 编辑验收\n\nNEWER_DURING_SAVE';
  await replace(submitted);
  locker=spawn(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',"import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(2); c.rollback(); c.close()",path.join(fixture.runtime,'app.db')],{cwd:repo,env:session.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{locker.stdout.once('data',resolve);locker.once('error',reject);locker.once('exit',code=>{if(code)reject(Error('fixture lock failed'))});});
  await click('保存新版本');await until(`document.querySelector('.ice-editor-bar')?.innerText.includes('正在保存')`);
  await replace(newer);
  await until(`!document.querySelector('.ice-editor-bar button[title="Ctrl+S"]')?.disabled`,15000);
  assert('late_version_ack_preserves_new_input',(await source()).includes('NEWER_DURING_SAVE'));
  assert('only_submitted_snapshot_is_published',(await rpc('articles.document')).markdown===submitted);
  assert('new_input_still_marked_dirty',await evaluate(`document.querySelector('.ice-editor-bar')?.innerText.includes('编辑中')||document.querySelector('.ice-editor-bar')?.innerText.includes('工作草稿已保存')`));
  await until(`window.ice.request('articles.editor_draft_get',{job_id:${JSON.stringify(fixture.job)}}).then(r=>r.draft?.content.includes('NEWER_DURING_SAVE'))`);
  assert('newer_input_persisted_as_recovery',true);
  await click('保存新版本');await until(`!document.querySelector('.ice-editor-bar button[title="Ctrl+S"]')?.disabled`);
  assert('second_save_uses_updated_baseline',(await rpc('articles.document')).markdown===newer);
  await backToChat();await click('编辑正文');await until(`Boolean(document.querySelector('.tiptap h1'))`);
  assert('old_recovery_not_offered_after_version_save',!await evaluate(`document.body.innerText.includes('检测到未保存的工作草稿')`));
  await click('源模式');await until(`Boolean(document.querySelector('.cm-content'))`);
  await replace('# 编辑验收\n\nRECOVER_ME');
  await backToChat();await click('编辑正文');await until(`document.body.innerText.includes('检测到未保存的工作草稿')`);
  await click('源模式');await until(`Boolean(document.querySelector('.cm-content'))`);
  await click('恢复草稿');await until(`document.querySelector('.cm-content')?.innerText.includes('RECOVER_ME')`);
  assert('source_view_updates_on_recovery',true);
  for(const width of [1280,1024,800]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(150);
    assert('editor_no_horizontal_overflow_'+width,await evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'));
    assert('save_stays_in_primary_row_'+width,await evaluate(`(()=>{const row=document.querySelector('.ice-editor-bar__primary').getBoundingClientRect(),button=document.querySelector('button[title="Ctrl+S"]').getBoundingClientRect();return button.top>=row.top&&button.bottom<=row.bottom+1&&button.right<=row.right+1;})()`));
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const sourceShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'editor-native-source.png'),Buffer.from(sourceShot.data,'base64'));
  await replace('');await backToChat();
  assert('empty_recovery_saved_before_navigation',(await rpc('articles.editor_draft_get')).draft?.content==='');
  await click('编辑正文');await until(`document.body.innerText.includes('检测到未保存的工作草稿')`);
  await click('恢复草稿');await click('源模式');await until(`Boolean(document.querySelector('.cm-content'))`);
  assert('empty_recovery_can_be_restored',(await source()).trim()==='');
  assert('empty_recovery_did_not_erase_published_body',(await rpc('articles.document')).markdown===newer);
  const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'editor-native.png'),Buffer.from(shot.data,'base64'));
  assert('no_javascript_errors',session.errors.length===0);result.passed=true;
 }catch(error){
  result.passed=false;result.errors.push(error.stack);
  try{
    result.screenText=await evaluate('document.body.innerText');
    const shot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(out,'editor-native-failure.png'),Buffer.from(shot.data,'base64'));
  }catch{}
 }
 finally{
  if(locker&&locker.exitCode===null)await new Promise(resolve=>locker.once('exit',resolve));
  result.errors.push(...session.errors);await session.close();
  result.state='finished';
  fs.writeFileSync(path.join(out,'editor-native.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
 }
})().catch(error=>{console.error(error);process.exitCode=1});
