/* Compile the normal project installer on NTFS using the audited complete ZIP. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const root=path.resolve(__dirname,'..');
const manifest=require('../desktop/package.json');
const scratch=path.resolve('E:/Codex-ICE-Build-1.5.2-01a0f697');
const config=JSON.parse(fs.readFileSync(path.join(root,'desktop/electron-builder.json'),'utf8'));
const hash=async(file,algorithm='sha256')=>{const value=crypto.createHash(algorithm);for await(const chunk of fs.createReadStream(file))value.update(chunk);return value.digest(algorithm==='sha512'?'base64':'hex');};
async function copy(source,target){await pipeline(fs.createReadStream(source,{highWaterMark:1024*1024}),fs.createWriteStream(target,{highWaterMark:1024*1024}));if(fs.statSync(source).size!==fs.statSync(target).size||await hash(source)!==await hash(target))throw Error('Staging copy differs: '+target);}
(async()=>{
  if(manifest.version!=='1.5.2'||!config.nsis.useZip||config.nsis.differentialPackage!==false)throw Error('Unexpected installer contract');
  if(fs.existsSync(scratch)){
    const marker=JSON.parse(fs.readFileSync(path.join(scratch,'BUILD-STAGING.json'),'utf8'));
    if(marker.project!==root||marker.version!==manifest.version||marker.temporary!==true)throw Error('Unowned staging path');
  }else fs.mkdirSync(scratch);
  fs.mkdirSync(path.join(scratch,'temp'),{recursive:true});
  fs.writeFileSync(path.join(scratch,'BUILD-STAGING.json'),JSON.stringify({project:root,version:manifest.version,temporary:true}));
  const input=path.join(scratch,'input-payload.zip');
  await copy(path.join(root,'release/ICE-Loop-Studio-1.5.2-x64.zip'),input);
  const payload={path:input,size:fs.statSync(input).size,sha512:await hash(input,'sha512')};
  // Version-pinned adapter: replace only redundant app compression, not NSIS logic.
  // The archive is a byte-checked copy; helper cleanup may delete this copy safely.
  const {build,Platform,Arch}=require('../desktop/node_modules/electron-builder');
  const {NsisTarget}=require('../desktop/node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
  NsisTarget.prototype.buildAppPackage=async function(appOutDir,arch){
    if(this.name!=='nsis'||arch!==1||path.resolve(appOutDir)!==path.join(root,'release/win-unpacked'))throw Error('Unexpected package target');
    return payload;
  };
  process.env.TEMP=path.join(scratch,'temp');process.env.TMP=process.env.TEMP;
  await build({projectDir:path.join(root,'desktop'),prepackaged:path.join(root,'release/win-unpacked'),
    targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),config:{...config,directories:{...config.directories,output:scratch}}});
  const name='ICE-Loop-Studio-1.5.2-Setup.exe';
  await copy(path.join(scratch,name),path.join(root,'release',name));
  const result={version:manifest.version,method:'normal NSIS template on NTFS, reused audited ZIP',
    source_zip_sha512:payload.sha512,installer_bytes:fs.statSync(path.join(root,'release',name)).size,
    installer_sha256:await hash(path.join(root,'release',name)),staging_root:scratch,
    existing_installation_touched:false};
  fs.writeFileSync(path.join(root,'docs/v1.5.2-ntfs-installer.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
