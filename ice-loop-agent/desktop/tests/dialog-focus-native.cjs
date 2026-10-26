'use strict';
// 批次B3/B4（2026-10-21 后续工程）：真实应用内的“关闭后跳转”焦点保持 + 动效双态记录。
// - B3 应用级：设置弹窗 Esc 关闭后立刻 Ctrl+K 打开命令面板——新面板保有焦点，
//   不被旧弹窗的焦点归还逻辑劫持（复验 Codex ui.tsx 修复，无全局改动）。
//   嵌套原图关回缩略图已由 interaction-integrity 覆盖（viewer_escape_returns_thumbnail_focus），
//   本专项不重复该旅程。
// - B4：prefers-reduced-motion 两种状态分别记录为独立结果（正常态动画真实运行；
//   减弱态为 none）。同一会话内用 CDP Emulation.setEmulatedMedia 切换并恢复，
//   计时用 performance.now 单调时间，不做固定睡眠断言。
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned interaction-lists fixture required');
const report={state:'running',scope:'source Electron; real dialogs; emulated motion states',checks:{},motion:{},runtime:fixture.runtime};
const save=()=>fs.writeFileSync(path.join(out,'dialog-focus-native.json'),JSON.stringify(report,null,2));
(async()=>{
 let session;
 try{
  session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,call,until}=session;
  const check=(name,value)=>{report.checks[name]=Boolean(value);save();if(!value)throw Error(name+' failed');};
  const VK={k:75,',':188,Escape:27,Enter:13};
  const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
  await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);

  // ---------- B3 应用级：关闭设置后立即打开命令面板（关闭→跳转） ----------
  await key(',',2);
  await until(`Boolean(document.querySelector('[aria-label="普通文章默认上限"]'))`);
  const budgetInDialog=await evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`);
  check('settings_open_focus_inside',budgetInDialog===true);
  // 无固定等待：Esc 后同一毫秒级序列立刻 Ctrl+K——新层必须接管键盘与焦点。
  const jumpAt=await evaluate(`performance.now()`);
  await key('Escape');await key('k',2);
  await until(`Boolean(document.querySelector('[aria-label="搜索命令"]'))`);
  const afterJump=await evaluate(`performance.now()`);
  report.motion.jumpElapsedMs=afterJump-jumpAt;
  check('close_then_jump_palette_open',true);
  check('close_then_jump_focus_in_palette',await evaluate(`document.activeElement?.getAttribute('aria-label')==='搜索命令'`));
  check('close_then_jump_settings_unmounted',await evaluate(`!document.querySelector('[aria-label="普通文章默认上限"]')`));
  await key('Escape');await until(`!document.querySelector('[aria-label="搜索命令"]')`);

  // ---------- B4：动效双态分别记录（正常态动画真实运行 / 减弱态禁用） ----------
  // native-session 启动即 reduce；先切到 no-preference 观测正常态，再恢复 reduce。
  const probeClasses=['ice-skeleton','ice-dialog-overlay'];
  const readMotion=async()=>JSON.parse(await evaluate(`(()=>{
    const rows=[];
    for(const name of ${JSON.stringify(probeClasses)}){
      const node=document.createElement('div');node.className=name;document.body.append(node);
      const style=getComputedStyle(node);
      const anims=node.getAnimations?node.getAnimations():[];
      rows.push({name,animationName:style.animationName,animationDuration:style.animationDuration,
        running:anims.filter(a=>a.playState==='running').length,at:performance.now()});
      node.remove();
    }
    return JSON.stringify(rows);})()`));
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await wait(120);
  const normal=await readMotion();
  report.motion.normal={evidence:normal};
  check('motion_normal_skeleton_animation_declared',normal[0].animationName!=='none');
  check('motion_normal_animation_actually_running',normal.some(row=>row.running>0));
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await wait(120);
  const reduced=await readMotion();
  report.motion.reduced={evidence:reduced};
  check('motion_reduced_skeleton_animation_disabled',reduced.every(row=>row.animationName==='none'&&row.running===0));
  check('motion_states_recorded_separately',Boolean(report.motion.normal.evidence&&report.motion.reduced.evidence));

  check('no_renderer_exceptions',session.errors.length===0);
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{if(session)await session.close();save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks,motion:report.motion}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
