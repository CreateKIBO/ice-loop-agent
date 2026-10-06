/* Refresh only app source and the matching PE integrity entry, preserving runtimes. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {computeData}=require('../desktop/node_modules/app-builder-lib/out/asar/integrity.js');
const {NtExecutable,NtExecutableResource,Resource}=require('../desktop/node_modules/resedit');
(async()=>{
  const asar=await import('../desktop/node_modules/@electron/asar/lib/asar.js');
  const source=path.join(root,'.test-tmp','ui-source-'+Date.now());fs.mkdirSync(source,{recursive:true});
  const config=JSON.parse(fs.readFileSync(path.join(root,'desktop/electron-builder.json'),'utf8'));
  for(const name of config.files.filter(name=>!name.includes('*'))){
    const destination=path.join(source,name);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(path.join(root,'desktop',name),destination);
  }
  function copy(from,to){if(fs.statSync(from).isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copy(path.join(from,name),path.join(to,name));}else{if(fs.existsSync(to))fs.chmodSync(to,0o666);fs.writeFileSync(to,fs.readFileSync(from));}}
  copy(path.join(root,'desktop/renderer'),path.join(source,'renderer'));
  const filenames=[],metadata={};
  function enumerate(folder){for(const name of fs.readdirSync(folder)){const file=path.join(folder,name),stat=fs.statSync(file);filenames.push(file);metadata[file]={type:stat.isDirectory()?'directory':'file',stat};if(stat.isDirectory())enumerate(file);}}
  enumerate(source);console.log('Curated app files: '+filenames.length);
  const archive=path.join(root,'.test-tmp/app-final.asar');await asar.createPackageFromFiles(source,archive,filenames,metadata);console.log('ASAR written');
  for(const folder of ['release/win-unpacked']){
    const target=path.join(root,folder),resources=path.join(target,'resources');
    if(!fs.existsSync(path.join(resources,'engine/ice-engine.exe')))throw Error('Complete runtime must exist: '+target);
    const template=fs.readFileSync(path.join(target,'ICE Loop Studio.exe'));
    fs.copyFileSync(archive,path.join(resources,'app.asar'));
    const integrity=await computeData({resourcesPath:resources,resourcesRelativePath:'resources',resourcesDestinationPath:resources,extraResourceMatchers:[]});
    const executable=NtExecutable.from(template),resource=NtExecutableResource.from(executable);
    const languages=Resource.VersionInfo.fromEntries(resource.entries)[0].getAllLanguagesForStringValues();
    if(languages.length!==1)throw Error('Unexpected PE version languages');
    const previous=resource.entries.find(entry=>entry.type==='INTEGRITY'&&entry.id==='ELECTRONASAR');
    resource.entries=resource.entries.filter(entry=>!(entry.type==='INTEGRITY'&&entry.id==='ELECTRONASAR'));
    const list=Object.entries(integrity).map(([file,{algorithm,hash}])=>({file:path.win32.normalize(file),alg:algorithm,value:hash}));
    const replacement=Buffer.from(JSON.stringify(list)),previousBin=previous&&Buffer.from(previous.bin);
    const offset=previousBin?template.indexOf(previousBin):-1;
    if(previousBin&&previousBin.length===replacement.length&&offset>=0&&template.indexOf(previousBin,offset+1)<0){
      // Same resource length: preserve PE layout/version and update only integrity bytes.
      const fd=fs.openSync(path.join(target,'ICE Loop Studio.exe'),'r+');
      try{if(fs.writeSync(fd,replacement,0,replacement.length,offset)!==replacement.length)throw Error('Incomplete PE integrity update');}finally{fs.closeSync(fd);}
    }else{
      resource.entries.push({type:'INTEGRITY',id:'ELECTRONASAR',bin:replacement,lang:languages[0].lang,codepage:languages[0].codepage});
      resource.outputResource(executable);fs.writeFileSync(path.join(target,'ICE Loop Studio.exe'),Buffer.from(executable.generate()));
    }
    console.log('UI and PE integrity refreshed: '+target);
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
