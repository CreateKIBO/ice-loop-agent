'use strict';
// Visibility management preserves saved articles, assets and review evidence.
function lifecycleDialog(id,title,content){
  document.querySelector('#'+id)?.remove();
  const dialog=document.createElement('dialog');dialog.id=id;dialog.className='modal lifecycle-dialog';
  dialog.innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-life-close aria-label="关闭">×</button></div>${content}<p class="lifecycle-status" role="status" aria-live="polite"></p>`;
  dialog.addEventListener('click',e=>{if(e.target.closest('[data-life-close]'))dialog.close();});
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();chatIcons();return dialog;
}
function confirmLifecycle(title,description,label){
  return new Promise(resolve=>{
    const dialog=lifecycleDialog('lifecycle-confirm',title,`<p>${esc(description)}</p><div class="modal-actions"><button type="button" class="button secondary" data-life-close>取消</button><button type="button" class="button primary" data-life-confirm>${esc(label)}</button></div>`);
    let accepted=false;dialog.querySelector('[data-life-confirm]').addEventListener('click',()=>{accepted=true;dialog.close();});dialog.addEventListener('close',()=>resolve(accepted),{once:true});
  });
}
function clearManagedConversation(){
  creative.id=null;creative.data=null;creative.selected=null;creative.retryMessage=null;creative.useCurrent=false;creative.text='';creative.refs=[];creative.documents=[];creative.selectedText='';creative.requestError='';creative.dirty=false;ui.dirty=false;++creative.token;
}
async function manageConversation(action,id){
  if(creative.dirty||ui.dirty){toast('请先保存候选稿修改，再管理会话');return false;}
  const aid=activeAccount().id;
  if(action!=='restore'&&!await confirmLifecycle(action==='delete'?'删除这次会话？':'归档这次会话？',action==='delete'?'会话移入回收站，可恢复。正在生成的回复会停止，已保存文章和审批记录仍保留。':'归档后从最近会话移除，可恢复。正在生成的回复会停止，文章和审批记录保留。',action==='delete'?'移入回收站':'确认归档'))return false;
  if(aid!==activeAccount().id)return false;
  await api(action==='archive'?'chat.update':action==='delete'?'chat.delete':'chat.restore',{account_id:aid,conversation_id:id,...(action==='archive'?{archived:true}:action==='restore'?{archived:false}:{})});
  if(aid!==activeAccount().id)return false;
  if(action!=='restore'&&creative.id===id){clearManagedConversation();if(ui.view==='chat')await renderCreativeChat();}
  if(action==='restore'&&creative.id===id&&ui.view==='chat')await renderCreativeChat();
  await refreshConversationList();toast(action==='delete'?'会话已移入回收站':action==='archive'?'会话已归档':'会话已恢复');return true;
}
async function openConversationManager(){
  const aid=activeAccount().id;
  const dialog=lifecycleDialog('conversation-manager','管理创作会话',`<div class="lifecycle-filters"><select id="conversation-visibility" aria-label="会话范围"><option value="active">最近会话</option><option value="archived">已归档</option><option value="deleted">回收站</option></select><input id="conversation-search" placeholder="搜索会话名称" aria-label="搜索会话"></div><p class="muted">删除与归档都可恢复；已保存文章不受影响。</p><div id="conversation-management-list" class="lifecycle-list"></div>`);
  let sequence=0;
  const load=async()=>{const token=++sequence,status=dialog.querySelector('.lifecycle-status');status.textContent='正在读取会话…';try{
    const visibility=dialog.querySelector('#conversation-visibility').value;
    const rows=await api('chat.list',{account_id:aid,archived:visibility==='archived',deleted:visibility==='deleted',query:dialog.querySelector('#conversation-search').value});
    if(!dialog.open||aid!==activeAccount().id||token!==sequence)return;
    dialog.querySelector('#conversation-management-list').innerHTML=rows.map(r=>`<div class="lifecycle-row"><div><strong>${esc(r.title)}</strong><small>${r.deleted?'回收站':r.archived?'已归档':'活动会话'} · ${dateString(r.updated_at)}</small></div><div class="button-row">${!r.deleted?`<button class="button secondary small" data-life-open-chat="${esc(r.id)}">查看</button>`:''}${r.deleted||r.archived?`<button class="button secondary small" data-life-conversation="restore" data-id="${esc(r.id)}">恢复</button>`:`<button class="button secondary small" data-life-conversation="archive" data-id="${esc(r.id)}">归档</button>`}${!r.deleted?`<button class="button text-button small danger-text" data-life-conversation="delete" data-id="${esc(r.id)}">删除</button>`:''}</div></div>`).join('')||'<p class="chat-muted">这里还没有会话</p>';status.textContent='';
  }catch(error){if(dialog.open&&token===sequence)status.textContent=error.message;}};
  dialog.querySelector('#conversation-visibility').addEventListener('change',load);dialog.querySelector('#conversation-search').addEventListener('input',load);
  dialog.addEventListener('click',async e=>{const open=e.target.closest('[data-life-open-chat]');if(open){if(aid!==activeAccount().id)return;dialog.close();await openCreativeConversation(open.dataset.lifeOpenChat);return;}const button=e.target.closest('[data-life-conversation]');if(!button||button.disabled)return;button.disabled=true;try{if(await manageConversation(button.dataset.lifeConversation,button.dataset.id))await load();}catch(error){dialog.querySelector('.lifecycle-status').textContent=error.message;}finally{button.disabled=false;}});
  await load();return dialog;
}
async function manageTask(action,id){
  if(ui.dirty||ui.draftDirty){toast('请先保存正文修改，再管理任务');return false;}
  const aid=activeAccount().id;
  if(action!=='restore'&&!await confirmLifecycle(action==='delete'?'删除这个制作任务？':'归档这个制作任务？','任务将从活动列表移除，尚在运行时先停止。可在任务管理中恢复；正文、配图、审批及已导出文件保留。',action==='delete'?'移入回收站':'确认归档'))return false;
  if(aid!==activeAccount().id)return false;
  const result=await api('jobs.'+action,{job_id:id,account_id:aid});
  if(aid!==activeAccount().id)return false;
  if(action!=='restore'&&ui.currentJob===id)changeView('studio');
  await refresh();toast(result.stopping?'已移除，当前执行正在停止；停止后可恢复':action==='restore'?'任务已恢复，点击继续才会运行':action==='archive'?'任务已归档':'任务已移入回收站');return true;
}
async function openTaskManager(){
  const aid=activeAccount().id;
  const dialog=lifecycleDialog('task-manager','管理制作任务',`<div class="lifecycle-filters"><select id="task-visibility" aria-label="任务范围"><option value="active">活动任务</option><option value="archived">已归档</option><option value="deleted">回收站</option></select><input id="task-search" placeholder="搜索标题或主题" aria-label="搜索任务"></div><p class="muted">恢复只放回任务列表，运行需要另行点击继续。</p><div id="task-management-list" class="lifecycle-list"></div>`);
  let sequence=0;
  const load=async()=>{const token=++sequence;dialog.querySelector('.lifecycle-status').textContent='正在读取任务…';try{
    const visibility=dialog.querySelector('#task-visibility').value,query=dialog.querySelector('#task-search').value.toLowerCase();
    const rows=await api('jobs.list',{account_id:aid,visibility});if(!dialog.open||aid!==activeAccount().id||token!==sequence)return;
    dialog.querySelector('#task-management-list').innerHTML=rows.filter(r=>(r.final_title||r.topic||'').toLowerCase().includes(query)).map(r=>`<div class="lifecycle-row"><div><strong>${esc(r.final_title||r.topic)}</strong><small>${esc(articleSeriesLabel(r))} · ${esc(stateNames[r.state]||r.state)} · ${dateString(r.updated_at)}</small></div><div class="button-row">${visibility==='active'?`<button class="button secondary small" data-life-open-task="${esc(r.job_id)}">查看</button><button class="button secondary small" data-life-task="archive" data-id="${esc(r.job_id)}">归档</button>`:`<button class="button secondary small" data-life-task="restore" data-id="${esc(r.job_id)}">恢复</button>`}${visibility!=='deleted'?`<button class="button text-button small danger-text" data-life-task="delete" data-id="${esc(r.job_id)}">删除</button>`:''}</div></div>`).join('')||'<p class="chat-muted">这里还没有任务</p>';dialog.querySelector('.lifecycle-status').textContent='';
  }catch(error){if(dialog.open&&token===sequence)dialog.querySelector('.lifecycle-status').textContent=error.message;}};
  dialog.querySelector('#task-visibility').addEventListener('change',load);dialog.querySelector('#task-search').addEventListener('input',load);
  dialog.addEventListener('click',async e=>{const open=e.target.closest('[data-life-open-task]');if(open){if(aid!==activeAccount().id)return;dialog.close();await openJob(open.dataset.lifeOpenTask);return;}const button=e.target.closest('[data-life-task]');if(!button||button.disabled)return;button.disabled=true;try{if(await manageTask(button.dataset.lifeTask,button.dataset.id))await load();}catch(error){dialog.querySelector('.lifecycle-status').textContent=error.message;}finally{button.disabled=false;}});await load();return dialog;
}
function paintCreativeRequestError(){
  document.querySelector('#chat-request-error')?.remove();const composer=document.querySelector('#chat-composer');if(!composer||!creative.requestError)return;
  composer.insertAdjacentHTML('beforebegin',`<div id="chat-request-error" class="chat-request-error" role="alert"><strong>请求未开始</strong><p>${esc(creative.requestError)}</p><small>输入和资料仍保留。可检查模型设置后重新发送。</small><div class="button-row"><button class="button secondary small" data-view="models">检查模型设置</button><button class="button text-button small" data-life-dismiss-error>收起</button></div></div>`);
}
function paintCreativeControls(){
  const hidden=Boolean(creative.data?.conversation.archived||creative.data?.conversation.deleted),busy=Boolean(creative.sending||creative.data?.messages.some(m=>m.status==='streaming'));
  const generate=document.querySelector('#chat-generate-draft'),send=document.querySelector('.chat-send');if(generate)generate.disabled=hidden||busy;if(send)send.disabled=hidden||busy;
}
function paintConversationAccess(){
  const conv=creative.data?.conversation,hidden=Boolean(conv?.archived||conv?.deleted);
  document.querySelector('#chat-access-note')?.remove();
  if(hidden)document.querySelector('#chat-context')?.insertAdjacentHTML('afterend',`<div id="chat-access-note" class="chat-access-note">${conv.deleted?'会话在回收站':'会话已归档'} · 恢复后可继续创作 <button class="button secondary small" data-life-conversation="restore" data-id="${esc(conv.id)}">恢复会话</button></div>`);
  for(const node of document.querySelectorAll('#chat-input,#chat-model,#chat-mode,#chat-clarification button,#chat-clarification textarea,#chat-handoff button,#chat-article [data-chat-action],.creative-toolbar [data-chat-action=archive],.creative-toolbar [data-chat-action=rename]'))if(hidden)node.disabled=true;
  const input=document.querySelector('#chat-input');if(input&&hidden)input.placeholder='恢复会话后可继续发送消息';
  paintCreativeControls();paintCreativeRequestError();
}
const paintMessagesWithLifecycle=paintCreativeMessages;
paintCreativeMessages=function(){paintMessagesWithLifecycle();paintConversationAccess();};
const paintPreviewWithLifecycle=paintCreativePreview;
paintCreativePreview=function(){paintPreviewWithLifecycle();paintConversationAccess();};
let rememberedChatModel='',rememberedModelAccount='';
const renderChatWithLifecycle=renderCreativeChat;
renderCreativeChat=async function(){await renderChatWithLifecycle();if(ui.view!=='chat')return;if(rememberedModelAccount!==activeAccount().id){rememberedChatModel='';rememberedModelAccount=activeAccount().id;creative.requestError='';}const select=document.querySelector('#chat-model');if(select&&[...select.options].some(o=>o.value===rememberedChatModel))select.value=rememberedChatModel;paintConversationAccess();};
function augmentLifecycleActions(){
  let changed=false;
  if(ui.view==='chat'){const row=workspace.querySelector('.creative-toolbar .button-row');if(row&&!row.querySelector('[data-life-conversation=delete]')){row.insertAdjacentHTML('beforeend',`<button class="chat-icon-button" data-life-conversation="delete" data-id="${esc(creative.id||'')}" title="删除会话（可恢复）" aria-label="删除会话" ${!creative.id||creative.data?.conversation.deleted?'disabled':''}>${ci('trash-2')}</button>`);changed=true;}}
  if(ui.view==='studio'){
    const heading=workspace.querySelector('.page-heading .heading-meta');if(heading&&!workspace.querySelector('[data-life-manage-tasks]')){heading.insertAdjacentHTML('beforebegin','<button class="button secondary" data-life-manage-tasks>管理任务</button>');changed=true;}
    for(const card of workspace.querySelectorAll('.task-card[data-job]'))if(!card.querySelector('.task-lifecycle-actions')){card.insertAdjacentHTML('beforeend',`<div class="task-lifecycle-actions"><button class="button text-button small" data-life-task="archive" data-id="${esc(card.dataset.job)}">归档</button><button class="button text-button small danger-text" data-life-task="delete" data-id="${esc(card.dataset.job)}">删除</button></div>`);changed=true;}
    const detail=workspace.querySelector('.detail-heading>.button-row');if(detail&&!detail.querySelector('[data-life-task]')){detail.insertAdjacentHTML('beforeend',`<button class="button secondary small" data-life-task="archive" data-id="${esc(ui.currentJob)}">归档任务</button><button class="button secondary small danger-text" data-life-task="delete" data-id="${esc(ui.currentJob)}">删除任务</button><button class="button secondary small" data-life-manage-tasks>管理任务</button>`);changed=true;}
  }
  if(changed)chatIcons();
}
new MutationObserver(augmentLifecycleActions).observe(workspace,{childList:true,subtree:true});
document.addEventListener('change',e=>{if(e.target.id==='chat-model'){rememberedChatModel=e.target.value;rememberedModelAccount=activeAccount().id;}});
document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-life-task],[data-life-conversation],[data-life-manage-tasks],[data-life-dismiss-error]');if(!button||button.closest('#task-manager,#conversation-manager'))return;
  e.preventDefault();e.stopImmediatePropagation();if(button.disabled)return;button.disabled=true;
  try{if(button.hasAttribute('data-life-manage-tasks'))await openTaskManager();else if(button.hasAttribute('data-life-dismiss-error')){creative.requestError='';paintCreativeRequestError();}else if(button.dataset.lifeTask)await manageTask(button.dataset.lifeTask,button.dataset.id);else if(button.dataset.id){const result=await manageConversation(button.dataset.lifeConversation,button.dataset.id);if(result&&button.dataset.lifeConversation==='restore'&&ui.view==='chat')await renderCreativeChat();}}catch(error){toast(error.message);}finally{button.disabled=false;}
},true);
