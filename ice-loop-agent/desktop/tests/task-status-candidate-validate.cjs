'use strict';
// 批F2（2026-10-25 候选对照轮）：36 项状态源校验工具（精确 ID 集合）。
const fs=require('node:fs'),path=require('node:path');
const file=path.resolve(__dirname,'task-status-candidate-compare-2026-10-25.json');
const data=JSON.parse(fs.readFileSync(file,'utf8'));
const allowed=new Set(['done','reused','deferred','blocked']);
const expected=[];
for(const batch of 'ABCDEF')for(let i=1;i<=6;i++)expected.push(batch+i);
const errors=[];
const ids=new Set();
const counts={done:0,reused:0,deferred:0,blocked:0};
for(const item of data.items){
  if(!item.id)errors.push('missing id');
  if(ids.has(item.id))errors.push('duplicate id '+item.id);
  ids.add(item.id);
  if(!allowed.has(item.status))errors.push(item.id+': unknown status '+item.status);
  else counts[item.status]++;
  if(!item.note||!item.evidence)errors.push(item.id+': missing note/evidence');
}
for(const id of expected)if(!ids.has(id))errors.push('missing item '+id);
for(const id of ids)if(!expected.includes(id))errors.push('unexpected item '+id);
if(data.items.length!==36)errors.push('item count '+data.items.length+' != 36');
if(errors.length){console.error('INVALID:\n'+errors.join('\n'));process.exit(1);}
console.log('VALID items=36 done='+counts.done+' reused='+counts.reused+' deferred='+counts.deferred+' blocked='+counts.blocked);
