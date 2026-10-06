const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),runtime=path.join(process.env.ICE_TEST_RUNTIME_BASE||path.join(root,'.test-tmp'),'browser-'+Date.now());fs.mkdirSync(runtime,{recursive:true});
const exe=process.env.ICE_TEST_EXECUTABLE,env={...process.env,ICE_DESKTOP_RUNTIME:runtime};
if(exe){env.PATH=path.join(process.env.SystemRoot,'System32');for(const key of ['ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH'])delete env[key];}
const child=spawn(exe||require('electron'),exe?['--browser-smoke']:[path.join(root,'desktop'),'--browser-smoke'],{cwd:exe?path.dirname(exe):root,env,windowsHide:true,stdio:'pipe'});
let stderr='';child.stderr.on('data',data=>stderr+=data);const timer=setTimeout(()=>child.kill(),180000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timer);try{if(fs.existsSync(path.join(runtime,'browser-error.txt')))throw Error(fs.readFileSync(path.join(runtime,'browser-error.txt'),'utf8'));assert.equal(code,0);const result=JSON.parse(fs.readFileSync(path.join(runtime,'browser-result.json'),'utf8'));console.log(JSON.stringify({runtime,packaged:!!exe,...result},null,2));}catch(error){console.error(error.message,stderr.slice(-1000),runtime);process.exitCode=1;}});
