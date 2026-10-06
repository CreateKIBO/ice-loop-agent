'use strict';
const executionEdits=new Map();
function executionPanel(data){
  const plan=data.execution;if(!plan)return '';
  const active=data.job.current_node==='verify_code'&&['awaiting_user','failed','paused'].includes(data.job.state);
  if(!active)return '';
  const key=data.job.job_id+':'+plan.content_hash,edits=executionEdits.get(key)||{};
  const message=plan.status==='needs_input'?`需要补充 ${plan.missing_inputs.length} 段代码的示例输入。${plan.approved?'之前的代码批准已记录。':''}`:plan.approved?'当前源码和输入已经审阅。若运行失败，请查看下方真实错误后修改。':'请审阅下面每段源码和输入，一次确认后执行。';
  return `<section class="review-panel execution-panel" data-execution-key="${esc(key)}"><h3>${plan.status==='needs_input'?'补充即将运行的示例输入':'审阅即将运行的代码'}</h3><p class="review-summary">${esc(message)}</p>${data.job.state==='failed'?`<p class="error">${esc(data.job.pause_reason)}</p>`:''}${plan.blocks.map(block=>`<article class="execution-block"><div class="section-bar"><h3>代码 ${block.index} · ${esc(block.filename)}</h3>${badge(block.needs_input?'缺少输入':block.input_calls?'输入已准备':'无需交互输入',block.needs_input?'amber':'')}</div><pre class="run-output">${esc(block.source)}</pre>${block.input_calls||block.stdin_text?`<label>示例输入（每行对应一次读取）<textarea data-execution-input="${esc(block.stdin_key)}" rows="${Math.min(6,Math.max(2,block.input_calls))}" maxlength="4000" placeholder="例如：第一行填姓名，第二行填年龄；按代码里的提示填写。">${esc(edits[block.stdin_key]??block.stdin_text)}</textarea></label><p class="muted">检测到 ${block.input_calls} 处输入读取；循环可能需要更多行。${block.stdin_key!==block.filename?'此段单独保存输入：'+esc(block.stdin_key):''}</p>`:''}</article>`).join('')}<p class="muted">只执行当前确认的源码和输入；已通过且内容相同的运行记录会复用。</p><button class="button primary" data-action="approve-execution">${plan.status==='needs_input'?'已审阅源码与输入，保存并运行':data.job.state==='failed'?'已审阅修正内容，再次运行':'已审阅代码，运行本次示例'}</button></section>`;
}
function executionInputsFromPanel(data){
  const inputs={...(data.stdin_by_filename||{})};
  for(const field of document.querySelectorAll('[data-execution-input]'))inputs[field.dataset.executionInput]=field.value;
  return inputs;
}
document.addEventListener('input',event=>{
  if(!event.target.matches('[data-execution-input]'))return;
  const key=event.target.closest('[data-execution-key]').dataset.executionKey;
  const values=executionEdits.get(key)||{};values[event.target.dataset.executionInput]=event.target.value;executionEdits.set(key,values);
});
