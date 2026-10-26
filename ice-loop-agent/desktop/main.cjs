const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, session, clipboard, ClipboardItem, screen } = require('electron');
if(process.argv.includes('--credential-helper')){require('./credential-helper.cjs');return;}
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');
const {copyTextVerified}=require('./clipboard.cjs');
const exportApprovals = new (require('./export-approval.cjs').ExportApprovals)();
const originalImages = new (require('./original-images.cjs').OriginalImages)();

const project = app.isPackaged ? path.join(process.resourcesPath,'engine-project') : path.resolve(__dirname, '..');
const dataSelection = app.isPackaged ? path.join(app.getPath('appData'),'ICE Loop Studio','workspace-path.json') : path.join(project, '.desktop-data-path.json');
const {resolveWorkspace,StartupRecovery,recoveryRequest}=require('./startup-recovery.cjs');
const installDirectory=process.env.PORTABLE_EXECUTABLE_DIR||path.dirname(process.execPath);
const nonSystemDrive=['G:/','D:/','E:/','F:/'].find(drive=>fs.existsSync(drive));
const userWorkspace='ICE-Workspace-'+createHash('sha256').update(app.getPath('appData')).digest('hex').slice(0,8);
const defaultRuntime=app.isPackaged ? (!/^c:/i.test(installDirectory)?path.join(installDirectory,userWorkspace):nonSystemDrive?path.join(nonSystemDrive,'ICE Loop Studio',userWorkspace):null) : path.join(project,'.desktop-runtime');
if(!defaultRuntime){dialog.showErrorBox('工作目录不可用','请准备C盘之外的数据盘，或设置ICE_DESKTOP_RUNTIME后启动。');app.quit();process.exit(1);}
const workspace=resolveWorkspace({selection:dataSelection,override:process.env.ICE_DESKTOP_RUNTIME,fallback:defaultRuntime});
const runtime=workspace.runtime;
const firstPackagedStart=app.isPackaged&&workspace.firstRun;
fs.mkdirSync(runtime, { recursive: true });
const chatLifecycle=stage=>{
  if(process.argv.includes('--chat-smoke'))fs.appendFileSync(path.join(runtime,'chat-lifecycle.log'),new Date().toISOString()+' '+stage+'\n');
  if(process.argv.includes('--startup-diagnostics'))fs.appendFileSync(path.join(runtime,'startup-diagnostics.log'),new Date().toISOString()+' '+stage+'\n');
};
chatLifecycle('main:runtime-ready');
for (const folder of ['electron', 'electron/sessions', 'electron/crash-dumps', 'logs']) fs.mkdirSync(path.join(runtime, folder), { recursive: true });
app.setPath('userData', path.join(runtime, 'electron'));
app.setPath('sessionData', path.join(runtime, 'electron', 'sessions'));
app.setPath('crashDumps', path.join(runtime, 'electron', 'crash-dumps'));
app.setAppLogsPath(path.join(runtime, 'logs'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'ice', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window;
let embeddedBrowser;
let python;
let shuttingDown = false;
let starting = true, startupProgress = null, startupCancelTimer = null, startupDeadline = null, startupFailure = '';
let credentialWarning='';
let smokeClipboard=null;
let nextId = 0;
const pending = new Map();
if(app.isPackaged)process.env.ICE_PACKAGED='1';
const backupActions = new (require('./backup-actions.cjs').BackupActions)({
  request: (...args) => request(...args), dialog, window: () => window, project, selection: dataSelection,
});
const methods = new Set(['bootstrap', 'brief.suggest', 'jobs.list', 'jobs.create', 'jobs.get', 'jobs.resume', 'jobs.stop',
  'approvals.decide', 'approvals.edit', 'articles.save', 'articles.finalize', 'assets.select', 'assets.preview',
  'execution.approve', 'execution.inputs', 'claims.verify', 'models.save', 'models.routes_save', 'models.probe', 'library.list', 'library.read']);
for (const method of ['accounts.save','accounts.switch','accounts.export','resources.list','resources.preview','resources.analyze','resources.apply','resources.use','resources.update','resources.vision','resources.recommend','vision.save','vision.probe','drafts.list','drafts.get','drafts.save','history.list','history.get','history.update','history.progress','planning.context','planning.propose','planning.confirm']) methods.add(method);
for (const method of ['articles.revisions','articles.compare','articles.restore']) methods.add(method);
for (const method of ['supplements.from_library','supplements.plan','supplements.prepare','supplements.execute','assets.review','outlines.list','outlines.preview','outlines.save','outlines.update','outlines.match']) methods.add(method);
for(const method of ['rules.list','rules.save','rules.resolve','rules.remove','tools.status','tools.diagnostics','reminders.list','reminders.save','reminders.dismiss','git.preview','git.apply','models.catalog','articles.semantic_review','assets.redo','resources.transform','resources.cover','capture.windows','capture.native'])methods.add(method);
methods.add('tools.execution_settings');
methods.add('execution.code_save');
methods.add('execution.policy_save');
for(const method of ['prompts.generate','prompts.save','prompts.references','resources.import_style','budgets.get','budgets.save'])methods.add(method);
for(const method of ['chat.list','chat.create','chat.get','chat.update','chat.send','chat.stop','chat.sources','chat.candidate_save','chat.submit','chat.reviews','chat.review','chat.rebase','chat.prepare_assets'])methods.add(method);
methods.add('chat.fork');
methods.add('chat.save_draft');
methods.add('chat.drafts');
for(const method of ['chat.delete','chat.restore','jobs.archive','jobs.delete','jobs.restore'])methods.add(method);
// Explicit public methods used by the new workbench. Internal run_turn and the
// unfinished probe endpoint remain unavailable to renderer requests.
for (const method of require('./workbench-methods.cjs')) methods.add(method);
// 可信导出（R05/R06/R13 完成）：目录经由 ice:choose-export-dir 用户选择后，
// 该绝对路径作为短期批准引用传给 articles.export_bundle；Python 端再次校验。
methods.add('articles.export_bundle');
methods.add('accounts.preview_import');

function engineCommand(){
  if(app.isPackaged)return {file:path.join(process.resourcesPath,'engine','ice-engine.exe'),args:[]};
  return {file:pythonExecutable(),args:['-m','ice_agent.desktop_service']};
}

function pythonExecutable() {
  const candidates = [process.env.ICE_PYTHON, path.join(project, '.venv', 'Scripts', 'python.exe')];
  const root = path.join(project, '.tools', 'python');
  if (fs.existsSync(root)) for (const folder of fs.readdirSync(root)) candidates.push(path.join(root, folder, 'python.exe'));
  return candidates.find(file => file && fs.existsSync(file) && fs.statSync(file).isFile());
}

function request(method, params = {}) {
  if (!python || python.killed || !python.stdin.writable) return Promise.reject(new Error('文章引擎尚未连接，请重新启动工作台'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout=method.startsWith('recovery.')||(starting&&(method==='bootstrap'||method==='secrets.set'))?30*60*1000:135000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请检查任务状态后重试')); }, timeout);
    pending.set(id, { resolve, reject, timer,method });
    python.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('引擎连接中断')); }
    });
  });
}

