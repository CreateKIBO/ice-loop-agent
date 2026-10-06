'use strict';
const {BrowserWindow,ipcMain,dialog,clipboard,ClipboardItem}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {randomUUID,createHash}=require('node:crypto');const dns=require('node:dns').promises;
const {copyRichVerified}=require('./clipboard.cjs');
function publicAddress(ip){
  if(ip.includes(':'))return /^[23][0-9a-f]{0,3}:/i.test(ip)&&!/^2001:(?:db8|0|2|10|20):|^2001::|^2002:/i.test(ip);
  const parts=ip.split('.').map(Number),[a,b,c]=parts;
  return parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&a>0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
async function checkPublic(url){const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('网页截图仅接受公开HTTPS地址');const rows=await dns.lookup(parsed.hostname,{all:true});if(!rows.length||rows.some(r=>!publicAddress(r.address)))throw Error('网页截图不访问本地或内网地址');return parsed;}
function installTools({window,assertSender,request,runtime}){
  ipcMain.handle('ice:read-rules',async event=>{assertSender(event);const selected=await dialog.showOpenDialog(window(),{title:'读取只读规则参考文档',properties:['openFile'],filters:[{name:'规则文档',extensions:['md','txt','json']}]});if(selected.canceled)return null;const file=selected.filePaths[0],stat=fs.statSync(file);if(stat.size>800000)throw Error('规则文档超过800KB');const raw=fs.readFileSync(file),text=raw.toString('utf8').replace(/^\uFEFF/,'');let rules=null;if(file.toLowerCase().endsWith('.json')){const data=JSON.parse(text);rules=data.rules||data;}return {text,name:path.basename(file),rules,source_path:file,modified_at:stat.mtime.toISOString(),file_sha256:createHash('sha256').update(raw).digest('hex')};});
  ipcMain.handle('ice:copy-article',async(event,jobId)=>{assertSender(event);const data=await request('articles.clipboard',{job_id:jobId});return copyRichVerified(clipboard,payload=>new ClipboardItem(payload),data);});
  async function capture(url,selector,local=false){
    const target=local?null:await checkPublic(url);
    if(typeof selector!=='string'||selector.length>200)throw Error('选择器最长200字');
    const captureWindow=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,webSecurity:true,backgroundThrottling:false,partition:'capture-'+randomUUID()}});
    const ses=captureWindow.webContents.session;
    ses.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
    ses.webRequest.onBeforeRequest((details,callback)=>{
      if(local){callback({cancel:!details.url.startsWith('file:')});return;}
      checkPublic(details.url).then(parsed=>callback({cancel:parsed.origin!==target.origin})).catch(()=>callback({cancel:true}));
    });
    captureWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('网页加载超时，请手动截图导入')),30000);});
    try{
      const operation=(async()=>{
      await (local?captureWindow.loadFile(url):captureWindow.loadURL(target.href));
      // Trusted measurements run in a separate world; exported HTML deliberately
      // disallows page scripts and must not need unsafe-eval in its CSP.
      const evaluate=code=>captureWindow.webContents.executeJavaScriptInIsolatedWorld(1001,[{code}]);
      const measured=await evaluate('Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight))+2');
      const height=Math.max(900,Math.min(20000,measured));captureWindow.setSize(1200,height);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      let rect=null;if(selector)rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('未找到页面元素');const r=e.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()`);
      if(rect&&(rect.width<10||rect.height<10||rect.x+rect.width>1200||rect.y+rect.height>height))throw Error('元素超出截图区域（最长20000像素），请选择较小的页面元素或手动分段截图');
      const image=await captureWindow.webContents.capturePage(rect||undefined);if(image.isEmpty())throw Error('页面截图为空');
      const root=path.join(runtime,'captures','web');fs.mkdirSync(root,{recursive:true});const file=path.join(root,randomUUID()+'.png');fs.writeFileSync(file,image.toPNG());
      return request('capture.web_finish',{file_path:file,url:local?'exported_article_preview':target.href,selector});
      })();
      return await Promise.race([operation,timeout]);
    }finally{clearTimeout(timer);captureWindow.destroy();}
  }
  ipcMain.handle('ice:capture-web',async(event,url,selector='')=>{assertSender(event);return capture(url,selector);});
  ipcMain.handle('ice:capture-article',async(event,jobId)=>{assertSender(event);const data=await request('jobs.get',{job_id:jobId});if(!data.export.folder)throw Error('请先导出文章');const file=path.join(data.export.folder,'04-阅读与排版预览.html'),manifest=JSON.parse(fs.readFileSync(path.join(data.export.folder,'.ice-export-manifest.json'),'utf8'));if(require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==manifest.files['04-阅读与排版预览.html'])throw Error('预览已变化，请重新导出');return capture(file,'main',true);});
  return {capture};
}
module.exports={installTools,publicAddress,checkPublic};
