/* Read-only live-site observation in an isolated packaged app. No model or login actions. */
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'.test-tmp/tapnow-live-'+Date.now());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function cdp(url){
 const socket=new WebSocket(url),pending=new Map();let seq=0;
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);const item=pending.get(reply.id);if(item){clearTimeout(item.timer);pending.delete(reply.id);reply.error?item.reject(Error(reply.error.message)):item.resolve(reply.result);}});
 return {close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));})};
}
async function run(){
 fs.mkdirSync(runtime,{recursive:true});
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const app=spawn(path.join(root,'release/win-unpacked/ICE Loop Studio.exe'),['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{cwd:root,env:{...process.env,ICE_DESKTOP_RUNTIME:runtime},windowsHide:true,stdio:'ignore'});
 const connections=[];const result={runtime,url:'https://app.tapnow.media/home',readOnly:true};
 try{
  let targets=[];
  for(let i=0;i<120;i++){try{targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();if(targets.some(t=>t.type==='page'&&t.url.includes('index.html')))break;}catch{}await sleep(500);}
  const own=targets.find(t=>t.type==='page'&&t.url.includes('index.html'));if(!own)throw Error('App page not ready');
  const ui=await cdp(own.webSocketDebuggerUrl);connections.push(ui);
  const opened=await ui.send('Runtime.evaluate',{expression:'bootReady.then(()=>window.ice.openTapNow())',awaitPromise:true,returnByValue:true});if(opened.exceptionDetails)throw Error(opened.exceptionDetails.text);
  let remote;
  for(let i=0;i<80;i++){targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();remote=targets.find(t=>t.type==='page'&&t.url.startsWith('https://app.tapnow.media/'));if(remote)break;await sleep(500);}
  if(!remote)throw Error('Embedded TapNow target not ready');
  const page=await cdp(remote.webSocketDebuggerUrl);connections.push(page);
  const started=Date.now(),deadline=started+90000;
  do{
   try{const probe=await page.send('Runtime.evaluate',{expression:'({url:location.href,title:document.title,readyState:document.readyState,visibleCharacters:document.body?.innerText?.trim().length||0,canvasCount:document.querySelectorAll("canvas").length})',returnByValue:true});result.page=probe.result?.value;}catch(error){result.observationError=error.message;}
   if(result.page?.visibleCharacters>30&&result.page?.readyState==='complete'&&Date.now()-started>15000)break;await sleep(1000);
  }while(Date.now()<deadline);
  result.center= (await page.send('Runtime.evaluate',{expression:'document.elementFromPoint(innerWidth/2,innerHeight/2)?.outerHTML.slice(0,800)',returnByValue:true})).result?.value;
  try{const shot=await page.send('Page.captureScreenshot',{format:'png',fromSurface:true});const file=path.join(runtime,'live-tapnow.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));result.screenshot=file;}catch(error){result.captureError=error.message;}
  result.rendered=Boolean(result.page?.visibleCharacters>30&&result.screenshot);
 }catch(error){result.error=error.message;result.rendered=false;}
 finally{
  for(const conn of connections)conn.close();
  await new Promise(resolve=>{const kill=spawn('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.once('exit',resolve);kill.once('error',()=>{app.kill();resolve();});});
  fs.writeFileSync(path.join(root,'docs/v1.3-tapnow-live.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
