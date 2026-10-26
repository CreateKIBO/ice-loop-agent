// Real Chromium DOM regression for the production focus helper; no model or publication.
'use strict';
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/glm-review-fixture.json'),'utf8'));
if(path.dirname(fixture.root)!==path.join(repo,'.test-tmp/release-glm-review')||!fs.existsSync(path.join(fixture.root,'.test-owner.json')))throw Error('Owned fixture required');
const report={scope:'source Electron; production helper in real DOM; synthetic rows; offline',checks:{},state:'running'};
const helper=esbuild.buildSync({stdin:{contents:"export * from './components/focusRestore';",resolveDir:path.join(repo,'desktop/ui/src'),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'focusUnderTest'}).outputFiles[0].text;
(async()=>{let session;try{
 session=await openNativeSession(repo,fixture.runtime,{entryPath:fixture.entry});const {evaluate,until}=session;
 await until(`Boolean(document.querySelector('.ice-sidebar')) || Boolean(document.querySelector('button[title="GLM交互验收长会话"]'))`);
 const check=(name,ok)=>{report.checks[name]=Boolean(ok);if(!ok)throw Error(name);};
 await evaluate(helper);
 const setup=async()=>evaluate(`(()=>{document.getElementById('focus-fixture')?.remove();const host=document.createElement('div');host.id='focus-fixture';host.innerHTML='<ul><li id="focus-row-0"><button class="focus-row" id="focus-button-0">first</button></li><li id="focus-row-1"><button class="focus-row" id="focus-button-1">second</button></li></ul><button id="focus-other">other panel</button>';document.body.append(host);document.getElementById('focus-button-0').focus();window.focusStop=focusUnderTest.focusAfterRowRemoval(document.getElementById('focus-row-0'),'.focus-row');})()`);
 await setup();await wait(700);await evaluate(`document.getElementById('focus-row-0').remove()`);await until(`document.activeElement?.id==='focus-button-1'`);
 check('slow_refresh_over_320ms_restores_next_row',true);
 await setup();await evaluate(`document.getElementById('focus-other').focus();document.getElementById('focus-row-0').remove()`);await wait(500);
 check('new_panel_focus_is_not_stolen',await evaluate(`document.activeElement?.id==='focus-other'`));
 await setup();await evaluate(`document.querySelector('#focus-fixture ul').remove()`);await wait(500);
 check('detached_list_is_not_focused',await evaluate(`document.activeElement?.id!=='focus-button-1'`));
 await setup();await evaluate(`document.getElementById('focus-row-1').remove();document.getElementById('focus-row-0').remove()`);await until(`document.activeElement===document.querySelector('#focus-fixture ul')`);
 check('empty_list_receives_keyboard_focus',true);
 await evaluate(`window.focusStop();document.getElementById('focus-fixture').remove()`);
 check('no_renderer_exceptions',session.errors.length===0);report.state='finished';
}catch(error){report.state='failed';report.error=error.stack;}finally{if(session)await session.close();fs.writeFileSync(path.join(repo,'docs/上线准备/interaction-acceptance-native.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));process.exitCode=report.state==='finished'?0:1;})();
