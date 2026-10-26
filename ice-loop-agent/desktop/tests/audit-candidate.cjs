const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),root=path.resolve(process.argv[2]||'');
assert.ok(root.startsWith(path.join(repo,'.test-tmp/candidates')+path.sep),'candidate must belong to this workspace');
const marker=JSON.parse(fs.readFileSync(path.join(root,'CANDIDATE.json'),'utf8'));assert.equal(marker.project,repo);assert.equal(marker.state,'built');assert.equal(marker.source_changes.length,0);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const asar=await import('../node_modules/@electron/asar/lib/asar.js');const file=path.join(root,'release/win-unpacked/resources/app.asar');
const names=asar.listPackage(file).map(name=>name.replaceAll('\\','/').replace(/^\//,''));
const expected=[];for(const name of fs.readdirSync(path.join(repo,'desktop'))){if(name.endsWith('.cjs')&&JSON.parse(fs.readFileSync(path.join(repo,'desktop/electron-builder.json'))).files.includes(name))expected.push(name);}
function tree(folder,prefix){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,entry.name),name=prefix+'/'+entry.name;if(entry.isDirectory())tree(full,name);else expected.push(name);}}
tree(path.join(repo,'desktop/renderer'),'renderer');tree(path.join(repo,'desktop/ui/dist'),'ui/dist');expected.push('tests/writing-ux-ui.cjs','tests/execution-viewer-ui.cjs');
for(const name of expected){assert.ok(names.includes(name),'missing ASAR entry '+name);assert.equal(hash(asar.extractFile(file,path.normalize(name))),hash(fs.readFileSync(path.join(repo,'desktop',name))),'stale ASAR '+name);}
const packedPackage=JSON.parse(asar.extractFile(file,'package.json')),sourcePackage=JSON.parse(fs.readFileSync(path.join(repo,'desktop/package.json')));
for(const key of ['name','version','main','type','dependencies','exports'])assert.deepEqual(packedPackage[key],sourcePackage[key],'runtime package field '+key);
assert.equal(packedPackage.version,marker.version);
assert.ok(expected.includes('workbench-methods.cjs')&&expected.includes('ui-mode.cjs')&&expected.some(name=>name.startsWith('ui/dist/assets/')));
for(const name of names)assert.ok(!/(^|\/)(app\.db|settings\.json|credentials\.json|secrets\.json|Cookies|Local State|\.env)$/.test(name),'private data in ASAR');
const result={state:'passed',candidate:root,version:marker.version,matched_files:expected.length,asar_sha256:hash(fs.readFileSync(file)),ui_dist_checked:true,workbench_allowlist_checked:true};fs.writeFileSync(path.join(root,'asar-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
