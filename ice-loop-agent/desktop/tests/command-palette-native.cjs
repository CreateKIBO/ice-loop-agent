'use strict';
// Real palette command deduplication through the renderer bridge and real backend.
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const f=JSON.parse(fs.readFileSync(path.join(out,'interaction-lists-fixture.json'),'utf8'));
if(path.dirname(f.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(f.root,'.test-owner.json')))throw Error('Owned fixture required');
const report={state:'running',runtime:f.runtime,checks:{}};
const save=()=>fs.writeFileSync(path.join(out,'command-palette-native.json'),JSON.stringify(report,null,2));
const rows=()=>fs.readFileSync(f.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
(async()=>{let s;
 try{
  s=await openNativeSession(repo,f.runtime,{entryPath:f.entry});
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  await s.until(`document.querySelectorAll('.ice-nav-row__main').length>=4`);
  const before=rows().filter(r=>r.method==='chat.create'&&r.phase==='started').length;
  fs.writeFileSync(f.fault,JSON.stringify({delayMs:{'chat.create':600}}));
  for(const type of ['keyDown','keyUp'])await s.call('Input.dispatchKeyEvent',{type,key:'k',modifiers:2,windowsVirtualKeyCode:75});
  await s.until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await s.call('Input.insertText',{text:'新建会话'});
  await s.until(`document.querySelectorAll('[role="option"]').length===1`);
  await s.evaluate(`(()=>{const b=document.querySelector('[role="option"]');b.click();b.click();b.click();})()`);
  await s.until(`!document.querySelector('[aria-label="搜索命令"]')`);
  await wait(900);
  report.writes=rows().filter(r=>r.method==='chat.create'&&r.phase==='started').length-before;
  check('same_tick_three_commands_write_once',report.writes===1);
  check('command_completed',rows().filter(r=>r.method==='chat.create'&&r.phase==='resolved').length===1);
  // A failed command remains retryable; clearing the fault must release the synchronous gate.
  fs.writeFileSync(f.fault,JSON.stringify({fail:['chat.create']}));
  for(const type of ['keyDown','keyUp'])await s.call('Input.dispatchKeyEvent',{type,key:'k',modifiers:2,windowsVirtualKeyCode:75});
  await s.until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  await s.call('Input.insertText',{text:'新建会话'});
  await s.until(`document.querySelectorAll('[role="option"]').length===1`);
  await s.evaluate(`document.querySelector('[role="option"]').click()`);
  await s.until(`Boolean(document.querySelector('[role="alert"]')?.textContent.includes('未执行'))`);
  check('failed_command_keeps_palette_open',await s.evaluate(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`));
  check('failed_command_names_action',await s.evaluate(`document.querySelector('[role="alert"]').textContent.includes('新建会话')`));
  fs.writeFileSync(f.fault,'{}');
  await s.evaluate(`document.querySelector('[role="option"]').click()`);
  await s.until(`!document.querySelector('[aria-label="搜索命令"]')`);
  check('failed_command_can_retry_after_recovery',rows().filter(r=>r.method==='chat.create'&&r.phase==='resolved').length===2);
  check('retry_performs_only_one_new_write',rows().filter(r=>r.method==='chat.create'&&r.phase==='started').length-before===3);
  check('no_renderer_exceptions',s.errors.length===0);
  report.state='finished';
 }catch(e){report.state='failed';report.error=e.stack;}
 finally{fs.writeFileSync(f.fault,'{}');if(s)await s.close();save();}
 console.log(JSON.stringify(report));process.exitCode=report.state==='finished'?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
