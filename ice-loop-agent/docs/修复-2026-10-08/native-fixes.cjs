'use strict';
// 本轮实际Electron UI验收；全部runtime/fixture在G盘，不改应用源码。
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(repo,'.test-tmp/small-fixes-20261008/native-retry/review-fixture.json'),'utf8'));
const packaged=false;
const runtime=packaged?path.join(repo,'.test-tmp/small-fixes-20261008/native-packaged'):fixture.runtime;
if(packaged){
 fs.mkdirSync(runtime,{recursive:true});
 for(const file of ['app.db','settings.json'])fs.copyFileSync(path.join(fixture.runtime,file),path.join(runtime,file));
}
const resultFile=path.join(repo,'docs/修复-2026-10-08',packaged?'native-packaged-result.json':'native-source-result.json');
const results={mode:packaged?'packaged':'source',runtime,observations:{},errors:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const executable=packaged?path.join(repo,'release/win-unpacked/ICE Loop Studio.exe'):require(path.join(repo,'desktop/node_modules/electron'));
 const env={...process.env,ICE_DESKTOP_RUNTIME:runtime,PYTHONUTF8:'1'};
 for(const key of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'])delete env[key];
 const args=packaged?['--new-ui','--remote-debugging-port='+port]:[path.join(repo,'desktop'),'--new-ui','--remote-debugging-port='+port];
 const child=spawn(executable,args,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(runtime,'native-review.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ws,next=0,pending=new Map(),closed=false;
 child.on('exit',()=>{closed=true;});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  ws.send(JSON.stringify({id,method,params}));
 });
 const evaluate=async expression=>{
  const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result?.value;
 };
 const shot=async name=>{
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(repo,'docs/修复-2026-10-08',name),Buffer.from(shot.data,'base64'));
 };
 try{
  let target;
  for(let n=0;n<100;n++){
   if(closed)throw Error('Electron exited before connection');
   try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();target=targets.find(t=>t.url.startsWith('ice://app/'));if(target)break;}catch{}
   await delay(300);
  }
  if(!target)throw Error('No desktop page target');
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{
   const message=JSON.parse(event.data);
   if(message.id){const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.error?request.reject(Error(JSON.stringify(message.error))):request.resolve(message.result);}
   if(message.method==='Runtime.exceptionThrown')results.errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
   if(message.method==='Page.javascriptDialogOpening')cdp('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});
  });
  await cdp('Runtime.enable');await cdp('Page.enable');
  for(let n=0;n<80;n++){const ready=await evaluate("document.body.innerText.includes('制作任务')");if(ready)break;await delay(250);}
  results.observations.initial_text=await evaluate('document.body.innerText.slice(0,1500)');
  results.observations.has_new_conversation_button=await evaluate("[...document.querySelectorAll('button')].some(b=>/新建.*(会话|对话)/.test(b.innerText))");
  results.observations.chat_get_shape=await evaluate("window.ice.request('chat.get',{conversation_id:"+JSON.stringify(fixture.conversation_id)+"}).then(r=>({isArray:Array.isArray(r),keys:Object.keys(r),messages:Array.isArray(r.messages)}))");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='原生验收已有会话').click()");
  await delay(2200);
  results.observations.after_conversation_click=await evaluate('document.body.innerText.slice(0,1800)');
  results.observations.conversation_crashes=/some is not a function/.test(results.observations.after_conversation_click);
  await shot(packaged?'packaged-chat-crash.png':'source-chat-crash.png');
  await cdp('Page.reload');await delay(1800);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='编辑正文').click()");
  await delay(1800);
  results.observations.editor_text=await evaluate('document.body.innerText.slice(0,2200)');
  results.observations.editor_open=await evaluate("Boolean(document.querySelector('.ProseMirror,[contenteditable=true]'))");
  results.observations.editor_initial=await evaluate("document.querySelector('.ProseMirror,[contenteditable=true]')?.innerText");
  if(!results.observations.editor_open)throw Error('Editor did not mount: '+results.observations.editor_text);
  await evaluate("(()=>{const e=document.querySelector('.ProseMirror,[contenteditable=true]');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false,' RICH_UNSAVED_MARKER');return e.innerText;})()");
  await delay(100);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='源模式').click()");
  await delay(800);
  results.observations.source_after_rich_edit=await evaluate("document.querySelector('.cm-content')?.innerText||document.querySelector('textarea')?.value");
  results.observations.rich_edit_missing_from_source=!results.observations.source_after_rich_edit?.includes('RICH_UNSAVED_MARKER');
  await shot(packaged?'packaged-editor-source-loss.png':'source-editor-source-loss.png');
  await evaluate("(()=>{const e=document.querySelector('.cm-content');if(!e)return false;e.focus();document.execCommand('selectAll');document.execCommand('insertText',false,'# SOURCE_UNSAVED_MARKER\\n\\nSource mode edited.');return e.innerText;})()");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='富文本').click()");
  await delay(200);
  results.observations.rich_after_source_edit=await evaluate("document.querySelector('.ProseMirror,[contenteditable=true]')?.innerText");
  results.observations.source_edit_missing_from_rich=!results.observations.rich_after_source_edit?.includes('SOURCE_UNSAVED_MARKER');

  await delay(1000);
  results.observations.recovery_draft=await evaluate("window.ice.request('articles.editor_draft_get',{job_id:"+JSON.stringify(fixture.job_id)+"}).then(r=>r.draft?.content||'')");
  results.observations.source_draft_persisted=results.observations.recovery_draft.includes('SOURCE_UNSAVED_MARKER');
  const before=await evaluate("window.ice.request('chat.list',{}).then(r=>r.length)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='新建会话').click()");
  await delay(1600);
  const after=await evaluate("window.ice.request('chat.list',{}).then(r=>r.length)");
  results.observations.create_conversation_works=after===before+1;
  results.observations.new_conversation_composer=await evaluate("Boolean(document.querySelector('textarea'))");
  // Only this test runtime is mutated; the real application is untouched.

  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
  await delay(150);
  results.observations.palette_visible=await evaluate("document.body.innerText.includes('打开统一文章编辑器')");

  const o=results.observations;
  results.accepted=o.has_new_conversation_button && !o.conversation_crashes && o.editor_open
    && !o.rich_edit_missing_from_source && !o.source_edit_missing_from_rich
    && o.source_draft_persisted && o.create_conversation_works && o.new_conversation_composer;
  if(!results.accepted) throw Error('Native scoped regression did not meet all checks');
  results.observations.status='completed';

 }catch(error){results.observations.status='error';results.errors.push(error.stack);}
 finally{
  try{if(ws?.readyState===1)await cdp('Page.close');}catch{}
  if(!closed)await Promise.race([new Promise(r=>child.once('exit',r)),delay(4000)]);
  if(!closed){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(r=>killer.on('exit',r));}
  ws?.close();log.end();
  fs.writeFileSync(resultFile,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  if(!results.accepted)process.exitCode=1;
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
