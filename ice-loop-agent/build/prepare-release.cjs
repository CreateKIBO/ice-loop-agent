/* Curated release resources: never copy workspace databases, keys, sessions or user articles. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const distArg=process.argv.indexOf('--dist-root');
const dist=distArg>=0?path.resolve(process.argv[distArg+1]||''):path.join(root,'dist');
if(distArg>=0){
  const candidate=path.dirname(dist),boundary=path.join(root,'.test-tmp/candidates')+path.sep;
  if(!candidate.startsWith(boundary)||path.basename(dist)!=='dist'||!fs.existsSync(path.join(candidate,'CANDIDATE.json')))throw Error('Unowned candidate resource destination');
}

const pythonRoot=path.join(root,'.tools','python');
const pythonHome=fs.readdirSync(pythonRoot).map(p=>path.join(pythonRoot,p)).find(p=>fs.existsSync(path.join(p,'python.exe')));
if(!pythonHome)throw Error('Build Python runtime missing');
fs.mkdirSync(dist,{recursive:true});
const reject=new Set(['site-packages','__pycache__','test','tests','idlelib','ensurepip']);
const target=path.join(dist,'teaching-python');fs.mkdirSync(target,{recursive:true});
function copy(source,destination){
  const info=fs.statSync(source);
  if(info.isDirectory()){
    fs.mkdirSync(destination,{recursive:true});
    for(const name of fs.readdirSync(source))if(!reject.has(name))copy(path.join(source,name),path.join(destination,name));
  }else{
    const data=fs.readFileSync(source);
    if(fs.existsSync(destination)){
      if(fs.readFileSync(destination).equals(data))return;
      fs.chmodSync(destination,0o666);
    }
    fs.writeFileSync(destination,data);
  }
}
for(const name of ['python.exe','python312.dll','python3.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt','Lib','DLLs']){
  const source=path.join(pythonHome,name);if(fs.existsSync(source))copy(source,path.join(target,name));
}
const project=path.join(dist,'engine-project');fs.mkdirSync(project,{recursive:true});
copy(path.join(root,'profiles'),path.join(project,'profiles'));
fs.writeFileSync(path.join(project,'BUILD.json'),JSON.stringify({version:require('../desktop/package.json').version,built_at:new Date().toISOString(),teaching_python:'3.12.13',user_data_included:false},null,2));
console.log('Release resources prepared: '+dist);
