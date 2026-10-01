'use strict';
const planningState = { token:0, context:null, proposal:null, busy:false, loading:false, episodeTouched:false, autoExercise:'' };
function planningStatus(message, error=false) { const node=document.querySelector('#planning-status'); node.textContent=message; node.classList.toggle('error',error); }
function planningButtons() {
  document.querySelector('#brief-fill').disabled = planningState.busy || planningState.loading || briefState.busy;
  document.querySelector('#planning-propose').disabled = planningState.busy || planningState.loading || briefState.busy || !planningState.context?.next_episode;
  newForm.querySelector('[type="submit"]').disabled = planningState.busy || planningState.loading || briefState.busy || !planningState.context?.next_episode;
}
async function loadPlanningContext(auto=true, request=api) {
  const token=++planningState.token, accountId=activeAccount().id, series=newForm.elements.series.value;
  planningState.context=null; planningState.proposal=null; planningState.loading=true; planningState.busy=false;
  document.querySelector('#planning-candidates').replaceChildren();
  document.querySelector('#planning-context').textContent='正在读取当前栏目的历史文章与发布进度…'; planningButtons();
  try {
    const context=await request('planning.context',{account_id:accountId,series});
    if (token!==planningState.token || !newDialog.open || accountId!==activeAccount().id || series!==newForm.elements.series.value) return;
    planningState.context=context;
    if (auto && !planningState.episodeTouched) newForm.elements.episode.value=context.next_episode ?? '';
    const exercise=newForm.elements.exercise_to_answer;
    if (!exercise.value || exercise.value===planningState.autoExercise) { exercise.value=context.previous_exercise.slice(0,1000); planningState.autoExercise=exercise.value; }
    document.querySelector('#planning-context').textContent = `${series} · 已发布至第 ${context.last_published_episode} 期 → 建议第 ${context.next_episode ?? '—'} 期。${context.published_count} 篇已登记发布，${context.draft_count} 篇草稿。${context.same_episode_drafts ? ' 这一期已有草稿，可先检查是否重复创建。' : ''}${!context.last_published_episode ? ' 尚未登记发布进度，可在发布记录中补充。' : ''}`;
    planningStatus(context.next_episode ? '历史已就绪。AI 拟题后，选择候选并修改下方内容，再确认开始。' : '期号已达上限，请核对发布记录。',!context.next_episode);
  } catch(error) { if(token===planningState.token) planningStatus(error.message,true); }
  finally { if(token===planningState.token) {planningState.loading=false;planningButtons();} }
}
async function openNewArticle({reset=false}={}) {
  if(reset) {newForm.reset(); planningState.autoExercise='';}
  if(ui.series && activeAccount().columns.some(c=>c.code===ui.series)) newForm.elements.series.value=ui.series;
  planningState.episodeTouched=false;
  if(!newDialog.open) newDialog.showModal();
  await loadPlanningContext();
}
function renderPlanningCandidates() {
  const result=planningState.proposal; if(!result)return;
  const refs=new Map(result.history.map(row=>[row.history_id,row]));
  document.querySelector('#planning-candidates').innerHTML=`<p class="planning-analysis">${esc(result.analysis)}</p><div class="planning-list">${result.candidates.map((item,index)=>`<article class="planning-card" data-plan-card="${index}"><div class="planning-card-heading"><span>${index===result.recommended ? '推荐方向' : `候选 ${index+1}`}</span><button type="button" class="button secondary small" data-plan-action="choose" data-index="${index}">采用并编辑</button></div><h3>${esc(item.title)}</h3><p>${esc(item.topic)}</p><p class="planning-reason">${esc(item.reason)}</p>${item.source_ids.length ? `<p class="planning-refs">参考：${item.source_ids.map(id=>esc(refs.get(id)?.title||id)).join(' · ')}</p>` : ''}</article>`).join('')}</div>`;
}
async function proposeHistory(request=api) {
  if(planningState.busy || planningState.loading || briefState.busy || !planningState.context)return;
  if(!newForm.elements.episode.reportValidity())return;
  const token=++planningState.token, accountId=activeAccount().id, fields=Object.fromEntries(new FormData(newForm));
  planningState.busy=true; planningButtons(); document.querySelector('#brief-fill').disabled=true;
  planningStatus('正在分析历史标题、正文与结尾。你可以继续填写，候选不会自动覆盖表单…');
  try {
    const result=await request('planning.propose',{account_id:accountId,fields,context_hash:planningState.context.context_hash});
    if(token!==planningState.token || !newDialog.open || accountId!==activeAccount().id || fields.series!==newForm.elements.series.value || fields.episode!==newForm.elements.episode.value)return;
    planningState.proposal=result; renderPlanningCandidates();
    planningStatus(`已生成 ${result.candidates.length} 个候选，请选择一个，或保留你自己的标题。${result.model ? ` 使用 ${result.model}。` : ''}`);
  } catch(error) {if(token===planningState.token) planningStatus(error.message,true);}
  finally {if(token===planningState.token) {planningState.busy=false;document.querySelector('#brief-fill').disabled=false;planningButtons();}}
}
function choosePlanningCandidate(index) {
  const item=planningState.proposal?.candidates[index];if(!item)return;
  newForm.elements.topic.value=item.title;
  newForm.elements.content_angle.value=item.topic;
  for(const key of ['core_benefit','next_episode_plan']) if(!newForm.elements[key].value || document.querySelector('#brief-replace').checked) newForm.elements[key].value=item[key];
  document.querySelectorAll('[data-plan-card]').forEach(node=>node.classList.toggle('selected',Number(node.dataset.planCard)===index));
  planningStatus('已采用标题。你可以直接改写标题和需求，确认后会以表单内容为准。');
  newForm.elements.topic.focus();
}
function initPlanning() {
  newForm.addEventListener('input',event=>{
    if(event.target.name==='episode') {planningState.episodeTouched=true; planningState.proposal=null; if(!planningState.loading)++planningState.token;planningState.busy=false;document.querySelector('#planning-candidates').replaceChildren();planningButtons();}
  });
  newForm.elements.series.addEventListener('change',()=>{planningState.episodeTouched=false;loadPlanningContext().catch(error=>toast(error.message));});
  newDialog.addEventListener('close',()=>{++planningState.token;planningState.context=null;planningState.proposal=null;planningState.loading=false;planningState.busy=false;});
}
async function renderHistory() {
  const accountId=activeAccount().id;
  const rows=await api('history.list'); if(ui.view!=='history'||activeAccount().id!==accountId)return;
  const columns=activeAccount().columns, today=new Date(), date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const options=selected=>columns.map(c=>`<option value="${esc(c.code)}" ${c.code===selected?'selected':''}>${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  workspace.innerHTML=pageHeading('EDITORIAL MEMORY','下一篇，从已有内容出发。','登记真实发布进度，让选题和系列衔接有据可依。')+`<section class="publication-panel history-progress"><form id="history-progress-form"><div><h3>快速设置已发布进度</h3><p class="muted">已有文章还没导入？先设置期号，之后可在草稿箱导入正文，再逐篇登记。0 表示尚未发布。</p></div><label>栏目<select name="series">${options(columns[0].code)}</select></label><label>已发布到第几期<input name="episode" type="number" required min="0" max="9999"></label><button class="button primary" type="submit">保存进度</button></form><p id="history-progress-status" class="muted" role="status"></p></section><div class="section-bar"><h2>历史文章 · ${rows.length} 篇</h2><button class="button text-button" data-plan-action="refresh-history">刷新来源 ↻</button></div><p class="muted history-note">存稿和完成任务默认是草稿。手动登记“已发布”仅更新本地记录，不会向微信发送文章；发布时的正文会留存为历史快照。</p><div class="history-list">${rows.map(row=>`<form class="publication-panel history-record" data-history-id="${esc(row.history_id)}" data-hash="${esc(row.content_hash)}"><div class="history-title"><label>标题<input name="title" value="${esc(row.title)}" required maxlength="300"></label>${badge(row.status==='published'?'已发布':'草稿',row.status==='published'?'green':'')}<button type="button" class="button text-button small" data-plan-action="preview-history" data-id="${esc(row.history_id)}">阅读正文 ↗</button></div><div class="history-fields"><label>栏目<select name="series" required><option value="">请选择栏目</option>${options(row.series)}</select></label><label>期号<input name="episode" type="number" min="1" max="9999" required value="${row.episode??''}"></label><label>状态<select name="status"><option value="draft" ${row.status==='draft'?'selected':''}>草稿</option><option value="published" ${row.status==='published'?'selected':''}>已发布</option></select></label><label>实际发布日期<input name="published_at" type="date" max="${date}" value="${esc(row.published_at)}" ${row.status==='published'?'required':''}></label><button type="submit" class="button secondary small">保存登记</button></div><div class="history-body" hidden></div></form>`).join('')||'<div class="empty-state"><h3>还没有历史文章</h3><p>在草稿箱导入文章，或在公众号设置中填写存稿目录。</p></div>'}</div>`;
  await loadHistoryProgress();
}
async function loadHistoryProgress() {
  const form=document.querySelector('#history-progress-form');if(!form)return;
  const series=form.elements.series.value, accountId=activeAccount().id;
  const result=await api('planning.context',{series,account_id:accountId});
  if(!form.isConnected || series!==form.elements.series.value || accountId!==activeAccount().id)return;
  form.elements.episode.value=result.last_published_episode;
  document.querySelector('#history-progress-status').textContent=`有效发布进度：第 ${result.last_published_episode} 期；新文章默认第 ${result.next_episode??'—'} 期。逐篇已发布记录与快速进度取较大值。`;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-plan-action]');if(!button)return;
  try {
    if(button.dataset.planAction==='propose')await proposeHistory();
    else if(button.dataset.planAction==='choose') choosePlanningCandidate(Number(button.dataset.index));
    else if(button.dataset.planAction==='reload') {planningState.episodeTouched=false;await loadPlanningContext();}
    else if(button.dataset.planAction==='history') {newDialog.close();changeView('history');}
    else if(button.dataset.planAction==='refresh-history') await renderHistory();
    else if(button.dataset.planAction==='preview-history') {const row=button.closest('.history-record'),node=row.querySelector('.history-body');if(!node.hidden)node.hidden=true;else {const accountId=activeAccount().id,record=await api('history.get',{history_id:button.dataset.id});if(!row.isConnected||accountId!==activeAccount().id)return;node.innerHTML=renderMarkdown(record.body);node.hidden=false;}}
  } catch(error){toast(error.message);}
});
document.addEventListener('change',event=>{
  if(event.target.closest('#history-progress-form') && event.target.name==='series')loadHistoryProgress().catch(error=>toast(error.message));
  if(event.target.closest('.history-record') && event.target.name==='status')event.target.form.elements.published_at.required=event.target.value==='published';
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(form.id!=='history-progress-form'&&!form.matches('.history-record'))return;
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try {const fields=Object.fromEntries(new FormData(form));fields.episode=Number(fields.episode);
    if(form.id==='history-progress-form')await api('history.progress',fields);
    else await api('history.update',{...fields,history_id:form.dataset.historyId,content_hash:form.dataset.hash});
    toast('发布记录已保存，下次新建文章会使用更新后的进度');await renderHistory();
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});