async function captureRun(jobId,figureNo,runKeys,automatic=false){
    const context=await request('assets.capture_context',{job_id:jobId,figure_no:figureNo,run_keys:runKeys,automatic});
    const capture=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    let temporaryFile;
    try{
      await capture.loadURL('ice://app/capture.html');
      const height=await capture.webContents.executeJavaScript('window.renderCapture('+JSON.stringify(context)+')');
      if(height>7000)throw Error('运行内容较长，请减少截图内容后重试');
      capture.setContentSize(1100,Math.max(400,height+20));
      await capture.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      const image=await capture.webContents.capturePage(),folder=path.join(runtime,'screenshots');fs.mkdirSync(folder,{recursive:true});
      const file=path.join(folder,'execution-'+randomUUID()+'.png');temporaryFile=file;fs.writeFileSync(file,image.toPNG());
      // Finish both durable imports before discarding the owned intermediate PNG.
      return await request('assets.capture_finish',{job_id:jobId,figure_no:figureNo,run_keys:context.run_keys,capture_hash:context.capture_hash,file_path:file,automatic});
    }finally{
      try{if(!capture.isDestroyed())capture.destroy();}
      finally{if(temporaryFile){try{fs.unlinkSync(temporaryFile);}catch(error){if(error.code!=='ENOENT')console.error('运行截图中间文件清理失败：',temporaryFile,error.message);}}}
    }
}

// 受信应用页面白名单：旧 renderer 与 v2.0 新工作台（同一 window、同一 preload）。
const TRUSTED_APP_FRAMES = new Set(['ice://app/index.html', 'ice://app/ui/index.html']);
const uiMode = require('./ui-mode.cjs');
const UI_PAGES = uiMode.UI_PAGES;
const uiPreferenceFile = () => path.join(runtime, 'ui-preference.json');
const newUiBuilt = () => fs.existsSync(path.join(__dirname, 'ui', 'dist', 'index.html'));
const startPage = () => uiMode.chooseStartPage({
  argv: process.argv, newUiBuilt: newUiBuilt(), savedMode: uiMode.readUiMode(uiPreferenceFile()),
});

function assertSender(event) {
  const frameUrl = event.senderFrame ? event.senderFrame.url.split('#')[0] : '';
  if (!window || event.sender !== window.webContents || !TRUSTED_APP_FRAMES.has(frameUrl)) {
    throw new Error('无效的窗口请求');
  }
}

async function readKeys() {
  const file = process.argv.includes('--provider-smoke')&&process.env.ICE_SMOKE_CREDENTIALS ? process.env.ICE_SMOKE_CREDENTIALS : path.join(runtime, 'credentials.json');
  if (!fs.existsSync(file)) return {};
  if (!safeStorage.isEncryptionAvailable()){credentialWarning='系统凭据加密不可用，已保留原凭据；请使用环境变量或修复系统凭据服务。';return {};}
  let stored;
  try{stored=JSON.parse(fs.readFileSync(file,'utf8'));if(!stored||typeof stored!=='object'||Array.isArray(stored))throw Error('invalid');}
  catch{credentialWarning='模型凭据文件无法读取，原文件保留。请在模型与设置重新保存Key。';return {};}
  const keys = {};
  for (const [provider, value] of Object.entries(stored)){
    try{keys[provider] = safeStorage.decryptString(Buffer.from(value, 'base64'));}
    catch{credentialWarning='部分已保存的模型凭据无法在当前工作区解密。原凭据已保留，请在模型与设置重新保存对应Key后测试连接。';}
  }
  if(Object.keys(keys).length<Object.keys(stored).length){
    // Only known historical application profiles are examined; no browser profile search.
    const appData=app.getPath('appData');
    const candidates=['Electron','ice-loop-studio','ICE Loop Studio'].map(name=>path.join(appData,name,'Local State'));
    for(const candidate of candidates){
      if(!fs.existsSync(candidate))continue;
      let master;try{master=JSON.parse(fs.readFileSync(candidate,'utf8')).os_crypt;}catch{continue;}
      if(!master?.encrypted_key)continue;
      const probe=path.join(runtime,'credential-migration',randomUUID());fs.mkdirSync(probe,{recursive:true});fs.writeFileSync(path.join(probe,'Local State'),JSON.stringify({os_crypt:master}));
      const recovered=await new Promise(resolve=>{
        const args=[...(app.isPackaged?[]:[path.join(project,'desktop')]),'--credential-helper','--helper-runtime',probe,'--cipher-file',file];
        const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let raw='';let settled=false;
        const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>{child.kill();finish({});},10000);child.stderr.resume();
        child.stdout.on('data',data=>{raw+=data;if(raw.length>20000){child.kill();finish({});}});
        child.on('error',()=>finish({}));child.on('exit',()=>{try{finish(JSON.parse(raw.trim()).keys||{});}catch{finish({});}});
      });
      for(const provider of Object.keys(stored))if(typeof recovered[provider]==='string'&&recovered[provider].length<=4096)keys[provider]=recovered[provider];
      if(Object.keys(keys).length===Object.keys(stored).length){
        if(!process.argv.includes('--provider-smoke')){
          const backup=file+'.before-v1.0';if(!fs.existsSync(backup))fs.copyFileSync(file,backup);
          const migrated={};for(const [provider,key] of Object.entries(keys))migrated[provider]=safeStorage.encryptString(key).toString('base64');
          const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(migrated));fs.renameSync(temporary,file);
        }
        credentialWarning='已兼容读取旧版本凭据；原加密文件保留，模型连接状态仍以实际测试为准。';break;
      }
    }
  }
  return keys;
}

