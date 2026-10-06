'use strict';

// A single control system for legacy pages, with explicit task/default budgets.
const controlPending = new Map();
function controlBusy(button, busy) {
  if (!button || !button.isConnected) return;
  if (busy && !controlPending.has(button)) {
    controlPending.set(button, {label:button.textContent.trim() || button.getAttribute('aria-label') || '操作',
      aria:button.getAttribute('aria-label')});
    button.dataset.uiBusy='true'; button.setAttribute('aria-busy','true');
    button.setAttribute('aria-label',controlPending.get(button).label+'，正在处理');
    const spinner=document.createElement('span');spinner.className='control-spinner spinner';spinner.setAttribute('aria-hidden','true');button.append(spinner);
  } else if (!busy && controlPending.has(button)) {
    const old=controlPending.get(button);controlPending.delete(button);
    delete button.dataset.uiBusy;button.removeAttribute('aria-busy');
    button.querySelector('.control-spinner')?.remove();
    if(old.aria===null)button.removeAttribute('aria-label');else button.setAttribute('aria-label',old.aria);
  }
  paintControlActivity();
}
function paintControlActivity() {
  let host=document.querySelector('#control-activity');
  if(!host){host=document.createElement('div');host.id='control-activity';host.setAttribute('role','status');host.setAttribute('aria-live','polite');host.hidden=true;document.body.append(host);}
  for(const [node] of controlPending)if(!node.isConnected)controlPending.delete(node);
  const record=[...controlPending.values()].at(-1),signature=controlPending.size+':'+(record?.label||'');
  if(host.dataset.signature===signature)return;
  host.dataset.signature=signature;const wasHidden=host.hidden;host.hidden=!controlPending.size;
  if(controlPending.size){host.innerHTML=`<span class="spinner" aria-hidden="true"></span><div><strong>正在处理</strong><span>${esc(record.label)}</span></div>`;if(wasHidden)window.iceMotion?.enter(host);}
}
async function runControl(button, task) {
  if(button?.dataset.uiBusy==='true')return;
  const before=button?.disabled;if(button){button.disabled=true;controlBusy(button,true);}
  try{return await task();}finally{if(button){button.disabled=before;controlBusy(button,false);}}
}
let clickedControl;
function trackControl(event){
  const button=event.type==='submit'?event.submitter:event.target.closest('button');
  if(!button||button.disabled||button.closest('.browser-toolbar'))return;
  clickedControl=button;queueMicrotask(()=>{if(button.disabled)controlBusy(button,true);});
}
document.addEventListener('click',trackControl,true);
document.addEventListener('submit',trackControl,true);
new MutationObserver(records=>{
  for(const record of records){const node=record.target;
    if(record.type==='attributes'&&node.tagName==='BUTTON'){
      if(!node.disabled)controlBusy(node,false);else if(node===clickedControl)controlBusy(node,true);
    }
  }
  for(const [node] of controlPending)if(!node.isConnected)controlPending.delete(node);
  if(controlPending.size||document.querySelector('#control-activity:not([hidden])'))paintControlActivity();
}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});

function budgetFields(data){return `<div class="budget-inputs"><label>新写作任务 · 每篇上限<span class="budget-number"><input name="max_model_calls" type="number" min="1" max="100" required value="${data.max_model_calls}"><span>次</span></span></label><label>导入稿补图 · 每篇上限<span class="budget-number"><input name="max_image_model_calls" type="number" min="1" max="100" required value="${data.max_image_model_calls||12}"><span>次</span></span></label></div>`;}
function budgetNotice(error){return String(error?.message||error).includes('MODEL_BUDGET_EXCEEDED');}
async function saveBudgetDefaults(form, accountId, button){
  const fields=Object.fromEntries(new FormData(form));
  return runControl(button,async()=>{
    await api('budgets.save',{scope:'defaults',account_id:accountId,max_model_calls:Number(fields.max_model_calls),max_image_model_calls:Number(fields.max_image_model_calls)});
    if(activeAccount().id!==accountId)return;
    ui.bootstrap=await api('bootstrap');toast('默认调用上限已保存，新任务采用新预算；已有任务可单独调整');
  });
}
const modelsBeforeControls=renderModels;
renderModels=function(){
  modelsBeforeControls();
  document.querySelector('#page-name').textContent='模型与预算';
  const accountId=activeAccount().id;
  const old=document.querySelector('#model-budget');if(old)old.closest('label').hidden=true;
  const panel=document.createElement('section');panel.className='budget-panel';panel.id='global-model-budget';
  panel.innerHTML=`<div class="budget-panel-heading"><div><span class="eyebrow">AI REQUEST LIMITS</span><h2>AI 调用预算</h2><p>这是每篇任务的请求次数上限。默认预算用于新任务，当前文章可单独调整。</p></div><button class="button secondary small" type="button" data-budget-open>查看当前预算</button></div><form id="default-budget-form">${budgetFields(ui.bootstrap.settings)}<div class="budget-actions"><p>重试也占用次数。补图预算只允许拟写配图提示词，原正文保持只读。</p><button type="submit" class="button primary">保存默认预算</button></div><p class="budget-message" role="status"></p></form>`;
  document.querySelector('.model-grid').before(panel);
  panel.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const status=e.target.querySelector('[role=status]');status.textContent='正在保存…';
    try{await saveBudgetDefaults(e.target,accountId,e.submitter);if(activeAccount().id===accountId){status.textContent='已保存。已有文章的预算请在「当前文章预算」中调整。';if(old)old.value=ui.bootstrap.settings.max_model_calls;}}
    catch(error){status.textContent=error.message;status.dataset.tone='error';}
  });
};

