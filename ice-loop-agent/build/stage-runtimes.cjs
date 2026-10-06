/* Copy only generated runtimes into the release and isolated test application. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function copy(source,target){
  if(fs.statSync(source).isDirectory()){fs.mkdirSync(target,{recursive:true});for(const name of fs.readdirSync(source))if(name!=='__pycache__')copy(path.join(source,name),path.join(target,name));}
  else{const data=fs.readFileSync(source);if(fs.existsSync(target)){if(fs.readFileSync(target).equals(data))return;fs.chmodSync(target,0o666);}fs.writeFileSync(target,data);}
}
for(const folder of ['release/win-unpacked','.test-tmp/independent-v1']){
  const resources=path.join(root,folder,'resources');if(!fs.existsSync(resources))throw Error('Complete Electron runtime missing: '+resources);
  for(const [source,target] of [['ice-engine','engine'],['teaching-python','teaching-python'],['engine-project','engine-project']])copy(path.join(root,'dist',source),path.join(resources,target));
  console.log('Generated resources updated: '+resources);
}
