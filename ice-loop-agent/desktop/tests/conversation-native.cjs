'use strict';
// Native Electron acceptance. G-only fixture; never sends to an AI provider.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'), out=path.join(repo,'docs/交互迭代-2026-10-15');
const fixture=JSON.parse(fs.readFileSync(path.join(out,'native-fixture.json'),'utf8'));
const result={checks:{},errors:[],runtime:fixture.runtime};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(name,value)=>{result.checks[name]=Boolean(value);if(!value)throw Error(name+' failed');};
(async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env,ICE_DESKTOP_RUNTIME:fixture.runtime,PYTHONUTF8:'1',TEMP:fixture.runtime,TMP:fixture.runtime};
 for(const key of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'])delete env[key];
 const child=spawn(require('../node_modules/electron'),[path.join(repo,'desktop'),'--new-ui','--remote-debugging-port='+port],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(fixture.runtime,'electron.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ws,closed=false,id=0;const pending=new Map();child.on('exit',()=>{closed=true;});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method));},45000);
  pending.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id:key,method,params}));});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const until=async(expression,ms=18000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return true;await delay(200);}throw Error('UI timeout: '+expression);};
 const click=async(text,scope='document')=>evaluate(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b)throw Error('Button missing: '+${JSON.stringify(text)});b.click();return true;})()`);
 const setInput=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 const choose=title=>evaluate(`document.querySelector('button[title='+CSS.escape(${JSON.stringify(title)})+']').click()`);
 const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'));};
 try{
  let target;for(let n=0;n<100;n++){if(closed)throw Error('Electron exited');try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.url.startsWith('ice://app/'));if(target)break;}catch{}await delay(250);}
  if(!target)throw Error('Desktop target missing');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')result.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(`Boolean(document.querySelector('button[title="交互验收会话"]'))`);await choose('交互验收会话');
  await until(`document.querySelectorAll('.ice-markdown table').length>=16`);
  assert('markdown_layout',await evaluate(`Boolean(document.querySelector('.ice-chat-log h1')&&document.querySelector('.ice-chat-log pre code')&&document.querySelector('.ice-chat-log table'))`));
  assert('model_html_and_remote_images_inert',await evaluate(`!window.__UX_INJECTED&&!document.querySelector('.ice-markdown script,.ice-markdown iframe,.ice-markdown img')`));
  await click('复制代码');await until(`document.querySelector('[aria-label="复制代码"]')?.innerText.includes('已复制')`);assert('desktop_code_copy',true);
  await click('重命名');await setInput('#ice-conversation-title','重新命名的创作会话');await click('保存名称');
  await until(`document.querySelector('.ice-conversation-header h1')?.innerText==='重新命名的创作会话'`);
  assert('rename_persisted',await evaluate(`window.ice.request('chat.get',{conversation_id:${JSON.stringify(fixture.conversation)}}).then(r=>r.conversation.title==='重新命名的创作会话')`));
  await setInput('textarea[aria-label="消息输入"]','NATIVE_UNSENT_INPUT');
  await click('初稿',`document.querySelector('[aria-label="创作模式"]')`);await delay(120);
  await choose('第二个验收会话');await until(`document.querySelector('.ice-conversation-header h1')?.innerText==='第二个验收会话'`);
  assert('other_thread_input_isolated',await evaluate(`document.querySelector('textarea[aria-label="消息输入"]').value===''`));
  await choose('重新命名的创作会话');await until(`document.querySelector('textarea[aria-label="消息输入"]')?.value==='NATIVE_UNSENT_INPUT'`);
  assert('mode_restored_on_thread_switch',await evaluate(`document.querySelector('[aria-label="创作模式"] [aria-pressed=true]')?.innerText==='初稿'`));
  await evaluate(`(()=>{const e=document.querySelector('.ice-chat-log');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));})()`);
  await until(`Boolean(document.querySelector('.ice-jump-latest'))`);
  assert('cached_history_not_counted_as_new',await evaluate(`!document.querySelector('.ice-jump-latest').innerText.includes('条回复有更新')`));
  await evaluate('window.__UX_BEFORE_RELOAD=true');await cdp('Page.reload');
  await until(`!window.__UX_BEFORE_RELOAD && document.readyState==='complete' && Boolean(document.querySelector('button[title="重新命名的创作会话"]'))`);await choose('重新命名的创作会话');
  await until(`document.querySelector('textarea[aria-label="消息输入"]')?.value==='NATIVE_UNSENT_INPUT'`);
  assert('input_and_mode_survive_reload',await evaluate(`document.querySelector('[aria-label="创作模式"] [aria-pressed=true]')?.innerText==='初稿'`));
  await until(`document.querySelectorAll('.ice-markdown table').length>=16`);
  await evaluate(`(()=>{const e=document.querySelector('.ice-chat-log');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));})()`);await until(`Boolean(document.querySelector('.ice-jump-latest button'))`);
  // Append a completed fixture message through SQLite, then wait for the real chat.get polling path.
  const code="import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',('native-new-reply',sys.argv[2],'assistant','## 新的回复\\n\\nNATIVE_NEW_REPLY','completed','{}','2026-10-15T12:00:00+08:00')); c.commit(); c.close()";
  execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',code,path.join(fixture.runtime,'app.db'),fixture.conversation],{cwd:repo,env,windowsHide:true});
  await until(`document.querySelector('.ice-jump-latest')?.innerText.includes('1 条回复有更新')`,20000);
  assert('new_reply_does_not_steal_reading_position',await evaluate(`document.querySelector('.ice-chat-log').scrollTop<80`));
  await evaluate(`document.querySelector('.ice-jump-latest button').click()`);await delay(250);
  assert('jump_to_latest',await evaluate(`(()=>{const e=document.querySelector('.ice-chat-log');return e.scrollHeight-e.scrollTop-e.clientHeight<80;})()`));
  await shot('conversation.png');
  await choose('原生草稿预览');await until(`Boolean(document.querySelector('[role=dialog] table'))`);
  assert('draft_reading_preview',await evaluate(`Boolean(document.querySelector('[role=dialog] h1'))`));
  await click('Markdown',`document.querySelector('[role=dialog]')`);
  assert('draft_source_mode',await evaluate(`document.querySelector('.ice-draft-reading > pre')?.innerText.includes('# 阅读示例')`));
  await click('排版预览',`document.querySelector('[role=dialog]')`);await until(`Boolean(document.querySelector('[role=dialog] table'))`);await shot('draft-preview.png');
  await click('关闭',`document.querySelector('[role=dialog]')`);
  await click('再次使用');await delay(100);
  assert('reuse_preserves_current_input',await evaluate(`(()=>{const t=document.querySelector('textarea[aria-label="消息输入"]').value;return t.includes('NATIVE_UNSENT_INPUT')&&t.includes('保留这个问题');})()`));
  for(const width of [1280,1024,800]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await delay(150);
    assert('no_overflow_'+width,await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
  }
  assert('no_javascript_errors',result.errors.length===0);result.passed=true;
 }catch(error){result.errors.push(error.stack);result.passed=false;try{if(ws)await shot('native-failure.png');}catch{}}
 finally{
  try{if(ws?.readyState===1)await cdp('Page.close');}catch{}
  if(!closed)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(4000)]);
  if(!closed){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(r=>killer.on('exit',r));}
  ws?.close();log.end();fs.writeFileSync(path.join(out,'native-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
