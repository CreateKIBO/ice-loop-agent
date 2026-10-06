const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),runtime=path.join(process.env.ICE_TEST_RUNTIME_BASE||path.join(root,'.test-tmp'),'prompt-native-'+Date.now());
fs.mkdirSync(runtime,{recursive:true});
const prepare=spawnSync(path.join(root,'.venv/Scripts/python.exe'),['-m','tests.prepare_prompt_smoke',runtime],{cwd:root,windowsHide:true,encoding:'utf8',timeout:300000,env:{...process.env,PYTHONUTF8:'1'}});
if(prepare.status!==0)throw Error('Fixture preparation failed: '+JSON.stringify({status:prepare.status,signal:prepare.signal,error:prepare.error?.message,stderr:prepare.stderr,stdout:prepare.stdout}));
const packaged=process.env.ICE_TEST_EXECUTABLE;
const env={...process.env,ICE_DESKTOP_RUNTIME:runtime};
for(const key of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'])delete env[key];
if(packaged){env.PATH=path.join(process.env.SystemRoot,'System32');for(const key of ['ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH'])delete env[key];}
const child=spawn(packaged||require('electron'),packaged?['--prompt-smoke']:[path.join(root,'desktop'),'--prompt-smoke'],{cwd:packaged?path.dirname(packaged):root,env,windowsHide:true,stdio:'pipe'});
let stderr='';child.stdout.resume();child.stderr.on('data',d=>stderr+=d);
const timer=setTimeout(()=>{child.kill();console.error('Native prompt test timeout',runtime);process.exitCode=1;},240000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('exit',code=>{
  clearTimeout(timer);
  try{
    const error=path.join(runtime,'prompt-smoke-error.txt');if(fs.existsSync(error))throw Error(fs.readFileSync(error,'utf8'));
    const result=JSON.parse(fs.readFileSync(path.join(runtime,'prompt-smoke.json'),'utf8'));assert.equal(code,0);
    for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
    console.log(JSON.stringify({runtime,...result},null,2));
  }catch(error){console.error(error.stack,stderr.slice(-2000),runtime);process.exitCode=1;}
});
