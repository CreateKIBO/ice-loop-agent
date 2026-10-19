'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');
function load(file){const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../ui/src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('module','exports',code)(m,m.exports);return m.exports;}
const routes=load('app/modelRoutes.ts'),drafts=load('data/composerDraft.ts');
const profile=(id,key,status='verified')=>({profile_id:id,provider:id,model_id:id,has_key:key,status});
const route={primary:'qwen',fallbacks:['deepseek'],thinking_policy:'prefer_off'};

test('a verified unassigned Kimi key is not reported as a ready writer',()=>{
 assert.equal(routes.writingReadiness(), 'unknown');
 assert.equal(routes.writingReadiness({profiles:[profile('qwen',false)],routes:{writer:route}}),'missing');
 assert.equal(routes.writingReadiness({profiles:[profile('qwen',false),profile('kimi',true)],routes:{writer:route}}),'unrouted');
 assert.equal(routes.writingReadiness({profiles:[profile('kimi',true)],routes:{}}),'unrouted');
});
test('readiness respects usable writer fallbacks and distinguishes an untested route',()=>{
 assert.equal(routes.writingReadiness({profiles:[profile('qwen',false),profile('deepseek',true)],routes:{writer:route}}),'ready');
 assert.equal(routes.writingReadiness({profiles:[profile('qwen',true,'requires_probe')],routes:{writer:route}}),'untested');
});
test('text-only assignment preserves visual routes and thinking/fallback choices without modifying snapshots',()=>{
 const input={writer:{...route,fallbacks:['deepseek','kimi']},planner:{...route,fallbacks:['deepseek']},visual_reviewer:{...route,fallbacks:[]}};
 const selected=routes.textRoutes(input),changed=routes.assignPrimary(selected,'kimi');
 assert.equal(changed.visual_reviewer,undefined);assert.equal(input.writer.primary,'qwen');
 assert.deepEqual(input.writer.fallbacks,['deepseek','kimi']);assert.deepEqual(changed.writer.fallbacks,['deepseek']);
 assert.equal(changed.planner.thinking_policy,'prefer_off');
 assert.equal(routes.assignPrimary(selected,'kimi','writer').planner.primary,'qwen');
});
test('initial input handoff is scoped, repeatable under StrictMode and retains just the latest staged draft',()=>{
 drafts.stageComposerDraft('a','one',{text:'first request',mode:'draft'});
 assert.equal(drafts.peekStagedComposerDraft('b','one'),null);
 assert.equal(drafts.peekStagedComposerDraft('a','two'),null);
 assert.equal(drafts.peekStagedComposerDraft('a','one').mode,'draft');
 assert.equal(drafts.peekStagedComposerDraft('a','one').text,'first request');
 drafts.acknowledgeStagedComposerDraft('b','one');assert.ok(drafts.peekStagedComposerDraft('a','one'));
 drafts.stageComposerDraft('b','two',{text:'next',mode:'discuss'});assert.equal(drafts.peekStagedComposerDraft('a','one'),null);
 drafts.acknowledgeStagedComposerDraft('b','two');assert.equal(drafts.peekStagedComposerDraft('b','two'),null);
 assert.throws(()=>drafts.stageComposerDraft('a','one',{text:'x'.repeat(50001),mode:'draft'}));
});
