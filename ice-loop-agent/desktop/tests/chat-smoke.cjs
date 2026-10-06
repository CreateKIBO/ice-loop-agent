const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'.test-tmp/chat-desktop-'+Date.now());
const python=path.join(root,'.venv/Scripts/python.exe');
const seed=spawn(python,['-m','tests.prepare_chat_smoke',runtime],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:'pipe'});
seed.stderr.on('data',d=>process.stderr.write(d));
seed.on('exit',code=>{
 if(code!==0){process.exitCode=1;return;}
 const packaged=process.env.ICE_PACKAGED_EXE;
 const env={...process.env,ICE_DESKTOP_RUNTIME:runtime};
 if(packaged){env.PATH=path.join(process.env.SystemRoot,'System32');for(const key of ['ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH'])delete env[key];}
 const child=spawn(packaged||require('electron'),packaged?['--chat-smoke']:[path.join(root,'desktop'),'--chat-smoke'],{cwd:root,windowsHide:true,env,stdio:'pipe'});
 let errors='';child.stderr.on('data',d=>errors+=d);
 const timer=setTimeout(()=>{if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();console.error('chat timeout',runtime);process.exitCode=1;},1200000);
 child.on('exit',code=>{clearTimeout(timer);const result=path.join(runtime,'chat-result.json'),error=path.join(runtime,'chat-error.txt');if(code!==0||!fs.existsSync(result)){console.error(fs.existsSync(error)?fs.readFileSync(error,'utf8'):errors,runtime);process.exitCode=1;}else console.log(JSON.stringify({runtime,...JSON.parse(fs.readFileSync(result,'utf8'))},null,2));});
});
