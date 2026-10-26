"use strict";
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
// A short-lived, least-capability window. It cannot issue normal app RPCs.
class StartupProgress {
  constructor({BrowserWindow,ipcMain,runtime,preload,onCancel,now=Date.now}) {
    Object.assign(this,{BrowserWindow,ipcMain,runtime,preload,onCancel,now});
    this.session=randomUUID().replaceAll('-','');this.view=null;this.finished=false;this.cancelled=false;
    this.state={revision:0,phase:'connecting',cancelable:true};this.started=now();
    this.control=path.join(runtime,'startup-control');
    if(fs.existsSync(this.control)&&fs.lstatSync(this.control).isSymbolicLink())throw Error('启动控制目录不能是目录联接');
    fs.mkdirSync(this.control,{recursive:true});this.cancelFile=path.join(this.control,'cancel-'+this.session);
    this.handlers=['ice:startup-state','ice:startup-cancel'];
    ipcMain.handle(this.handlers[0],event=>{this.assertSender(event);return this.state;});
    ipcMain.handle(this.handlers[1],event=>{this.assertSender(event);return this.cancel();});
    this.timer=setTimeout(()=>void this.show().catch(error=>console.warn('启动等待页载入失败：',error.message)),450);
  }
  assertSender(event) {
    if(!this.view||event.sender!==this.view.webContents||event.senderFrame?.url!=='ice://app/ui/index.html?startup=1')throw Error('无效的启动窗口请求');
  }
  async show() {
    if(this.finished)return;
    const view=this.view=new this.BrowserWindow({width:580,height:420,minWidth:460,minHeight:380,show:false,
      title:'ICE Loop · 正在准备工作区',autoHideMenuBar:true,resizable:true,
      webPreferences:{preload:this.preload,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    view.on('close',event=>{if(!this.finished){event.preventDefault();this.cancel();}});
    view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    view.webContents.on('will-navigate',(event,url)=>{if((event.url||url)!=='ice://app/ui/index.html?startup=1')event.preventDefault();});
    await view.loadURL('ice://app/ui/index.html?startup=1');
    if(!this.finished&&!view.isDestroyed())view.show();
  }
  accept(value) {
    const phases=new Set(['snapshot_database','scan_files','copy_files','verify_archive','verify_files','verify_database','save_recovery_point','upgrade_database','initialize_workspace','ready']);
    if(this.finished||value?.kind!=='startup.progress'||!phases.has(value.phase))return false;
    if(this.cancelled)return true;
    const next={revision:this.state.revision+1,phase:value.phase,cancelable:value.cancelable===true&&!this.cancelled};
    for(const key of ['files_done','bytes_done','pages_done','pages_total'])if(Number.isFinite(value[key])&&value[key]>=0)next[key]=value[key];
    this.state=next;if(this.view&&!this.view.isDestroyed())this.view.webContents.send('ice:startup-progress',next);
    return true;
  }
  cancel() {
    if(this.finished||this.cancelled||!this.state.cancelable)return {cancelled:this.cancelled};
    fs.writeFileSync(this.cancelFile,'cancel',{flag:'wx'});this.cancelled=true;
    this.state={revision:this.state.revision+1,phase:'cancelling',cancelable:false};
    if(this.view&&!this.view.isDestroyed())this.view.webContents.send('ice:startup-progress',this.state);
    this.onCancel();return {cancelled:true};
  }
  end() {
    if(this.finished)return;this.finished=true;clearTimeout(this.timer);
    for(const channel of this.handlers)this.ipcMain.removeHandler(channel);
    if(this.view&&!this.view.isDestroyed())this.view.destroy();this.view=null;
    try{fs.unlinkSync(this.cancelFile);}catch(error){if(error.code!=='ENOENT')console.warn('启动取消标记保留，未影响资料');}
  }
}
module.exports={StartupProgress};