async function verifyRestoredSidecar(restoredRuntime) {
  return new Promise((resolve,reject)=>{
    const command=engineCommand();const child=spawn(command.file,[...command.args,'--project-root',project,'--runtime-root',restoredRuntime],
      {cwd:project,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',...(app.isPackaged?{ICE_TEACHING_PYTHON:path.join(process.resourcesPath,'teaching-python','python.exe')}: {})}});
    const results=new Map();const timer=setTimeout(()=>{child.kill();reject(Error('恢复后的引擎启动超时'));},30000);
    child.stderr.resume();
    readline.createInterface({input:child.stdout}).on('line',line=>{
      try{const response=JSON.parse(line);if(response.error)throw Error(response.error.message);results.set(response.id,response.result);}
      catch(error){child.kill();clearTimeout(timer);reject(error);}
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);if(code!==0||!results.has(1)||!results.has(2))reject(Error('恢复引擎启动失败'));else resolve(results.get(1).runtime_root===restoredRuntime&&results.get(1).accounts.length===2&&results.get(2).length>0);});
    child.stdin.end(JSON.stringify({id:1,method:'bootstrap'})+'\n'+JSON.stringify({id:2,method:'resources.list'})+'\n');
  });
}

async function startEngine() {
  chatLifecycle('engine:starting');
  const command=engineCommand();const executable = command.file;
  if (!executable) throw new Error('找不到 Python 3.12+。请运行项目的安装脚本，或设置 ICE_PYTHON 指向解释器。');
  const args = [...command.args, '--project-root', project, '--runtime-root', runtime];
  if(startupProgress)args.push('--startup-session',startupProgress.session);
  if (process.argv.includes('--smoke')||process.argv.includes('--browser-smoke')) args.push('--article-root', path.join(runtime, 'articles'));
  python = spawn(executable, args, {
    cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',TEMP:path.join(runtime,'staging'),TMP:path.join(runtime,'staging'),...(app.isPackaged?{ICE_TEACHING_PYTHON:path.join(process.resourcesPath,'teaching-python','python.exe')}: {}) }
  });
  readline.createInterface({ input: python.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line);
      if(starting&&response.kind==='startup.error'&&typeof response.message==='string'){startupFailure=response.message.slice(0,1500);return;}
      if(starting&&startupProgress?.accept(response)){
        // Real progress renews only boot requests, with a separate hard deadline.
        if(Date.now()-startupProgress.started<30*60*1000)for(const entry of pending.values())if(entry.method==='bootstrap'||entry.method==='secrets.set')entry.timer.refresh();
        return;
      }
      const entry = pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(response.id);
      if (response.error) {
        const error = new Error(response.error.message);
        // v2 稳定错误码随 Error 透传给 renderer（M1-09）；旧页面只读 message，不受影响。
        error.code = response.error.code || 'INTERNAL';
        error.recoverable = Boolean(response.error.recoverable);
        error.action = response.error.action || null;
        error.engineReply = true;
        entry.reject(error);
      } else entry.resolve(entry.method==='bootstrap'?{...response.result,credential_warning:credentialWarning}:response.result);
    } catch { /* A protocol error must never become renderer HTML. */ }
  });
  python.stderr.on('data', data => {
    try{fs.appendFileSync(path.join(runtime, 'sidecar.log'), data);}catch{/* A disk error must still reach startup recovery. */}
  });
  let exitReported = false;
  const exited = (code, signal, spawnError = null) => {
    if (exitReported) return;
    exitReported = true;
    // Exit diagnostics contain no request bodies, keys or document content.
    try { fs.appendFileSync(path.join(runtime,'logs','engine-exit.jsonl'),JSON.stringify({
      at:new Date().toISOString(),code,signal,spawn_error:spawnError,expected:shuttingDown
    })+'\n'); } catch { /* A full disk must not prevent rejecting pending requests. */ }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(starting&&startupFailure?startupFailure:'文章引擎已退出，请重启工作台')); }
    pending.clear();
    if (!shuttingDown && window && !window.isDestroyed()) window.webContents.send('ice:engine-exit');
  };
  python.on('exit', (code,signal) => exited(code,signal));
  python.on('error', error => exited(null,null,error.code || 'SPAWN_ERROR'));
  const keys = await readKeys();
  chatLifecycle('engine:credentials-read');
  if (Object.keys(keys).length) await request('secrets.set', { keys });
  await request('bootstrap');
  chatLifecycle('engine:ready');
}

