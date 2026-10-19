'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');
function load(){
 const file=path.join(__dirname,'../ui/src/components/toastHost.ts');
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};new Function('module','exports',code)(m,m.exports);return m.exports;
}
test('nested modal notifications return to the previous dialog and clear on close',()=>{
 const {toastHost,registerToastHost}=load(),first={},second={};let updates=0;
 const off=toastHost.subscribe(()=>updates++);
 assert.equal(toastHost.get(),null);const a=registerToastHost(first),b=registerToastHost(second);
 assert.equal(toastHost.get(),second);b();assert.equal(toastHost.get(),first);b();assert.equal(updates,3);
 a();assert.equal(toastHost.get(),null);off();registerToastHost({});assert.equal(updates,4);
});
test('out-of-order portal cleanup cannot detach the active notification host',()=>{
 const {toastHost,registerToastHost}=load(),first={},second={};
 const a=registerToastHost(first),b=registerToastHost(second);a();assert.equal(toastHost.get(),second);
 b();assert.equal(toastHost.get(),null);
});
