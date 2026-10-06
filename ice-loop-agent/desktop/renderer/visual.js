'use strict';
const visualState = {resources:[],accountId:'',jobId:'',pipelineToken:0,renderToken:0};
const usageLabels = {cover:'封面',illustration:'插图',screenshot:'截图',reference:'视觉参考'};
function promptForSlot(data,slot){return slot.kind==='body_real'?'':slot.prompt||(slot.kind==='cover'?data.cover_prompt:'')||'';}
function resourceSearchText(resource){return [resource.title,resource.description,...(resource.tags||[]),resource.visual_analysis?.summary,resource.visual_analysis?.style].filter(Boolean).join(' ').toLocaleLowerCase();}
function visualCard(resource){
  const report=resource.visual_analysis,analysis=resource.analysis;
  return `<article class="asset-card" data-resource="${esc(resource.resource_id)}"><div class="asset-visual"><img alt="${esc(resource.title)}" data-resource-image="${esc(resource.resource_id)}"></div><div class="asset-info"><div class="visual-card-heading"><h3>${esc(resource.title)}</h3><span class="badge">${usageLabels[resource.usage]||'待标注'}${resource.style_reference?' · 风格参考':''}</span></div><p>${resource.width} × ${resource.height} · 已归档副本</p><p>${esc(resource.description||'添加用途说明，让下一篇更容易找到合适的图。')}</p><div class="resource-tags">${(resource.tags||[]).map(tag=>`<span>${esc(tag)}</span>`).join('')}</div><div class="resource-label">实际像素主色</div>${paletteHTML(resource.palette)}
  ${report?`<details class="visual-report"><summary>AI 识图记录 · ${esc(report.model)}</summary><p>${esc(report.summary)}</p><dl><dt>风格</dt><dd>${esc(report.style)}</dd><dt>构图</dt><dd>${esc(report.composition)}</dd><dt>可见文字（待核对）</dt><dd>${esc(report.visible_text||'未识别到清楚文字')}</dd><dt>分析边界</dt><dd>${esc(report.limitations||'内容、文字与用途仍需人工审阅。')}</dd></dl></details>`:''}
  ${analysis?`<div class="resource-analysis"><div class="resource-label">AI 主题配色建议</div>${paletteHTML(analysis.theme_colors)}<p>${esc(analysis.explanation)}</p><label>应用前可修改色值<input class="resource-colors" value="${esc(analysis.theme_colors.join(', '))}" maxlength="100"></label><button class="button primary small" data-pub-action="apply-palette" data-id="${esc(resource.resource_id)}">应用到当前公众号</button></div>`:''}
  <div class="button-row"><button class="button secondary small" data-v-action="edit-resource" data-id="${esc(resource.resource_id)}">编辑说明</button><button class="button secondary small" data-v-action="vision-resource" data-id="${esc(resource.resource_id)}">AI 识图分析 ↗</button><button class="button secondary small" data-pub-action="analyze-resource" data-id="${esc(resource.resource_id)}">分析色值</button><button class="button secondary small" data-pub-action="use-resource" data-id="${esc(resource.resource_id)}">用于文章</button></div><p class="resource-caption">识图分析发送压缩图片；分析色值仅发送色值和定位。两者均由你点击后调用模型。</p></div></article>`;
}
function filterVisualResources(){
  const query=document.querySelector('#resource-search')?.value.trim().toLocaleLowerCase()||'',usage=document.querySelector('#resource-usage-filter')?.value||'';
  let count=0;
  for(const card of workspace.querySelectorAll('[data-resource]')){
    const resource=visualState.resources.find(row=>row.resource_id===card.dataset.resource);
    card.hidden=Boolean((usage&&resource.usage!==usage)||(query&&!resourceSearchText(resource).includes(query)));if(!card.hidden)count++;
  }
  const node=document.querySelector('#resource-count');if(node)node.textContent=`${count} / ${visualState.resources.length} 项资源`;
}
async function renderVisualResources(){
  const token=++visualState.renderToken,aid=activeAccount().id,resources=await api('resources.list');
  if(token!==visualState.renderToken||ui.view!=='resources'||activeAccount().id!==aid)return;
  if(visualState.accountId!==aid){visualState.jobId='';visualState.accountId=aid;}
  visualState.resources=resources;
  workspace.innerHTML=pageHeading('IMAGES WITH A PURPOSE','配图资源箱','真实截图交给 Agent，生图提示词带到 TapNow。归档后继续编辑、分析和复用。',`<div class="button-row"><button class="button secondary" data-v-action="open-tapnow">打开 TapNow ↗</button><button class="button primary" data-pub-action="import-resource">＋ 导入图片</button>${activeAccount().preset==='ice-loop'?'<button class="button secondary" data-v-action="import-ice-style">导入 ICE Loop 风格包</button>':''}</div>`)+
  `<section class="visual-workbench"><div class="visual-intro"><div><span class="eyebrow">01 / PREPARE</span><h2>按文章准备每一张图</h2><p>选择图位 → 截取真实运行记录，或复制提示词到 TapNow → 导入结果并选用。</p></div><label>文章任务<select id="visual-job"><option value="">选择一篇文章</option>${ui.jobs.map(job=>`<option value="${esc(job.job_id)}" ${job.job_id===visualState.jobId?'selected':''}>${esc(job.final_title||job.topic)}</option>`).join('')}</select></label></div><div id="visual-pipeline" role="status"><p class="muted">先选择已经生成配图计划的文章。</p></div></section>
  <div class="section-bar"><h2>已归档资源</h2><button class="button text-button" data-pub-action="analyze-all-resources">综合分析主题配色 ↗</button></div><div class="resource-toolbar"><label>搜索图片<input id="resource-search" type="search" placeholder="标题、标签、内容或风格"></label><label>用途<select id="resource-usage-filter"><option value="">全部用途</option>${Object.entries(usageLabels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><span id="resource-count" class="muted">${resources.length} 项资源</span></div><div class="asset-grid resource-grid">${resources.map(visualCard).join('')||'<div class="empty-state"><h3>给内容，积累自己的视觉语言。</h3><p>导入封面、参考图，或选择文章让 Agent 准备运行截图。支持 PNG、JPEG、WebP。</p></div>'}</div>`;
  paintPalettes();
  document.querySelector('#resource-search').addEventListener('input',filterVisualResources);
  document.querySelector('#resource-usage-filter').addEventListener('change',filterVisualResources);
  document.querySelector('#visual-job').addEventListener('change',loadVisualPipeline);
  await Promise.allSettled([loadVisualPipeline(),...resources.map(async resource=>{
    const preview=await api('resources.preview',{resource_id:resource.resource_id});if(ui.view!=='resources'||activeAccount().id!==aid)return;
    const image=workspace.querySelector(`[data-resource-image="${resource.resource_id}"]`);if(image)image.src=preview.data_url;
  })]);
}
async function loadVisualPipeline(){
  const token=++visualState.pipelineToken,select=document.querySelector('#visual-job'),root=document.querySelector('#visual-pipeline');
  if(!select||!root)return;visualState.jobId=select.value;const jobId=select.value;
  if(!jobId){root.dataset.state='idle';root.innerHTML='<p class="muted">选择文章后会列出截图与生图图位。</p>';return;}
  root.dataset.state='loading';root.textContent='正在读取配图计划…';
  try{
    const data=await api('jobs.get',{job_id:jobId});
    if(token!==visualState.pipelineToken||!root.isConnected||select.value!==jobId)return;
    const blocked=data.job.lease||data.pending_approval?.scope==='asset_plan';
    root.innerHTML=(blocked?'<p class="visual-notice">请先完成当前任务和配图计划审核，再准备素材。</p>':'')+`<div class="visual-slot-list">${data.slots.map(slot=>visualSlotActions(data,slot,Boolean(blocked))).join('')||'<p class="muted">本文还没有配图计划，请到文章工作区完成前面的审核。</p>'}</div>`;
    root.dataset.state='ready';
  }catch(error){if(root.isConnected&&token===visualState.pipelineToken){root.textContent=error.message;root.dataset.state='error';}}
}
function visualSlotActions(data,slot,blocked=false){
  const jobId=data.job.job_id,prompt=promptForSlot(data,slot),real=slot.kind==='body_real';
  return `<section class="visual-slot"><div><span class="eyebrow">FIGURE ${String(slot.figure_no).padStart(2,'0')} / ${real?'EXECUTION':'TAPNOW'}</span><h3>${esc(slot.caption)}</h3><p>${slot.valid?'当前图片已选用':'尚未选用图片'} · ${real?'从已执行记录截图，其他界面可手动导入':'复制完整提示词，在 TapNow 手动生成'}</p></div><div class="button-row">${real?`<button class="button primary small" data-v-action="capture-run" data-job-id="${esc(jobId)}" data-figure="${slot.figure_no}" ${blocked?'disabled':''}>Agent 截图</button>`:`<button class="button secondary small" data-v-action="edit-prompt" data-job-id="${esc(jobId)}" data-figure="${slot.figure_no}" ${blocked?'disabled':''}>拟写 / 编辑提示词</button><button class="button primary small" data-v-action="copy-prompt" data-job-id="${esc(jobId)}" data-figure="${slot.figure_no}" ${blocked||!prompt?'disabled':''}>复制提示词</button><button class="button secondary small" data-v-action="open-tapnow">打开 TapNow ↗</button>`}<button class="button secondary small" data-v-action="import-slot" data-job-id="${esc(jobId)}" data-figure="${slot.figure_no}" ${blocked?'disabled':''}>导入并选用</button><button class="button text-button small" data-v-action="recommend" data-job-id="${esc(jobId)}" data-figure="${slot.figure_no}" ${blocked?'disabled':''}>推荐已有资源</button></div>${prompt?`<details><summary>查看完整生图提示词</summary><pre class="visual-prompt">${esc(prompt)}</pre></details>`:''}</section>`;
}
function visualDialog(id,title,content){
  let dialog=document.getElementById(id);if(!dialog){dialog=document.createElement('dialog');dialog.id=id;dialog.className='modal visual-modal';document.body.append(dialog);}
  dialog.innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" type="button" data-v-action="close-dialog" aria-label="关闭">×</button></div>${content}`;
  dialog.showModal();return dialog;
}
function openMetadata(resource){
  const dialog=visualDialog('visual-edit','编辑资源说明',`<form id="resource-edit-form"><label>图片标题<input name="title" required maxlength="100" value="${esc(resource.title)}"></label><label>内容与用途说明<textarea name="description" maxlength="1000" rows="4">${esc(resource.description||'')}</textarea></label><div class="form-row"><label>检索标签（逗号分隔，最多12个）<input name="tags" value="${esc((resource.tags||[]).join(', '))}"></label><label>主要用途<select name="usage">${Object.entries(usageLabels).map(([key,label])=>`<option value="${key}" ${(resource.usage||'reference')===key?'selected':''}>${label}</option>`).join('')}</select></label></div><label class="brief-replace"><input name="style_reference" type="checkbox" ${resource.style_reference?'checked':''}>用作当前公众号的生图风格参考（最多8张）</label><p class="muted">你保存的说明和标签会保留，后续 AI 分析不会覆盖已有内容。</p><div class="modal-actions"><button type="submit" class="button primary">保存说明</button></div></form>`);
  const accountId=activeAccount().id;
  dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter||event.target.querySelector('[type="submit"]');button.disabled=true;
    try{const fields=Object.fromEntries(new FormData(event.target));await api('resources.update',{...fields,style_reference:event.target.elements.style_reference.checked,tags:fields.tags.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean),account_id:accountId,resource_id:resource.resource_id,content_hash:resource.content_hash});dialog.close();await renderResources();toast('资源说明已保存');}catch(error){toast(error.message);}finally{button.disabled=false;}
  });
}
async function openPromptEditor(jobId,figureNo){
  const accountId=activeAccount().id,data=await api('jobs.get',{job_id:jobId}),slot=data.slots.find(row=>row.figure_no===figureNo);
  if(!slot||slot.kind==='body_real'||data.job.lease||data.pending_approval?.scope==='asset_plan')throw Error('请先确认生图图位，并等待当前任务结束');
  const params={account_id:accountId,job_id:jobId,figure_no:figureNo,content_hash:slot.content_hash,body_hash:data.body_hash};
  const referenceData=await api('prompts.references',params);
  if(activeAccount().id!==accountId)throw Error('公众号已切换，请重新打开提示词');
  const dialog=visualDialog('prompt-editor','为这张图，写一份具体的提示词',`<span class="eyebrow">FIGURE ${figureNo} / MANUAL TAPNOW</span><p>${esc(slot.caption)}</p><p class="muted">AI重拟读取当前公众号视觉规范与标记的风格参考说明，并结合本文内容。参考图仍需你在TapNow上传。保存提示词保留已选图片；需要换图时再导入新结果。</p><form><textarea name="prompt" rows="12" maxlength="30000" required spellcheck="false">${esc(promptForSlot(data,slot))}</textarea><p class="brief-status" role="status"></p><div class="button-row"><button type="button" class="button secondary" data-prompt-generate>根据文章与风格 AI 重拟 ↗</button><button type="submit" class="button primary">保存我的提示词</button></div></form>`);
  const form=dialog.querySelector('form'),input=form.elements.prompt,status=form.querySelector('[role="status"]'),generateButton=form.querySelector('[data-prompt-generate]'),save=form.querySelector('[type="submit"]');
  const references=document.createElement('section');references.className='prompt-references';references.setAttribute('aria-label','TapNow 参考图上传顺序');
  references.innerHTML='<strong>在 TapNow 按以下顺序上传参考图</strong><ol>'+referenceData.references.map(row=>`<li><span class="prompt-reference-image">${row.resource_id?`<img data-prompt-reference="${esc(row.resource_id)}" alt="${esc(row.title)}">`:''}</span><div><b>图片 ${row.image} · ${{template:'编辑底图',identity:'品牌身份参考',style:'风格参考'}[row.role]||'参考图'}</b><span>${esc(row.filename||row.title)}</span></div></li>`).join('')+'</ol><p class="muted">封面只改标题与期号，沿用原图版式；正文图不放大品牌标志。参考图需要在 TapNow 手动上传，复制文字不会附带图片。原始资产可在配图资源箱查看。</p>';
  form.before(references);
  const budgetRow=document.createElement('div');budgetRow.className='prompt-budget-row';
  budgetRow.innerHTML=`<span data-prompt-budget-status>正在读取本篇预算…</span><button type="button" class="button secondary small" data-budget-open data-budget-job="${esc(jobId)}">调整本篇预算</button>`;
  form.before(budgetRow);
  async function refreshPromptBudget(){
    try{const budget=await api('budgets.get',{job_id:jobId,account_id:accountId});
      if(dialog.open&&activeAccount().id===accountId)budgetRow.querySelector('[data-prompt-budget-status]').textContent=`本篇已用 ${budget.job.used} / ${budget.job.limit} 次 · 剩余 ${budget.job.remaining} 次`;
    }catch(error){if(dialog.open&&activeAccount().id===accountId)budgetRow.querySelector('[data-prompt-budget-status]').textContent=error.message;}
  }
  await refreshPromptBudget();
  await Promise.allSettled(referenceData.references.filter(row=>row.resource_id).map(async row=>{
    const preview=await api('resources.preview',{resource_id:row.resource_id});
    const image=references.querySelector(`[data-prompt-reference="${row.resource_id}"]`);
    if(image&&dialog.open&&activeAccount().id===accountId)image.src=preview.data_url;
  }));
  let edits=0,busy=false;input.addEventListener('input',()=>edits++);
  generateButton.addEventListener('click',async()=>{
    if(busy)return;const version=edits;busy=true;generateButton.disabled=true;save.disabled=true;status.dataset.tone='';status.textContent='正在拟写，可能计费。你仍可修改，返回结果会保护你的新编辑…';
    try{
      const result=await api('prompts.generate',params);
      if(!dialog.open||activeAccount().id!==accountId)return;
      if(edits!==version){status.textContent='你已继续编辑，AI结果未覆盖。可复制下方候选自行合并。';const candidate=document.createElement('textarea');candidate.readOnly=true;candidate.rows=6;candidate.value=result.prompt;candidate.setAttribute('aria-label','未覆盖你的编辑的AI候选');form.append(candidate);}
      else {input.value=result.prompt;status.textContent=`候选来自 ${result.model}；可继续修改，点击保存后生效。`;}
    }catch(error){status.textContent=window.iceControls?.isBudgetError(error)?'本篇调用预算已用完。点击「调整本篇预算」，保存后可重新拟写；你的编辑保持原样。':error.message;status.dataset.tone='error';}finally{busy=false;generateButton.disabled=false;save.disabled=false;await refreshPromptBudget();}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;save.disabled=true;
    try{await api('prompts.save',{...params,prompt:input.value});dialog.close();await afterVisualMutation(jobId);toast('提示词已保存，已选图片保留。现在可复制到TapNow');}
    catch(error){status.textContent=error.message;}finally{save.disabled=false;}
  });
}
async function openRunCapture(jobId,figureNo){
  const data=await api('jobs.get',{job_id:jobId}),keys=Object.keys(data.runs).filter(key=>{const run=data.runs[key];return !run.timed_out&&run.runtime?.output_limited!=='true'&&(run.exit_code===0||run.verdict==='expected_failure_ok');});
  if(!keys.length)throw Error('本篇尚无通过的运行记录。请补充示例输入并重新执行；意外失败和超时记录不能直接作为就绪配图。');
  const dialog=visualDialog('run-capture-dialog','让 Agent 截取运行记录',`<p class="muted">程序会将本篇已执行的源码、输入、输出与退出码显示在独立窗口，再截图并归档到当前图位和资源箱。请核对与图位说明的对应关系。</p><form id="run-capture-form"><label>截图内容<select name="run_key">${keys.map(key=>`<option value="${esc(key)}">${esc(data.runs[key].filename)} · exit ${data.runs[key].exit_code}</option>`).join('')}${keys.length>1?'<option value="">本篇全部运行记录</option>':''}</select></label><div class="modal-actions"><button class="button primary" type="submit">截图、归档并选用</button></div><p class="muted" role="status" id="run-capture-status"></p></form>`);
  dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter||event.target.querySelector('[type="submit"]');button.disabled=true;
    try{document.querySelector('#run-capture-status').textContent='正在截取并归档…';const key=event.target.elements.run_key.value;await window.ice.captureRun(jobId,figureNo,key?[key]:keys);dialog.close();await afterVisualMutation(jobId);toast('真实运行截图已选入图位，并存入资源箱');}
    catch(error){document.querySelector('#run-capture-status').textContent=error.message;}finally{button.disabled=false;}
  });
}
async function afterVisualMutation(jobId){
  if(ui.currentJob===jobId){ui.fingerprint='';await refresh();}
  else if(ui.view==='resources')await renderResources();
}
async function openRecommendations(jobId,figureNo){
  const result=await api('resources.recommend',{job_id:jobId,figure_no:figureNo});
  const dialog=visualDialog('visual-recommend','从资源箱寻找合适的图片',`<p class="muted">按已标注内容、用途、比例和配色排序。分数用于相对比较，请预览后选用。</p><div class="recommend-list">${result.recommendations.map(resource=>`<article class="recommend-item"><img data-rec-image="${esc(resource.resource_id)}" alt="${esc(resource.title)}"><div><h3>${esc(resource.title)}</h3><p>${esc(resource.reasons.join(' · '))}</p><span class="muted">匹配评分 ${resource.score} / 100</span><button class="button secondary small" data-rec-id="${esc(resource.resource_id)}">选用此图片</button></div></article>`).join('')||'<p>暂无合适资源；可先添加用途说明，或截图、去 TapNow 生图后导入。</p>'}</div>`);
  const accountId=activeAccount().id;
  dialog.addEventListener('click',async event=>{const button=event.target.closest('[data-rec-id]');if(!button)return;button.disabled=true;
    try{if(activeAccount().id!==accountId)throw Error('公众号已切换，请重新推荐');const resource=result.recommendations.find(row=>row.resource_id===button.dataset.recId);await api('resources.use',{resource_id:resource.resource_id,content_hash:resource.content_hash,slot_hash:result.slot_hash,job_id:jobId,figure_no:figureNo});dialog.close();await afterVisualMutation(jobId);toast('已选用资源，请核对文章图位');}catch(error){toast(error.message);}finally{button.disabled=false;}
  },{signal:dialogAbort(dialog)});
  await Promise.allSettled(result.recommendations.map(async resource=>{const preview=await api('resources.preview',{resource_id:resource.resource_id});const image=dialog.querySelector(`[data-rec-image="${resource.resource_id}"]`);if(image&&dialog.open)image.src=preview.data_url;}));
}
function dialogAbort(dialog){if(dialog._abort)dialog._abort.abort();dialog._abort=new AbortController();dialog.addEventListener('close',()=>dialog._abort.abort(),{once:true});return dialog._abort.signal;}
function visualModelPanel(){
  const config=ui.bootstrap.settings.vision||{provider:'qwen',model_id:'',status:'requires_probe'};
  return `<section class="route-panel visual-model-panel"><span class="eyebrow">VISION / INDEPENDENT MODEL</span><h2>让模型真正读懂图片</h2><p>视觉模型独立配置，与正文模型共享供应商 Key。先测试识图，再到资源箱分析内容、风格与配色。DeepSeek 请用 deepseek-flash；Pro 不支持图片。</p><form id="vision-form"><div class="form-row"><label>供应商<select name="provider">${['qwen','deepseek','bigmodel','kimi','ark','minimax'].map(key=>`<option value="${key}" ${config.provider===key?'selected':''}>${providers[key][1]}</option>`).join('')}</select></label><label>支持图片输入的模型 ID<input name="model_id" value="${esc(config.model_id)}" required maxlength="160" placeholder="DeepSeek 可填 deepseek-flash；其他供应商填视觉模型 ID"></label></div><div class="button-row"><button class="button secondary" type="submit">保存视觉模型</button><button class="button primary" type="button" data-v-action="probe-vision">测试识图 ↗</button><span class="muted">${config.status==='verified'?'识图样例已通过':'尚未通过识图测试'} · 测试会发送一张小图片，可能计费</span></div></form></section>`;
}
function bindVisualModelForm(){document.querySelector('#vision-form')?.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{ui.bootstrap=await api('vision.save',Object.fromEntries(new FormData(event.target)));renderModels();toast('视觉模型配置已保存，正文模型保持原配置');}catch(error){toast(error.message);}finally{button.disabled=false;}});}
if(typeof document!=='undefined')document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-v-action]');if(!button)return;button.disabled=true;
  try{
    const action=button.dataset.vAction,jobId=button.dataset.jobId||ui.currentJob,figureNo=Number(button.dataset.figure);
    if(action==='open-tapnow')await window.ice.openTapNow();
    else if(action==='edit-prompt')await openPromptEditor(jobId,figureNo);
    else if(action==='import-ice-style'){await api('resources.import_style',{account_id:activeAccount().id});await renderResources();toast('7张正式风格资产已导入并设为参考；可在资源说明中取消标记');}
    else if(action==='close-dialog')button.closest('dialog').close();
    else if(action==='edit-resource')openMetadata(visualState.resources.find(row=>row.resource_id===button.dataset.id));
    else if(action==='vision-resource'){
      const accountId=activeAccount().id,resource=visualState.resources.find(row=>row.resource_id===button.dataset.id),original=button.textContent;button.textContent='正在识图…';
      try{await api('resources.vision',{account_id:accountId,resource_id:resource.resource_id,content_hash:resource.content_hash});if(activeAccount().id===accountId)await renderResources();toast('内容、风格与配色建议已生成，可以继续修改说明');}finally{button.textContent=original;}
    }else if(action==='copy-prompt'){
      const data=await api('jobs.get',{job_id:jobId}),slot=data.slots.find(slot=>slot.figure_no===figureNo),prompt=slot&&promptForSlot(data,slot);
      if(data.pending_approval?.scope==='asset_plan')throw Error('请先确认配图计划');if(!prompt)throw Error('当前图位没有可复制的生图提示词');
      const copied=await window.ice.copyText(prompt);if(copied.ok)toast('完整提示词已复制，可在 TapNow 粘贴生图');else showCopyFallback(copied);
    }else if(action==='capture-run')await openRunCapture(jobId,figureNo);
    else if(action==='import-slot'){const result=await window.ice.importImage(jobId,figureNo);if(result){await afterVisualMutation(jobId);toast('图片已选入图位并归档到资源箱');}}
    else if(action==='recommend')await openRecommendations(jobId,figureNo);
    else if(action==='probe-vision'){const form=document.querySelector('#vision-form');if(!form.reportValidity())return;ui.bootstrap=await api('vision.save',Object.fromEntries(new FormData(form)));await api('vision.probe');ui.bootstrap=await api('bootstrap');renderModels();toast('视觉模型已通过识图样例测试');}
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});
if(typeof module!=='undefined')module.exports={promptForSlot,resourceSearchText};