function registerIPC() {
  ipcMain.handle('ice:pick-knowledge-file',async event => {
    assertSender(event);
    const selected=await dialog.showOpenDialog(window,{title:'导入知识文档（原文只读）',properties:['openFile'],
      filters:[{name:'文档',extensions:['md','markdown','txt','docx']}]});
    if(selected.canceled)return null;
    return selected.filePaths[0];
  });
  // 可信导出（R13）：目录必须由用户在系统对话框中选择——该绝对路径即短期批准引用；
  // Python 端 articles.export_bundle 仍会再次校验绝对/非C/链接/占用。
  ipcMain.handle('ice:choose-export-dir',async event => {
    assertSender(event);
    const selected=await dialog.showOpenDialog(window,{title:'选择导出位置（将在其中创建新文件夹）',
      properties:['openDirectory','createDirectory']});
    if(selected.canceled||!selected.filePaths[0])return null;
    return exportApprovals.issue(selected.filePaths[0]);
  });
  ipcMain.handle('ice:cancel-export-dir',(event,destination)=>{
    assertSender(event);
    if(typeof destination!=='string'||!path.isAbsolute(destination))throw Error('导出位置无效');
    exportApprovals.consume(destination);return {ok:true};
  });
  ipcMain.handle('ice:open-export-folder',async(event,destination)=>{
    assertSender(event);const folder=exportApprovals.completedPath(destination);
    const error=await shell.openPath(folder);if(error)throw Error(error);return {ok:true};
  });
  ipcMain.handle('ice:import-creative-document',async(event,accountId)=>{
    assertSender(event);
    const selected=await dialog.showOpenDialog(window,{title:'引用文档（仅用于当前对话）',properties:['openFile'],filters:[{name:'文档',extensions:['md','txt','docx']}]});
    if(selected.canceled)return null;
    return request('outlines.read',{file_path:selected.filePaths[0],account_id:accountId});
  });
  ipcMain.handle('ice:original-image-open', async (event, params) => {
    assertSender(event);
    if (!params || !['candidate','resource'].includes(params.kind) || typeof params.account_id!=='string' || !params.account_id || params.account_id.length>200) throw Error('原图请求无效');
    const keys=params.kind==='candidate'?['job_id','candidate_id']:['resource_id'];
    if(keys.some(key=>typeof params[key]!=='string'||!params[key]||params[key].length>200))throw Error('原图编号无效');
    const epoch=originalImages.epoch;
    const source=await request('images.original_source',params);
    if(source.account_id!==params.account_id)throw Error('公众号已切换，请重新打开图片');
    return originalImages.open(source,epoch);
  });
  ipcMain.handle('ice:original-image-release', (event, token) => { assertSender(event); return originalImages.release(token); });
  embeddedBrowser=require('./browser.cjs').installBrowser({window:()=>window,assertSender,request,runtime});
  require('./tools.cjs').installTools({window:()=>window,assertSender,request,runtime});
  ipcMain.handle('ice:import-outline',async(event,accountId)=>{
    assertSender(event);
    const selected=await dialog.showOpenDialog(window,{title:'读取栏目选题大纲（预览后才保存）',properties:['openFile'],filters:[{name:'选题大纲',extensions:['md','txt','docx']}]});
    if(selected.canceled)return null;
    return request('outlines.read',{file_path:selected.filePaths[0],account_id:accountId});
  });
  ipcMain.handle('ice:choose-workspace',async event=>{
    assertSender(event);const result=await dialog.showOpenDialog(window,{title:'选择新工作区所在文件夹（C盘之外，重启后切换）',properties:['openDirectory','createDirectory']});
    if(result.canceled)return null;
    if(/^c:/i.test(result.filePaths[0]))throw Error('请选择C盘之外的数据目录');
    const destination=path.join(result.filePaths[0],'ICE-Workspace-'+Date.now());fs.mkdirSync(destination,{recursive:true});
    fs.mkdirSync(path.dirname(dataSelection),{recursive:true});fs.writeFileSync(dataSelection,JSON.stringify({runtime_root:destination,fresh:true},null,2));
    return {runtime_root:destination,restart_required:true};
  });
  ipcMain.handle('ice:import-article',async(event,accountId)=>{
    assertSender(event);
    const result=await dialog.showOpenDialog(window,{title:'导入已有文章，创建只读补图任务',properties:['openFile'],filters:[{name:'Markdown文章',extensions:['md']}]});
    if(result.canceled)return null;
    return request('supplements.create',{file_path:result.filePaths[0],account_id:accountId});
  });
  ipcMain.handle('ice:create-backup', async event => {
    assertSender(event);
    return backupActions.create();
  });
  ipcMain.handle('ice:inspect-recovery-point', async(event,pointId)=>{
    assertSender(event);return backupActions.inspectPoint(pointId);
  });
  ipcMain.handle('ice:delete-recovery-point', async(event,pointId,recordHash)=>{
    assertSender(event);
    return backupActions.exclusive(async()=>{
      const list=await request('recovery.list');const point=list.points.find(p=>p.point_id===pointId&&p.record_hash===recordHash&&p.can_delete);
      if(!point)throw Error('恢复点状态已变化，请刷新后检查');
      const answer=await dialog.showMessageBox(window,{type:'warning',title:'删除恢复点',message:'删除所选恢复点？',
        detail:new Date(point.created_at).toLocaleString()+'\n仅删除此恢复点的已验证备份和索引。当前工作区文章与配图保留。此操作无法撤销。',
        buttons:['保留','删除此恢复点'],defaultId:0,cancelId:0,noLink:true});
      if(answer.response!==1)return null;
      return request('recovery.delete',{point_id:pointId,record_hash:recordHash});
    });
  });
  ipcMain.handle('ice:open-recovery-folder',async event=>{
    assertSender(event);const list=await request('recovery.list');if(!fs.existsSync(list.directory))throw Error('尚未创建恢复点');
    const error=await shell.openPath(list.directory);if(error)throw Error('无法打开恢复点目录');return {ok:true};
  });
  ipcMain.handle('ice:inspect-backup', async event => {
    assertSender(event);
    return backupActions.inspect();
  });
  ipcMain.handle('ice:restore-backup', async (event,token) => {
    assertSender(event);
    return backupActions.restore(token);
  });
  ipcMain.handle('ice:activate-restored-backup', async (event,token) => {
    assertSender(event);
    return backupActions.activate(token);
  });
  ipcMain.handle('ice:open-html', async (event,jobId) => {
    assertSender(event);
    const data = await request('jobs.get',{job_id:jobId});
    if(!data.export.folder)throw Error('请先复检并导出文章包');
    if(data.article.readiness==='review_pending')throw Error('正文已修改，请先复检并导出，再打开当前 HTML 预览');
    const file = path.join(data.export.folder,'04-阅读与排版预览.html');
    const manifestFile = path.join(data.export.folder,'.ice-export-manifest.json');
    if(!fs.existsSync(file)||!fs.existsSync(manifestFile))throw Error('请重新导出，以生成 HTML 预览');
    const manifest = JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if(manifest.files['04-阅读与排版预览.html']!==hash)throw Error('预览文件被外部修改，请检查文章包');
    const error = await shell.openPath(file);if(error)throw Error(error);
    return {ok:true};
  });
  ipcMain.handle('ice:copy-text',async(event,text)=>{
    assertSender(event);
    if(typeof text!=='string'||!text.trim()||text.length>30000)throw Error('请先选择有效提示词');
    return copyTextVerified(clipboard,text);
  });
  ipcMain.handle('ice:capture-run',async(event,jobId,figureNo,runKeys)=>{
    assertSender(event);
    return captureRun(jobId,figureNo,runKeys);
  });
  ipcMain.handle('ice:capture-window', async event => {
    assertSender(event);
    const folder = path.join(runtime, 'screenshots');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'studio-' + Date.now() + '.png');
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(file, screenshot.toPNG());
    return { file };
  });
  ipcMain.handle('ice:chat-send',async(event,params)=>{
    assertSender(event);
    if(!params||typeof params!=='object'||Array.isArray(params)||JSON.stringify(params).length>500000)throw Error('无效的发送请求');
    try{return {ok:true,result:await request('chat.send',params)};}
    catch(error){return {ok:false,error:{message:String(error.message||'发送回执未确认').slice(0,2000),code:error.code||'NETWORK',
      recoverable:Boolean(error.recoverable),action:error.action||null,settled:error.engineReply===true}};}
  });
  ipcMain.handle('ice:request', async (event, method, params) => {
    assertSender(event);
    if (!methods.has(method) || typeof params !== 'object' || params === null || JSON.stringify(params).length > 500000) throw new Error('无效请求');
    if (method === 'articles.export_bundle') exportApprovals.assert(params.destination);
    const result=await request(method, params);
    if (method === 'articles.export_bundle') result.can_open=exportApprovals.complete(params.destination);
    if(['accounts.switch','accounts.save','accounts.import'].includes(method)){embeddedBrowser.reset();void originalImages.clear();exportApprovals.clear();}
    return result;
  });
  ipcMain.handle('ice:import-image', async (event, jobId, figureNo) => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: `导入图 ${figureNo}`, properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (choice.canceled) return null;
    return request('assets.import', { job_id: jobId, figure_no: figureNo, file_path: choice.filePaths[0], archive_resource:true });
  });
  ipcMain.handle('ice:import-publication', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入公众号配置或品牌说明', properties: ['openFile'], filters: [{ name: '配置与文档', extensions: ['json','md','txt'] }] });
    if (choice.canceled) return null;
    const file = choice.filePaths[0];
    if (fs.statSync(file).size > 128000) throw Error('文件过大，请使用小于128KB的配置或品牌说明');
    const result=await request('accounts.import', { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), format: path.extname(file).slice(1).toLowerCase(), name: path.basename(file, path.extname(file)) });
    embeddedBrowser.reset();void originalImages.clear();exportApprovals.clear();
    return result;
  });
  ipcMain.handle('ice:choose-publication-dir', async (event,kind) => {
    assertSender(event);
    if(kind!=='library'&&kind!=='output')throw Error('未知目录用途');
    const choice=await dialog.showOpenDialog(window,{title:kind==='library'?'选择已有文章目录（只读）':'选择新文章输出目录',
      properties:kind==='library'?['openDirectory']:['openDirectory','createDirectory']});
    return choice.canceled?null:choice.filePaths[0];
  });
  ipcMain.handle('ice:export-publication', async event => {
    assertSender(event);
    const bundle = await request('accounts.export');
    const choice = await dialog.showSaveDialog(window, { title: '导出公众号配置', defaultPath: path.join(runtime, 'publication-profile.json'), filters: [{ name: 'JSON配置', extensions: ['json'] }] });
    if (choice.canceled) return null;
    fs.writeFileSync(choice.filePath, JSON.stringify(bundle, null, 2));
    return { file: choice.filePath };
  });
  ipcMain.handle('ice:import-resource', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入配图资源', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp'] }] });
    if (choice.canceled) return null;
    return request('resources.import', { file_path: choice.filePaths[0] });
  });
  ipcMain.handle('ice:import-draft', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入文章草稿', properties: ['openFile'], filters: [{ name: 'Markdown与文本', extensions: ['md','txt'] }] });
    if (choice.canceled) return null;
    const file = choice.filePaths[0];
    if (fs.statSync(file).size > 600000) throw Error('草稿文件过大，请使用小于600KB的文本');
    return request('drafts.save', { title: path.basename(file, path.extname(file)), body: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') });
  });
  ipcMain.handle('ice:export-draft', async (event, draftId) => {
    assertSender(event);
    const draft = await request('drafts.get', { draft_id: draftId });
    const choice = await dialog.showSaveDialog(window, { title: '导出草稿', defaultPath: path.join(runtime, 'draft.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (choice.canceled) return null;
    fs.writeFileSync(choice.filePath, draft.body);
    return { file: choice.filePath };
  });
  ipcMain.handle('ice:save-key', async (event, provider, key) => {
    assertSender(event);
    if (!['qwen', 'deepseek', 'kimi', 'bigmodel', 'ark','minimax'].includes(provider) || typeof key !== 'string' || key.length > 4096) throw new Error('凭据无效');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，请改用环境变量配置');
    const file = path.join(runtime, 'credentials.json');
    let stored={};if(fs.existsSync(file)){
      try{stored=JSON.parse(fs.readFileSync(file,'utf8'));if(!stored||typeof stored!=='object'||Array.isArray(stored))throw Error('invalid');}
      catch{const backup=file+'.before-v1.0';if(!fs.existsSync(backup))fs.copyFileSync(file,backup);stored={};}
    }
    if (key) stored[provider] = safeStorage.encryptString(key).toString('base64'); else delete stored[provider];
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(stored)); fs.renameSync(temporary, file);
    await request('secrets.set', { keys: { [provider]: key } });
    return { ok: true };
  });
  ipcMain.handle('ice:open-folder', async (event, jobId) => {
    assertSender(event);
    const data = await request('jobs.get', { job_id: jobId });
    const folder = data.export.publishing_folder;
    if (!folder || !fs.existsSync(folder)) throw new Error('请先复检与导出，生成文本/图片发布包');
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle('ice:tapnow', async event => {
    assertSender(event);
    return embeddedBrowser.route('tapnow');
  });
  ipcMain.handle('ice:switch-ui', async (event, mode) => {
    assertSender(event);
    if (mode !== 'new' && mode !== 'classic') throw new Error('未知界面');
    if (mode === 'new' && !newUiBuilt()) throw new Error('新工作台未随本版本安装，请继续使用经典界面');
    try { uiMode.writeUiMode(uiPreferenceFile(), mode); } catch { /* 记不住选择不阻塞本次切换 */ }
    embeddedBrowser.reset();
    await window.loadURL(UI_PAGES[mode]);
    return { ok: true };
  });
  // 引擎退出后的恢复入口：重启整个应用（引擎随主进程重新拉起）。
  ipcMain.handle('ice:relaunch', async event => {
    assertSender(event);
    app.relaunch();
    app.quit();
    return { ok: true };
  });
}

async function createWindow() {
  chatLifecycle('window:creating');
  window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1040, minHeight: 720,
    title: 'ICE Loop Studio', backgroundColor: '#F3F2ED', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: !process.argv.includes('--smoke')&&!process.argv.includes('--browser-smoke')&&!process.argv.includes('--chat-smoke')&&!process.argv.includes('--prompt-smoke') } });
  chatLifecycle('window:created');
  if(process.argv.includes('--chat-smoke')){window.webContents.on('did-start-loading',()=>chatLifecycle('window:loading'));window.webContents.on('did-finish-load',()=>chatLifecycle('window:loaded'));window.webContents.on('did-fail-load',(_event,code,description)=>chatLifecycle('window:load-failed '+code+' '+description));window.webContents.on('render-process-gone',(_event,details)=>chatLifecycle('renderer:gone '+details.reason));}
  if(process.argv.includes('--prompt-smoke'))window.webContents.once('did-finish-load',()=>setTimeout(async()=>{
    try{await require('./prompt-smoke.cjs')({window,request,captureRun,runtime});}
    catch(error){fs.writeFileSync(path.join(runtime,'prompt-smoke-error.txt'),error.stack||error.message);}
    app.quit();
  },1600));
  window.setMenuBarVisibility(false);
  if(process.argv.includes('--chat-smoke'))window.webContents.once('did-finish-load',()=>setTimeout(async()=>{
    try{const result=await require('./chat-smoke.cjs')({window,request,runtime});fs.writeFileSync(path.join(runtime,'chat-result.json'),JSON.stringify(result,null,2));}
    catch(error){fs.writeFileSync(path.join(runtime,'chat-error.txt'),error.stack||error.message);}finally{app.quit();}
  },1200));
  window.on('resize',()=>embeddedBrowser.resize());
  window.on('closed',()=>{embeddedBrowser.reset();void originalImages.clear();});
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)void originalImages.clear();});
  // New UI reports credential_warning from bootstrap; only the classic UI has
  // a global toast function. Do not throw during new-workbench startup.
  if(credentialWarning)window.webContents.once('did-finish-load',()=>{window.webContents.executeJavaScript('if(typeof toast === "function") toast('+JSON.stringify(credentialWarning)+')').catch(()=>{});});
  if(process.argv.includes('--review-smoke')){
    window.webContents.once('did-finish-load',()=>setTimeout(async()=>{
      try{
        const fixture=JSON.parse(fs.readFileSync(path.join(runtime,'review-fixture.json'),'utf8'));
        const result=await window.webContents.executeJavaScript('window.__ICE_REVIEW_SMOKE__('+JSON.stringify(fixture.job_id)+')');
        await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        fs.writeFileSync(path.join(runtime,'review-proof.png'),(await window.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(runtime,'review-result.json'),JSON.stringify(result,null,2));
      }catch(error){fs.writeFileSync(path.join(runtime,'review-error.txt'),error.stack||error.message);}finally{app.quit();}
    },1800));
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, legacyURL) => { if (!(event.url||legacyURL||'').startsWith('ice://app/')) event.preventDefault(); });
  window.once('ready-to-show', () => { if (!process.argv.includes('--smoke')&&!process.argv.includes('--review-smoke')&&!process.argv.includes('--browser-smoke')&&!process.argv.includes('--chat-smoke')) window.show(); });
  if (process.argv.includes('--ui-smoke')) {
    let smokeSettled = false;
    const settle = async outcome => {
      if (smokeSettled) return; smokeSettled = true;
      try { fs.writeFileSync(path.join(runtime, 'ui-smoke-result.json'), JSON.stringify(outcome, null, 2)); }
      catch (error) { fs.writeFileSync(path.join(runtime, 'ui-smoke-error.txt'), error.stack || error.message); }
      finally { app.quit(); }
    };
    window.webContents.on('did-fail-load', (_e, code, description, url) => {
      settle({ ok: false, stage: 'did-fail-load', code, description, url });
    });
    window.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const info = await window.webContents.executeJavaScript('({title:document.title,rootChildren:document.getElementById("root")?document.getElementById("root").children.length:-1,rootText:document.getElementById("root")?document.getElementById("root").innerText.slice(0,200):""})');
        await settle({ ok: info.rootChildren > 0, ...info, url: window.webContents.getURL() });
      } catch (error) { await settle({ ok: false, stage: 'execute', error: error.message }); }
    }, 1500));
    setTimeout(() => settle({ ok: false, stage: 'timeout', url: window.webContents.getURL() }), 30000);
  }
  await window.loadURL(startPage());
  if (process.argv.includes('--dpi-smoke')) {
    // M2-10：以 zoomFactor 近似 100/125/150/200% 缩放，记录窗口与视口几何+截图。
    (async () => {
      const geometry = { display: screen.getPrimaryDisplay().scaleFactor, rows: [] };
      try {
        for (const zoom of [1, 1.25, 1.5, 2]) {
          window.webContents.setZoomFactor(zoom);
          await new Promise(resolve => setTimeout(resolve, 600));
          const bounds = window.getBounds();
          const viewport = await window.webContents.executeJavaScript(
            '({w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth})');
          const shot = await window.webContents.capturePage();
          const file = path.join(runtime, 'dpi-' + String(zoom).replace('.', '_') + '.png');
          fs.writeFileSync(file, shot.toPNG());
          geometry.rows.push({ zoom, bounds, viewport, screenshot: path.basename(file) });
        }
        fs.writeFileSync(path.join(runtime, 'dpi-geometry.json'), JSON.stringify(geometry, null, 2));
      } catch (error) {
        fs.writeFileSync(path.join(runtime, 'dpi-smoke-error.txt'), error.stack || error.message);
      } finally { app.quit(); }
    })();
  }
  if (process.argv.includes('--widths-smoke')) {
    // 批次B-07：500/800/1024/1280 CSS 视口（窗口尺寸模拟）下注入长中文标题与
    // 超长无空格串，验收页面不产生横向溢出。这是视口级检查；网页缩放由
    // --dpi-smoke（zoomFactor 近似）覆盖，物理系统 DPI 需真机另行验收，不混用结论。
    // 仅在本检查中放宽产品最小窗口宽度，让 500/800 视口真实生效。
    window.setMinimumSize(480, 600);
    const runWidths = async () => {
      const report = { widths: [500, 800, 1024, 1280], rows: [], ok: true };
      try {
        const injected = await window.webContents.executeJavaScript(`(() => {
          const unbroken = 'Agent'.repeat(80) + '超长无空格压力串'.repeat(20);
          const longTitle = '这是一个用于验收窄窗口截断与换行行为的超长中文会话标题'.repeat(4);
          const touched = [];
          const search = document.querySelector('[aria-label="搜索会话或草稿"]');
          if (search) { search.value = unbroken; search.dispatchEvent(new Event('input', { bubbles: true })); touched.push('search'); }
          const heading = document.querySelector('h1');
          if (heading) { heading.textContent = longTitle; touched.push('h1'); }
          return touched;
        })()`);
        report.injected = injected;
        for (const width of report.widths) {
          window.setContentSize(width, 800);
          await new Promise(resolve => setTimeout(resolve, 700));
          const metrics = await window.webContents.executeJavaScript(`(() => {
            const de = document.documentElement;
            const offenders = [];
            for (const el of de.querySelectorAll('*')) {
              if (el.scrollWidth > de.clientWidth + 1 && !el.closest('.ice-chat-log')) offenders.push(el);
              if (offenders.length >= 5) break;
            }
            return { viewport: de.clientWidth, scrollWidth: de.scrollWidth,
                     overflowX: de.scrollWidth > de.clientWidth,
                     offenders: offenders.map(el => String(el.className || el.tagName).slice(0, 60)) };
          })()`);
          const shot = await window.webContents.capturePage();
          const file = path.join(runtime, 'widths-' + width + '.png');
          fs.writeFileSync(file, shot.toPNG());
          report.rows.push({ width, ...metrics, screenshot: path.basename(file) });
          if (metrics.overflowX) report.ok = false;
        }
      } catch (error) {
        report.ok = false;
        report.error = error.stack || error.message;
      }
      fs.writeFileSync(path.join(runtime, 'widths-report.json'), JSON.stringify(report, null, 2));
      app.quit();
    };
    const startWhenLoaded = () => {
      if (window.webContents.isLoading()) { setTimeout(startWhenLoaded, 300); return; }
      setTimeout(runWidths, 1200);
    };
    startWhenLoaded();
  }
  if(process.argv.includes('--browser-smoke')){
    setTimeout(async()=>{try{const result=await require('./browser-smoke.cjs').run({window,controller:embeddedBrowser,request,runtime});fs.writeFileSync(path.join(runtime,'browser-result.json'),JSON.stringify(result,null,2));}catch(error){fs.writeFileSync(path.join(runtime,'browser-error.txt'),error.stack||error.message);}finally{app.quit();}},1200);
  }
  if (process.argv.includes('--smoke')) {
    setTimeout(async () => {
      try {
        const result = await window.webContents.executeJavaScript('window.__ICE_SMOKE__()');
        fs.writeFileSync(path.join(runtime, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
        await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__("studio")');
        await new Promise(resolve => setTimeout(resolve, 350));
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        result.nativeScreenshot = await window.webContents.executeJavaScript('window.ice.captureWindow()');
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(runtime, 'desktop-preview.png'), image.toPNG());
        for (const view of ['models','article','assets','resources','versions','backups']) {
          await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__(' + JSON.stringify(view) + ')');
          if(view==='resources')result.resourcePipeline=await window.webContents.executeJavaScript('({ready:document.querySelector("#visual-pipeline").dataset.state==="ready",slots:document.querySelectorAll("#visual-pipeline .visual-slot").length})');
          await new Promise(resolve => setTimeout(resolve, 150));
          await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
          const capture = await window.webContents.capturePage();
          fs.writeFileSync(path.join(runtime, 'desktop-' + (view==='resources'?'ice-resources':view) + '.png'), capture.toPNG());
        }
        window.setSize(1040, 800);
        await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__("studio")');
        await new Promise(resolve => setTimeout(resolve, 350));
        result.compact = await window.webContents.executeJavaScript('({bodyWidth:document.body.scrollWidth, viewport:innerWidth, heading:document.querySelector("h1").textContent})');
        const compact = await window.webContents.capturePage();
        fs.writeFileSync(path.join(runtime, 'desktop-compact.png'), compact.toPNG());
        window.setSize(1460, 1000);
        result.publications = await window.webContents.executeJavaScript('window.__ICE_PUBLICATION_SMOKE__()');
        result.planning = await window.webContents.executeJavaScript('window.__ICE_PLANNING_SMOKE__()');
        await request('resources.import', {file_path:result.nativeScreenshot.file});
        result.resources = await window.webContents.executeJavaScript('window.__ICE_RESOURCE_SMOKE__()');
        const backupFile=path.join(path.dirname(runtime),'desktop-backup-'+randomUUID()+'.zip');
        const backup=await request('backup.create',{file_path:backupFile});
        const inspected=await request('backup.inspect',{file_path:backupFile});
        const restored=await request('backup.restore',{file_path:backupFile,destination:path.join(path.dirname(runtime),'desktop-restored-'+randomUUID()),package_hash:inspected.package_hash});
        result.maintenance.backup=backup.files>0&&backup.accounts.length===2;
        result.maintenance.packageChecked=backup.package_hash===inspected.package_hash;
        result.maintenance.restore=fs.existsSync(path.join(restored.runtime_root,'app.db'));
        result.maintenance.restart=await verifyRestoredSidecar(restored.runtime_root);
        result.maintenance.backup_file=backupFile;result.maintenance.restored_runtime=restored.runtime_root;
        const preview=path.join(result.maintenance.export_folder,'04-阅读与排版预览.html');
        const previewWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
        try{
          await previewWindow.loadFile(preview);
          result.maintenance.htmlRendered=await previewWindow.webContents.executeJavaScript('Boolean(document.querySelector("main h1"))&&Boolean(document.querySelector("figure img"))&&document.querySelectorAll("pre code").length>=3');
          await previewWindow.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(image=>image.decode()))');
          fs.writeFileSync(path.join(runtime,'desktop-html.png'),(await previewWindow.webContents.capturePage()).toPNG());
        }finally{previewWindow.destroy();}
        for (const view of ['accounts','drafts','resources','history','new']) {
          await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__(' + JSON.stringify(view) + ')');
          await new Promise(resolve=>setTimeout(resolve,250));
          const actual = await window.webContents.executeJavaScript('({view:ui.view,heading:document.querySelector("h1")?.textContent,form:Boolean(document.querySelector("#account-form"))})');
          if (view === 'accounts' && !actual.form) throw Error('公众号设置页面未渲染：'+JSON.stringify(actual));
          await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
          const capture = await window.webContents.capturePage(); fs.writeFileSync(path.join(runtime,'desktop-'+view+'.png'),capture.toPNG());
        }
        const bootstrap=await request('bootstrap',{});
        const libraryRoot=path.join(runtime,'supplement-library'),sourceFolder='007-已有文章补图验收';
        const inputFolder=path.join(libraryRoot,sourceFolder);fs.mkdirSync(path.join(inputFolder,'images'),{recursive:true});
        fs.copyFileSync(result.nativeScreenshot.file,path.join(inputFolder,'images','old.png'));
        const body=['# '+bootstrap.account.columns[0].code+' / 007 补图保留原稿','',
          '这是需要保持原样的正文。','','![图1：封面](images/old.png)','','## 一、真实示例','',
          '```python','message = input("输入内容：")','print(message)','```','',
          '![图2：运行截图](待配图：截图｜Agent)','','## 写在最后','','原来的结尾保持不变。',''].join('\r\n');
        const sourceFile=path.join(inputFolder,'01-公众号正文.md'),raw=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(body)]);
        fs.writeFileSync(sourceFile,raw);
        const configured=await request('accounts.save',{account:{...bootstrap.account,library_root:libraryRoot}});
        await window.webContents.executeJavaScript('useBootstrap('+JSON.stringify(configured)+')');
        result.supplements=await window.webContents.executeJavaScript('window.__ICE_SUPPLEMENT_SMOKE__('+JSON.stringify(sourceFolder)+')');
        result.supplements.originalPreserved=fs.readFileSync(sourceFile).equals(raw)&&createHash('sha256').update(raw).digest('hex')===result.supplements.source_hash;
        const supplemented=fs.readFileSync(path.join(result.supplements.export_folder,'01-公众号正文.md'),'utf8');
        result.supplements.textPreserved=supplemented.includes(body.split('\r\n')[0])&&supplemented.includes('原来的结尾保持不变。\r\n')&&supplemented.includes('message = input("输入内容：")\r\nprint(message)\r\n');
        result.supplements.promptExported=fs.readFileSync(path.join(result.supplements.export_folder,'03-配图提示词.md'),'utf8').includes('edited cover');
        for(const view of ['assets','plan','source']){
          await window.webContents.executeJavaScript(view==='plan'?'openSupplementPlan(ui.currentJob)':view==='source'?'ui.tab="article";ui.mode="edit";renderDetail()':'ui.tab="assets";renderDetail()');
          await new Promise(resolve=>setTimeout(resolve,200));
          await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
          fs.writeFileSync(path.join(runtime,'desktop-supplement-'+view+'.png'),(await window.webContents.capturePage()).toPNG());
          if(view==='plan')await window.webContents.executeJavaScript('document.querySelector("#supplement-plan").close()');
        }
        window.setSize(1040,800);
        await window.webContents.executeJavaScript('ui.tab="assets";ui.mode="preview";renderDetail()');
        await new Promise(resolve=>setTimeout(resolve,250));
        result.supplements.compact=await window.webContents.executeJavaScript('document.body.scrollWidth===innerWidth');
        fs.writeFileSync(path.join(runtime,'desktop-supplement-compact.png'),(await window.webContents.capturePage()).toPNG());
        result.outlines=await window.webContents.executeJavaScript('window.__ICE_OUTLINE_SMOKE__()');
        await window.webContents.executeJavaScript('newDialog.close();changeView("outlines");renderOutlines()');
        await new Promise(resolve=>setTimeout(resolve,350));
        result.outlines.pageCaptureReady=await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(!newDialog.open&&document.querySelectorAll(".outline-saved-row").length===26))))');
        fs.writeFileSync(path.join(runtime,'desktop-outlines.png'),(await window.webContents.capturePage()).toPNG());
        window.setSize(1460,1000);
        await window.webContents.executeJavaScript('openNewArticle({reset:true}).then(async()=>{newForm.elements.title_mode.value="outline";syncTitleMode();await loadOutlineChoices();document.querySelector("#outline-topic-choice").value=outlineState.available.find(row=>row.episode===11).topic_id;await adoptOutline();newDialog.scrollTop=0;})');
        await new Promise(resolve=>setTimeout(resolve,350));
        result.outlines.formCaptureReady=await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(newDialog.open&&newForm.elements.episode.value==="11"&&newForm.elements.topic.value==="审阅后修改的第十一期"&&outlineReady()))))');
        fs.writeFileSync(path.join(runtime,'desktop-outline-new.png'),(await window.webContents.capturePage()).toPNG());
        result.productionTools=await window.webContents.executeJavaScript('window.__ICE_TOOLS_SMOKE__()');
        await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        fs.writeFileSync(path.join(runtime,'desktop-tools.png'),(await window.webContents.capturePage()).toPNG());
        window.setSize(1040,800);
        await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        result.productionTools.compact=await window.webContents.executeJavaScript('document.body.scrollWidth===innerWidth');
        fs.writeFileSync(path.join(runtime,'desktop-tools-compact.png'),(await window.webContents.capturePage()).toPNG());
        const publicationJob=await request('jobs.get',{job_id:result.maintenance.job_id});
        const publicationFolder=publicationJob.export.publishing_folder;
        const publishingBody=fs.readFileSync(path.join(publicationFolder,'文本','01-公众号正文.md'),'utf8');
        const publishingInfo=fs.readFileSync(path.join(publicationFolder,'文本','02-发布信息.txt'),'utf8');
        const publishingImages=fs.readdirSync(path.join(publicationFolder,'图片'));
        const references=[...publishingBody.matchAll(/^!\[[^\]\r\n]*\]\(\.\.\/图片\/([^\)\r\n]+)\)/gm)];
        result.publicationExport={folder:publicationFolder,twoFolders:JSON.stringify(fs.readdirSync(publicationFolder).sort())===JSON.stringify(['图片','文本'].sort()),
          markdown:publishingBody.startsWith('# '),imagesOnly:publishingImages.length>0&&publishingImages.every(name=>/\.(png|jpe?g|webp)$/i.test(name)),
          linksResolved:references.length>0&&references.every(match=>fs.existsSync(path.join(publicationFolder,'图片',match[1]))),
          archiveSeparate:publicationFolder!==publicationJob.export.folder,manualInstructions:publishingInfo.includes('手动发布')&&publishingInfo.includes('草稿')};
        fs.writeFileSync(path.join(runtime, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
        app.quit();
      } catch (error) { fs.writeFileSync(path.join(runtime, 'desktop-smoke-error.txt'), error.stack||error.message); app.quit(); }
    }, 1800);
  }
}

