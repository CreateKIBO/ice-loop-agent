'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
const uiRequire=Module.createRequire(path.join(UI,'package.json'));
function compile(relative) {
  const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',relative)],bundle:true,write:false,
    format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},
    external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
  const module=new Module(path.join(UI,'.interaction-under-test.cjs'));
  module.filename=path.join(UI,'.interaction-under-test.cjs');
  module.paths=Module._nodeModulePaths(UI); module._compile(result.outputFiles[0].text,module.filename);
  return module.exports;
}
const draft=compile('data/composerDraft.ts');
const reading=compile('features/chat/readingState.ts');
const {MarkdownView}=compile('components/MarkdownView.tsx');
const React=uiRequire('react');
const {renderToStaticMarkup}=uiRequire('react-dom/server');
const html=text=>renderToStaticMarkup(React.createElement(MarkdownView,{text}));
const storage=()=>{const map=new Map();return{map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};

test('composer restores both mode and input after remount, isolated by account and conversation',()=>{
  const s=storage();
  draft.saveComposerDraft(s,'a','one',{text:'待发送内容',mode:'draft'},1000);
  assert.deepEqual(draft.loadComposerDraft(s,'a','one',1001),{text:'待发送内容',mode:'draft'});
  assert.equal(draft.loadComposerDraft(s,'b','one',1001).text,'');
  assert.equal(draft.loadComposerDraft(s,'a','two',1001).text,'');
});
test('unknown modes, hostile identities, malformed and expired input records are ignored',()=>{
  const s=storage(), key=draft.composerKey('a','one');
  for(const value of ['bad','null',JSON.stringify({version:2,account:'b',conversation:'one',text:'wrong',mode:'draft',updatedAt:1000}),
    JSON.stringify({version:2,account:'a',conversation:'one',text:'wrong',mode:'publish',updatedAt:1000})]){
    s.setItem(key,value);assert.equal(draft.loadComposerDraft(s,'a','one',1001).text,'');
  }
  draft.saveComposerDraft(s,'a','one',{text:'expired',mode:'draft'},1000);
  assert.equal(draft.loadComposerDraft(s,'a','one',1000+31*86400000).text,'');
});
test('bounded input pruning never clears unrelated application storage',()=>{
  const s=storage();s.setItem('brand-profile','keep');
  for(let n=0;n<65;n++)draft.saveComposerDraft(s,'a','t'+n,{text:'input',mode:'edit'},1000+n);
  assert.equal(s.getItem('brand-profile'),'keep');
  assert.equal(draft.loadComposerDraft(s,'a','t0',1100).text,'');
  assert.equal(draft.loadComposerDraft(s,'a','t64',1100).text,'input');
});
test('clearing an input removes its record while retaining a chosen nondefault mode',()=>{
  const s=storage();
  draft.saveComposerDraft(s,'a','one',{text:'',mode:'images'},1000);
  assert.equal(draft.loadComposerDraft(s,'a','one',1001).mode,'images');
  draft.saveComposerDraft(s,'a','one',{text:'',mode:'discuss'},1002);
  assert.equal(s.getItem(draft.composerKey('a','one')),null);
});
test('storage failures do not throw or falsely report persistence',()=>{
  const s={getItem(){throw Error('blocked')},setItem(){throw Error('full')},removeItem(){throw Error('blocked')}};
  assert.equal(draft.loadComposerDraft(s,'a','one').text,'');
  assert.equal(draft.saveComposerDraft(s,'a','one',{text:'keep in input',mode:'draft'}),false);
});
test('IME candidate confirmation and newline/modifier keys never send',()=>{
  const enter={key:'Enter',shiftKey:false};
  assert.equal(draft.shouldSendKey(enter,false),true);
  for(const input of [{...enter,shiftKey:true},{...enter,isComposing:true},{...enter,keyCode:229},{...enter,ctrlKey:true},{key:'a',shiftKey:false}]){
    assert.equal(draft.shouldSendKey(input,false),false);
  }
  assert.equal(draft.shouldSendKey(enter,true),false);
});
test('late send acknowledgement cannot erase newly typed or another thread input',()=>{
  assert.equal(draft.mayClearAcknowledgedInput(3,3,'a','a'),true);
  assert.equal(draft.mayClearAcknowledgedInput(3,4,'a','a'),false);
  assert.equal(draft.mayClearAcknowledgedInput(3,3,'a','b'),false);
  assert.equal(draft.appendComposerText('new input','old message'),'new input\n\nold message');
});
test('reading position and new streaming content are distinguished from previously read replies',()=>{
  assert.equal(reading.isNearBottom(1000,200,300),false);
  assert.equal(reading.isNearBottom(1000,650,300),true);
  const rows=[{id:'u1',role:'user',content:'hi'},{id:'a1',role:'assistant',content:'new'}];
  assert.equal(reading.unreadAssistantUpdates(rows,new Map([['a1','old']])),1);
  assert.equal(reading.unreadAssistantUpdates(rows,new Map([['a1','new']])),0);
});
test('chat polling follows live data using a callback independent of a mounted conversation',()=>{
  assert.equal(reading.idleChatPollingInterval({state:{data:undefined}}),8000);
  assert.equal(reading.idleChatPollingInterval({state:{data:{messages:[{status:'completed'}]}}}),8000);
  assert.equal(reading.idleChatPollingInterval({state:{data:{messages:[{status:'streaming'}]}}}),1500);
});
test('assistant Markdown renders readable headings, formatting, lists, code and tables',()=>{
  const result=html('# 标题\n\n**重点**与`变量`\n\n- 项目\n\n```python\nprint("中文")\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |');
  for(const tag of ['<h1>','<strong>','<code>','<ul>','<table>','<thead>','<tbody>'])assert.ok(result.includes(tag),tag);
  assert.ok(result.includes('复制代码'));assert.ok(result.includes('print('));
});
test('model HTML is escaped, unsafe URLs cannot execute, and remote images never load',()=>{
  const result=html('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://example.com/pixel.png)\n\n<iframe src="https://example.com"></iframe>');
  assert.ok(!result.includes('<script'));assert.ok(!result.includes('<iframe'));assert.ok(!result.includes('<img'));
  assert.ok(!result.includes('href="javascript:'));assert.ok(result.includes('&lt;script&gt;'));
  for(const value of ['javascript:alert(1)','data:text/html,test','file:///G:/private','https://user:pass@example.com','https://example.com\n/path'])assert.equal(reading.safeMessageUrl(value),null);
  assert.equal(reading.safeMessageUrl('https://example.com/page'),'https://example.com/page');
});
