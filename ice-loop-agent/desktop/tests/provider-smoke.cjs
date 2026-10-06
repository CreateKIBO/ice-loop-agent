const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'.test-tmp/providers-v1');
const child=spawn(require('electron'),[path.join(root,'desktop'),'--provider-smoke'],{cwd:root,windowsHide:true,env:{...process.env,ICE_DESKTOP_RUNTIME:runtime,ICE_SMOKE_CREDENTIALS:path.join(root,'.desktop-runtime/credentials.json')},stdio:'pipe'});
child.stderr.on('data',()=>{});child.stdout.on('data',()=>{});
const timer=setTimeout(()=>{child.kill();console.error('Provider test exceeded its bounded timeout');process.exitCode=1;},180000);
child.on('exit',()=>{clearTimeout(timer);const file=path.join(runtime,'provider-smoke.json'),error=path.join(runtime,'provider-error.txt');if(fs.existsSync(file))console.log(fs.readFileSync(file,'utf8'));else {console.error(fs.existsSync(error)?fs.readFileSync(error,'utf8'):'No provider report');process.exitCode=1;}});
