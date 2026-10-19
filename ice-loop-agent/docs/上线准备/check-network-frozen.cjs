'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'network-frozen-fixture.json'),'utf8').replace(/^\uFEFF/,''));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-network-frozen')||!fs.existsSync(fixture.exe))throw Error('Owned frozen fixture required');
const closed=new Set(),report={scope:'Packaged Windows network probe, not a desktop installer',checks:{},results:[],root:fixture.root};
const tlsServer=net.createServer(socket=>{socket.on('data',()=>{});socket.on('error',()=>{});socket.on('close',()=>closed.add('tls'));});
const server=http.createServer((req,res)=>{
 req.resume();const mode=req.url.split('/')[1];res.on('close',()=>closed.add(mode));
 if(mode!=='valid')return;
 res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'close'});
 res.end('data: '+JSON.stringify({choices:[{delta:{content:'冻结探针：中文 {1} "quote"'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
});
const run=mode=>new Promise((resolve,reject)=>{
 const child=spawn(fixture.exe,[String(server.address().port),mode,...(mode==='tls'?[String(tlsServer.address().port)]:[])],{cwd:fixture.root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',TEMP:fixture.root,TMP:fixture.root},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 child.once('error',reject);child.once('exit',code=>code===0?resolve({mode,...JSON.parse(stdout.trim()),stderr}):reject(Error('probe exit '+code+' '+stderr)));
});
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
 try{
  for(const mode of ['valid','cancel','timeout','tls'])report.results.push(await run(mode));
  report.checks.frozen_dependencies_and_unicode=report.results[0].frozen&&report.results[0].text==='冻结探针：中文 {1} "quote"';
  report.checks.cancel_and_deadline_release_connections=report.results.slice(1).every(r=>r.active_requests===0&&r.elapsed_ms<2000)&&closed.has('cancel')&&closed.has('timeout');
  report.checks.no_stderr_errors=report.results.every(r=>r.stderr==='');report.success=Object.values(report.checks).every(Boolean);
  report.checks.tls_handshake_socket_released=closed.has('tls');report.success=Object.values(report.checks).every(Boolean);
  report.exe_sha256=crypto.createHash('sha256').update(fs.readFileSync(fixture.exe)).digest('hex');
 }finally{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>tlsServer.close(resolve));fs.writeFileSync(path.join(__dirname,'network-frozen.json'),JSON.stringify(report,null,2));}
 if(!report.success)throw Error('packaged probe failed');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
