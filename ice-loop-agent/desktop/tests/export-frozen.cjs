'use strict';
// Frozen engine RPC + actual bundle bytes. No Electron/OS dialogs in this check.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备'),fixture=JSON.parse(fs.readFileSync(path.join(out,'export-fixture.json'),'utf8'));
const build=JSON.parse(fs.readFileSync(path.join(out,'export-freeze-build.json'),'utf8'));
if(build.state!=='finished'||build.exit_code!==0)throw Error('Frozen build is not a completed success');
const executable=path.join(build.root,'dist/ice-engine/ice-engine.exe');
const destination=path.join(path.dirname(fixture.runtime),'frozen-bundle');
const report={state:'running',runtime:fixture.runtime,executable,checks:{},errors:[]};
const save=()=>fs.writeFileSync(path.join(out,'export-frozen.json'),JSON.stringify(report,null,2));
const assert=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
const env={...process.env,TEMP:fixture.runtime,TMP:fixture.runtime,PYTHONUTF8:'1'};
env.PATH=path.join(process.env.SystemRoot||'C:\\Windows','System32');
for(const key of ['DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY','PYTHONPATH','VIRTUAL_ENV','ICE_PYTHON','ICE_TEACHING_PYTHON'])delete env[key];
const child=spawn(executable,['--project-root',repo,'--runtime-root',fixture.runtime,'--article-root',path.join(path.dirname(fixture.runtime),'articles')],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let next=0,closed=false;const pending=new Map();save();
const errorFile=fs.createWriteStream(path.join(fixture.runtime,'frozen-engine-stderr.log'));child.stderr.pipe(errorFile);
child.on('error',error=>{for(const entry of pending.values())entry.reject(error);});
child.on('exit',(code,signal)=>{closed=true;report.exit_code=code;report.signal=signal;for(const entry of pending.values())entry.reject(Error('Frozen engine exited'));});
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(Error(value.error.message||String(value.error))):entry.resolve(value.result);});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Frozen RPC timeout '+method));},45000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
(async()=>{
 try{
  const boot=await call('bootstrap');assert('frozen_engine_uses_isolated_runtime',path.resolve(boot.runtime_root)===path.resolve(fixture.runtime));
  const snapshot=await call('articles.delivery_snapshot',{job_id:fixture.job});
  assert('frozen_parser_and_real_readiness_checks_load',snapshot.blocking.length===0&&snapshot.figures.length===fixture.image_count);
  await call('articles.delivery_confirm',{job_id:fixture.job,delivery_hash:snapshot.delivery_hash});
  const result=await call('articles.export_bundle',{job_id:fixture.job,destination,mode:'ready',body_hash:snapshot.body_hash,delivery_hash:snapshot.delivery_hash});
  assert('frozen_ready_export_succeeds',result.mode==='ready'&&result.images===fixture.image_count);
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8'));
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert('frozen_manifest_matches_actual_bytes',Object.entries(manifest.files).every(([file,digest])=>hash(path.join(destination,file))===digest));
  const md=fs.readFileSync(path.join(destination,'文本/01-公众号正文.md'),'utf8').replace(/\r\n/g,'\n');
  const txt=fs.readFileSync(path.join(destination,'文本/02-公众号正文.txt'),'utf8').replace(/\r\n/g,'\n');
  const output=fixture.output.replace(/\r\n/g,'\n').trimEnd();
  assert('frozen_run_output_is_expanded_in_both_formats',md.includes(output)&&txt.includes(output)&&!md.includes('RUN_OUTPUT:'));
  assert('frozen_markdown_and_original_images_use_relative_paths',manifest.images.every(image=>md.includes('../'+image.file)&&hash(path.join(destination,image.file))===image.sha256));
  assert('frozen_text_is_plain_without_losing_programs',!txt.startsWith('# ')&&!txt.includes('```python')&&txt.includes('print('));
 }catch(error){report.errors.push(error.stack||String(error));}
 finally{
  child.stdin.end();
  if(!closed)await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve();};const timer=setTimeout(finish,8000);child.once('exit',finish);});
  if(!closed){const stop=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>stop.once('exit',resolve));report.errors.push('Frozen engine required owned process-tree termination');}
  lines.close();errorFile.end();for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();
  report.state='finished';report.success=!report.errors.length&&Object.values(report.checks).every(Boolean)&&report.exit_code===0;save();console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;
 }
})();
