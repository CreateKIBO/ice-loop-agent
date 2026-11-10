"use strict";
// v3.11：讨论结束后的“写初稿”按钮——显示条件与发送文字。
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(name){const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',name)],bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'});const mod=new Module(path.join(UI,'.draft-test.cjs'));mod.filename=path.join(UI,'.draft-test.cjs');mod.paths=Module._nodeModulePaths(UI);mod._compile(result.outputFiles[0].text,mod.filename);return mod.exports;}
const draft=compile('features/chat/draftRequest.ts');
const row=(extra={})=>({id:'a2',role:'assistant',status:'completed',content:'我们确定写给新手的版本。',metadata:{mode:'discuss'},...extra});
test('shows only under the latest completed discussion reply without pending questions',()=>{
 assert.equal(draft.canDraftFrom(row(),'a2',undefined),true);
 assert.equal(draft.canDraftFrom(row({metadata:{}}),'a2',undefined),true,'旧消息没有 mode 时按讨论处理');
 assert.equal(draft.canDraftFrom(row(),'a3',undefined),false,'不是最新回复');
 assert.equal(draft.canDraftFrom(row(),'a2','a2'),false,'还有待答问题时先答题');
 assert.equal(draft.canDraftFrom(row({metadata:{mode:'draft'}}),'a2',undefined),false,'初稿回复下不再重复');
 assert.equal(draft.canDraftFrom(row({status:'streaming'}),'a2',undefined),false);
 assert.equal(draft.canDraftFrom(row({status:'failed'}),'a2',undefined),false);
 assert.equal(draft.canDraftFrom(row({role:'user'}),'a2',undefined),false);
 assert.equal(draft.canDraftFrom(row({content:'  '}),'a2',undefined),false);
});
test('request text asks for a full draft from the discussion and appends optional requirements',()=>{
 const plain=draft.draftRequestText('  ');
 assert.equal(plain,draft.DRAFT_FROM_DISCUSSION);
 assert.match(plain,/根据我们以上的讨论/);assert.match(plain,/不要再重复提问/);
 const extra=draft.draftRequestText(' 1500 字左右 ');
 assert.ok(extra.endsWith('补充要求：1500 字左右'));
 assert.ok(extra.length<1200,'远低于发送上限');
});
