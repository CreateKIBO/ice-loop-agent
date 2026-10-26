"use strict";
// contextBridge objects are frozen. Inject at Electron's clipboard adapter, not window.ice.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function scriptedClipboard(repo,fixture){
 const root=path.resolve(fixture.root);
 if(!root.startsWith(path.join(repo,'.test-tmp')+path.sep)||!fs.existsSync(path.join(root,'.test-owner.json')))throw Error('Owned clipboard fixture required');
 const id=crypto.randomUUID(),control=path.join(root,'copy-control-'+id+'.json'),results=path.join(root,'copy-results-'+id+'.jsonl'),entry=path.join(root,'copy-entry-'+id+'.cjs');
 fs.writeFileSync(control,'{}');
 fs.writeFileSync(entry,`const fs=require('node:fs'),crypto=require('node:crypto');const {clipboard,ipcMain}=require('electron');
 let text='',writes=0,sequence=0;clipboard.writeText=value=>{text=String(value);writes++};
 clipboard.readText=()=>JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).deny?'':text;
 const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(...args)=>{
 const result=await fn(...args);if(channel==='ice:copy-text')fs.appendFileSync(${JSON.stringify(results)},JSON.stringify({id:++sequence,ok:result.ok,writes,length:args[1].length,sha256:crypto.createHash('sha256').update(args[1]).digest('hex')})+'\\n');return result;});
 require(${JSON.stringify(fixture.entry)});`);
 return {entry,deny(value){fs.writeFileSync(control,JSON.stringify({deny:value}));},rows(){return fs.existsSync(results)?fs.readFileSync(results,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];},results};
}
module.exports={scriptedClipboard};
