'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'interaction-lists-fixture.json'),'utf8'));
const report={state:'running',runtime:f.runtime,checks:{}};
const save=()=>fs.writeFileSync(path.join(out,'download-target-native.json'),JSON.stringify(report,null,2));
(async()=>{let s;try{
 s=await openNativeSession(repo,f.runtime,{entryPath:f.entry});
 const check=(name,v)=>{report.checks[name]=Boolean(v);save();if(!v)throw Error(name+' failed');};
 const section=`document.querySelector('section[aria-label="下载待归档"]')`;
 const row=`[...${section}.querySelectorAll('.ice-card')].find(c=>c.innerText.includes('download-bind.png'))`;
 const select=`${row}.querySelector('[aria-label="选择文章"]')`;
 const figure=`${row}.querySelector('[aria-label="选择图位"]')`;
 const bind=`[...${row}.querySelectorAll('button')].find(b=>b.innerText.trim()==='绑定并采纳')`;
 const pick=async(expr,v)=>s.evaluate(`(()=>{const e=${expr};e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await s.until(`Boolean(${section})`);await s.until(`Boolean(${row})`);
 await pick(select,f.jobs.completed);
 await s.until(`(${figure}).options.length>1`);
 await pick(figure,String(f.assets.figure));
 await s.until(`!(${bind}).disabled`);
 fs.writeFileSync(f.fault,JSON.stringify({delayMs:{'jobs.get':900}}));
 await pick(select,f.jobs.paused);
 check('switch_target_disables_old_figure_immediately',await s.evaluate(`(${figure}).disabled&&(${figure}).value===''`));
 check('switch_target_disables_binding_until_loaded',await s.evaluate(`(${bind}).disabled`));
 await wait(1100);
 check('empty_target_does_not_offer_old_slots',await s.evaluate(`(${figure}).options.length===1&&(${bind}).disabled`));
 fs.writeFileSync(f.fault,'{}');
 await pick(select,f.jobs.completed);await s.until(`(${figure}).options.length>1`);
 check('new_target_requires_explicit_figure_selection',await s.evaluate(`(${figure}).value===''&&(${bind}).disabled`));

 for(const width of [500,800,1024,1280]){
   await s.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await wait(160);
   await s.evaluate(`(()=>{const b=document.querySelector('button[aria-controls="ice-task-pane"]');if(b.getAttribute('aria-expanded')!=='true')b.click();})()`);
   await s.until(`!document.querySelector('#ice-task-pane').hidden`);
   check('task_controls_fit_'+width,await s.evaluate(`(()=>{const p=document.querySelector('#ice-task-pane');return p.scrollWidth<=p.clientWidth+2&&document.documentElement.scrollWidth<=innerWidth+2;})()`));
 }
 await s.call('Emulation.clearDeviceMetricsOverride');
 const image=await s.call('Page.captureScreenshot',{format:'png'});
 report.screenshot=path.join(f.root,'download-target-layout.png');fs.writeFileSync(report.screenshot,Buffer.from(image.data,'base64'));
 check('no_renderer_exceptions',s.errors.length===0);report.state='finished';
 }catch(e){report.state='failed';report.error=e.stack;}
 finally{fs.writeFileSync(f.fault,'{}');if(s)await s.close();save();}
 console.log(JSON.stringify(report));process.exitCode=report.state==='finished'?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
