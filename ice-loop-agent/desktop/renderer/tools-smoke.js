window.__ICE_TOOLS_SMOKE__=async function(){
  const result={};
  await api('rules.save',{name:'桌面验收品牌A',kind:'brand',text:'标题不超过30字',rules:{title_max_chars:30}});
  await api('rules.save',{name:'桌面验收品牌B',kind:'brand',text:'标题不超过26字',rules:{title_max_chars:26}});
  let state=await api('rules.list');result.conflictDetected=state.conflicts.length===1;
  ui.view='tools';await renderWorkbench();
  document.querySelector('[data-tool="resolve-rule"]').click();
  for(let i=0;i<100;i++){state=await api('rules.list');if(!state.conflicts.length)break;await new Promise(r=>setTimeout(r,50));}
  result.conflictResolved=!state.conflicts.length;
  await renderWorkbench();
  const original=toolsState.resources.find(row=>row.width>=500&&row.height>=400);if(!original)throw Error('无可验收图片');
  const form=document.querySelector('#image-tool-form');form.elements.resource_id.value=original.resource_id;form.elements.title.value='让每一步，都有依据';form.elements.period.value='PY / 111';form.elements.rect.value=JSON.stringify([80,80,Math.min(original.width-10,1300),Math.min(original.height-10,650)]);
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<100&&!document.querySelector('#image-tool-result img');i++)await new Promise(r=>setTimeout(r,50));
  result.coverUI=Boolean(document.querySelector('#image-tool-result img'));
  const rows=await api('resources.list');result.coverMetadata=rows.some(row=>row.derivation?.title==='让每一步，都有依据'&&row.derivation.period==='PY / 111');
  const transformed=await api('resources.transform',{resource_id:original.resource_id,content_hash:original.content_hash,crop:[0,0,400,300],redactions:[[20,20,60,60]],reason:'桌面验收：保留原图、生成裁切遮挡版本'});result.crop=transformed.width===400&&transformed.height===300;
  const reminder=await api('reminders.save',{title:'桌面验收提醒',due_at:new Date(Date.now()-1000).toISOString()});result.reminder=reminder.some(row=>row.due&&row.title==='桌面验收提醒');
  for(const row of reminder.filter(row=>row.title==='桌面验收提醒'))await api('reminders.dismiss',{reminder_id:row.reminder_id});
  // The preceding publication/outline tests intentionally finish in another account.
  // Exercise article tools against the account that owns the completed demo article.
  await useBootstrap(await api('accounts.switch',{account_id:'ice-loop'}),'tools');
  const job=(await api('jobs.list')).find(row=>row.state==='completed'&&!row.image_only);if(!job)throw Error('无完整文章');
  const clipboard=await window.ice.copyArticle(job.job_id);result.richClipboard=clipboard.ok;result.clipboardHTML=clipboard.html_verified===true;
  result.richContentReady=clipboard.image_count>0&&(clipboard.ok||clipboard.html.includes('data:image/')&&clipboard.html.includes('style='));
  if(!clipboard.ok){const dialog=showCopyFallback(clipboard);result.clipboardFallback=Boolean(dialog.querySelector('#manual-copy-content img'));dialog.close();}
  const capture=await window.ice.captureArticle(job.job_id);result.articleCapture=capture.capture.capture_mode==='web'&&capture.width>0;
  try{const web=await window.ice.captureWeb('https://example.com','body');result.publicWebCapture=web.width>0;}catch(error){result.publicWebCapture=false;result.publicWebError=error.message;}
  let data=await api('jobs.get',{job_id:job.job_id});let slot=data.slots.find(row=>row.kind==='cover');
  if(!slot.selected_candidate){
    const resource=(await api('resources.list'))[0];if(!resource)throw Error('原公众号没有验收资源');
    await api('resources.use',{job_id:job.job_id,figure_no:slot.figure_no,resource_id:resource.resource_id,content_hash:resource.content_hash,slot_hash:slot.content_hash});
    data=await api('jobs.get',{job_id:job.job_id});slot=data.slots.find(row=>row.kind==='cover');
  }
  const selected=slot.selected_candidate;if(!selected)throw Error('验收封面未选用');
  await api('assets.redo',{job_id:job.job_id,figure_no:slot.figure_no,content_hash:slot.content_hash,prompt:'Use case: self-test cover. Flat editorial, accurate title added locally; no 3D.'});
  const redo=await api('jobs.get',{job_id:job.job_id});result.singleSlotRedo=redo.slots.find(row=>row.figure_no===slot.figure_no).selected_candidate===null&&redo.slots.filter(row=>row.figure_no!==slot.figure_no).every(row=>row.selected_candidate===data.slots.find(old=>old.figure_no===row.figure_no).selected_candidate);
  await api('assets.select',{job_id:job.job_id,candidate_id:selected});await api('articles.finalize',{job_id:job.job_id});
  result.diagnostics=Boolean((await api('tools.diagnostics')).file_path);
  ui.view='tools';await renderWorkbench();result.toolsUI=Boolean(document.querySelector('#rule-tool-form')&&document.querySelector('#web-capture-form')&&document.querySelector('#execution-tool-form'));
  return result;
};
