'use strict';
const candidateNames={pending:'待审核',accepted:'已接受',rejected:'已否决'};
function candidateReviewRows(data,slot,blocked){
  return `<div class="candidate-review-list">${slot.candidates.map((candidate,index)=>`<div class="candidate-review-row"><div><strong>候选 ${index+1} · ${esc(candidateNames[candidate.review_status]||candidate.review_status)}</strong><p>${esc(candidate.review_note||'预览图片后，决定是否用于这个图位。')}</p></div><div class="button-row"><button class="button secondary small" data-supp-action="candidate" data-job-id="${esc(data.job.job_id)}" data-candidate="${esc(candidate.candidate_id)}" ${blocked?'disabled':''}>预览与审核</button></div></div>`).join('')}</div>`;
}
function supplementPlanBar(data){return `<div class="supplement-banner"><div><span class="eyebrow">IMAGE ONLY</span><h3>文字留在原稿，配图在这里完善。</h3><p>修改图注、截图/生图类型与提示词，或选择新插图位置。改动图位要求后，需要重新选用图片。</p></div><button class="button secondary" data-supp-action="plan" data-job-id="${esc(data.job.job_id)}">编辑配图计划 →</button></div>`;}
function supplementContext(data){
  return `<div class="side-panel"><div class="panel-heading">已有文章补图</div><ol class="step-list"><li class="done"><span class="step-dot">✓</span><div>保留原稿快照<div class="step-sub">标题、期号、文字和代码只读</div></div></li><li class="current"><span class="step-dot">02</span><div>逐张准备与审核<div class="step-sub">截图 / 已有资源 / 手动 TapNow</div></div></li><li class="${data.export.folder?'done':''}"><span class="step-dot">03</span><div>另存补图候选<div class="step-sub">原文件保持不变</div></div></li></ol><div class="panel-foot">正文事实和发布审核仍需单独完成。<br>补图不会推进栏目期号。</div></div><div class="side-panel context-panel"><div class="panel-heading">原稿与证据</div><p class="supplement-path">${esc(data.supplement.source.original_path)}</p><p class="muted">原文件 SHA256</p><code class="supplement-digest">${esc(data.supplement.source.sha256)}</code><p class="muted">${data.supplement.source_status==='unchanged'?'原文件与导入快照一致。':'原文件已修改或移走，当前任务仍基于导入时的快照。'}</p><p class="muted">${data.slots.filter(slot=>slot.valid).length} / ${data.slots.length} 张配图已选用 · ${Object.keys(data.runs).length} 条真实执行</p></div>`;
}
function supplementTaskFlow(job){return `<div class="side-panel"><div class="panel-heading">原稿补图流程 <span class="eyebrow">01—03</span></div><ol class="step-list"><li class="done"><span class="step-dot">✓</span><div>保留原稿<div class="step-sub">文字、标题和期号不改写</div></div></li><li class="${job.readiness==='images_ready'?'done':'current'}"><span class="step-dot">02</span><div>准备并审核配图<div class="step-sub">截图 / 资源复用 / 手动 TapNow</div></div></li><li><span class="step-dot">03</span><div>另存补图候选<div class="step-sub">正文仍需单独审核</div></div></li></ol></div>`;}
function supplementEvidence(data){return `<div class="supplement-banner"><div><h3>为截图运行原稿示例</h3><p>只执行你选中的 Python / Java 片段，结果用于截图。原稿中的文字和声称的运行输出不会被自动改写或核验。</p></div>${data.supplement.codes.length?`<button class="button secondary" data-supp-action="execute" data-job-id="${esc(data.job.job_id)}">审阅并执行示例 →</button>`:'<span class="muted">没有可执行的 Python / Java 围栏</span>'}</div>`;}
function planFields(slot,index,anchors){return `<section class="supplement-plan-row" data-plan-row="${index}"><div class="form-row"><label>图号<input name="figure_no" type="number" min="1" max="999" value="${slot.figure_no}" ${slot.slot_id?'readonly':''}></label><label>图片用途<select name="kind">${[['cover','封面'],['body_ai','AI 插图 / 已有资源'],['body_real','真实运行截图 / 手动截图']].map(([value,label])=>`<option value="${value}" ${slot.kind===value?'selected':''}>${label}</option>`).join('')}</select></label></div><label>图注<input name="caption" maxlength="200" required value="${esc(slot.caption)}"></label>${slot.source_image?'<p class="muted">位置：保留原稿图片行。原有图片行的图注文字也保持原样。</p>':`<label>插图位置<select name="anchor_id">${anchors.map(anchor=>`<option value="${esc(anchor.id)}" ${slot.anchor_id===anchor.id?'selected':''}>${esc(anchor.label)}</option>`).join('')}</select></label>`}<label>TapNow 提示词（截图图位保存时清空）<textarea name="prompt" rows="4" maxlength="10000">${esc(slot.prompt||'')}</textarea></label></section>`;}
async function openSupplementPlan(jobId){
  const data=await api('jobs.get',{job_id:jobId});if(!data.supplement)throw Error('请选择已有文章补图任务');
  const accountId=activeAccount().id,slots=structuredClone(data.slots),anchors=data.supplement.anchors;
  const dialog=visualDialog('supplement-plan','编辑已有文章的配图计划',`<p class="muted">只保存图位要求，不会修改原稿文字。已有图位保留，可添加新的插图位置。</p><form id="supplement-plan-form"><div id="supplement-plan-rows">${slots.map((slot,index)=>planFields(slot,index,anchors)).join('')}</div><button type="button" class="button secondary" id="supplement-add">＋ 添加图位</button><div class="modal-actions"><button class="button primary" type="submit">保存配图计划</button></div><p id="supplement-plan-status" class="muted" role="status"></p></form>`);
  dialog.querySelector('#supplement-add').addEventListener('click',()=>{
    if(slots.length>=32){toast('最多32个图位');return;}
    const used=new Set(Array.from(dialog.querySelectorAll('[name="figure_no"]'),input=>Number(input.value)));let no=1;while(used.has(no))no++;
    const slot={figure_no:no,kind:'body_ai',caption:'新增配图',anchor_id:anchors[0].id,prompt:`Use case: editorial illustration for ${JSON.stringify(data.article.topic)}; canvas ratio: 4:3; palette: ${activeAccount().colors}; in-image text: none; layout: clear focal subject, generous space; style: ${activeAccount().image_style}; no real product logos or invented screenshots.`};
    slots.push(slot);dialog.querySelector('#supplement-plan-rows').insertAdjacentHTML('beforeend',planFields(slot,slots.length-1,anchors));
  });
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try{
      if(activeAccount().id!==accountId)throw Error('公众号已切换，请重新打开计划');
      const values=Array.from(dialog.querySelectorAll('[data-plan-row]'),row=>{
        const original=slots[Number(row.dataset.planRow)];const field=name=>row.querySelector(`[name="${name}"]`)?.value;
        return {slot_id:original.slot_id,figure_no:Number(field('figure_no')),caption:field('caption'),kind:field('kind'),prompt:field('prompt'),anchor_id:original.source_image?null:field('anchor_id')};
      });
      await api('supplements.plan',{job_id:jobId,plan_hash:data.supplement.plan_hash,slots:values});
      dialog.close();await afterVisualMutation(jobId);toast('配图计划已保存，原稿保持只读');
    }catch(error){dialog.querySelector('#supplement-plan-status').textContent=error.message;}finally{button.disabled=false;}
  },{signal:dialogAbort(dialog)});
}
async function openCandidateReview(jobId,candidateId){
  const data=await api('jobs.get',{job_id:jobId}),slot=data.slots.find(slot=>slot.candidates.some(row=>row.candidate_id===candidateId));
  if(!slot)throw Error('候选不存在，请刷新');const candidate=slot.candidates.find(row=>row.candidate_id===candidateId);
  const preview=await api('assets.preview',{job_id:jobId,candidate_id:candidateId});
  const dialog=visualDialog('candidate-review','审阅这张配图',`<p class="muted">图${slot.figure_no} · ${esc(slot.caption)} · ${esc(candidateNames[candidate.review_status])}</p><img class="candidate-full-image" src="${esc(preview)}" alt="${esc(slot.caption)}"><form id="candidate-review-form"><label>审核说明 / 否决原因<textarea name="note" rows="3" maxlength="1000" placeholder="否决时请说明需要改进的地方">${esc(candidate.review_note||'')}</textarea></label><div class="modal-actions"><button class="button secondary" type="submit" value="rejected">否决这张图片</button><button class="button primary" type="submit" value="accepted">接受并选用</button></div><p class="muted" id="candidate-review-status" role="status">旧候选和审核原因会保留。否决当前采用的图片后，该图位恢复为待准备。</p></form>`);
  const candidateImage=dialog.querySelector('.candidate-full-image');candidateImage.dataset.candidateId=candidateId;candidateImage.dataset.imageJob=jobId;
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const decision=event.submitter.value,buttons=Array.from(event.target.querySelectorAll('button'));buttons.forEach(button=>button.disabled=true);
    try{await api('assets.review',{job_id:jobId,candidate_id:candidateId,content_hash:candidate.content_hash,slot_hash:slot.content_hash,decision,note:event.target.elements.note.value});dialog.close();await afterVisualMutation(jobId);toast(decision==='accepted'?'已接受并选用图片':'已否决，旧图片与原因保留');}
    catch(error){dialog.querySelector('#candidate-review-status').textContent=error.message;}finally{buttons.forEach(button=>button.disabled=false);}
  },{signal:dialogAbort(dialog)});
}
async function openSupplementExecution(jobId){
  const data=await api('jobs.get',{job_id:jobId});if(!data.supplement?.codes.length)throw Error('没有可执行的原稿代码');
  const dialog=visualDialog('supplement-execution','准备原稿示例运行',`<p class="muted">只执行选中的片段。它在本机运行，请先检查源码；静态扫描不能替代完整沙箱。</p><form id="supplement-execution-form"><label>代码片段<select name="code_index">${data.supplement.codes.map(code=>`<option value="${code.index}">${esc(code.filename)} · ${esc(code.language)}</option>`).join('')}</select></label><label>示例输入（按实际交互每行一项）<textarea name="stdin" maxlength="4000" rows="4"></textarea></label><div class="modal-actions"><button class="button secondary" type="submit">预览源码与输入 →</button></div></form><div id="supplement-execution-review"></div>`);
  const signal=dialogAbort(dialog);
  dialog.querySelector('[name="stdin"]').closest('label').insertAdjacentHTML('afterend','<label class="checkbox-label"><input name="expect_failure" type="checkbox">这段代码用于展示预期报错（仍会真实执行并保留错误）</label>');
  dialog.querySelector('#supplement-execution-form').addEventListener('input',()=>dialog.querySelector('#supplement-execution-review').replaceChildren(),{signal});
  dialog.querySelector('#supplement-execution-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try{
      const request=await api('supplements.prepare',{job_id:jobId,code_index:Number(event.target.elements.code_index.value),stdin:event.target.elements.stdin.value,expect_failure:event.target.elements.expect_failure.checked});
      const root=dialog.querySelector('#supplement-execution-review');
      root.innerHTML=`<div class="review-panel"><h3>${esc(request.filename)}</h3><pre class="run-output">${esc(request.source)}</pre><p class="muted">示例输入</p><pre class="run-output">${esc(request.stdin||'（空）')}</pre><form id="supplement-run-confirm"><label class="checkbox-label"><input type="checkbox" name="reviewed" required>我已检查上述源码和输入，允许本次在本机执行。</label><div class="modal-actions"><button class="button primary" type="submit">执行这一段示例</button></div><p class="muted" id="supplement-run-status" role="status"></p></form></div>`;
      if(request.expect_failure)root.querySelector('h3').insertAdjacentHTML('afterend','<p class="muted">本次已明确标为教学报错素材：只有真实报错才符合预期；超时和输出超限仍不通过。</p>');
      root.querySelector('form').addEventListener('submit',async runEvent=>{
        runEvent.preventDefault();const runButton=runEvent.submitter;runButton.disabled=true;
        try{await api('supplements.execute',{job_id:jobId,code_index:request.index,content_hash:request.content_hash,reviewed:runEvent.target.elements.reviewed.checked});dialog.close();await afterVisualMutation(jobId);toast('真实运行记录已保存，可到截图图位让 Agent 截图');}
        catch(error){root.querySelector('#supplement-run-status').textContent=error.message;}finally{runButton.disabled=false;}
      },{signal});
    }catch(error){toast(error.message);}finally{button.disabled=false;}
  },{signal});
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-supp-action]');if(!button)return;button.disabled=true;
  try{
    const action=button.dataset.suppAction,jobId=button.dataset.jobId||ui.currentJob;
    if(action==='import'){const job=await window.ice.importArticle(activeAccount().id);if(job){await openJob(job.job_id);ui.tab='assets';renderDetail();}}
    else if(action==='library'){const job=await api('supplements.from_library',{folder:button.dataset.folder,source_hash:button.dataset.sourceHash,account_id:activeAccount().id});await openJob(job.job_id);ui.tab='assets';renderDetail();}
    else if(action==='plan')await openSupplementPlan(jobId);
    else if(action==='candidate')await openCandidateReview(jobId,button.dataset.candidate);
    else if(action==='execute')await openSupplementExecution(jobId);
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});

