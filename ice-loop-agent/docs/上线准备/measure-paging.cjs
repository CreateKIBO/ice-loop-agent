'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),f=JSON.parse(fs.readFileSync(path.join(__dirname,'paging-fixture.json'),'utf8'));
const rows=[];
for(const mode of ['history-before','history-after','history-summary','topics-before','topics-after']){
 const result=spawnSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B',path.join(repo,'tests/measure_paging_memory.py'),mode],
  {cwd:repo,env:{...process.env,TEMP:f.runtime,TMP:f.runtime},windowsHide:true,encoding:'utf8',timeout:60000});
 if(result.status!==0)throw Error(result.stderr||result.error||mode+' failed');rows.push(JSON.parse(result.stdout));
}
const [before,after,summary,topics,topicsPage]=rows;
const checks={same_complete_model_context:before.result_hash===after.result_hash,
 unchanged_confirmation_hash:before.context_hash===after.context_hash&&after.context_hash===summary.context_hash,
 all_1500_titles_retained_for_model:after.titles===1500,full_five_bodies_retained:after.history===5&&summary.history===5,
 traced_allocation_reduced:after.python_traced_peak_bytes<before.python_traced_peak_bytes*.5,
 title_payload_omitted_only_for_ui:summary.titles===0&&summary.serialized_bytes<after.serialized_bytes,
 topic_response_is_one_page:topicsPage.rows===10&&topics.rows===2001,
 topic_transfer_reduced:topicsPage.serialized_bytes<topics.serialized_bytes*.02};
const report={success:Object.values(checks).every(Boolean),runtime:f.runtime,checks,samples:rows,
 scope:'Independent Python processes; tracemalloc includes response serialization. These are Python allocations, not total OS RAM or a latency SLA.'};
fs.writeFileSync(path.join(__dirname,'paging-memory.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!report.success)process.exitCode=1;