app.whenReady().then(async () => {
  chatLifecycle('app:ready');
  if(process.argv.includes('--smoke')){
    smokeClipboard=[];
    for(const item of await clipboard.read()){
      if(!item.types.length)continue;
      const payload={};for(const type of item.types)payload[type]=await item.getType(type);
      smokeClipboard.push(new ClipboardItem(payload));
    }
  }
  protocol.handle('ice', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/__image/')) return originalImages.respond(request).catch(() => new Response('image unavailable', {status:410}));
    // 新版工作台（v2.0）挂载在 /ui/ 前缀，产物来自 desktop/ui/dist；
    // 其余路径仍走旧 renderer，过渡期两套页面并存（ADR-001）。
    const uiPrefix = '/ui/';
    let root, file;
    if (pathname.startsWith(uiPrefix)) {
      root = path.join(__dirname, 'ui', 'dist');
      file = path.resolve(root, '.' + pathname.slice(uiPrefix.length - 1));
    } else {
      root = path.join(__dirname, 'renderer');
      file = path.resolve(root, '.' + pathname);
    }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerIPC();
  try {
    if(workspace.error)throw workspace.error;
    startupProgress=new (require('./startup-progress.cjs').StartupProgress)({BrowserWindow,ipcMain,runtime,preload:path.join(__dirname,'preload.cjs'),
      onCancel:()=>{startupCancelTimer=setTimeout(()=>{if(python&&!python.killed)python.kill();},10000);}});
    startupDeadline=setTimeout(()=>{startupFailure='工作区准备超过30分钟，已停止本次启动，请检查资料大小与磁盘状态后重试';if(python&&!python.killed)python.kill();},30*60*1000);
    await startEngine();
    if(startupProgress.cancelled)throw Error('启动已取消');
    clearTimeout(startupCancelTimer);clearTimeout(startupDeadline);
    if(firstPackagedStart||workspace.fresh)require('./startup-recovery.cjs').publishWorkspace(dataSelection,runtime);
    if(process.argv.includes('--provider-smoke')){
      const profiles=(await request('bootstrap')).settings.profiles;const results=[];
      for(const profile of profiles){
        if(!profile.has_key){results.push({provider:profile.provider,status:'not_configured'});continue;}
        try{results.push({...await request('tools.provider_check',{provider:profile.provider}),status:'passed'});}
        catch(error){results.push({provider:profile.provider,status:'failed',error:error.message});}
      }
      fs.writeFileSync(path.join(runtime,'provider-smoke.json'),JSON.stringify({credential_warning:credentialWarning,results},null,2));app.quit();return;
    }
    await createWindow();
    startupProgress?.end();starting=false;
    const {PreparationQueue}=require('./automation.cjs');
    const preparationQueue=new PreparationQueue(request,captureRun);
    const preparationTimer=setInterval(()=>{if(!shuttingDown&&!process.argv.includes('--prompt-smoke'))preparationQueue.tick().catch(()=>{});},5000);
    preparationTimer.unref();
    app.once('before-quit',()=>clearInterval(preparationTimer));
  }
  catch (error) {
    const cancelled=startupProgress?.cancelled;
    // Keep cancellation marker until the owned sidecar has stopped.
    if(cancelled){
      if(python&&python.exitCode===null&&python.signalCode===null){
        python.kill();await new Promise(resolve=>{python.once('close',resolve);setTimeout(resolve,3000);});
      }
    }
    startupProgress?.end();starting=false;clearTimeout(startupCancelTimer);clearTimeout(startupDeadline);
    if(cancelled){app.quit();return;}
    if (process.argv.includes('--smoke')||process.argv.includes('--review-smoke')||process.argv.includes('--provider-smoke')||process.argv.includes('--ui-smoke')) fs.writeFileSync(path.join(runtime, process.argv.includes('--provider-smoke')?'provider-error.txt':process.argv.includes('--review-smoke')?'review-error.txt':process.argv.includes('--ui-smoke')?'ui-smoke-error.txt':'desktop-smoke-error.txt'), error.message);
    else {
      // Stop only our sidecar before standalone recovery. A rejected database
      // must never be opened by a second background engine/queue consumer.
      if(python&&!python.killed){
        const child=python;
        await new Promise(resolve=>{
          const timer=setTimeout(()=>child.kill(),1500);
          child.once('close',()=>{clearTimeout(timer);resolve();});
          if(child.exitCode!==null||child.signalCode!==null){clearTimeout(timer);resolve();}
          else child.stdin.end();
        });
      }
      const recovery=new StartupRecovery({dialog,selection:dataSelection,project,
        request:(method,params)=>recoveryRequest(engineCommand(),project,path.join(runtime,'staging','startup-recovery'),method,params),
        restart:async()=>{delete process.env.ICE_DESKTOP_RUNTIME;app.relaunch();}});
      await recovery.run(error);
    }
    app.quit();
  }
});
app.on('window-all-closed', () => {if(!starting)app.quit();});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('before-quit', event => {
  if(smokeClipboard){event.preventDefault();const saved=smokeClipboard;smokeClipboard=null;clipboard.write(saved).catch(()=>{}).finally(()=>app.quit());return;}
  shuttingDown = true;
  startupProgress?.end();clearTimeout(startupCancelTimer);clearTimeout(startupDeadline);
  embeddedBrowser?.reset();
  void originalImages.clear();
  if (python && !python.killed) { python.stdin.end(); setTimeout(() => python.kill(), 1000).unref(); }
});
