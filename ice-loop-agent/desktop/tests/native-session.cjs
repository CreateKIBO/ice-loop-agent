'use strict';
// Shared source-Electron test session. Own process tree; no cloud credentials.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function openNativeSession(repo,runtime,{useWorkspaceSelection=false,entryPath=null}={}){
 const started=Date.now();
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env,ICE_DESKTOP_RUNTIME:runtime,PYTHONUTF8:'1',TEMP:runtime,TMP:runtime};
 if(entryPath){
  const file=path.resolve(entryPath),owned=path.resolve(runtime,'..')+path.sep;
  if(!file.startsWith(owned)||!fs.statSync(file).isFile())throw Error('Native test preload must belong to its fixture');
 }
 if(useWorkspaceSelection)delete env.ICE_DESKTOP_RUNTIME;
 for(const key of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'])delete env[key];
 const child=spawn(require('../node_modules/electron'),[entryPath||path.join(repo,'desktop'),'--new-ui','--startup-diagnostics','--remote-debugging-port='+port],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(runtime,'resource-electron.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let closed=false,ws,sequence=0;const pending=new Map(),errors=[];child.once('exit',()=>{closed=true;});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},45000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const until=async(expression,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await wait(150);}throw Error('UI timeout '+expression);};
 const close=async()=>{try{if(ws?.readyState===1)await call('Page.close');}catch{}if(!closed)await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve();};const timer=setTimeout(finish,4000);child.once('exit',finish);});if(!closed){const p=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await new Promise(r=>p.once('exit',r));}ws?.close();log.end();};
 try{
  let target,observed=[];for(let n=0;n<120;n++){if(closed)throw Error('Electron exited');try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();observed=targets.map(t=>({type:t.type,url:t.url}));target=targets.find(t=>t.url.startsWith('ice://app/'));if(target)break;}catch{}await wait(250);}
  if(!target){fs.writeFileSync(path.join(runtime,'native-startup-failure.json'),JSON.stringify({elapsed_ms:Date.now()-started,targets:observed},null,2));throw Error('Desktop target missing');}ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  await call('Runtime.enable');await call('Page.enable');await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  return {call,evaluate,until,close,errors,env,pid:child.pid,startupMs:Date.now()-started,
    getTargets:async()=>await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()};
 }catch(error){await close();throw error;}
}
module.exports={openNativeSession,wait};
