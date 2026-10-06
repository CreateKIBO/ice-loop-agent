const test=require('node:test'),assert=require('node:assert/strict');
const {PreparationQueue}=require('../automation.cjs');
test('automatic screenshots fill only empty real slots and re-export without human approval',async()=>{
  const calls=[],captures=[];
  const data={job:{lease:null},article:{spec:{production_mode:'auto_prepare'}},runs:{'run-1':{stdout:'real'}},slots:[{figure_no:1,kind:'cover'},{figure_no:2,kind:'body_real'},{figure_no:3,kind:'body_real',selected_candidate:'mine'}]};
  const request=async(method,params)=>{calls.push({method,params});if(method==='jobs.list')return[{job_id:'j',state:'completed',production_mode:'auto_prepare'}];if(method==='jobs.get')return data;return{};};
  const queue=new PreparationQueue(request,async(...args)=>captures.push(args));await queue.tick();await queue.tick();
  assert.deepEqual(captures,[['j',2,['run-1'],true]]);
  assert.equal(calls.filter(r=>r.method==='articles.finalize').length,1);
  assert.equal(calls.find(r=>r.method==='articles.finalize').params.confirm_delivery,undefined);
});
test('screenshot failure is visible and does not repeat every poll',async()=>{
  const errors=[];let attempts=0;
  const request=async(method,params)=>{
    if(method==='jobs.list')return[{job_id:'j',state:'completed',production_mode:'auto_prepare'}];
    if(method==='jobs.get')return{job:{},article:{spec:{production_mode:'auto_prepare'}},runs:{r:{stdout:'record'}},slots:[{figure_no:2,kind:'body_real'}]};
    if(method==='automation.capture_failure')errors.push(params);
  };
  const queue=new PreparationQueue(request,async()=>{attempts++;throw Error('too tall');});await queue.tick();await queue.tick();
  assert.equal(attempts,1);assert.equal(errors[0].error,'too tall');
});
test('review mode, running tasks, and image-only jobs never auto-capture',async()=>{
  let captures=0;
  const queue=new PreparationQueue(async()=>[{state:'completed',production_mode:'review_each'},{state:'running',production_mode:'auto_prepare'},{state:'completed',production_mode:'auto_prepare',image_only:true}],async()=>captures++);
  await queue.tick();assert.equal(captures,0);
});
test('a human-rejected run screenshot stays rejected after a queue restart',async()=>{
  let captures=0;
  const request=async method=>method==='jobs.list'?[{job_id:'j',state:'completed',production_mode:'auto_prepare'}]:{job:{},article:{spec:{production_mode:'auto_prepare'}},runs:{r:{}},slots:[{figure_no:2,kind:'body_real',candidates:[{source:'run_capture',review_status:'rejected'}]}]};
  await new PreparationQueue(request,async()=>captures++).tick();
  assert.equal(captures,0);
});
