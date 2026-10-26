/* Remote sites run in isolated Chromium views; only the local workbench owns IPC. */
const {WebContentsView, BrowserWindow, session, ipcMain} = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const SITES = Object.freeze({tapnow:{name:'TapNow',url:'https://app.tapnow.media/home'},wechat:{name:'微信公众号',url:'https://mp.weixin.qq.com/'}});
function siteFor(id){if(!Object.hasOwn(SITES,id))throw Error('请选择 TapNow 或微信公众号');return SITES[id];}
function allowedURL(raw,blank=false){
  if(blank&&raw==='about:blank')return true;
  try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&raw.length<=4096;}catch{return false;}
}
function partition(account,site){siteFor(site);return 'persist:publication-web-'+crypto.createHash('sha256').update(account+'\0'+site).digest('hex').slice(0,24);}
function bounds(raw,size){
  if(!raw||!['x','y','width','height'].every(key=>Number.isFinite(raw[key])))throw Error('网页区域尺寸无效');
  const x=Math.max(66,Math.round(raw.x)),y=Math.max(130,Math.round(raw.y));
  if(x>=size[0]-100||y>=size[1]-80)throw Error('网页区域超出窗口');
  return {x,y,width:Math.max(1,Math.min(Math.round(raw.width),size[0]-x)),height:Math.max(1,Math.min(Math.round(raw.height),size[1]-y))};
}
function installBrowser({window:owner,assertSender,request,runtime}){
  let active=null,account=null,layout=null,visible=false,epoch=0;
  const pages=new Map(),popups=new Set(),configured=new Map(),downloads=new Set();
  function state(page=active){
    if(!page||page.view.webContents.isDestroyed())return {site:null,visible:false,openCount:pages.size,popupCount:popups.size};
    const wc=page.view.webContents;
    return {site:page.site,account_id:page.account,openCount:pages.size,popupCount:popups.size,url:wc.getURL()||siteFor(page.site).url,title:wc.getTitle(),loading:wc.isLoading(),
      canBack:wc.navigationHistory.canGoBack(),canForward:wc.navigationHistory.canGoForward(),error:page.error||'',visible:visible&&page===active};
  }
  function emit(extra={}){const win=owner();if(win&&!win.isDestroyed())win.webContents.send('ice:browser-state',{...state(),...extra});}
  function detach(){const win=owner();if(active&&win&&!win.isDestroyed()){try{win.contentView.removeChildView(active.view);}catch{}}visible=false;}
  function hide(){epoch++;detach();emit();return {ok:true};}
  function reset(){hide();cancelDownloads();for(const [ses,handler] of configured)ses.removeListener('will-download',handler);configured.clear();for(const page of pages.values())if(!page.view.webContents.isDestroyed())page.view.webContents.close();pages.clear();for(const popup of popups)if(!popup.isDestroyed())popup.destroy();popups.clear();active=null;account=null;}
  function cancelDownloads(page=null){
    for(const transfer of [...downloads])if(!page||transfer.page===page)transfer.cancel();
  }
  function releaseSession(ses){
    if([...pages.values()].some(page=>page.session===ses))return;
    const handler=configured.get(ses);
    if(handler){ses.removeListener('will-download',handler);configured.delete(ses);}
  }
  function configureSession(ses){
    if(configured.has(ses))return;
    ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    ses.setPermissionCheckHandler(()=>false);
    const onDownload=(_event,item,wc)=>{
      const page=[...pages.values()].find(page=>page.view.webContents===wc||page.session===wc?.session);
      if(!page){item.cancel();return;}
      if(downloads.size>=4){item.cancel();if(account===page.account)emit({download:'已有 4 个下载正在处理，请完成或取消后再试',download_status:'interrupted'});return;}
      // Source identity belongs to the download, never to a later UI selection.
      const sourceAccount=page.account;
      const notify=extra=>{if(account===sourceAccount&&pages.get(page.site)===page)emit(extra);};
      let finished=false;
      const transfer={page,cancel(){if(finished)return;finished=true;downloads.delete(transfer);item.removeListener('done',onDone);try{item.cancel();}catch{}}};
      const onDone=(_event,result)=>{
        if(finished)return;finished=true;downloads.delete(transfer);
        const savePath=result==='completed'?item.getSavePath():null;
        if(result!=='completed'||!savePath){notify({download:'下载未完成',download_status:'interrupted'});return;}
        // A completed user file is preserved even if staging fails or the UI switches.
        request('downloads.stage',{account_id:sourceAccount,file_path:savePath,origin_url:String(item.getURL()||'').slice(0,300)})
          .then(staged=>notify({download:staged.deduped?'该图片此前已下载过，沿用原归档记录':'下载完成，已进入待归档，请在工作台选择图位',
            download_status:'staged',download_id:staged.download_id,download_file:savePath}))
          .catch(error=>notify({download:'下载已保存，但归档失败：'+error.message,download_status:'stage_failed',download_file:savePath}));
      };
      downloads.add(transfer);item.once('done',onDone);
      try{
        const folder=path.join(runtime,'downloads',crypto.createHash('sha256').update(sourceAccount).digest('hex').slice(0,16),page.site);
        fs.mkdirSync(folder,{recursive:true});
        const safe=path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,160)||'download';
        // Electron only permits save-path/options changes synchronously inside
        // will-download. Chromium owns the dialog and getSavePath is authoritative.
        item.setSaveDialogOptions({title:'保存 '+siteFor(page.site).name+' 下载文件',defaultPath:path.join(folder,safe)});
      }catch{transfer.cancel();notify({download:'下载未完成，请重新选择保存位置',download_status:'interrupted'});}
    };
    configured.set(ses,onDownload);ses.on('will-download',onDownload);
  }
  function secureContents(wc,page){
    wc.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown'&&(input.control||input.meta)&&!input.alt&&String(input.key).toLowerCase()==='k'){
        event.preventDefault();const win=owner();if(win&&!win.isDestroyed()){win.webContents.focus();win.webContents.send('ice:command-palette');}
      }
    });
    for(const eventName of ['will-navigate','will-redirect'])wc.on(eventName,(event,legacyURL)=>{if(!allowedURL(event.url||legacyURL,true)){event.preventDefault();page.error='该链接不能在内嵌浏览器中打开';emit();}});
    wc.setWindowOpenHandler(details=>{
      if(!allowedURL(details.url,true)||popups.size>=5)return {action:'deny'};
      return {action:'allow',overrideBrowserWindowOptions:{parent:owner(),width:1100,height:800,minWidth:700,minHeight:500,
        autoHideMenuBar:true,title:siteFor(page.site).name+' · 登录与网页',
        webPreferences:{partition:partition(page.account,page.site),nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:undefined}}};
    });
    wc.on('did-create-window',popup=>{
      popups.add(popup);popup.setMenuBarVisibility(false);secureContents(popup.webContents,page);
      popup.on('closed',()=>popups.delete(popup));
    });
  }
  async function show(params){
    const site=String(params.site||'tapnow');siteFor(site);
    const token=++epoch;
    const bootstrap=await request('bootstrap');
    if(token!==epoch)return {cancelled:true};
    const id=bootstrap.account.id;
    if(account&&account!==id){reset();epoch=token;}account=id;
    const win=owner();if(!win||win.isDestroyed())throw Error('工作台窗口已关闭');
    const rectangle=bounds(params.bounds,win.getContentSize());
    let page=pages.get(site);
    let loadHome=false;
    if(!page){
      const ses=session.fromPartition(partition(id,site));configureSession(ses);
      const view=new WebContentsView({webPreferences:{session:ses,nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:true}});
      page={site,account:id,session:ses,view,error:''};pages.set(site,page);secureContents(view.webContents,page);
      for(const eventName of ['did-start-loading','did-stop-loading','did-navigate','did-navigate-in-page','page-title-updated'])view.webContents.on(eventName,()=>{if(active===page)emit();});
      view.webContents.on('did-fail-load',(_e,code,_description,_url,main)=>{if(main&&code!==-3){page.error='网页加载失败（'+code+'），请检查网络后重试';if(active===page)emit();}});
      view.webContents.on('render-process-gone',()=>{page.error='网页进程已退出，请刷新重试';if(active===page)emit();});
      loadHome=true;
    }
    detach();active=page;layout=rectangle;visible=true;
    win.contentView.addChildView(page.view);page.view.setBounds(rectangle);
    if(loadHome)page.view.webContents.loadURL(siteFor(site).url).catch(()=>{});
    emit();return state();
  }
  ipcMain.handle('ice:browser-show',(event,params)=>{assertSender(event);return show(params||{});});
  ipcMain.handle('ice:browser-hide',event=>{assertSender(event);return hide();});
  ipcMain.handle('ice:browser-bounds',(event,raw)=>{
    assertSender(event);if(!active||!visible)return {ok:true};
    layout=bounds(raw,owner().getContentSize());active.view.setBounds(layout);return {ok:true};
  });
  ipcMain.handle('ice:browser-command',async(event,action,value)=>{
    assertSender(event);if(!active)throw Error('请先打开网页工作台');
    const target=active;
    const current=(await request('bootstrap')).account.id;
    if(active!==target)return {cancelled:true};
    if(current!==target.account){reset();throw Error('公众号已切换，请重新打开网页');}
    const wc=active.view.webContents;active.error='';
    if(action==='back'){if(wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();}
    else if(action==='forward'){if(wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();}
    else if(action==='reload')wc.reload();
    else if(action==='stop')wc.stop();
    else if(action==='close-all'){reset();emit();return state();}
    else if(action==='close'){
      const page=active;hide();cancelDownloads(page);pages.delete(page.site);releaseSession(page.session);active=null;layout=null;
      for(const popup of popups)if(!popup.isDestroyed()&&popup.webContents.session===page.session){popup.destroy();popups.delete(popup);}
      if(!wc.isDestroyed())wc.close();emit();return state();
    }
    else if(action==='home')wc.loadURL(siteFor(active.site).url).catch(()=>{});
    else if(action==='navigate'){if(!allowedURL(value))throw Error('请输入有效的 HTTPS 网页地址');wc.loadURL(value).catch(()=>{});}
    else if(action==='logout'){
      const page=active;for(const popup of popups)if(popup.webContents.session===page.session&&!popup.isDestroyed())popup.destroy();
      await page.session.clearStorageData();await page.session.clearCache();wc.loadURL(siteFor(page.site).url).catch(()=>{});
    }else throw Error('未知浏览器操作');
    emit();return state();
  });
  return {hide,reset,state,route(site){siteFor(site);owner().webContents.send('ice:browser-route',{site});return {ok:true,embedded:true,site};},
    // Used only by the main-process native acceptance runner, never exposed to remote sites.
    testPage:()=>active,resize(){if(active&&visible&&layout){try{active.view.setBounds(bounds(layout,owner().getContentSize()));}catch{detach();}}}};
}
module.exports={installBrowser,siteFor,allowedURL,partition,bounds};
