"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {openNativeSession}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'recovery-points-fixture.json')));
if(path.dirname(f.root)!==path.join(repo,'.test-tmp/release-backup')||!f.runtime.startsWith(f.root+path.sep))throw Error('Unowned fixture');
const report={state:'running',runtime:f.runtime,checks:{},errors:[]};
const save=()=>fs.writeFileSync(path.join(out,'recovery-points-native.json'),JSON.stringify(report,null,2));
const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name);};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let session;
(async()=>{try{
 save();
 // Real cancellation through the startup renderer bridge, before live writes.
 fs.writeFileSync(path.join(f.root,'cancel-startup-once'),'owned test action');
 const child=require('node:child_process').spawn(require('../node_modules/electron'),[f.cancel_entry,'--new-ui'],{cwd:repo,env:{...process.env,ICE_DESKTOP_RUNTIME:f.cancel_runtime,TEMP:f.cancel_runtime,TMP:f.cancel_runtime},windowsHide:true,stdio:'ignore'});
 const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Startup cancellation timeout'));},25000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve(code);});});
 check('startup-cancel-exits-without-rescue-dialog',exit===0);
 check('startup-cancel-preserves-original-database-bytes',hash(path.join(f.cancel_runtime,'app.db'))===f.cancel_database_hash);
 check('startup-cancel-leaves-no-transient-control-files',fs.readdirSync(path.join(f.cancel_runtime,'startup-control')).length===0);
 fs.unlinkSync(path.join(f.root,'cancel-startup-once'));
 session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});const {evaluate,until,call}=session;
 await until(`Boolean(document.querySelector('#ice-account-select'))`);
 const rpc=(method,params={})=>evaluate(`window.ice.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const click=async text=>{const expression=`[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.disabled)`;await until(`Boolean(${expression})`);await evaluate(`(${expression}).click()`);};
 const idle=()=>until(`document.querySelector('.ice-backup')?.getAttribute('aria-busy')==='false'`,90000);
 const listing=await rpc('recovery.list'),point=listing.points[0];
 check('automatic-full-point-exists-before-original-upgrade',point.state==='ready'&&point.source_schema===19&&point.target_schema===f.target_schema);
 const db=JSON.parse(execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
  "import sqlite3,json,sys;d=sqlite3.connect(sys.argv[1]);print(json.dumps({'version':d.execute('pragma user_version').fetchone()[0],'calls':d.execute('select count(*) from model_invocations').fetchone()[0]}));d.close()",path.join(f.runtime,'app.db')],{env:session.env,encoding:'utf8',windowsHide:true}));
 check('live-schema-upgraded-without-paid-model-calls',db.version===f.target_schema&&db.calls===0);
 const trace=fs.readFileSync(path.join(f.root,'startup-phases.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 check('real-copy-verification-and-upgrade-phase-order',trace.findIndex(p=>p.phase==='copy_files')>=0&&trace.findIndex(p=>p.phase==='save_recovery_point')<trace.findIndex(p=>p.phase==='upgrade_database'));
 check('startup-wait-window-was-rendered',fs.existsSync(path.join(f.root,'startup-wait.png'))&&fs.readFileSync(path.join(f.root,'startup-dom.txt'),'utf8').includes('准备你的创作空间'));
 check('startup-window-is-destroyed-after-ready',!(await session.getTargets()).some(t=>t.url.includes('?startup=1')));
 await click('备份与恢复');await idle();await until(`Boolean(document.querySelector('[aria-label="升级恢复点"] .ice-backup__point'))`);
 check('real-management-list-displays-point',await evaluate(`document.querySelector('[aria-label="升级恢复点"]').innerText.includes('升级前自动保存')`));
 await click('校验并预览');await until(`Boolean(document.querySelector('[aria-label="备份恢复预览"]'))`,90000);await idle();
 check('point-preview-shows-hash-and-review-gate',await evaluate(`document.querySelector('[aria-label="备份恢复预览"]').textContent.includes('SHA256')&&[...document.querySelectorAll('button')].find(e=>e.innerText==='恢复到新目录').disabled`));
 const privateResult=await evaluate(`window.ice.request('recovery.restore',{}).then(()=>false,()=>true)`);check('raw-recovery-restore-not-public',privateResult);
 for(const width of [500,800,1280]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});check('recovery-dialog-no-horizontal-overflow-'+width,await evaluate(`(()=>{const d=document.querySelector('[role=dialog]');return d.scrollWidth<=d.clientWidth+1})()`));}
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 const plan=path.join(f.root,'recovery-dialogs.json');fs.writeFileSync(plan,JSON.stringify([{canceled:false,filePaths:[f.root]}]));
 await evaluate(`document.querySelector('.ice-backup__confirm input').click()`);await click('恢复到新目录');await until(`Boolean(document.querySelector('[aria-label="恢复结果"]'))`,90000);await idle();
 const restored=JSON.parse(fs.readFileSync(path.join(f.root,'selection.json'))).runtime_root;
 check('point-restore-is-new-directory',restored!==f.runtime&&restored.startsWith(f.root+path.sep)&&fs.existsSync(path.join(restored,'app.db')));
 const restoredSettings=JSON.parse(fs.readFileSync(path.join(restored,'settings.json')));
 check('large-managed-file-is-retained-byte-for-byte',hash(path.join(restoredSettings.article_root,'large-test-asset.bin'))===f.large_hash&&hash(f.large_file)===f.large_hash);
 await click('立即创建恢复点');await idle();await until(`document.querySelectorAll('.ice-backup__point').length===2`,90000);
 check('manual-create-receipt-is-visible',await evaluate(`document.querySelector('[aria-label="升级恢复点"]').innerText.includes('完整恢复点已保存')`));
 fs.writeFileSync(plan,JSON.stringify([{response:0}]));await click('删除恢复点');await idle();check('cancelled-delete-preserves-two-points',(await rpc('recovery.list')).points.length===2);
 fs.writeFileSync(plan,JSON.stringify([{response:1}]));await click('删除恢复点');await idle();check('confirmed-delete-removes-only-one-point',(await rpc('recovery.list')).points.length===1);
 check('current-article-and-image-data-survive-delete',(await rpc('articles.document',{job_id:f.job})).markdown.includes('这是需要保留的原稿')&&hash(f.large_file)===f.large_hash);
 check('no-unexpected-dialogs-left',JSON.parse(fs.readFileSync(plan)).length===0);
 const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(f.root,'recovery-management.png'),Buffer.from(screenshot.data,'base64'));
 check('no-uncaught-renderer-errors',session.errors.length===0);
 report.state='finished';report.restored_runtime=restored;
 }catch(error){report.state='failed';report.errors.push(error.stack);throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({state:report.state,checks:Object.keys(report.checks).length,root:f.root}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
