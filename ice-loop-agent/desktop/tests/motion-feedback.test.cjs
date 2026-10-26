"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');
const esbuild=require('../node_modules/esbuild'),ui=path.resolve(__dirname,'../ui');
function compile(relative){const {outputFiles}=esbuild.buildSync({entryPoints:[path.join(ui,'src',relative)],bundle:true,write:false,platform:'node',format:'cjs',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty'},logLevel:'silent'});
 const m=new Module(path.join(ui,'.motion-test.cjs'));m.filename=path.join(ui,'.motion-test.cjs');m.paths=Module._nodeModulePaths(ui);m._compile(outputFiles[0].text,m.filename);return m.exports;}
const {progressFeedback}=compile('features/chat/progressFeedback.ts');
const {turnSteps}=compile('data/eventStream.ts');
const start={sequence:1,type:'turn.started',created_at:'2026-10-25T12:00:00Z',payload:{turn_id:'turn-a'}};
const phase={sequence:2,type:'turn.phase',created_at:'2026-10-25T12:00:01Z',payload:{turn_id:'turn-a',phase:'waiting_model'}};
const stale={progress:{phase:'receiving',started_at:start.created_at}};
test('real finished events override stale streaming metadata and stop every active presentation',()=>{
 for(const [status,phase,tone,label] of [['completed','ready','success','完成'],['completed','awaiting_input','warning','等待你回答'],['failed','','danger','生成失败'],['stopped','','warning','已停止']]){
  const result=progressFeedback(turnSteps([start,{...phase}, {sequence:3,type:'turn.finished',created_at:'2026-10-25T12:00:05Z',payload:{turn_id:'turn-a',status,phase}}],'turn-a'),stale);
  assert.equal(result.active,false);assert.equal(result.tone,tone);assert.equal(result.label,label);assert.equal(result.finishedAt,'2026-10-25T12:00:05Z');assert(!result.steps.some(step=>step.status==='active'));
 }
});
test('terminal metadata stops old event animation without modifying the event history',()=>{
 const progress=turnSteps([start,phase],'turn-a');
 const result=progressFeedback(progress,{progress:{phase:'failed'}});
 assert.equal(result.active,false);assert.equal(result.tone,'danger');assert(result.steps.every(step=>step.status!=='active'));
 assert(progress.steps.some(step=>step.status==='active'));assert.equal(result.finishedAt,undefined);
});
test('active feedback follows only real current events and never creates an estimated percentage',()=>{
 const result=progressFeedback(turnSteps([start,phase],'turn-a'),stale);
 assert.equal(result.label,'等待模型响应');assert.equal(result.active,true);assert.equal(result.tone,'working');
 assert.equal('percent' in result,false);assert.equal('value' in result,false);
 const other=progressFeedback(turnSteps([{...phase,payload:{turn_id:'other',phase:'tools'}}],'turn-a'),{progress:'queued'});
 assert.equal(other.label,'排队等待');
});
test('pending button retains accessible label, disabled semantics and original child structure',()=>{
 const {createElement}=require('../ui/node_modules/react');const {renderToStaticMarkup}=require('../ui/node_modules/react-dom/server');
 const {Button}=compile('components/ui.tsx');
 const html=renderToStaticMarkup(createElement(Button,{loading:true},'保存草稿'));
 assert(html.includes('aria-busy="true"'));assert(html.includes('disabled=""'));assert(html.includes('保存草稿'));
 assert(html.includes('ice-activity-rail--compact'));assert(!html.includes('ice-spinner'));
});
