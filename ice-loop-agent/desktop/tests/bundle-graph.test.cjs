'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const parent=path.resolve(__dirname,'../../.test-tmp');fs.mkdirSync(parent,{recursive:true});
async function fixture(run){
 const root=fs.mkdtempSync(path.join(parent,'bundle-graph-'));
 try{const {inspectBundle}=await import(pathToFileURL(path.join(__dirname,'../ui/scripts/bundle-report.mjs')).href);return await run(root,inspectBundle);}
 finally{if(path.dirname(root)!==parent)throw Error('Unowned test root');fs.rmSync(root,{recursive:true,force:true});}
}
test('bundle graph counts static imports once and distinguishes lazy assets from startup payload',async()=>fixture((root,inspect)=>{
 fs.mkdirSync(path.join(root,'assets'));
 fs.writeFileSync(path.join(root,'index.html'),'<script type="module" src="./assets/main.js"></script>');
 fs.writeFileSync(path.join(root,'assets/main.js'),'import "./shared.js"; import("./later.js"); /* import("./not-real.js") */');
 fs.writeFileSync(path.join(root,'assets/shared.js'),'export const x=1;');
 fs.writeFileSync(path.join(root,'assets/later.js'),'import "./shared.js";');
 const result=inspect(root);
 assert.deepEqual(result.static_js,['assets/main.js','assets/shared.js']);
 assert.equal(result.static_js_bytes,fs.statSync(path.join(root,'assets/main.js')).size+fs.statSync(path.join(root,'assets/shared.js')).size);
 assert.deepEqual(result.missing,[]);
}));
test('bundle graph reports missing lazy JavaScript and CSS preload-map references',async()=>fixture((root,inspect)=>{
 fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'index.html'),'<script src="./assets/main.js"></script>');
 fs.writeFileSync(path.join(root,'assets/main.js'),'import("./missing.js"); const deps=["assets/missing.css"];');
 assert.deepEqual(inspect(root).missing,['assets/missing.css','assets/missing.js']);
}));
test('bundle graph rejects escaped local paths and identifies network imports',async()=>fixture((root,inspect)=>{
 fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'index.html'),'<script src="./assets/main.js"></script>');
 const file=path.join(root,'assets/main.js');fs.writeFileSync(file,'import "https://example.invalid/ui.js";');
 assert.deepEqual(inspect(root).external,['https://example.invalid/ui.js']);
 fs.writeFileSync(file,'import "../../unowned.js";');assert.throws(()=>inspect(root),/escapes bundle/);
}));
