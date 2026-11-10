"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(name){const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',name)],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});const mod=new Module(path.join(UI,'.delivery-test.cjs'));mod.filename=path.join(UI,'.delivery-test.cjs');mod.paths=Module._nodeModulePaths(UI);mod._compile(result.outputFiles[0].text,mod.filename);return mod.exports;}
const delivery=compile('data/chatDelivery.ts'),draft=compile('data/composerDraft.ts'),questions=compile('features/chat/clarification.ts');
const storage=()=>{const map=new Map();return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
const record=(account,conversation='one')=>({version:1,account,conversation,requestId:crypto.randomUUID(),payload:{text:'原请求',mode:'draft',citations:[]},createdAt:Date.now(),source:'composer',draftEditId:'edit-1'});
test('outbox binds account conversation and payload, and an older acknowledgement cannot clear a newer record',()=>{
 const s=storage(),a=record('a'),b=record('a');delivery.saveDelivery(s,a);
 assert.equal(delivery.readDelivery(s,'a','one').record.requestId,a.requestId);assert.equal(delivery.readDelivery(s,'b','one').record,null);
 delivery.saveDelivery(s,b);delivery.clearDelivery(s,a);assert.equal(delivery.readDelivery(s,'a','one').record.requestId,b.requestId);
 delivery.clearDelivery(s,b);assert.equal(delivery.readDelivery(s,'a','one').record,null);assert.equal(s.map.has('unrelated'),false);
});
test('outbox recovers after reload and never expires an unresolved request due to a clock change',()=>{
 const s=storage(),r=record('reload');r.createdAt=1;delivery.saveDelivery(s,r);
 const fresh=compile('data/chatDelivery.ts');assert.equal(fresh.readDelivery(s,'reload','one').record.requestId,r.requestId);
 r.createdAt=Date.now()+365*86400000;delivery.saveDelivery(s,r);assert.equal(fresh.readDelivery(s,'reload','one').record.requestId,r.requestId);delivery.clearDelivery(s,r);
});
test('storage failures retain bounded in-process recovery and preserve unrelated keys',()=>{
 const s=storage();s.setItem('unrelated','must remain');const r=record('quota');const denied={...s,setItem(){throw Error('quota');}};
 assert.equal(delivery.saveDelivery(denied,r).persisted,false);assert.equal(delivery.readDelivery(denied,'quota','one').record.requestId,r.requestId);
 assert.equal(s.getItem('unrelated'),'must remain');delivery.clearDelivery(null,r);assert(delivery.deliveryMemoryStats().bytes<=2*1024*1024);
});
test('acknowledgement clears only the exact submitted edit token, keeping changes made while sending',()=>{
 const s=storage(),r=record('edit');draft.saveComposerDraft(s,'edit','one',{text:'原请求',mode:'draft',editId:'new-edit'});
 delivery.clearAcknowledgedComposer(s,r);assert.equal(draft.loadComposerDraft(s,'edit','one').text,'原请求');
 draft.saveComposerDraft(s,'edit','one',{text:'原请求',mode:'draft',editId:'edit-1'});delivery.clearAcknowledgedComposer(s,r);assert.equal(draft.loadComposerDraft(s,'edit','one').text,'');
});
test('response validators require complete accepted receipts and keep cancellation distinct from model retry',()=>{
 const ack={message_id:'a',user_message_id:'u',started:false,accepted:true,replayed:true,status:'completed'};
 assert.deepEqual(delivery.parseDeliveryResponse(ack),ack);assert.throws(()=>delivery.parseDeliveryResponse({accepted:true}),/回执格式/);
 assert.equal(delivery.parseDeliveryResponse({accepted:false,cancelled:true,request_id:'cancel'}).cancelled,true);
 assert.equal(delivery.parseReceiptResponse({accepted:false,found:false}),null);assert.throws(()=>delivery.parseDeliveryResponse({accepted:false,found:false}),/回执格式/);
});
test('corrupt or cross-scope stored requests are not silently trusted',()=>{
 const s=storage(),r=record('bad');s.setItem(delivery.deliveryKey('bad','one'),JSON.stringify({...r,account:'other'}));assert.equal(delivery.readDelivery(s,'bad','one').record,null);
 assert.throws(()=>delivery.saveDelivery(s,{...r,payload:{text:'x'.repeat(12001)}}),/参数无效|容量/);
});
test('clarification accepts a complete editable answer set and restores only matching questions in the same scope',()=>{
 const q=questions.questionsFrom([{id:'reader',question:'给谁看？',options:['新手','进阶']},{id:'goal',question:'目的？',options:[]}]),s=storage();
 assert.equal(q.length,2);assert.equal(questions.answersReady(q,{reader:'新手'}),false);assert.equal(questions.answersReady(q,{reader:'新手',goal:'学会循环'}),true);
 questions.saveAnswers(s,'a','c','m',q,{reader:'新手',goal:'学会循环'});
 assert.equal(questions.readAnswers(s,'a','c','m',q).goal,'学会循环');assert.deepEqual(questions.readAnswers(s,'b','c','m',q),{});
 assert.deepEqual(questions.readAnswers(s,'a','c','m',[{...q[0],question:'问题已变化'}]),{});
 assert.deepEqual(questions.questionsFrom([{id:'same',question:'一',options:[]},{id:'same',question:'二',options:[]}]),[]);
});
test('failed message diagnostic is redacted before both display and copy',()=>{
 const {MessageBubble}=compile('features/chat/MessageBubble.tsx'),req=Module.createRequire(path.join(UI,'package.json')),React=req('react'),{renderToStaticMarkup}=req('react-dom/server');
 const html=renderToStaticMarkup(React.createElement(MessageBubble,{row:{id:'m',role:'assistant',content:'api_key=DO_NOT_SHOW',status:'failed',metadata:{error_code:'NETWORK',error_message:'api_key=DO_NOT_SHOW'}},animateIn:false,onReuse:()=>{},onRetry:()=>{}}));
 assert(!html.includes('DO_NOT_SHOW'));assert(html.includes('重试此回复'));assert(html.includes('复制诊断'));
});

test('clarification citation choices distinguish inheritance, explicit removal and newly selected hashed sources',()=>{
 const selected=[{chunkId:'new-chunk',hash:'new-hash'}];
 assert.deepEqual(questions.clarificationCitations('inherit',selected),{});
 assert.deepEqual(questions.clarificationCitations('none',selected),{citations:[]});
 assert.deepEqual(questions.clarificationCitations('selected',selected),{citations:[{chunk_id:'new-chunk',hash:'new-hash'}]});
 assert.throws(()=>questions.clarificationCitations('selected',[]),/先.*选择/);
});

test('rich clarification drafts survive storage escaping without truncating their JSON',()=>{
 const q=questions.questionsFrom([{id:'parts',question:'保留哪些内容？',multiple:true,options:['选项甲'.repeat(60),'选项乙'.repeat(60),'选项丙'.repeat(60),'选项丁'.repeat(60)]}]);
 const answer={selected:q[0].options,other:'引号"与换行\n'.repeat(250).slice(0,1800)};
 const encoded=questions.encodeDraft(answer),s=storage();
 assert.ok(encoded.length>2000,'fixture crosses the previous storage limit');
 assert.equal(questions.saveAnswers(s,'owned','chat','message',q,{parts:encoded}),true);
 const restored=questions.readAnswers(s,'owned','chat','message',q);
 assert.deepEqual(questions.decodeDraft(q[0],restored.parts),{...answer,delegate:false});
 assert.equal(questions.draftAnswer(q[0],questions.decodeDraft(q[0],restored.parts)),questions.draftAnswer(q[0],answer));
});

test('overlong combined clarification answers remain intact and cannot be submitted',()=>{
 const q=questions.questionsFrom([{id:'parts',question:'选择材料',multiple:true,options:['甲'.repeat(180),'乙'.repeat(180),'丙'.repeat(180),'丁'.repeat(180)]}]);
 const value={selected:q[0].options,other:'补'.repeat(1800)};
 const full=[value.selected.join('、'),value.other].join('；');
 assert.equal(questions.draftAnswer(q[0],value),full,'show the full answer instead of silently cutting user text');
 assert.equal(questions.answersReady(q,{parts:full}),false);
});
