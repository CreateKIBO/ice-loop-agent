'use strict';
// 批A5（2026-10-25）：data/clipboard.ts（renderer 侧）的分支行为单测。
// 组件内通过 window.ice / navigator 全局读取——这里直接替换全局驱动真实函数。
// 覆盖：桥接 ok:false → 抛错并携带桥接文案（不假成功）；ok:true / 旧桥 undefined → 正常；
// Promise reject → 传播；超长文本绕过桥接且无浏览器剪贴板时明确失败；空文本先失败不触桥。
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
const result=esbuild.buildSync({entryPoints:[path.join(UI,'src/data/clipboard.ts')],bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'});
const m=new Module(path.join(UI,'.clipboard-test.cjs'));m.filename=path.join(UI,'.clipboard-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);
const {copyPlainText}=m.exports;

function withGlobals(ice,navigator,run){
  const w=global.window;
  const navDescriptor=Object.getOwnPropertyDescriptor(global,'navigator');
  global.window={ice};
  Object.defineProperty(global,'navigator',{value:navigator??{},configurable:true,writable:true});
  return run().finally(()=>{
    if(w!==undefined)global.window=w;else delete global.window;
    if(navDescriptor)Object.defineProperty(global,'navigator',navDescriptor);
    else delete global.navigator;
  });
}

test('bridge ok:false throws with bridge message instead of fake success',async()=>{
  await withGlobals({copyText:async()=>({ok:false,message:'当前系统剪贴板不可用。'})},{},()=>
    assert.rejects(copyPlainText('提示词'),/当前系统剪贴板不可用/));
});
test('bridge ok:true resolves; legacy undefined also resolves',async()=>{
  await withGlobals({copyText:async()=>({ok:true})},{},()=>copyPlainText('提示词'));
  await withGlobals({copyText:async()=>undefined},{},()=>copyPlainText('提示词'));
});
test('bridge rejection propagates with its error',async()=>{
  await withGlobals({copyText:async()=>{throw Error('桥接异常X');}},{},()=>
    assert.rejects(copyPlainText('提示词'),/桥接异常X/));
});
test('over-limit text skips bridge and fails clearly without browser clipboard',async()=>{
  await withGlobals({copyText:async()=>({ok:true})},{},()=>
    assert.rejects(copyPlainText('a'.repeat(30001)),/剪贴板不可用/));
});
test('empty text fails before touching bridge',async()=>{
  let called=false;
  await withGlobals({copyText:async()=>{called=true;return {ok:true};}},{},()=>
    assert.rejects(copyPlainText('  '),/没有可复制的内容/));
  assert.equal(called,false);
});


test('over-limit text copies complete source through browser fallback',async()=>{
  const text='标题\n'+'x'.repeat(31000);let copied=null,bridged=false;
  await withGlobals({copyText:async()=>{bridged=true;}},{clipboard:{writeText:async value=>{copied=value;}}},()=>copyPlainText(text));
  assert.equal(copied,text);assert.equal(bridged,false);
});
