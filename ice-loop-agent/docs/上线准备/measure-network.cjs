'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'.test-tmp/release-network',crypto.randomUUID().replaceAll('-','').slice(0,12));
fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'.test-owner.json'),JSON.stringify({purpose:'network cancellation and bounded memory acceptance'}));
const report={scope:'Fresh independent Python clients; same 16MiB logical SSE event. Python traced allocation, not total OS RAM.',offered_payload_bytes:16*1024*1024,root,results:[]};
const server=http.createServer(async(req,res)=>{
 req.resume();res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'close'});
 if(req.url.startsWith('/valid/')){res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');return;}
 res.write('data: ');const chunk=Buffer.alloc(16384,'x');
 for(let n=0;n<1024&&!res.destroyed;n++){
  if(!res.write(chunk))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
 }
 if(!res.destroyed)res.end('\n');
});
const run=(mode,base)=>new Promise((resolve,reject)=>{
 const child=spawn(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B',path.join(__dirname,'measure_network_client.py'),mode,base],{cwd:repo,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',TEMP:root,TMP:root},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 child.on('exit',code=>code===0?resolve(JSON.parse(stdout.trim())):reject(Error('measurement exit '+code+' '+stderr)));child.on('error',reject);
});
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{report.results.push(await run('before',base));report.results.push(await run('after',base));
  report.success=report.results.every(r=>r.error_code==='RESPONSE_INCOMPLETE')&&report.results[1].python_traced_peak_bytes<report.results[0].python_traced_peak_bytes;
 }finally{await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(__dirname,'network-memory.json'),JSON.stringify(report,null,2));}
 if(!report.success)throw Error('memory comparison failed');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