function currentBudgetJob(){return ui.view==='detail'?ui.currentJob:null;}
async function openBudgetDialog(jobId=currentBudgetJob()){
  const accountId=activeAccount().id;
  const data=await api('budgets.get',{account_id:accountId,...(jobId?{job_id:jobId}:{})});
  if(activeAccount().id!==accountId)return;
  const job=data.job;
  const current=job?`<section class="current-budget"><h3>${job.image_only?'当前补图任务':'当前文章'}预算</h3><div class="budget-meter"><span><b>${job.used}</b> 已用</span><span><b>${job.remaining}</b> 剩余</span><span><b>${job.limit}</b> 上限</span></div><progress max="${Math.max(1,job.limit)}" value="${job.used}" aria-label="本篇模型调用使用情况"></progress>${job.legacy_budget?'<p class="budget-compat">此旧补图任务原预算为0；现在使用独立补图预算，首次重拟时固定到本篇，原正文保持只读。</p>':''}<form id="current-budget-form"><label>本篇调用上限<span class="budget-number"><input name="limit" type="number" min="${Math.max(1,job.used)}" max="100" value="${job.limit}" required><span>次</span></span></label><button class="button primary" type="submit">保存本篇预算</button><p class="budget-message" role="status"></p></form></section>`:'<p class="budget-compat">打开制作任务或配图提示词后，可以调整该篇任务的上限。创作讨论的独立请求不计入制作任务预算。</p>';
  const dialog=visualDialog('model-budget-dialog','AI 调用预算',`${current}<details class="budget-defaults" ${job?'':'open'}><summary>全局默认预算 · 新任务生效</summary><form id="dialog-default-budget">${budgetFields(data)}<button class="button secondary" type="submit">保存默认预算</button><p class="budget-message" role="status"></p></form></details><p class="muted">这里控制调用次数，费用按所选模型实际计费。保存预算不会自动重试请求，也不会改动模型配置或正文。</p>`);
  dialog._budgetJob=jobId;
  if(job)dialog.querySelector('#current-budget-form').addEventListener('submit',async e=>{
    e.preventDefault();const status=e.target.querySelector('[role=status]');status.dataset.tone='';status.textContent='正在保存…';
    try{const result=await runControl(e.submitter,()=>api('budgets.save',{scope:'job',job_id:jobId,account_id:accountId,limits_hash:job.limits_hash,limit:Number(e.target.elements.limit.value)}));
      if(!dialog.open||activeAccount().id!==accountId)return;
      Object.assign(job,result.job);dialog.querySelector('.budget-meter').innerHTML=`<span><b>${job.used}</b> 已用</span><span><b>${job.remaining}</b> 剩余</span><span><b>${job.limit}</b> 上限</span>`;
      const bar=dialog.querySelector('progress');bar.max=job.limit;bar.value=job.used;status.textContent='本篇预算已保存。返回原页面，点击重拟或继续任务即可。';dialog.querySelector('.budget-compat')?.remove();
    }catch(error){status.textContent=error.message;status.dataset.tone='error';}
  });
  dialog.querySelector('#dialog-default-budget').addEventListener('submit',async e=>{e.preventDefault();const status=e.target.querySelector('[role=status]');
    try{await saveBudgetDefaults(e.target,accountId,e.submitter);if(dialog.open&&activeAccount().id===accountId)status.textContent='已保存，新任务采用新预算。';}catch(error){status.textContent=error.message;status.dataset.tone='error';}
  });
}
document.addEventListener('click',async event=>{const button=event.target.closest('[data-budget-open]');if(!button)return;event.preventDefault();
  try{await runControl(button,()=>openBudgetDialog(button.dataset.budgetJob||currentBudgetJob()));}catch(error){toast(error.message);}
});
const contextBeforeControls=detailContext;
detailContext=function(data){let html=contextBeforeControls(data);const maximum=data.supplement?data.job.limits.max_image_model_calls??ui.bootstrap.settings.max_image_model_calls??12:data.job.limits.max_model_calls;
  html=html.replace(`${data.invocations.length} / ${data.job.limits.max_model_calls}`,`${data.invocations.length} / ${maximum}`);
  return html.replace('</ul>','</ul><button class="button secondary small" data-budget-open data-budget-job="'+esc(data.job.job_id)+'">调整本篇 AI 预算</button>');
};
const toastBeforeControls=toast;
toast=function(message){toastBeforeControls(message);const node=document.querySelector('#toast');const failed=/错误|失败|EXCEEDED|Error|请先|不能|无法|已变化/.test(String(message));node.dataset.tone=failed?'error':'info';
  node.innerHTML=`<span class="toast-dot" aria-hidden="true"></span><span>${esc(message)}</span><button type="button" class="toast-dismiss" data-toast-dismiss aria-label="关闭提示">×</button>`;
  if(budgetNotice(message)){node.insertAdjacentHTML('beforeend','<button type="button" class="button secondary small" data-budget-open>调整预算</button>');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),15000);}
};
document.addEventListener('click',e=>{if(e.target.closest('[data-toast-dismiss]'))document.querySelector('#toast').classList.remove('show');});
const budgetShortcut=document.createElement('button');budgetShortcut.type='button';budgetShortcut.className='button secondary small budget-shortcut';budgetShortcut.dataset.budgetOpen='';budgetShortcut.textContent='AI 预算';budgetShortcut.title='查看默认及当前文章的模型调用上限';document.querySelector('.topbar-right').prepend(budgetShortcut);
const modelsNav=document.querySelector('[data-view="models"] .nav-text');if(modelsNav)modelsNav.textContent='模型与预算';
window.iceControls={run:runControl,openBudget:openBudgetDialog,isBudgetError:budgetNotice,get pendingCount(){return controlPending.size;}};
