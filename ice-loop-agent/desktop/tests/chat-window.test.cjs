'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),esbuild=require('esbuild');
function load(file){const box={module:{exports:{}},exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(__dirname,'../ui/src',file),'utf8'),{loader:'ts',format:'cjs'}).code,box);return box.module.exports;}
const {messagePosition,estimateMessage,MESSAGE_WINDOW}=load('features/chat/historyWindow.ts');
const {chatResult}=load('data/workbenchResponses.ts');
test('history navigation uses scoped identity and guards missing edges',()=>{
 const page={has_older:true,has_newer:true,oldest_id:'first',newest_id:'last'};
 assert.equal(JSON.stringify(messagePosition(page,'older')),JSON.stringify({before_message_id:'first'}));
 assert.equal(JSON.stringify(messagePosition(page,'newer')),JSON.stringify({after_message_id:'last'}));
 assert.equal(messagePosition({...page,has_older:false},'older'),null);
 assert.equal(messagePosition(undefined,'newer'),null);
 assert.equal(MESSAGE_WINDOW,40);
 assert.ok(estimateMessage('abc')>=100&&estimateMessage('a'.repeat(1000000))<=1400);
});
test('paged response validates metadata while supporting legacy payloads',()=>{
 const value={conversation:{id:'c',title:'test'},messages:[],candidates:[],current:{}};
 assert.equal(chatResult(value),value);
 const valid={has_older:false,has_newer:false,oldest_id:null,newest_id:null};
 assert.equal(chatResult({...value,message_page:valid}).message_page,valid);
 for(const page of [null,{}, {...valid,has_newer:1},{...valid,oldest_id:15}])assert.throws(()=>chatResult({...value,message_page:page}));
});
