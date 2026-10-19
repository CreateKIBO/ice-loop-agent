'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui'),uiRequire=Module.createRequire(path.join(UI,'package.json'));
function compile(relative){
 const result=esbuild.buildSync({entryPoints:[path.join(UI,'src/features/tasks',relative)],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
 const m=new Module(path.join(UI,'.workflow-review-test.cjs'));m.filename=path.join(UI,'.workflow-review-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
const model=compile('reviewModel.ts');
const topic=()=>({approval_id:'a',scope:'topic',content_hash:'hash-current',payload:{working_title:'topic',recommended:0,directions:[
 {'标题候选':'first','核心角度':'angle1','文章类型':'教程'},{'标题候选':'second','核心角度':'angle2','文章类型':'经验'}]}});
test('nonrecommended topic selection is submitted with actual approval hash',()=>{
 const params=model.decisionParams('job',topic(),1,'approve','');
 assert.equal(params.choice,1);assert.equal(params.content_hash,'hash-current');assert.equal(params.approval_id,'a');
});
test('editing a candidate preserves other fields without mutating the saved baseline',()=>{
 const original=topic(),changed=model.changeReviewRow(original,1,'标题候选','edited');
 assert.equal(original.payload.directions[1]['标题候选'],'second');assert.equal(changed.payload.directions[1]['标题候选'],'edited');
 assert.equal(changed.payload.directions[1]['文章类型'],'经验');assert.equal(model.reviewError(changed),null);
});
test('unknown scope, malformed list, empty title and stale selection cannot be approved',()=>{
 for(const approval of [{...topic(),scope:'unknown'},{...topic(),payload:{directions:['lost']}},model.changeReviewRow(topic(),0,'标题候选','')]){
  assert.ok(model.reviewError(approval));assert.throws(()=>model.decisionParams('job',approval,0,'approve',''));
 }
 assert.throws(()=>model.decisionParams('job',topic(),7,'approve',''));
 assert.equal(model.decisionParams('job',topic(),7,'reject','reason').choice,null);
});
test('an empty image plan can be reviewed, and an invalid recommendation falls back to an existing choice',()=>{
 assert.equal(model.reviewError({approval_id:'a',scope:'asset_plan',content_hash:'h',payload:{slots:[]}}),null);
 assert.equal(model.recommendedChoice({...topic(),payload:{...topic().payload,recommended:99}}),0);
});
test('execution input uses unique manifest keys and preserves literal user input',()=>{
 const blocks=[{index:1,filename:'a.py',stdin_key:'code_1_a.py',stdin_text:'',input_calls:1,expected_failure:false},
 {index:2,filename:'a.py',stdin_key:'code_2_a.py',stdin_text:'{"id":511}',input_calls:1,expected_failure:true}];
 const input=model.executionInputs(blocks);
 assert.deepEqual(model.missingInputNames(blocks,input),['code_1_a.py']);
 input['code_1_a.py']='21\nhello';assert.deepEqual(model.missingInputNames(blocks,input),[]);
 assert.equal(input['code_2_a.py'],'{"id":511}');assert.deepEqual(model.executionExpectations(blocks),{'1':false,'2':true});
});
test('candidate and code views escape model HTML instead of executing it',()=>{
 const React=uiRequire('react'),{renderToStaticMarkup}=uiRequire('react-dom/server');
 const {ApprovalReview}=compile('ApprovalReview.tsx'),{ExecutionReview}=compile('ExecutionReview.tsx');
 const approval=model.changeReviewRow(topic(),1,'标题候选','<script>bad()</script>');
 const html=renderToStaticMarkup(React.createElement(ApprovalReview,{approval,jobId:'j',disabled:false,onDirty(){},onSave:async()=>{},onDecide:async()=>{}}));
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 const rendered=renderToStaticMarkup(React.createElement(ExecutionReview,{detail:{job:{job_id:'j',state:'awaiting_user',lease:null},runs:{},execution:{content_hash:'h',approved:false,mode:'local_reviewed',blocks:[{index:1,filename:'a.py',stdin_key:'a.py',source:'<img src=x onerror=bad()>',stdin_text:'',input_calls:0,expected_failure:false}]}},disabled:false,onDirty(){},onRun:async()=>{},onResume:async()=>{}}));
 assert.ok(!rendered.includes('<img'));assert.ok(rendered.includes('&lt;img'));
 assert.ok(rendered.includes('确认运行并继续'));assert.ok(rendered.includes('disabled=""'));
});
