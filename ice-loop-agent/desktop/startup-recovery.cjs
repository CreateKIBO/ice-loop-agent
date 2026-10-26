"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { BackupActions } = require('./backup-actions.cjs');

function checkedRuntime(value, {allowRoot=false}={}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^c:/i.test(value)
      || (!allowRoot && path.parse(path.resolve(value)).root === path.resolve(value))) {
    throw Error('工作数据目录必须是 C 盘之外的绝对文件夹路径');
  }
  const resolved = path.resolve(value);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (/^c:/i.test(fs.realpathSync(ancestor))) throw Error('工作目录实际指向 C 盘，请选择其他数据盘');
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) throw Error('工作数据路径不是文件夹');
  return resolved;
}

function resolveWorkspace({selection, override, fallback}) {
  let runtime, selected = false, fresh = false;
  try {
    if (override) runtime = checkedRuntime(override);
    else if (fs.existsSync(selection)) {
      const stat = fs.statSync(selection);
      if (stat.size > 65536) throw Error('工作区选择记录过大');
      const record = JSON.parse(fs.readFileSync(selection, 'utf8'));
      runtime = checkedRuntime(record?.runtime_root); selected = true; fresh = record.fresh === true;
      if (!fresh && (!fs.existsSync(path.join(runtime, 'app.db')) || !fs.existsSync(path.join(runtime, 'settings.json')))) {
        throw Error('选定工作区不存在或资料不完整，请检查数据盘或选择其他工作区');
      }
    } else runtime = checkedRuntime(fallback);
    return {runtime, firstRun: !override && !selected, fresh: selected && fresh, error: null};
  } catch (error) {
    // This is a diagnostics/profile directory only. Never bootstrap an empty
    // engine here in place of a broken or temporarily disconnected workspace.
    const base = checkedRuntime(fallback);
    return {runtime: path.join(path.dirname(base), '.ice-startup-recovery'), firstRun: false, error};
  }
}

function publishWorkspace(selection, runtime, fresh = false) {
  runtime = checkedRuntime(runtime);
  const temporary = selection + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(selection), {recursive:true});
    fs.writeFileSync(temporary, JSON.stringify({runtime_root:runtime, ...(fresh ? {fresh:true} : {})}, null, 2), {flag:'wx'});
    fs.renameSync(temporary, selection);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return runtime;
}

