'use strict';
function browserChromePreference(){try{return localStorage.getItem('ice-browser-chrome')!=='expanded';}catch{return true;}}
const browserUI={site:'tapnow',observer:null,frame:0,boundsFrame:0,token:0,chromeCollapsed:browserChromePreference(),expanded:false};
function applyBrowserLayout(){
  workspace.classList.toggle('browser-chrome-collapsed',browserUI.chromeCollapsed);
  workspace.classList.toggle('browser-expanded',browserUI.expanded);
  const collapse=document.querySelector('[data-browser-action="collapse-chrome"]'),expand=document.querySelector('[data-browser-action="expand-view"]');
  if(collapse){collapse.textContent=browserUI.chromeCollapsed?'展开说明':'收起说明';collapse.setAttribute('aria-expanded',String(!browserUI.chromeCollapsed));}
  if(expand){expand.textContent=browserUI.expanded?'恢复布局':'扩大网页';expand.setAttribute('aria-pressed',String(browserUI.expanded));}
  const token=browserUI.token;
  queueMicrotask(()=>{if(token===browserUI.token&&ui.view==='browser'&&!document.querySelector('dialog[open]')){const r=browserRectangle();if(r)window.ice.browserBounds(r).catch(()=>{});}});
}
function browserRectangle(){const host=document.querySelector('#browser-host');if(!host)return null;const r=host.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
function unmountBrowser(){++browserUI.token;browserUI.observer?.disconnect();browserUI.observer=null;cancelAnimationFrame(browserUI.frame);cancelAnimationFrame(browserUI.boundsFrame);workspace.classList.remove('browser-workspace','browser-chrome-collapsed','browser-expanded');browserUI.expanded=false;window.ice.browserHide().catch(()=>{});}
async function mountBrowser(){
  if(ui.view!=='browser')return;
  if(document.querySelector('dialog[open]')){await window.ice.browserHide();return;}
  const rectangle=browserRectangle();if(!rectangle)return;
  const token=++browserUI.token,site=browserUI.site;
  try{const state=await window.ice.browserShow({site,bounds:rectangle});if(token===browserUI.token&&ui.view==='browser'&&!state.cancelled)updateBrowser(state);}catch(error){if(token===browserUI.token)document.querySelector('#browser-status').textContent=error.message;}
}
function updateBrowser(state){
  if(ui.view!=='browser'||state.site!==browserUI.site||state.account_id!==activeAccount().id)return;
  const address=document.querySelector('#browser-address');if(!address)return;
  if(document.activeElement!==address)address.value=state.url||'';
  document.querySelector('[data-browser-action="back"]').disabled=!state.canBack;
  document.querySelector('[data-browser-action="forward"]').disabled=!state.canForward;
  const reload=document.querySelector('[data-browser-action="reload"]');reload.textContent=state.loading?'停止加载':'刷新';reload.dataset.loading=String(state.loading);
  document.querySelector('#browser-status').textContent=state.download||state.error||(state.loading?'正在加载网页…':'登录、生成图片和发布均由你在网页中操作。');
}
function renderBrowser(){
  workspace.classList.add('browser-workspace');
  workspace.innerHTML=pageHeading('YOUR WEB WORKSPACE','生成与发布，都在这里。','内嵌浏览器 · 当前公众号独立登录 · 文件下载后可导入配图资源箱')+
    `<section class="browser-panel"><div class="browser-tabs" role="tablist" aria-label="网页站点"><button role="tab" aria-selected="${browserUI.site==='tapnow'}" data-browser-site="tapnow" class="${browserUI.site==='tapnow'?'active':''}"><span>◇</span> TapNow 生图</button><button role="tab" aria-selected="${browserUI.site==='wechat'}" data-browser-site="wechat" class="${browserUI.site==='wechat'?'active':''}"><span>▤</span> 微信公众号后台</button><button class="button text-button small browser-session-button" data-browser-action="logout">清除当前站点登录</button></div><form id="browser-address-form" class="browser-toolbar"><button type="button" class="button secondary small" data-browser-action="back" aria-label="后退">←</button><button type="button" class="button secondary small" data-browser-action="forward" aria-label="前进">→</button><button type="button" class="button secondary small" data-browser-action="reload">刷新</button><button type="button" class="button secondary small" data-browser-action="home">站点首页</button><input id="browser-address" aria-label="网页地址" type="url" required placeholder="https://" value="${browserUI.site==='tapnow'?'https://app.tapnow.media/home':'https://mp.weixin.qq.com/'}"><button class="button secondary small" type="submit">前往</button></form><div class="browser-notice"><span class="browser-dot"></span><span id="browser-status" role="status" aria-live="polite">正在准备浏览器…</span></div><div id="browser-host" class="browser-host" aria-label="${browserUI.site==='tapnow'?'TapNow':'微信公众号后台'} 内嵌网页"></div></section><p class="browser-footnote">TapNow：粘贴提示词 → 生成 → 下载 → 导入配图。公众号：新建图文 → 排版正文 → 上传图片 → 手机预览 → 手动发布。</p>`;
  const controls=document.createElement('div');controls.className='browser-view-controls';
  controls.innerHTML='<button type="button" class="button secondary small" data-browser-action="collapse-chrome" aria-expanded="false">展开说明</button><button type="button" class="button secondary small" data-browser-action="expand-view" aria-pressed="false">扩大网页</button>';
  document.querySelector('.browser-tabs').insertBefore(controls,document.querySelector('.browser-session-button'));
  applyBrowserLayout();
  document.querySelector('#browser-address-form').addEventListener('submit',async event=>{event.preventDefault();try{updateBrowser(await window.ice.browserCommand('navigate',document.querySelector('#browser-address').value));}catch(error){toast(error.message);}});
  browserUI.observer?.disconnect();browserUI.observer=new ResizeObserver(()=>{cancelAnimationFrame(browserUI.boundsFrame);browserUI.boundsFrame=requestAnimationFrame(()=>{if(ui.view==='browser'&&!document.querySelector('dialog[open]')){const r=browserRectangle();if(r)window.ice.browserBounds(r).catch(()=>{});}});});browserUI.observer.observe(document.querySelector('#browser-host'));
  // A previous article/editor can leave this scroll container far from the top.
  // Reset before measuring the native view on a new site or workbench visit.
  workspace.scrollTop=0;
  // Opening a site is a functional action: an occluded window may stop
  // animation frames. Defer until this render finishes, without waiting for paint.
  cancelAnimationFrame(browserUI.frame);
  const openingToken=++browserUI.token;
  queueMicrotask(()=>{if(openingToken===browserUI.token&&ui.view==='browser')mountBrowser();});
}
function openBrowserSite(site){browserUI.site=site;changeView('browser');}
window.ice.onBrowserRoute(openBrowserSite);
window.ice.onBrowserState(updateBrowser);
window.addEventListener('scroll',()=>{if(ui.view==='browser'){cancelAnimationFrame(browserUI.boundsFrame);browserUI.boundsFrame=requestAnimationFrame(()=>{const r=browserRectangle();if(r&&!document.querySelector('dialog[open]'))window.ice.browserBounds(r).catch(()=>{});});}},true);
workspace.addEventListener('click',async event=>{
  const tab=event.target.closest('[data-browser-site]');if(tab){browserUI.site=tab.dataset.browserSite;renderBrowser();return;}
  const button=event.target.closest('[data-browser-action]');if(!button)return;
  let action=button.dataset.browserAction;
  if(action==='collapse-chrome'){
    browserUI.chromeCollapsed=!browserUI.chromeCollapsed;
    try{localStorage.setItem('ice-browser-chrome',browserUI.chromeCollapsed?'collapsed':'expanded');}catch{}
    applyBrowserLayout();return;
  }
  if(action==='expand-view'){browserUI.expanded=!browserUI.expanded;applyBrowserLayout();return;}
  if(action==='logout'&&!confirm('清除当前公众号在此站点的登录和缓存？其他站点及公众号不受影响。'))return;
  if(action==='reload'&&button.dataset.loading==='true')action='stop';
  button.disabled=true;try{updateBrowser(await window.ice.browserCommand(action));}catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
});
new MutationObserver(records=>{if(ui.view==='browser'&&records.some(r=>r.target.tagName==='DIALOG'))mountBrowser().catch(error=>toast(error.message));}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
