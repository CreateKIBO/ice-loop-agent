'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');
function load(name){const file=path.join(__dirname,'../ui/src/app',name+'.ts'),code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('module','exports',code)(m,m.exports);return m.exports;}

test('article and image limits reject blank or zero while conversation zero is explicit unlimited',()=>{
 const {budgetValues}=load('budgetDraft'),valid={max_model_calls:'24',max_image_model_calls:'12',max_chat_calls:'0'};
 assert.equal(budgetValues(valid).max_chat_calls,0);
 for(const [key,values] of Object.entries({max_model_calls:['','0','101','1.5','1e1','-1'],max_image_model_calls:['','0','101'],max_chat_calls:['','1001','-1','Infinity']}))for(const value of values)assert.throws(()=>budgetValues({...valid,[key]:value}));
});
test('loaded defaults are copied into an editable string draft without modifying the source',()=>{
 const {budgetDraft,budgetValues}=load('budgetDraft'),data={max_model_calls:100,max_image_model_calls:1,max_chat_calls:1000,defaults_hash:'saved'};
 const draft=budgetDraft(data);assert.deepEqual(budgetValues(draft),{max_model_calls:100,max_image_model_calls:1,max_chat_calls:1000});draft.max_model_calls='2';assert.equal(data.max_model_calls,100);
});
test('settings owners clean up without detaching a newer owner of the same key',()=>{
 const registry=load('settingsDrafts').createSettingsDrafts();let dirty=true,notifications=0;const off=registry.subscribe(()=>notifications++);
 const removeOld=registry.register('budget',{read:()=>({dirty,busy:false}),discard:()=>{dirty=false;}});
 const removeNew=registry.register('budget',{read:()=>({dirty:false,busy:true}),discard:()=>assert.fail('busy cannot discard')});removeOld();
 assert.deepEqual(registry.status(),{dirty:false,busy:true});removeNew();assert.deepEqual(registry.status(),{dirty:false,busy:false});off();const before=notifications;registry.notify();assert.equal(notifications,before);
});
test('running settings block discarding every draft, including earlier registered keys',()=>{
 const registry=load('settingsDrafts').createSettingsDrafts();let discarded=0;
 registry.register('budget',{read:()=>({dirty:true,busy:false}),discard:()=>discarded++});registry.register('model',{read:()=>({dirty:false,busy:true}),discard:()=>discarded++});
 assert.throws(()=>registry.discard(),/正在保存或测试/);assert.equal(discarded,0);
});
test('explicit discard clears dirty inputs but does not call clean owners',()=>{
 const registry=load('settingsDrafts').createSettingsDrafts();let dirty=true;
 registry.register('budget',{read:()=>({dirty,busy:false}),discard:()=>{dirty=false;}});registry.register('clean',{read:()=>({dirty:false,busy:false}),discard:()=>assert.fail('clean owner')});
 assert.equal(registry.status().dirty,true);registry.discard();assert.deepEqual(registry.status(),{dirty:false,busy:false});
});
