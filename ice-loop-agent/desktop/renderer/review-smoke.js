/* Invoked only by the main process in an isolated native test. */
window.__ICE_REVIEW_SMOKE__=async function(jobId){
  await openJob(jobId);ui.tab='evidence';renderDetail();
  const textarea=document.querySelector('[data-execution-input]');
  if(!textarea)throw Error('缺输入任务没有逐段输入入口');
  const result={distinctInputPrompt:workspace.textContent.includes('补充即将运行的示例输入'),approvalRetained:workspace.textContent.includes('已')};
  textarea.value='小冰\n';textarea.dispatchEvent(new Event('input',{bubbles:true}));
  document.querySelector('[data-action="approve-execution"]').click();
  for(let i=0;i<200;i++){
    const data=await api('jobs.get',{job_id:jobId});
    if(data.runs['run-1']&&data.job.current_node!=='verify_code'){
      result.actualOutput=data.runs['run-1'].stdout.includes('你好，小冰');result.advanced=true;result.run_id=data.runs['run-1'].run_id;
      ui.detail=data;ui.tab='evidence';renderDetail();return result;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('提交输入后没有离开验证节点');
};
