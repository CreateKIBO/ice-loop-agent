/* Bounded fallback for npm's stalled tar extraction; pinned packages only. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),target=path.join(root,'.test-tmp/component-tarballs');fs.mkdirSync(target,{recursive:true});
const packages=[['@shoelace-style/shoelace','2.20.1'],['lucide','0.468.0'],['lit-html','3.3.3'],['@lit/reactive-element','2.1.2'],['lit','3.3.3'],['@esbuild/win32-x64','0.25.12']];
function download(url){const result=spawnSync('curl.exe',['-4','--fail','--silent','--show-error','--location','--max-time','30',url],{windowsHide:true,maxBuffer:32*1024*1024});if(result.status!==0)throw Error(result.stderr.toString().slice(0,300));return result.stdout;}
(async()=>{
 const records=[];
 for(const [name,version] of packages){
  const base='https://registry.npmjs.org/';
  const metadata=JSON.parse(download(base+name.replace('/','%2f')+'/'+version).toString('utf8'));
  const tarURL=base+name+'/-/'+name.split('/').at(-1)+'-'+version+'.tgz';
  const data=download(tarURL);
  const integrity='sha512-'+crypto.createHash('sha512').update(data).digest('base64');
  if(metadata.dist.integrity!==integrity)throw Error('Pinned package integrity mismatch: '+name);
  const file=path.join(target,name.replaceAll('/','-').replace('@','')+'.tgz');fs.writeFileSync(file,data);
  records.push({name,version,file,integrity});console.log(name,version,data.length,'verified');
 }
 fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(records,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
