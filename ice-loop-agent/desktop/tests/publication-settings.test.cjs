'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');
const file=path.join(__dirname,'../ui/src/features/publication/publicationModel.ts');
const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require);const model=m.exports;
const valid=()=>({...model.publicationDraft(),name:'纸间观察',audience:'城市散步者'});
test('new publications have a general profile with independent optional storage',()=>{
 const draft=valid();assert.equal(model.publicationError(draft),null);const payload=model.publicationPayload(draft);
 assert.equal(payload.preset,'general');assert.equal(payload.id,undefined);assert.equal(payload.article_root,'');assert.deepEqual(payload.words_range,[1200,2400]);
});
test('word ranges, duplicate columns and placeholder audiences cannot be silently saved',()=>{
 for(const change of [{words_range:['','2400']},{words_range:['2400','1200']},{words_range:['300','10001']},{columns:[{code:'A',name:'一'},{code:'A',name:'二'}]},{audience:'请设置你的目标读者'}])assert.ok(model.publicationError({...valid(),...change}));
});
test('editing drafts does not mutate cached account columns or collapse blank lines while typing',()=>{
 const account=model.emptyPublication(),draft=model.publicationDraft(account);draft.columns[0].name='新名称';draft.banned_text='第一项\n\n第二项\n';
 assert.equal(account.columns[0].name,'日常文章');assert.equal(draft.banned_text,'第一项\n\n第二项\n');assert.deepEqual(model.publicationPayload(draft).banned_words,['第一项','第二项']);
});
test('only validated hex colors become visual swatches',()=>{
 assert.deepEqual(model.brandColors('#2448DB, red, url(secret), #15191F'),['#2448DB','#15191F']);
 assert.ok(model.publicationError({...valid(),colors:'red'}));
});
test('import files use strict UTF-8, size/type limits, BOM handling and original text',async()=>{
 const data=await model.publicationFile(new File(['\uFEFF品牌说明\n原文'],'品牌.md'));
 assert.equal(data.text,'品牌说明\n原文');assert.equal(data.name,'品牌');assert.equal(data.format,'md');
 await assert.rejects(model.publicationFile(new File([new Uint8Array([0xff,0xfe,0xff])],'bad.txt')),/UTF-8/);
 await assert.rejects(model.publicationFile(new File(['x'],'bad.html')),/JSON/);
 await assert.rejects(model.publicationFile(new File(['x'.repeat(128001)],'large.txt')),/128KB/);
});
