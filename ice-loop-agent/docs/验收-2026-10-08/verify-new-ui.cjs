const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const repo=path.resolve(__dirname,'../..');
(async()=>{
 const asar=await import(pathToFileURL(path.join(repo,'desktop/node_modules/@electron/asar/lib/asar.js')).href);
 const archive=path.join(repo,'release/win-unpacked/resources/app.asar');
 const base=path.join(repo,'desktop/ui/dist');
 const rows=[];
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else{
  const relative=path.relative(base,file).replaceAll('\\','/');
  const source=fs.readFileSync(file),packaged=asar.extractFile(archive,path.normalize('ui/dist/'+relative));
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  rows.push({file:relative,bytes:source.length,match:hash(source)===hash(packaged),sha256:hash(source)});
 }}}
 walk(base);
 const result={files:rows,all_match:rows.every(r=>r.match)};
 fs.writeFileSync(path.join(repo,'docs/验收-2026-10-08/new-ui-asar-audit.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({files:rows.length,all_match:result.all_match}));
})().catch(e=>{console.error(e);process.exitCode=1;});

