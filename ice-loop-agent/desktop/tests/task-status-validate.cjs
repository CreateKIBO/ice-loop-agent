"use strict";
const fs=require('node:fs'),path=require('node:path');
const EXPECTED_IDS=Array.from('ABCDEF').flatMap(batch=>Array.from({length:6},(_,i)=>batch+(i+1)));
function validateTaskStatus(data){
 const errors=[],counts={done:0,reused:0,deferred:0,blocked:0},ids=new Set(),expected=new Set(EXPECTED_IDS);
 if(!data||!Array.isArray(data.items))return {errors:['items must be an array'],counts};
 for(const item of data.items){
  if(!item||typeof item!=='object'){errors.push('invalid item');continue;}
  if(!expected.has(item.id))errors.push('unknown id '+String(item.id));
  if(ids.has(item.id))errors.push('duplicate id '+item.id);
  ids.add(item.id);
  if(!Object.hasOwn(counts,item.status))errors.push(item.id+': unknown status '+item.status);
  else counts[item.status]++;
  for(const key of ['note','evidence'])if(typeof item[key]!=='string'||!item[key].trim())errors.push(item.id+': missing '+key);
 }
 for(const id of EXPECTED_IDS)if(!ids.has(id))errors.push('missing id '+id);
 if(data.items.length!==36)errors.push('item count '+data.items.length+' != 36');
 if(data.summary!==undefined){
  for(const key of Object.keys(counts))if(data.summary?.[key]!==counts[key])errors.push('summary mismatch '+key);
 }
 return {errors,counts};
}
if(require.main===module){
 try{
  const data=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'task-status-2026-10-25.json')),'utf8'));
  const {errors,counts}=validateTaskStatus(data);
  if(errors.length){console.error('INVALID: '+errors.join('; '));process.exitCode=1;}
  else console.log('VALID items=36 '+Object.entries(counts).map(([k,v])=>k+'='+v).join(' '));
 }catch(error){console.error('INVALID: '+error.message);process.exitCode=1;}
}
module.exports={validateTaskStatus};
