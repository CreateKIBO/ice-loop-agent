/* Isolated main-process acceptance. No credentials or publishing actions. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {dialog}=require('electron');
async function waitFor(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Browser acceptance timeout');}
let captureOwner;
async function capture(contents){
  // Destroying a native popup can invalidate its parent's Viz surface for a
  // frame. Retry only surface errors, with the isolated test window exposed.
  for(let attempt=0;attempt<3;attempt++){
    let timer;
    try{return await Promise.race([contents.capturePage(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Screenshot surface timeout')),5000);})]);}
    catch(error){
      if(attempt===2||!/UnknownVizError|surface|Screenshot surface timeout/i.test(error.message))throw error;
      if(captureOwner&&!captureOwner.isDestroyed()){captureOwner.showInactive();captureOwner.moveTop();}
      await new Promise(resolve=>setTimeout(resolve,250));
    }finally{clearTimeout(timer);}
  }
}
async function inspectLive(contents){
  if(!contents.getURL())return {readyState:'not_committed',visibleCharacters:0};
  let timer;try{return await Promise.race([contents.executeJavaScript('({readyState:document.readyState,visibleCharacters:document.body?.innerText?.trim().length||0})'),new Promise(resolve=>{timer=setTimeout(()=>resolve({readyState:'observation_timeout',visibleCharacters:0}),2000);})]);}finally{clearTimeout(timer);}
}
async function run({window,controller,request,runtime}){
  captureOwner=window;
  await window.webContents.executeJavaScript('bootReady');
  // Native child views need a composed surface; show without stealing keyboard focus.
  window.showInactive();
  const evaluate=source=>window.webContents.executeJavaScript(source);
  const result={fixtureRequests:[]};
  const layoutEvidence=async()=>{
    const host=await evaluate('browserRectangle()'),native=controller.testPage()?.view.getBounds(),size=window.getContentSize();
    if(!host||!native)return {aligned:false,host,native,size};
    const x=Math.max(66,Math.round(host.x)),y=Math.max(130,Math.round(host.y));
    const expected={x,y,width:Math.max(1,Math.min(Math.round(host.width),size[0]-x)),height:Math.max(1,Math.min(Math.round(host.height),size[1]-y))};
    return {host,native,expected,size,aligned:controller.state().visible&&['x','y','width','height'].every(key=>Math.abs(native[key]-expected[key])<=1),
      inside:native.x>=66&&native.y>=130&&native.width>0&&native.height>0&&native.x+native.width<=size[0]&&native.y+native.height<=size[1],
      hostFullyVisible:host.x>=0&&host.y>=0&&host.x+host.width<=size[0]+1&&host.y+host.height<=size[1]+1};
  };
  const awaitAligned=async()=>{try{await waitFor(async()=>{const evidence=await layoutEvidence();return evidence.aligned&&evidence.inside;});return layoutEvidence();}catch(error){throw Error(error.message+' LAYOUT '+JSON.stringify(await layoutEvidence()));}};
  await evaluate('window.ice.openTapNow()');
  await waitFor(()=>controller.testPage()?.site==='tapnow');
  result.tapnowRouteInside=await evaluate('ui.view==="browser"&&Boolean(document.querySelector("#browser-host"))');
  let page=controller.testPage();
  await new Promise(resolve=>setTimeout(resolve,10000));
  // Third-party requests can keep load pending and defer executeJavaScript.
  // Stop only the isolated acceptance page after its observation window.
  page.view.webContents.stop();
  result.liveTapNow={url:page.view.webContents.getURL(),title:page.view.webContents.getTitle(),error:controller.state().error};
  result.liveTapNow.dom=await inspectLive(page.view.webContents);
  try{fs.writeFileSync(path.join(runtime,'live-tapnow.png'),(await capture(page.view.webContents)).toPNG());result.liveTapNow.captured=true;}catch(error){result.liveTapNow.captured=false;result.liveTapNow.captureError=error.message;}
  await evaluate('document.querySelector("[data-browser-site=wechat]").click()');
  try{await waitFor(()=>controller.testPage()?.site==='wechat');}catch(error){throw Error(error.message+' '+JSON.stringify({size:window.getContentSize(),state:controller.state(),layout:await evaluate('({view:ui.view,inner:[innerWidth,innerHeight],rect:browserRectangle(),scroll:[scrollX,scrollY],host:document.querySelector("#browser-host")?.outerHTML})')}));}
  page=controller.testPage();await new Promise(resolve=>setTimeout(resolve,10000));page.view.webContents.stop();
  result.liveWeChat={url:page.view.webContents.getURL(),title:page.view.webContents.getTitle(),error:controller.state().error};
  result.liveWeChat.dom=await inspectLive(page.view.webContents);
  try{fs.writeFileSync(path.join(runtime,'live-wechat.png'),(await capture(page.view.webContents)).toPNG());result.liveWeChat.captured=true;}catch(error){result.liveWeChat.captured=false;result.liveWeChat.captureError=error.message;}
  fs.writeFileSync(path.join(runtime,'browser-live.json'),JSON.stringify({tapnow:result.liveTapNow,wechat:result.liveWeChat},null,2));
  result.isolatedPreferences={nodeIntegration:page.view.webContents.getLastWebPreferences().nodeIntegration,
    sandbox:page.view.webContents.getLastWebPreferences().sandbox,preload:page.view.webContents.getLastWebPreferences().preload||null};
  const originalAccount=(await request('bootstrap')).account;
  const partitionPath=page.session.storagePath;
  result.sessionOnDataDrive=partitionPath.startsWith(runtime)&&!/^c:/i.test(partitionPath);
  for(const site of ['tapnow','wechat']){
    await evaluate('openBrowserSite('+JSON.stringify(site)+')');
    try{await waitFor(()=>controller.testPage()?.site===site);}catch(error){fs.writeFileSync(path.join(runtime,'browser-layout-failure.png'),(await capture(window.webContents)).toPNG());throw Error(error.message+' '+JSON.stringify({size:window.getContentSize(),state:controller.state(),layout:await evaluate('({view:ui.view,inner:[innerWidth,innerHeight],rect:browserRectangle(),scroll:[scrollX,scrollY],mainScroll:workspace.scrollTop,text:workspace.innerText.slice(0,600)})')}));}
    const current=controller.testPage();current.view.webContents.stop();
    await current.session.protocol.handle('https',req=>{
      const pathname=new URL(req.url).pathname;
      if(new URL(req.url).hostname==='browser-fixture.example')result.fixtureRequests.push({site,path:pathname});
      if(pathname==='/download')return new Response('isolated browser download evidence',{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="browser-proof.txt"'}});
      return new Response('<!doctype html><title>Browser Fixture '+pathname+'</title><h1>内嵌浏览器验收 '+site+'</h1><p>独立会话、导航和远端隔离测试</p><a id="next" href="https://browser-fixture.example/next">下一页</a><a id="download" href="https://browser-fixture.example/download">下载文件</a><button id="popup" onclick="window.open(\'https://browser-fixture.example/login\')">登录弹窗</button>',{headers:{'content-type':'text/html; charset=utf-8'}});
    });
  }
  await evaluate('openBrowserSite("tapnow")');await waitFor(()=>controller.testPage()?.site==='tapnow');page=controller.testPage();
  await evaluate('window.ice.browserCommand("navigate","https://browser-fixture.example/start")');
  try{await waitFor(()=>page.view.webContents.getTitle().includes('/start')&&page.view.webContents.getURL().endsWith('/start')&&!page.view.webContents.isLoading());}catch(error){throw Error(error.message+' '+JSON.stringify({state:controller.state(),requests:result.fixtureRequests}));}
  result.remoteHasNoBridge=await page.view.webContents.executeJavaScript('typeof window.ice==="undefined"&&typeof require==="undefined"&&typeof process==="undefined"');
  // Change only the local chrome: the native webpage and current URL survive.
  const initialChrome=await evaluate('browserUI.chromeCollapsed'),initialExpanded=await evaluate('browserUI.expanded');
  if(initialExpanded)await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');
  if(initialChrome)await evaluate('document.querySelector("[data-browser-action=collapse-chrome]").click()');
  const descriptionOpen=await awaitAligned();
  await evaluate('document.querySelector("[data-browser-action=collapse-chrome]").click()');
  const descriptionClosed=await awaitAligned();
  result.collapseEnlargesWebpage=descriptionClosed.host.height>descriptionOpen.host.height+70;
  result.collapsePreferenceSaved=await evaluate('localStorage.getItem("ice-browser-chrome")==="collapsed"');
  const normalPanel=descriptionClosed;
  await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');
  const focusedPanel=await awaitAligned();
  result.expandedViewEnlargesWebpage=focusedPanel.host.width>normalPanel.host.width&&focusedPanel.host.height>normalPanel.host.height;
  result.layoutKeepsRemotePage=controller.testPage()===page&&page.view.webContents.getURL().endsWith('/start');
  fs.writeFileSync(path.join(runtime,'browser-expanded.png'),(await capture(window.webContents)).toPNG());
  await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');
  const restoredPanel=await awaitAligned();
  result.expandedViewRestores=await evaluate('!browserUI.expanded')&&Math.abs(restoredPanel.host.height-normalPanel.host.height)<2;
  if(!initialChrome)await evaluate('document.querySelector("[data-browser-action=collapse-chrome]").click()');
  if(initialExpanded)await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');
  result.chromeControlsAccessible=await evaluate('[...document.querySelectorAll("[data-browser-action=collapse-chrome],[data-browser-action=expand-view]")].every(b=>b.getBoundingClientRect().height>0)');
  for(const key of ['collapseEnlargesWebpage','collapsePreferenceSaved','expandedViewEnlargesWebpage','layoutKeepsRemotePage','expandedViewRestores','chromeControlsAccessible'])assert.equal(result[key],true,key);
  // Exercise real local chrome around the isolated remote fixture. No web
  // content receives the bridge, and native views must yield to local dialogs.
  const initialCollapsed=await evaluate('document.body.classList.contains("sidebar-collapsed")');
  try{
    if(initialCollapsed)await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
    const expanded=await awaitAligned();
    await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
    result.collapsedBrowserLayout=await awaitAligned();
    result.sidebarCollapsedBounds=result.collapsedBrowserLayout.aligned&&result.collapsedBrowserLayout.inside&&result.collapsedBrowserLayout.native.x<200&&result.collapsedBrowserLayout.native.width>expanded.native.width;
    assert.equal(result.sidebarCollapsedBounds,true,'collapsed sidebar native bounds match browser host');
    fs.writeFileSync(path.join(runtime,'browser-sidebar-collapsed.png'),(await capture(window.webContents)).toPNG());
    await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
    result.expandedBrowserLayout=await awaitAligned();
    result.sidebarExpandedBounds=result.expandedBrowserLayout.aligned&&result.expandedBrowserLayout.inside&&Math.abs(result.expandedBrowserLayout.native.x-expanded.native.x)<=1&&Math.abs(result.expandedBrowserLayout.native.width-expanded.native.width)<=1;
    assert.equal(result.sidebarExpandedBounds,true,'expanded sidebar restores native bounds');

    page.view.webContents.focus();
    await page.view.webContents.executeJavaScript('document.querySelector("#next").focus()',true);
    result.remoteShortcutOrigin={url:page.view.webContents.getURL(),focused:page.view.webContents.isFocused(),element:await page.view.webContents.executeJavaScript('document.activeElement.id')};
    assert.equal(result.remoteShortcutOrigin.element,'next','remote fixture has keyboard focus');
    page.view.webContents.sendInputEvent({type:'keyDown',keyCode:'Control'});
    page.view.webContents.sendInputEvent({type:'keyDown',keyCode:'K',modifiers:['control']});
    page.view.webContents.sendInputEvent({type:'keyUp',keyCode:'K',modifiers:['control']});
    page.view.webContents.sendInputEvent({type:'keyUp',keyCode:'Control'});
    await waitFor(async()=>await evaluate('Boolean(document.querySelector("#command-palette")?.open)')&&!controller.state().visible);
    result.remoteShortcutOpensLocalPalette=await evaluate('document.querySelector("#command-palette").open&&document.activeElement.id==="command-input"')&&!controller.state().visible;
    assert.equal(result.remoteShortcutOpensLocalPalette,true,'remote Ctrl K opens local palette without native overlay');
    fs.writeFileSync(path.join(runtime,'browser-command-palette.png'),(await capture(window.webContents)).toPNG());
    await evaluate('document.querySelector("#command-palette .command-close").click()');
    const afterPalette=await awaitAligned();
    result.browserRestoredAfterPalette=afterPalette.aligned&&page.view.webContents.getURL().endsWith('/start')&&await evaluate('!document.querySelector("dialog[open]")');
    assert.equal(result.browserRestoredAfterPalette,true,'closing palette restores the existing page and layout');

    await evaluate('document.querySelector("[data-studio-preferences]").click()');
    await waitFor(async()=>await evaluate('Boolean(document.querySelector("#studio-preferences")?.open)')&&!controller.state().visible);
    result.preferencesCoverRemoteView=await evaluate('document.querySelector("#studio-preferences").open&&Boolean(document.querySelector("#studio-motion"))')&&!controller.state().visible;
    assert.equal(result.preferencesCoverRemoteView,true,'display preferences are above the native browser');
    fs.writeFileSync(path.join(runtime,'browser-display-preferences.png'),(await capture(window.webContents)).toPNG());
    await evaluate('document.querySelector("#studio-preferences .modal-head button").click()');
    const afterPreferences=await awaitAligned();
    result.browserRestoredAfterPreferences=afterPreferences.aligned&&await evaluate('!document.querySelector("dialog[open]")');
    assert.equal(result.browserRestoredAfterPreferences,true,'closing preferences restores native browser');
  }finally{
    await evaluate('document.querySelector("#command-palette")?.close();document.querySelector("#studio-preferences")?.close()');
    if(await evaluate('document.body.classList.contains("sidebar-collapsed")')!==initialCollapsed)await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
    await awaitAligned();
  }
  await page.session.cookies.set({url:'https://browser-fixture.example',name:'acceptance-session',value:'tapnow-A'});
  await evaluate('document.querySelector("[data-browser-site=wechat]").click()');await waitFor(()=>controller.testPage()?.site==='wechat');
  result.siteCookiesIsolated=(await controller.testPage().session.cookies.get({name:'acceptance-session'})).length===0;
  await evaluate('openBrowserSite("tapnow")');await waitFor(()=>controller.testPage()?.site==='tapnow'&&controller.state().visible);
  result.cookieRetainedAfterNavigation=(await page.session.cookies.get({name:'acceptance-session'}))[0]?.value==='tapnow-A';
  const navEvents=[];page.view.webContents.on('will-navigate',(event,url)=>navEvents.push({url:event.url,legacy:url,prevented:event.defaultPrevented}));
  await page.view.webContents.executeJavaScript('document.querySelector("#next").click()',true);
  try{await waitFor(()=>page.view.webContents.getTitle().includes('/next'));}catch(error){throw Error(error.message+' '+JSON.stringify({state:controller.state(),events:navEvents,requests:result.fixtureRequests}));}
  await waitFor(()=>!page.view.webContents.isLoading());
  const beforeBack={...controller.state(),history:page.view.webContents.navigationHistory.getAllEntries().map(({url,title})=>({url,title}))};await evaluate('window.ice.browserCommand("back")');
  try{await waitFor(()=>page.view.webContents.getTitle().includes('/start')&&!page.view.webContents.isLoading());}catch(error){throw Error(error.message+' BACK '+JSON.stringify({before:beforeBack,state:controller.state(),requests:result.fixtureRequests}));}result.back=true;
  await evaluate('window.ice.browserCommand("forward")');await waitFor(()=>page.view.webContents.getTitle().includes('/next')&&!page.view.webContents.isLoading());result.forward=true;
  result.invalidURLRejected=await evaluate('window.ice.browserCommand("navigate","file:///G:/secret").then(()=>false,()=>true)');
  const oldSaveDialog=dialog.showSaveDialog,downloadPath=path.join(runtime,'downloads','browser-proof.txt');fs.mkdirSync(path.dirname(downloadPath),{recursive:true});
  dialog.showSaveDialog=async(_win,options)=>{assert.ok(options.defaultPath.startsWith(path.join(runtime,'downloads')));return {canceled:false,filePath:downloadPath};};
  try{
    const downloaded=new Promise(resolve=>page.session.once('will-download',(_event,item)=>item.once('done',(_event,status)=>resolve(status))));
    await page.view.webContents.executeJavaScript('document.querySelector("#download").click()',true);
    const status=await Promise.race([downloaded,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Download timeout')),10000))]);
    result.downloadSaved=status==='completed'&&fs.readFileSync(downloadPath,'utf8')==='isolated browser download evidence';
  }finally{dialog.showSaveDialog=oldSaveDialog;}
  const popupPromise=new Promise(resolve=>page.view.webContents.once('did-create-window',resolve));
  await page.view.webContents.executeJavaScript('document.querySelector("#popup").click()',true);
  const popup=await Promise.race([popupPromise,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Popup timeout')),10000))]);
  await waitFor(()=>popup.webContents.getTitle().includes('/login'));
  result.popupInside=popup.getParentWindow()===window;result.popupNoBridge=await popup.webContents.executeJavaScript('typeof window.ice==="undefined"&&typeof require==="undefined"');popup.destroy();
  fs.writeFileSync(path.join(runtime,'embedded-view.png'),(await capture(page.view.webContents)).toPNG());
  fs.writeFileSync(path.join(runtime,'browser-workspace.png'),(await capture(window.webContents)).toPNG());
  await evaluate('changeView("models")');result.hiddenOnLeave=!controller.state().visible;
  await evaluate('workspace.scrollTop=workspace.scrollHeight;changeView("browser")');await waitFor(()=>controller.state().visible);
  result.scrollResetOnEnter=await evaluate('workspace.scrollTop===0');
  const fullSize=window.getSize();window.setSize(1040,720);
  result.minimumBrowserLayout=await awaitAligned();
  result.minimumWindowActualSize=window.getSize();
  // Win32 converts client metrics and the non-client frame separately at 150%.
  // Assert the configured minimum and a bounded three-DIP outer-frame rounding.
  result.minimumWindowConstraint=window.getMinimumSize();
  result.minimumWindowSize=result.minimumWindowConstraint[0]===1040&&result.minimumWindowConstraint[1]===720&&result.minimumWindowActualSize[0]>=1040&&result.minimumWindowActualSize[0]<=1043&&result.minimumWindowActualSize[1]>=720&&result.minimumWindowActualSize[1]<=723;
  result.minimumHostFullyVisible=result.minimumBrowserLayout.hostFullyVisible;
  result.compactBounds=result.minimumBrowserLayout.aligned&&result.minimumBrowserLayout.inside;
  result.compactNoOverflow=await evaluate('document.body.scrollWidth===innerWidth');
  await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');
  const expandedMinimum=await awaitAligned();
  result.minimumExpandedViewVisible=expandedMinimum.hostFullyVisible&&expandedMinimum.aligned&&expandedMinimum.inside;
  assert.equal(result.minimumExpandedViewVisible,true,'expanded webpage fits minimum window');
  fs.writeFileSync(path.join(runtime,'browser-expanded-compact.png'),(await capture(window.webContents)).toPNG());
  await evaluate('document.querySelector("[data-browser-action=expand-view]").click()');await awaitAligned();
  fs.writeFileSync(path.join(runtime,'browser-compact.png'),(await capture(window.webContents)).toPNG());
  window.setSize(...fullSize);await awaitAligned();
  const next=await request('accounts.save',{account:{...originalAccount,id:undefined,name:'浏览器验收B',preset:'general',article_root:'',library_root:''}});
  controller.reset();await evaluate('useBootstrap('+JSON.stringify(next)+',"browser")');await waitFor(()=>controller.testPage());
  result.accountCookiesIsolated=(await controller.testPage().session.cookies.get({name:'acceptance-session'})).length===0;
  await request('accounts.switch',{account_id:originalAccount.id});controller.reset();
  const restored=await request('bootstrap');await evaluate('useBootstrap('+JSON.stringify(restored)+',"browser")');await waitFor(()=>controller.testPage());
  result.persistentCookieAfterViewRecreate=(await controller.testPage().session.cookies.get({name:'acceptance-session'}))[0]?.value==='tapnow-A';
  fs.writeFileSync(path.join(runtime,'browser-preassert.json'),JSON.stringify(result,null,2));
  for(const key of ['tapnowRouteInside','sessionOnDataDrive','remoteHasNoBridge','sidebarCollapsedBounds','sidebarExpandedBounds','remoteShortcutOpensLocalPalette','browserRestoredAfterPalette','preferencesCoverRemoteView','browserRestoredAfterPreferences','siteCookiesIsolated','cookieRetainedAfterNavigation','back','forward','downloadSaved','invalidURLRejected','popupInside','popupNoBridge','hiddenOnLeave','scrollResetOnEnter','minimumWindowSize','minimumHostFullyVisible','compactBounds','compactNoOverflow','accountCookiesIsolated','persistentCookieAfterViewRecreate'])assert.equal(result[key],true,key);
  assert.equal(result.isolatedPreferences.nodeIntegration,false);assert.equal(result.isolatedPreferences.sandbox,true);assert.equal(result.isolatedPreferences.preload,null);
  return result;
}
module.exports={run};
