const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),runtime=process.env.ICE_REVIEW_FIXTURE;
assert.ok(runtime&&fs.existsSync(path.join(runtime,'review-fixture.json')),'Seed an isolated review fixture first');
const packaged=process.env.ICE_TEST_EXECUTABLE,env={...process.env,ICE_DESKTOP_RUNTIME:runtime};
if(packaged){env.PATH=path.join(process.env.SystemRoot,'System32');for(const key of ['ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH'])delete env[key];}
const child=spawn(packaged||require('electron'),packaged?['--review-smoke']:[path.join(root,'desktop'),'--review-smoke'],{cwd:packaged?path.dirname(packaged):root,windowsHide:true,env,stdio:'pipe'});
let stderr='';child.stderr.on('data',data=>stderr+=data);child.stdout.resume();
const timer=setTimeout(()=>{child.kill();console.error('Review test timeout');process.exitCode=1;},60000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timer);try{const error=path.join(runtime,'review-error.txt');if(fs.existsSync(error))throw Error(fs.readFileSync(error,'utf8'));const result=JSON.parse(fs.readFileSync(path.join(runtime,'review-result.json'),'utf8'));assert.equal(code,0);for(const key of ['distinctInputPrompt','approvalRetained','actualOutput','advanced'])assert.equal(result[key],true,key);console.log(JSON.stringify({runtime,packaged:Boolean(packaged),...result},null,2));}catch(error){console.error(error.message,stderr.slice(-1000));process.exitCode=1;}});
