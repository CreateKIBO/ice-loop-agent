'use strict';
// 批E5（2026-10-25 候选对照轮）：本轮纯函数单测。
// 覆盖：对照选择状态机（恰两份/去重/三选拒绝/状态文案）、局部目录与回到开头的范围判定。
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(relative){
 const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',relative)],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
 const m=new Module(path.join(UI,'.candidate-compare-test.cjs'));m.filename=path.join(UI,'.candidate-compare-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
const compare=compile('features/chat/CandidateCompare.tsx');
const bridge=compile('features/editor/markdownBridge.ts');

const pick=id=>({id,title:'标题'+id,chars:100+Number(id)});

test('compare pick state machine: exactly two, dedupe, third rejected explicitly',()=>{
  const a=pick('1'),b=pick('2'),c=pick('3');
  let state=compare.toggleComparePick([],a);
  assert.deepEqual(state.next.map(p=>p.id),['1']);assert.equal(state.note,undefined);
  state=compare.toggleComparePick(state.next,b);
  assert.deepEqual(state.next.map(p=>p.id),['1','2']);
  // 第三份：明确拒绝，不悄悄替换
  state=compare.toggleComparePick(state.next,c);
  assert.deepEqual(state.next.map(p=>p.id),['1','2']);
  assert.ok(state.note.includes('最多两份')&&state.note.includes('先移除'));
  // 重复选择同一 ID = 移除
  state=compare.toggleComparePick(state.next,a);
  assert.deepEqual(state.next.map(p=>p.id),['2']);
  assert.ok((state.note||'').includes('移除'));
});

test('compare status notes guide the user at each count',()=>{
  assert.ok(compare.compareStatusNote([]).includes('未选择'));
  assert.ok(compare.compareStatusNote([pick('1')]).includes('再选一份'));
  assert.ok(compare.compareStatusNote([pick('1'),pick('2')]).includes('已选 2 份'));
});

test('markdown headings exclude fenced pseudo headings and carry level/line',()=>{
  const body='# 真标题\n\n```\n# 围栏里的伪标题\n```\n\n## 小节\n\n正文';
  const headings=bridge.markdownHeadings(body);
  assert.equal(headings.length,2);
  assert.equal(headings[0].text,'真标题');assert.equal(headings[0].level,1);
  assert.equal(headings[1].text,'小节');assert.equal(headings[1].level,2);
  assert.ok(!headings.some(h=>h.text.includes('伪标题')));
  // 无标题诚实空态
  assert.equal(bridge.markdownHeadings('只有正文没有标题').length,0);
});

test('setext headings parse with correct level and source line',()=>{
  const NL=String.fromCharCode(10);
  const body='Setext 大标题'+NL+'='+NL+NL+'首段'+NL+NL+'Setext 小节'+NL+'-'+NL+NL+'尾段';
  const headings=bridge.markdownHeadings(body);
  assert.equal(headings.length,2);
  assert.equal(headings[0].text,'Setext 大标题');assert.equal(headings[0].level,1);assert.equal(headings[0].line,1);
  assert.equal(headings[1].text,'Setext 小节');assert.equal(headings[1].level,2);assert.equal(headings[1].line,6);
});

test('duplicate heading texts keep separate indexes and lines',()=>{
  const NL=String.fromCharCode(10);
  const body='## 重复标题'+NL+NL+'第一处内容'+NL+NL+'## 重复标题'+NL+NL+'第二处内容';
  const headings=bridge.markdownHeadings(body);
  assert.equal(headings.length,2);
  assert.equal(headings[0].text,headings[1].text);
  assert.notEqual(headings[0].line,headings[1].line);
  assert.deepEqual(headings.map(h=>h.index),[0,1]);
});

test('CRLF bodies keep accurate heading lines for source anchors',()=>{
  const CRLF=String.fromCharCode(13)+String.fromCharCode(10);
  const body='# 对照正文标题乙'+CRLF+CRLF+'正文一'+CRLF+CRLF+'## tail-section'+CRLF+CRLF+'正文二';
  const headings=bridge.markdownHeadings(body);
  assert.equal(headings.length,2);
  assert.equal(headings[0].line,1);
  assert.equal(headings[1].text,'tail-section');assert.equal(headings[1].line,5);
});
