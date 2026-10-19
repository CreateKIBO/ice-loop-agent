'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../ui/node_modules/typescript');
const source=fs.readFileSync(path.join(__dirname,'../ui/src/features/editorial/editorialModel.ts'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const m={exports:{}};new Function('module','exports',code)(m,m.exports);
const {issueNumber,editorialInput,outlinePayload,outlinePage,topicFields}=m.exports;
test('jumping to issue100 takes its own following title and respects the selected column',()=>{
 const selected={series:'OBS',episode:100,title:'第100期标题',content_angle:'要点',core_benefit:'收益',next_episode_plan:''};
 const topics=[{...selected,episode:12,title:'不能误用旧期号的下一期'},{...selected,series:'LAB',episode:101,title:'另一个栏目'},selected];
 assert.equal(topicFields(selected,topics).next_episode_plan,'');
 topics.push({...selected,episode:101,title:'真正的第101期'});
 assert.equal(topicFields(selected,topics).next_episode_plan,'真正的第101期');
 assert.equal(topicFields({...selected,next_episode_plan:'明确写下的预告'},topics).next_episode_plan,'明确写下的预告');
});
test('issue selection accepts padded issue numbers beyond ten and refuses invalid input',()=>{
 assert.equal(issueNumber('0011'),11);assert.equal(issueNumber('100'),100);assert.equal(issueNumber('9999'),9999);
 for(const value of ['', '0','10000','1.5','-1','1e2','not a number'])assert.equal(issueNumber(value),null,value);
});
test('confirmed manual title, issue and edited requirements reach the composer without automatic send',()=>{
 const fields={series:'OBS',episode:100,title_mode:'outline',topic:'我改过的标题',content_angle:'真实内容角度',core_benefit:'读者收获',next_episode_plan:'下期方向'};
 const input=editorialInput(fields);assert.ok(input.includes('OBS 第100期'));assert.ok(input.includes('我改过的标题'));assert.ok(input.includes('保留这个标题，不重新拟题'));
 for(const text of ['真实内容角度','读者收获','下期方向'])assert.ok(input.includes(text));
 assert.equal(editorialInput({...fields,title_mode:'ai'}).includes('提出3–5个选题供我审阅'),true);
});
test('import payload drops unchecked rows and all source/foreign metadata',()=>{
 const row={series:'OBS',episode:11,title:'保存的标题',content_angle:'要点',core_benefit:'收益',next_episode_plan:'预告',include:true,
  existing:{account_id:'foreign'},source_line:12,file_path:'outside',topic_id:'untrusted'};
 const result=outlinePayload([row,{...row,episode:12,include:false}]);
 assert.deepEqual(result,[{series:'OBS',episode:11,title:'保存的标题',content_angle:'要点',core_benefit:'收益',next_episode_plan:'预告'}]);
 assert.equal(row.existing.account_id,'foreign');
});
test('thousand-issue import has bounded pages and retains later editable rows',()=>{
 const rows=Array.from({length:1000},(_,index)=>({episode:index+1,title:'期题'+(index+1)}));
 assert.equal(outlinePage(rows,0).rows.length,8);
 const last=outlinePage(rows,500);assert.equal(last.page,124);assert.equal(last.rows[7].episode,1000);
 assert.equal(outlinePage([],100).pages,1);assert.equal(outlinePage([],100).page,0);
 assert.equal(rows.length,1000);
});
