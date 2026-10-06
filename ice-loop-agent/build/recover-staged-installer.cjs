'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),scratch='E:/Codex-ICE-Build-1.5.2-01a0f697';
const name='ICE-Loop-Studio-1.5.2-Setup.exe',source=path.join(scratch,name),target=path.join(root,'release',name);
async function hash(file,algorithm='sha256') { const h=crypto.createHash(algorithm);for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest(algorithm==='sha512'?'base64':'hex'); }
(async()=>{
  const marker=JSON.parse(fs.readFileSync(path.join(scratch,'BUILD-STAGING.json'),'utf8'));
  if(marker.project!==root||marker.version!=='1.5.2'||marker.temporary!==true)throw Error('Unowned staging directory');
  if(require('../desktop/package.json').version!=='1.5.2')throw Error('Version changed');
  const before=fs.statSync(source);
  const check=spawnSync(path.join(root,'desktop/node_modules/7zip-bin/win/x64/7za.exe'),['t',source],{windowsHide:true,encoding:'utf8',timeout:300000});
  fs.writeFileSync(path.join(root,'docs/v1.5.2-staged-installer-check.log'),check.stdout+'\n'+check.stderr);
  if(check.status!==0||!check.stdout.includes('Everything is Ok'))throw Error('Staged installer archive validation failed');
  const digest=await hash(source),stable=fs.statSync(source);
  if(stable.size!==before.size||stable.mtimeMs!==before.mtimeMs)throw Error('Staging file is still changing');
  const existingCopyMatches=fs.existsSync(target)&&fs.statSync(target).size===stable.size&&await hash(target)===digest;
  if(!existingCopyMatches)await pipeline(fs.createReadStream(source,{highWaterMark:1024*1024}),fs.createWriteStream(target,{highWaterMark:1024*1024}));
  if(fs.statSync(target).size!==stable.size||await hash(target)!==digest)throw Error('Installer copy mismatch');
  const result={version:'1.5.2',method:'normal NSIS template on NTFS, reused audited ZIP; completed staging installer recovered after user-authorized G disk cleanup',
    source_zip_sha512:await hash(path.join(root,'release/ICE-Loop-Studio-1.5.2-x64.zip'),'sha512'),installer_bytes:stable.size,installer_sha256:digest,
    staging_root:scratch,staging_archive_verified:true,existing_copy_reused:existingCopyMatches,existing_installation_touched:false};
  fs.writeFileSync(path.join(root,'docs/v1.5.2-ntfs-installer.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
