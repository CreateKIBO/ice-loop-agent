// Immutable uninstall allowlist, embedded in NSIS rather than trusted from user data.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=file=>new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),stream=fs.createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));});
async function createInstallManifest(appOutDir,helper){
 const files=[];async function scan(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Linked install payload: '+full);if(entry.isDirectory())await scan(full);else if(entry.isFile())files.push({path:path.relative(appOutDir,full).split(path.sep).join('/'),bytes:fs.statSync(full).size,sha256:await digest(full)});else throw Error('Unsupported install entry: '+full);}}
 await scan(appOutDir);
 if(helper&&!files.some(row=>row.path==='resources/elevate.exe'))files.push({path:'resources/elevate.exe',bytes:fs.statSync(helper).size,sha256:await digest(helper),optional:true});
 files.sort((a,b)=>a.path.localeCompare(b.path));return {schema:1,files};
}
async function afterPack(context){
 let helper;
 // ZIP-only builds have no NSIS target to initialize its lazy options promise.
 if(context.targets?.some(target=>['nsis','nsis-web'].includes(target.name))){
  require('../desktop/node_modules/electron-builder');
  const {NSIS_PATH}=require('../desktop/node_modules/app-builder-lib/out/targets/nsis/nsisUtil.js');
  helper=path.join(await NSIS_PATH(),'elevate.exe');
 }
 const manifest=await createInstallManifest(context.appOutDir,helper);
 fs.mkdirSync(context.outDir,{recursive:true});fs.writeFileSync(path.join(context.outDir,'install-files.json'),JSON.stringify(manifest,null,2));
}
module.exports=afterPack;module.exports.createInstallManifest=createInstallManifest;
