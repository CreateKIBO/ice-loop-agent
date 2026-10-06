/* Verify the actual release, including ZIP contents, rather than a cached filename. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
(async()=>{
  const asar=await import('../desktop/node_modules/@electron/asar/lib/asar.js');
  const file=path.join(root,'release/win-unpacked/resources/app.asar');
  const packagedManifest=JSON.parse(asar.extractFile(file,'package.json').toString('utf8'));
  const executionProbe='tests/execution-viewer-ui.cjs';
  if(sha(asar.extractFile(file,path.normalize(executionProbe)))!==sha(fs.readFileSync(path.join(root,'desktop',executionProbe))))throw Error('Packaged execution/viewer regression probe is stale');
  if(packagedManifest.version!==require('../desktop/package.json').version)throw Error('Packaged application version is stale');
  function rendererFiles(directory,prefix='renderer'){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?rendererFiles(path.join(directory,entry.name),prefix+'/'+entry.name):[prefix+'/'+entry.name]);}
  for(const name of ['main.cjs','automation.cjs','chat-smoke.cjs','tests/writing-ux-ui.cjs','prompt-smoke.cjs','browser-smoke.cjs','tools.cjs','clipboard.cjs','browser.cjs','preload.cjs','credential-helper.cjs',...rendererFiles(path.join(root,'desktop/renderer'))]){
    const original=path.join(root,'desktop',name);if(!fs.statSync(original).isFile())continue;
    if(sha(asar.extractFile(file,path.normalize(name)))!==sha(fs.readFileSync(original)))throw Error('Packaged source is stale: '+name);
  }
  const output={version:packagedManifest.version,asar_sha256:sha(fs.readFileSync(file)),renderer_matches_source:true,packaged_version_matches_source:true};
  fs.writeFileSync(path.join(root,'.test-tmp/release-source-check.json'),JSON.stringify(output,null,2));
  console.log(JSON.stringify(output));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