function recoveryRequest(command, project, scratch, method, params, {timeoutMs=method.startsWith('recovery.')?30*60*1000:90000}={}) {
  return new Promise((resolve,reject) => {
    fs.mkdirSync(scratch,{recursive:true});
    const env = {...process.env, PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8', TEMP:scratch, TMP:scratch};
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTHORIZATION/i.test(key)) delete env[key];
    const child = spawn(command.file,[...command.args,'--project-root',project,'--runtime-root',scratch,'--recovery-operation',method],
      {cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='', size=0, finished=false;
    const finish = (error,result) => {
      if (finished) return;
      finished=true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer=setTimeout(()=>finish(Error('恢复检查超时，原工作区保持原样；请检查磁盘后重试')),timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>1024*1024)finish(Error('恢复检查返回数据异常'));else output+=chunk;});
    // Drain diagnostics without persisting settings, document text or credentials.
    child.stderr.on('data',()=>{});
    child.on('error',()=>finish(Error('无法启动独立恢复工具，请检查程序安装是否完整')));
    child.on('close',code=>{
      if(finished)return;
      try {const response=JSON.parse(output);if(code!==0||response.error)throw Error(response.error||'恢复工具未完成检查');finish(null,response.result);}
      catch(error){finish(Error(error instanceof SyntaxError?'恢复工具没有返回有效结果':error.message));}
    });
    child.stdin.on('error',()=>finish(Error('恢复工具连接已中断')));
    child.stdin.end(JSON.stringify(params)+'\n');
  });
}

class StartupRecovery {
  constructor({dialog,request,selection,project,restart}) {
    Object.assign(this,{dialog,request,selection,project,restart});
    this.backups = new BackupActions({dialog,request,selection,project,window:()=>undefined});
    this.pending = null;
  }
  accounts(items) {return items.slice(0,5).map(a=>a.name.slice(0,80)).join('、')+(items.length>5?' 等 '+items.length+' 个公众号':'');}
  async message(options) { return (await this.dialog.showMessageBox({noLink:true,...options})).response; }
  async activate(runtime,fresh=false,published=false) {
    this.pending = {runtime,fresh};
    if(!published)publishWorkspace(this.selection,runtime,fresh);
    this.pending = null;
    const response=await this.message({type:'info',title:'工作区已选定',message:'下次启动将使用所选工作区',
      detail:runtime+'\n原工作区资料保留。备份恢复的任务需要在工作台中审阅后手动继续。',
      buttons:['重启工作台','暂不启动'],defaultId:0,cancelId:1});
    if(response===0)await this.restart();
    return true;
  }
  async run(error) {
    let problem=error.message;
    for (;;) {
      const response=await this.message({type:'warning',title:'ICE Loop · 启动恢复',message:'工作台暂时无法启动',
        detail:problem+'\n\n请选择工作区或恢复备份。恢复工具不会启动模型调用，也不会覆盖原工作区。',
        buttons:['选择已有工作区','新建空白工作区','从备份恢复',...(this.pending||this.backups.pendingSelection?['重试切换已恢复的目录']:[]),'退出','从升级恢复点恢复'],
        defaultId:0,cancelId:this.pending||this.backups.pendingSelection?4:3});
      try {
        if(response===0){
          const picked=await this.dialog.showOpenDialog({title:'选择含 app.db 和 settings.json 的工作区',properties:['openDirectory']});
          if(picked.canceled)continue;
          const runtime=checkedRuntime(picked.filePaths[0]);
          const info=await this.request('workspace.inspect',{runtime_root:runtime});
          const confirmed=await this.message({type:'question',title:'确认切换工作区',message:'工作区检查通过',
            detail:this.accounts(info.accounts)+'\n数据库版本 '+info.database_schema+' → '+info.database_target_schema+'\n'+runtime+
              '\n继续后仅修改工作区选择记录，重启时才加载资料。',buttons:['确认切换','取消'],defaultId:1,cancelId:1});
          if(confirmed===0)return await this.activate(runtime);
        } else if(response===1){
          const picked=await this.dialog.showOpenDialog({title:'选择新工作区的父文件夹',properties:['openDirectory','createDirectory']});
          if(picked.canceled)continue;
          const parent=checkedRuntime(picked.filePaths[0],{allowRoot:true});
          const runtime=path.join(parent,'ice-workspace-'+randomUUID());
          if(await this.message({type:'question',title:'新建空白工作区',message:'在新目录开始创作',detail:runtime+'\n现有文章和配置仍保留在原工作区。',buttons:['创建并切换','取消'],defaultId:1,cancelId:1})!==0)continue;
          fs.mkdirSync(runtime);return await this.activate(runtime,true);
        } else if(response===2){
          const summary=await this.backups.inspect();if(!summary)continue;
          const confirmed=await this.message({type:'question',title:'确认备份内容',message:'备份校验通过',
            detail:this.accounts(summary.accounts)+'\n'+summary.files+' 个文件；版本 '+summary.app_version+
              '\n数据库 '+summary.database_schema+' → '+summary.database_target_schema+
              '\nAPI Key 和网页登录需要重新配置。恢复将新建目录，原资料保留。',
            buttons:['选择位置并恢复','取消'],defaultId:1,cancelId:1});
          if(confirmed!==0)continue;
          const restored=await this.backups.restore(summary.token);if(!restored)continue;
          if(restored.selection_error)throw Error(restored.selection_error+'\n恢复目录：'+restored.runtime_root);
          return await this.activate(restored.runtime_root,false,true);
        } else if(response===(this.pending||this.backups.pendingSelection?5:4)){
          const picked=await this.dialog.showOpenDialog({title:'选择原工作区（无需能启动）',properties:['openDirectory']});
          if(picked.canceled)continue;
          const runtimeRoot=checkedRuntime(picked.filePaths[0]);
          const listing=await this.request('recovery.list',{runtime_root:runtimeRoot});
          const points=listing.points.filter(point=>point.state==='ready').slice(0,8);
          if(!points.length)throw Error('此工作区没有完整恢复点，未更改原资料');
          const choice=await this.message({type:'question',title:'选择升级恢复点',message:'选择一份恢复点进行校验',
            detail:'以下最多展示最近 8 份完整恢复点。恢复到新目录，原工作区保留。',
            buttons:[...points.map(point=>new Date(point.created_at).toLocaleString()+' · schema '+point.source_schema),'取消'],defaultId:points.length,cancelId:points.length});
          if(choice>=points.length)continue;
          const summary=await this.backups.inspectPoint(points[choice].point_id,runtimeRoot);
          const confirmed=await this.message({type:'question',title:'确认恢复点内容',message:'恢复点校验通过',
            detail:this.accounts(summary.accounts)+'\n'+summary.files+' 个文件；数据库 '+summary.database_schema+' → '+summary.database_target_schema+'\nAPI Key 和网页登录需重新配置。',
            buttons:['选择位置并恢复','取消'],defaultId:1,cancelId:1});
          if(confirmed!==0)continue;
          const restored=await this.backups.restore(summary.token);if(!restored)continue;
          if(restored.selection_error)throw Error(restored.selection_error+'\n恢复目录：'+restored.runtime_root);
          return await this.activate(restored.runtime_root,false,true);
        } else if(response===3 && this.pending){
          return await this.activate(this.pending.runtime,this.pending.fresh);
        } else if(response===3 && this.backups.pendingSelection){
          const restored=await this.backups.activate(this.backups.pendingSelection.token);
          if(restored.selection_error)throw Error(restored.selection_error+'\n恢复目录：'+restored.runtime_root);
          return await this.activate(restored.runtime_root,false,true);
        } else return false;
      } catch(failure){problem=failure.message;}
    }
  }
}
module.exports={checkedRuntime,resolveWorkspace,publishWorkspace,recoveryRequest,StartupRecovery};
