'use strict';
const outlineState={token:0,selection:null,available:[]};
const outlinePage={accountId:null,text:'',sourceName:'手动粘贴',preview:null,filter:''};
let outlineEpisodeTimer;
function titleMode(){return newForm.elements.title_mode.value;}
function outlineReady(){return titleMode()!=='outline'||Boolean(outlineState.selection&&outlineState.selection.series===newForm.elements.series.value&&outlineState.selection.episode===Number(newForm.elements.episode.value));}
function outlineConfirmation(){return titleMode()==='outline'?{outline_topic_id:outlineState.selection?.topic_id,outline_topic_hash:outlineState.selection?.content_hash}:{};}
function syncTitleMode(){
  const mode=titleMode();
  const automatic=newForm.elements.production_mode?.value==='auto_prepare';
  newForm.elements.topic.required=!(automatic&&mode==='ai');
  document.querySelector('.planning-steps .active').textContent=mode==='ai'?'01 分析历史':mode==='outline'?'01 选择期题':'01 填写题目';
  document.querySelector('.history-assist').hidden=mode!=='ai';
  document.querySelector('#outline-choice').hidden=mode!=='outline';
  document.querySelector('#title-selection-status').hidden=mode==='ai';
  document.querySelector('#title-mode-note').textContent=mode==='ai'?'确认后按当前标题和需求写作，骨架、最终标题与配图仍会等待你审阅。':'确认后保留你修改后的标题，不调用 AI 重新拟题；骨架和配图计划仍需你审阅。';
  newForm.elements.topic.placeholder=mode==='ai'?'留空让 AI 分析历史拟题，或写下一个想法':mode==='outline'?'采用对应期题后，可继续修改标题':'写下本期最终标题，确认后会保留';
  if(automatic)document.querySelector('#title-mode-note').textContent='自动选定内容决策，完成后统一审阅。执行代码、事实核验、TapNow生图与发布仍遵循对应条件。';
}
document.addEventListener('change',event=>{if(event.target.name==='production_mode')syncTitleMode();});
async function loadOutlineChoices(){
  if(titleMode()!=='outline'||!newForm.elements.episode.checkValidity())return;
  const token=++outlineState.token,accountId=activeAccount().id,series=newForm.elements.series.value,episode=Number(newForm.elements.episode.value);
  document.querySelector('#outline-match-status').textContent='正在读取当前栏目的预设期题…';
  const result=await api('outlines.match',{account_id:accountId,series,episode});
  if(token!==outlineState.token||!newDialog.open||accountId!==activeAccount().id||titleMode()!=='outline'||series!==newForm.elements.series.value||episode!==Number(newForm.elements.episode.value))return;
  outlineState.available=result.available;
  if(!result.available.some(row=>row.topic_id===outlineState.selection?.topic_id&&row.content_hash===outlineState.selection?.content_hash))outlineState.selection=null;
  const picker=document.querySelector('#outline-topic-choice');
  picker.innerHTML='<option value="">请选择期题</option>'+result.available.map(row=>`<option value="${esc(row.topic_id)}">第 ${row.episode} 期 · ${esc(row.title)}</option>`).join('');
  picker.value=outlineState.selection?.topic_id||result.topic?.topic_id||'';
  document.querySelector('#outline-match-status').textContent=result.topic?`第 ${episode} 期已有题目：${result.topic.title}。点“采用对应期题”后，可修改并确认。`:`第 ${episode} 期尚未安排题目。可以选其他期，或导入大纲；本栏目共 ${result.available.length} 条，不限十篇。`;
  planningStatus(outlineState.selection?'已选用预设期题，可编辑后确认。':'请选择并采用预设期题，或切换到自己拟题。');
  planningButtons();
}
async function adoptOutline(){
  const identifier=document.querySelector('#outline-topic-choice').value,item=outlineState.available.find(row=>row.topic_id===identifier);
  if(!item){planningStatus('先选择一条预设期题。',true);return;}
  const accountId=activeAccount().id,series=newForm.elements.series.value,oldTitle=newForm.elements.topic.value,token=++outlineState.token;
  const result=await api('outlines.match',{account_id:accountId,series,episode:item.episode});
  if(token!==outlineState.token||accountId!==activeAccount().id||!newDialog.open||titleMode()!=='outline'||series!==newForm.elements.series.value||newForm.elements.topic.value!==oldTitle)return;
  if(!result.topic||result.topic.content_hash!==item.content_hash)throw Error('预设题目已变化，请重新读取');
  outlineState.selection=result.topic;
  newForm.elements.episode.value=item.episode;planningState.episodeTouched=true;
  for(const name of ['topic','content_angle','core_benefit','next_episode_plan']){
    const value=name==='topic'?result.topic.title:result.topic[name];
    newForm.elements[name].value=value||(name==='next_episode_plan'?result.next_title:'');
  }
  await loadPlanningContext(false);
  planningStatus('已采用这一期的预设题目。修改后确认，会保留为最终标题。');
}
function outlineRowsHtml(rows){
  const options=(series)=>activeAccount().columns.map(column=>`<option value="${esc(column.code)}" ${column.code===series?'selected':''}>${esc(column.code)} · ${esc(column.name)}</option>`).join('');
  return `<div class="outline-table-scroll"><table class="outline-table"><thead><tr><th>保留</th><th>栏目</th><th>期号</th><th>标题</th><th>内容要点</th><th>读者收益</th><th>下期预告</th></tr></thead><tbody>${rows.map((row,index)=>`<tr data-outline-row="${index}"><td><input type="checkbox" name="include" checked aria-label="保留第${index+1}条"></td><td><select name="series"><option value="">请选择</option>${options(row.series)}</select></td><td><input name="episode" type="number" min="1" max="9999" required value="${row.episode}"></td><td><input name="title" required maxlength="30" value="${esc(row.title)}">${row.existing?`<small>已存：${esc(row.existing.title)}</small>`:''}</td>${['content_angle','core_benefit','next_episode_plan'].map(key=>`<td><textarea name="${key}" rows="2" maxlength="${key==='content_angle'?300:1000}">${esc(row[key]||'')}</textarea></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function readOutlineRows(form){return Array.from(form.querySelectorAll('[data-outline-row]')).filter(row=>row.querySelector('[name="include"]').checked).map(row=>Object.fromEntries(['series','episode','title','content_angle','core_benefit','next_episode_plan'].map(key=>[key,key==='episode'?Number(row.querySelector(`[name="${key}"]`).value):row.querySelector(`[name="${key}"]`).value])));}
function showOutlinePreview(result){
  outlinePage.preview=result;
  const root=document.querySelector('#outline-preview');
  root.innerHTML=`<h3>识别出 ${result.rows.length} 条，可逐项修改</h3><p class="muted">${esc(result.errors.join('；')||'栏目和期号已识别。')}${result.ignored_lines.length?` 未识别 ${result.ignored_lines.length} 行，请对照原文检查。`:''}</p>${result.rows.length?`<form id="outline-save-form">${outlineRowsHtml(result.rows)}<label class="checkbox-label"><input type="checkbox" name="replace_existing">我确认覆盖本次涉及的已有期题（旧文章与已创建任务不修改）</label><div class="modal-actions"><button type="submit" class="button primary">确认并保存选题大纲</button></div><p id="outline-save-status" class="muted" role="status"></p></form>`:'<p>没有识别到题目，请参照下方示例填写栏目、期号和标题。</p>'}`;
}
async function renderOutlines(){
  const accountId=activeAccount().id,result=await api('outlines.list',{account_id:accountId});
  if(ui.view!=='outlines'||activeAccount().id!==accountId)return;
  if(outlinePage.accountId!==accountId){Object.assign(outlinePage,{accountId,text:'',sourceName:'手动粘贴',preview:null,filter:''});}
  const columns=activeAccount().columns;
  if(outlinePage.filter&&!columns.some(column=>column.code===outlinePage.filter))outlinePage.filter='';
  workspace.innerHTML=pageHeading('EDITORIAL ROADMAP','把接下来的文章，先安排好。','文档先识别、逐项修改、确认保存；新建文章按对应期选择，跳过 AI 拟题。')+`<section class="publication-panel outline-import"><div class="section-bar"><h2>导入或粘贴选题大纲</h2><div class="button-row"><button class="button secondary" data-outline-action="import">读取文档 ↗</button><button class="button text-button" data-outline-action="sample">填入示例</button></div></div><form id="outline-parse-form"><label>来源名称<input name="source_name" maxlength="200" required value="${esc(outlinePage.sourceName)}"></label><label>大纲文本<textarea name="text" rows="9" maxlength="400000" required placeholder="支持 Markdown、TXT、Word（.docx）。请参照示例标注栏目和期号。">${esc(outlinePage.text)}</textarea></label><button class="button primary" type="submit">识别并预览题目 →</button><p id="outline-parse-status" class="muted" role="status"></p></form><details class="outline-example"><summary>查看示例文本样式（含第11期、第100期）</summary><pre>${esc(result.example)}</pre><button class="button secondary small" data-outline-action="copy-example">复制示例</button></details><div id="outline-preview"></div></section><div class="section-bar"><h2>已安排 ${result.rows.length} 条期题</h2><select id="outline-filter" aria-label="按栏目筛选预设期题"><option value="">全部栏目</option>${columns.map(column=>`<option value="${esc(column.code)}" ${column.code===outlinePage.filter?'selected':''}>${esc(column.code)} · ${esc(column.name)}</option>`).join('')}</select></div><p class="muted">每栏目按1–9999期管理，不限十篇。单次文档可导入1000条，支持多次追加；保存大纲不会登记发布或创建文章任务。</p><div class="outline-saved-list">${result.rows.filter(row=>!outlinePage.filter||row.series===outlinePage.filter).map(row=>`<article class="outline-saved-row"><span class="series-label">${esc(row.series)} / ${String(row.episode).padStart(3,'0')}</span><div><h3>${esc(row.title)}</h3><p>${esc(row.content_angle||'尚未填写内容要点')}</p><small>${esc(row.source_name)}</small></div><button class="button secondary small" data-outline-action="edit" data-topic-id="${esc(row.topic_id)}">修改</button></article>`).join('')||'<div class="empty-state"><h3>还没有预设期题</h3><p>导入文档或填入示例，解析后确认保存。</p></div>'}</div>`;
  workspace.querySelector('[data-outline-action="copy-example"]').addEventListener('click',()=>window.ice.copyText(result.example).then(()=>toast('示例已复制')).catch(error=>toast(error.message)));
  if(outlinePage.preview)showOutlinePreview(outlinePage.preview);
}
async function editOutline(topicId){
  const accountId=activeAccount().id,result=await api('outlines.list',{account_id:accountId}),row=result.rows.find(row=>row.topic_id===topicId);
  if(!row)throw Error('选题已移除，请刷新');
  const dialog=visualDialog('outline-edit','修改这一期的题目',`<p class="muted">只修改选题大纲，已创建文章的标题不会随之变化。</p><form id="outline-edit-form">${outlineRowsHtml([row])}<div class="modal-actions"><button type="submit" class="button text-button danger" value="delete">删除预设题目</button><button type="submit" class="button primary" value="save">保存修改</button></div><p class="muted" id="outline-edit-status" role="status"></p></form>`);
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter||event.target.querySelector('[value="save"]');button.disabled=true;
    try{const values=readOutlineRows(event.target)[0];if(button.value!=='delete'&&!values)throw Error('请保留该行后保存');
      if(button.value==='delete'&&!confirm('删除这一期的预设题目？已创建的文章仍保留。'))return;
      await api('outlines.update',{...values,account_id:accountId,topic_id:topicId,content_hash:row.content_hash,delete:button.value==='delete'});
      dialog.close();outlinePage.preview=null;await renderOutlines();toast('选题大纲已更新');
    }catch(error){dialog.querySelector('#outline-edit-status').textContent=error.message;}finally{button.disabled=false;}
  },{signal:dialogAbort(dialog)});
}
newForm.elements.title_mode.addEventListener('change',async()=>{
  ++planningState.token;planningState.busy=false;planningState.proposal=null;outlineState.selection=null;++outlineState.token;
  document.querySelector('#planning-candidates').replaceChildren();syncTitleMode();planningButtons();
  try{if(titleMode()==='outline')await loadOutlineChoices();else planningStatus(titleMode()==='manual'?'填写最终标题并确认，后续不再拟题。':'点击分析历史，或保留自己的初始想法。');}catch(error){planningStatus(error.message,true);}
});
newForm.elements.episode.addEventListener('input',()=>{
  outlineState.selection=null;++outlineState.token;clearTimeout(outlineEpisodeTimer);planningButtons();
  outlineEpisodeTimer=setTimeout(()=>{if(newDialog.open&&newForm.elements.episode.checkValidity())loadPlanningContext(false).catch(error=>planningStatus(error.message,true));},250);
});
newForm.elements.series.addEventListener('change',()=>{outlineState.selection=null;++outlineState.token;});
newDialog.addEventListener('close',()=>{++outlineState.token;outlineState.selection=null;clearTimeout(outlineEpisodeTimer);});
document.querySelector('#outline-topic-choice').addEventListener('change',()=>{outlineState.selection=null;planningButtons();});
document.querySelector('#outline-adopt').addEventListener('click',async event=>{event.target.disabled=true;try{await adoptOutline();}catch(error){planningStatus(error.message,true);}finally{event.target.disabled=false;}});
document.addEventListener('input',event=>{if(event.target.closest('#outline-parse-form')){outlinePage.text=document.querySelector('#outline-parse-form').elements.text.value;outlinePage.sourceName=document.querySelector('#outline-parse-form').elements.source_name.value;outlinePage.preview=null;document.querySelector('#outline-preview').replaceChildren();ui.accountDirty=true;}else if(event.target.closest('#outline-save-form'))ui.accountDirty=true;});
document.addEventListener('change',event=>{
  if(event.target.id==='outline-filter'){
    outlinePage.filter=event.target.value;
    for(const row of document.querySelectorAll('.outline-saved-row'))row.hidden=Boolean(outlinePage.filter&&row.querySelector('.series-label').textContent.split('/')[0].trim()!==outlinePage.filter);
  }
  if(event.target.closest('[data-outline-row]')&&event.target.name==='include'){
    for(const field of event.target.closest('[data-outline-row]').querySelectorAll('input:not([name="include"]),select,textarea'))field.disabled=!event.target.checked;
  }
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-outline-action]');if(!button||button.dataset.outlineAction==='copy-example')return;button.disabled=true;
  try{const action=button.dataset.outlineAction;
    if(action==='manage'){newDialog.close();changeView('outlines');}
    else if(action==='edit')await editOutline(button.dataset.topicId);
    else if(action==='sample'||action==='import'){
      const accountId=activeAccount().id,data=action==='import'?await window.ice.importOutline(accountId):{text:(await api('outlines.list',{account_id:accountId})).example,source_name:'示例大纲'};
      if(!data||ui.view!=='outlines'||activeAccount().id!==accountId)return;
      const form=document.querySelector('#outline-parse-form');form.elements.text.value=data.text;form.elements.source_name.value=data.source_name;
      Object.assign(outlinePage,{text:data.text,sourceName:data.source_name,preview:null});document.querySelector('#outline-preview').replaceChildren();ui.accountDirty=true;
    }
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});

window.__ICE_OUTLINE_SMOKE__=async function(){
  const before=(await api('jobs.list')).length,accountId=activeAccount().id,column=activeAccount().columns[0];
  async function until(check,label){const deadline=Date.now()+25000;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));if(!check())throw Error('选题大纲界面等待超时：'+label+' '+JSON.stringify({view:ui.view,parse:document.querySelector('#outline-parse-status')?.textContent,save:document.querySelector('#outline-save-status')?.textContent,planning:document.querySelector('#planning-status')?.textContent,toast:document.querySelector('#toast')?.textContent,rows:document.querySelectorAll('.outline-saved-row').length,choices:outlineState.available.length}));}
  newDialog.close();changeView('outlines');await renderOutlines();
  document.querySelector('[data-outline-action="sample"]').click();
  await until(()=>document.querySelector('#outline-parse-form').elements.text.value.includes('第100期'),'填入示例');
  const sample=document.querySelector('#outline-parse-form').elements.text.value.includes(column.code);
  const text=`## ${column.code}\n`+Array.from({length:25},(_,index)=>`第${index+1}期：计划题目${index+1}`).join('\n')+'\n第100期：一百期的回顾\n内容要点：检查已有作品\n';
  const form=document.querySelector('#outline-parse-form');form.elements.text.value=text;form.elements.text.dispatchEvent(new Event('input',{bubbles:true}));
  form.requestSubmit();await until(()=>document.querySelectorAll('#outline-save-form [data-outline-row]').length===26,'识别预览');
  const preview=(await api('outlines.list')).rows.length===0;
  const row=document.querySelectorAll('#outline-save-form [data-outline-row]')[10];row.querySelector('[name="title"]').value='审阅后修改的第十一期';row.querySelector('[name="title"]').dispatchEvent(new Event('input',{bubbles:true}));
  const editable=!row.querySelector('[name="title"]').disabled;
  document.querySelector('#outline-save-form').requestSubmit();await until(()=>document.querySelectorAll('.outline-saved-row').length===26,'确认保存');
  const saved=(await api('outlines.match',{series:column.code,episode:11})).topic.title==='审阅后修改的第十一期';
  const overTen=document.querySelectorAll('.outline-saved-row').length>10;
  const compact=document.body.scrollWidth===innerWidth;
  await openNewArticle({reset:true});newForm.elements.title_mode.value='outline';newForm.elements.title_mode.dispatchEvent(new Event('change',{bubbles:true}));
  await until(()=>outlineState.available.length===26,'新建题目下拉');
  const hundred=outlineState.available.find(item=>item.episode===100);document.querySelector('#outline-topic-choice').value=hundred.topic_id;await adoptOutline();
  const issueHundred=newForm.elements.episode.value==='100'&&newForm.elements.topic.value==='一百期的回顾'&&outlineReady();
  newForm.elements.topic.value='我最终确认的百期题目';newForm.elements.topic.dispatchEvent(new Event('input',{bubbles:true}));
  document.querySelector('#brief-replace').checked=true;
  await fillBrief(async()=>({fields:{topic:'AI试图改掉题目',core_benefit:'回顾作品'},notes:[]}));
  const titleProtected=newForm.elements.topic.value==='我最终确认的百期题目';
  const fields=Object.fromEntries(new FormData(newForm)),confirmedData=await api('planning.confirm',{fields,context_hash:planningState.context.context_hash,...outlineConfirmation()});
  const confirmed=Boolean(confirmedData.confirmation_hash)&&document.querySelector('#planning-propose').disabled;
  let release;const late=fillBrief(()=>new Promise(resolve=>{release=resolve;}));
  newForm.elements.title_mode.value='manual';newForm.elements.title_mode.dispatchEvent(new Event('change',{bubbles:true}));
  release({fields:{topic:'过期AI标题',core_benefit:'过期内容'},notes:[]});await late;
  const sourceSwitchProtected=newForm.elements.topic.value===fields.topic&&newForm.elements.core_benefit.value!=='过期内容';
  newDialog.close();
  const noTask=(await api('jobs.list')).length===before;
  await useBootstrap(await api('accounts.switch',{account_id:'ice-loop'}),'studio');
  const isolated=(await api('outlines.list')).rows.length===0;
  await useBootstrap(await api('accounts.switch',{account_id:accountId}),'studio');
  const restored=(await api('outlines.match',{series:column.code,episode:100})).topic.title==='一百期的回顾';
  return {sample,preview,editable,saved,overTen,issueHundred,confirmed,titleProtected,sourceSwitchProtected,noTask,compact,isolated,restored};
};
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['outline-parse-form','outline-save-form'].includes(form.id))return;
  event.preventDefault();const button=event.submitter||form.querySelector('[type="submit"]'),accountId=activeAccount().id;button.disabled=true;
  const status=form.querySelector('[role="status"]');
  try{
    if(form.id==='outline-parse-form'){
      const snapshot={text:form.elements.text.value,source_name:form.elements.source_name.value};
      const result=await api('outlines.preview',{...snapshot,account_id:accountId});
      if(ui.view!=='outlines'||activeAccount().id!==accountId||snapshot.text!==form.elements.text.value||snapshot.source_name!==form.elements.source_name.value)return;
      Object.assign(outlinePage,{text:snapshot.text,sourceName:snapshot.source_name});showOutlinePreview(result);status.textContent='尚未保存。请检查识别结果，修改后确认。';
    }else{
      const preview=outlinePage.preview;if(!preview)throw Error('请先识别并预览题目');
      const result=await api('outlines.save',{account_id:accountId,text:outlinePage.text,source_name:outlinePage.sourceName,rows:readOutlineRows(form),preview_hash:preview.preview_hash,base_hash:preview.base_hash,replace_existing:form.elements.replace_existing.checked});
      if(ui.view!=='outlines'||activeAccount().id!==accountId)return;
      outlinePage.preview=null;ui.accountDirty=false;await renderOutlines();toast(`已保存 ${result.saved} 条期题，新建文章可以按期选择`);
    }
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
