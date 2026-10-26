const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('browserTest',{invoke:(channel,...args)=>{if(!['ice:browser-show','ice:browser-command','ice:browser-hide'].includes(channel))throw Error('test channel denied');return ipcRenderer.invoke(channel,...args);}});