window.__ICE_SUPPLEMENT_SMOKE__=async function(folder){
  const wait=async(test,label)=>{const until=Date.now()+60000;let notice='';while(Date.now()<until){if(await test())return;notice=document.querySelector('#toast')?.textContent||notice;await new Promise(resolve=>setTimeout(resolve,70));}throw Error('补图桌面验收超时：'+label+'；最近提示：'+notice);};
  newDialog.close();changeView('library');await renderLibrary();
  document.querySelector(`[data-library="${folder}"]`).click();
  await wait(()=>Boolean(document.querySelector('[data-supp-action="library"]')),'只读存稿入口');
  document.querySelector('[data-supp-action="library"]').click();
  await wait(()=>Boolean(ui.detail?.supplement),'创建补图任务');
  const jobId=ui.currentJob;
  await openJob(jobId);ui.mode='edit';ui.tab='article';renderDetail();
  const readonly=document.querySelector('#body-editor').readOnly&&!document.querySelector('[data-action="save-body"]');
  ui.mode='preview';ui.tab='assets';renderDetail();
  const manualTapNow=Boolean(document.querySelector('[data-v-action="copy-prompt"]'))&&Boolean(document.querySelector('[data-v-action="open-tapnow"]'));
  await openSupplementPlan(jobId);
  const plan=document.querySelector('#supplement-plan-form');plan.querySelector('[name="prompt"]').value='Use case: edited cover; palette: publication colors; no lettering.';
  document.querySelector('#supplement-add').click();
  plan.querySelectorAll('[name="caption"]')[2].value='已有资源补充插图';
  plan.requestSubmit(plan.querySelector('[type="submit"]'));
  await wait(()=>!document.querySelector('#supplement-plan').open,'编辑图位');
  await openJob(jobId);ui.tab='assets';renderDetail();
  let current=await api('jobs.get',{job_id:jobId});
  const planEdited=current.slots.length===3&&current.slots[0].prompt.includes('edited cover');
  const candidate=current.slots[0].candidates[0].candidate_id;
  const decide=async(decision,note)=>{
    await openCandidateReview(jobId,candidate);
    const form=document.querySelector('#candidate-review-form');form.elements.note.value=note;
    form.requestSubmit(form.querySelector(`[value="${decision}"]`));
    await wait(()=>!document.querySelector('#candidate-review').open,'单图'+decision);
  };
  await decide('accepted','检查后选用');await decide('rejected','本轮测试保留否决说明');
  current=await api('jobs.get',{job_id:jobId});
  const rejected=current.slots[0].selected_candidate===null&&current.slots[0].candidates[0].review_note.includes('否决说明');
  await decide('accepted','重新审阅后采用');
  await openSupplementExecution(jobId);
  const preparation=document.querySelector('#supplement-execution-form');preparation.elements.stdin.value='第一版输入';
  preparation.requestSubmit(preparation.querySelector('[type="submit"]'));
  await wait(()=>Boolean(document.querySelector('#supplement-run-confirm')),'第一次源码预览');
  preparation.elements.stdin.value='重新审阅的输入';preparation.elements.stdin.dispatchEvent(new Event('input',{bubbles:true}));
  const cleared=!document.querySelector('#supplement-run-confirm');
  preparation.requestSubmit(preparation.querySelector('[type="submit"]'));
  await wait(()=>document.querySelector('#supplement-execution-review').textContent.includes('重新审阅的输入'),'第二次源码预览');
  const runForm=document.querySelector('#supplement-run-confirm');runForm.elements.reviewed.checked=true;
  runForm.requestSubmit(runForm.querySelector('[type="submit"]'));
  await wait(()=>!document.querySelector('#supplement-execution').open,'真实执行');
  current=await api('jobs.get',{job_id:jobId});
  const actualRun=current.runs['supplement-1'].stdout.includes('重新审阅的输入')&&current.runs['supplement-1'].exit_code===0;
  await openRunCapture(jobId,2);
  const capture=document.querySelector('#run-capture-form');capture.requestSubmit(capture.querySelector('[type="submit"]'));
  await wait(()=>!document.querySelector('#run-capture-dialog').open,'真实运行截图');
  await openRecommendations(jobId,3);
  const recommendation=document.querySelector('#visual-recommend [data-rec-id]');if(!recommendation)throw Error('补图资源复用没有推荐结果');recommendation.click();
  await wait(()=>!document.querySelector('#visual-recommend').open,'复用资源');
  const exported=await api('articles.finalize',{job_id:jobId});
  await openJob(jobId);ui.tab='assets';renderDetail();
  current=await api('jobs.get',{job_id:jobId});
  return {job_id:jobId,readonly,manualTapNow,planEdited,rejected,reaccepted:current.slots[0].valid,
    cleared,actualRun,screenshot:current.slots[1].valid&&current.slots[1].candidates[0].source==='run_capture',
    resourceReuse:current.slots[2].valid,noModelCalls:current.invocations.length===0,
    stillNeedsTextReview:exported.readiness==='images_ready'&&current.report.ready===false,
    export_folder:exported.export.folder,source_hash:current.supplement.source.sha256,
    screenshot_file:current.slots[1].candidates[0].file_path};
};
