'use strict';
const creative = { account:'', id:null, data:null, selected:null, tab:'article', mode:'discuss', refs:[], documents:[], text:'', selectedText:'', sources:[], conversations:[], token:0, dirty:false, polling:false, lastPoll:0, signature:'', archived:false, useCurrent:false, sending:false, creating:false, retryMessage:null, deferred:new Set(), painted:new Set(), answers:{} };
const creativeStatus = {draft:'候选草稿',pending:'待审批',accepted:'已采用',rejected:'已退回',streaming:'生成中',completed:'',stopped:'已停止',interrupted:'回复已中断',failed:'生成失败'};
const ci = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const chatApi = (method,params={}) => api(method,{...params,account_id:activeAccount().id});
function chatIcons(){window.iceComponents?.icons();}
function chatCandidate(){if(creative.selected==='current')return null;return creative.data?.candidates.find(c=>c.id===creative.selected)||creative.data?.candidates[0];}
function resetCreativeAccount(){if(creative.account!==activeAccount().id){creative.account=activeAccount().id;creative.id=null;creative.data=null;creative.refs=[];creative.documents=[];creative.selectedText='';creative.useCurrent=false;creative.text='';creative.selected=null;creative.dirty=false;creative.archived=false;creative.answers={};creative.retryMessage=null;creative.painted.clear();++creative.token;}}
function creativeMountMatches(){
  const shell=document.querySelector('.creative-shell');
  return ui.view==='chat'&&shell?.dataset.chatAccount===activeAccount().id&&shell.dataset.chatConversation===String(creative.id||'')&&Boolean(document.querySelector('#chat-context')&&document.querySelector('#chat-messages')&&document.querySelector('#chat-composer'));
}
async function refreshConversationList(){
  const aid=activeAccount().id;
  const [rows,reviews,drafts]=await Promise.all([chatApi('chat.list',{archived:creative.archived}),chatApi('chat.reviews'),chatApi('chat.drafts')]);
  if(aid!==activeAccount().id)return;
  const conversations=[...new Map(rows.map(c=>[c.id,c])).values()];
  creative.conversations=conversations;
  document.querySelector('#recent-conversations').innerHTML=conversations.slice(0,6).map(c=>`<button class="recent-chat ${c.id===creative.id?'active':''}" data-chat-open="${esc(c.id)}" title="${esc(c.title)}">${ci('message-square')}<span>${esc(c.title)}</span></button>`).join('')||'<p class="chat-muted">还没有创作会话</p>';
  document.querySelector('#chat-review-count').textContent=reviews.filter(c=>c.status==='pending').length;
  document.querySelector('#sidebar-drafts').innerHTML=drafts.slice(0,5).map(d=>`<button class="recent-chat sidebar-draft" data-chat-draft="${esc(d.draft_id)}" data-conversation="${esc(d.conversation_id||'')}" title="${esc(d.title)}">${ci('file-text')}<span><strong>${esc(d.title)}</strong><small>${d.status==='accepted'?'已采用 · 可继续修改':d.status==='unapproved'?'初稿 · 未审批':'手动草稿'}</small></span></button>`).join('')||'<p class="chat-muted">保存初稿后显示在这里</p>';
  chatIcons();
}
async function renderCreativeChat(){
  resetCreativeAccount();
  const token=++creative.token,aid=activeAccount().id;
  await refreshConversationList();
  if(token!==creative.token||ui.view!=='chat'||aid!==activeAccount().id)return;
  if(!creative.id&&creative.conversations.length)creative.id=creative.conversations[0].id;
  if(creative.id){const id=creative.id,data=await chatApi('chat.get',{conversation_id:id});if(token!==creative.token||ui.view!=='chat'||aid!==activeAccount().id||id!==creative.id)return;creative.data=data;}
  else creative.data=null;
  if(creative.selected===null&&creative.data?.current.body&&(creative.data.candidates[0]?.status==='accepted'||creative.data.candidates[0]?.saved_draft?.changed)){creative.selected='current';creative.useCurrent=true;}
  creative.signature='';
  const conv=creative.data?.conversation;
  workspace.innerHTML=`<div class="creative-shell" data-chat-account="${esc(aid)}" data-chat-conversation="${esc(creative.id||'')}"><div class="creative-toolbar"><div><span class="eyebrow">CREATIVE WORKSPACE</span><h1>${esc(conv?.title||'让想法，在对话中成稿。')}</h1></div><div class="button-row"><button class="chat-icon-button" data-chat-action="sessions" title="查找会话" aria-label="查找会话">${ci('search')}</button><button class="chat-icon-button" data-chat-action="rename" title="重命名会话" aria-label="重命名会话">${ci('pencil')}</button><button class="chat-icon-button" data-chat-action="archive" title="归档会话" aria-label="归档会话">${ci('archive')}</button><button class="chat-icon-button" data-chat-action="preview" title="收起或展开文章预览" aria-label="收起或展开文章预览">${ci('panel-right-close')}</button></div></div><sl-split-panel id="creative-split" position="56"><section slot="start" class="conversation-pane"><div id="chat-context" class="chat-context"></div><div class="conversation-scroll" id="chat-messages" aria-live="polite" aria-label="创作对话"></div><div id="chat-progress" class="chat-progress" role="status" aria-live="polite" hidden></div><div class="draft-shortcut"><span>把已讨论的想法整理成文章</span><button id="chat-generate-draft" type="button" data-chat-action="generate-draft">${ci('file-plus-2')}生成初稿</button></div><form id="chat-composer" class="chat-composer"><textarea id="chat-input" maxlength="12000" aria-label="给编辑助手的消息" placeholder="讨论一个观点，或告诉我这篇文章想怎样修改…">${esc(creative.text)}</textarea><div class="composer-controls"><div class="button-row"><button type="button" class="chat-icon-button" data-chat-action="references" aria-label="引用文章" title="引用历史文章">${ci('paperclip')}</button><select id="chat-mode" aria-label="创作模式">${[['discuss','讨论'],['draft','生成初稿'],['edit','改稿'],['images','配图']].map(([v,l])=>`<option value="${v}" ${creative.mode===v?'selected':''}>${l}</option>`).join('')}</select><select id="chat-model" aria-label="写作模型"><option value="">使用写作模型配置</option>${ui.bootstrap.settings.profiles.map(p=>`<option value="${esc(p.profile_id)}">${esc(p.model_id)}</option>`).join('')}</select></div><button class="chat-send" type="submit" aria-label="发送消息">${ci('send')}</button><button type="button" class="chat-stop" data-chat-action="stop" hidden>${ci('square')}停止</button></div><div class="composer-hint">Enter 发送 · Shift + Enter 换行 <span>AI 内容需经审阅</span></div></form></section><aside slot="end" class="article-pane"><sl-tab-group id="creative-tabs"><sl-tab slot="nav" panel="article">文章预览</sl-tab><sl-tab slot="nav" panel="diff">修改对比</sl-tab><sl-tab slot="nav" panel="images">配图</sl-tab><sl-tab-panel name="article"><div id="chat-article"></div></sl-tab-panel><sl-tab-panel name="diff"><div id="chat-diff"></div></sl-tab-panel><sl-tab-panel name="images"><div id="chat-images"></div></sl-tab-panel></sl-tab-group><div id="chat-handoff" class="chat-handoff"></div></aside></sl-split-panel></div>`;
  document.querySelector('#chat-composer').addEventListener('submit',sendCreativeMessage);
  document.querySelector('.composer-controls .button-row').insertAdjacentHTML('afterbegin',`<button type="button" class="chat-icon-button" data-chat-action="document" title="附加文档" aria-label="附加文档">${ci('file-text')}</button>`);
  const mountedInput=document.querySelector('#chat-input'),mountedConversation=creative.id;
  mountedInput.addEventListener('input',e=>{if(aid===activeAccount().id&&mountedConversation===creative.id&&mountedInput===document.querySelector('#chat-input'))creative.text=e.target.value;});
  document.querySelector('#chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();document.querySelector('#chat-composer').requestSubmit();}});
  document.querySelector('#chat-mode').addEventListener('change',e=>{creative.mode=e.target.value;paintComposerMode();});
  document.querySelector('#creative-tabs').addEventListener('sl-tab-show',e=>creative.tab=e.detail.name);
  document.querySelector('#chat-article').addEventListener('mouseup',()=>{const selection=window.getSelection();if(selection?.anchorNode&&document.querySelector('#chat-article').contains(selection.anchorNode))creative.selectedText=selection.toString().slice(0,8000);});
  document.querySelector('#creative-split').addEventListener('sl-reposition',e=>{localStorage.setItem('ice-chat-split',String(e.target.position));});
  const position=Number(localStorage.getItem('ice-chat-split'));if(position>=30&&position<=75)document.querySelector('#creative-split').position=position;
  paintCreativeMessages();paintCreativePreview();paintComposerMode();chatIcons();
  document.querySelector('#creative-tabs').show(creative.tab);
}
function paintCreativeMessages(){
  if(!creativeMountMatches())return;
  const data=creative.data,conv=data?.conversation;
  document.querySelector('#chat-context').innerHTML=`<span class="context-pill">${esc(activeAccount().name)}</span>${conv?.series?`<span class="context-pill">${esc(conv.series)} · 栏目历史与大纲</span>`:''}<span class="context-pill">品牌规范</span>${creative.refs.map(id=>`<span class="context-pill" data-writing-reference="${esc(id)}">${esc(creative.sources.find(r=>r.id===id)?.title||'引用文章')}</span>`).join('')}${creative.selectedText?'<span class="context-pill">已选中文段</span>':''}${conv?.target.type?'<span class="context-pill">关联文章</span>':''}`;
  const messages=data?.messages||[];
  for(const [index,document] of creative.documents.entries())window.document.querySelector('#chat-context').insertAdjacentHTML('beforeend',`<button class="context-pill" data-chat-document-remove="${index}" title="移除文档">${esc(document.source_name)} ×</button>`);
  const container=document.querySelector('#chat-messages');
  const previousScrollTop=container.scrollTop;
  const nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<90;
  const previousNodes=new Map([...container.children].map(node=>[node.dataset.messageId,node]));
  const incoming=document.createElement('div');
  incoming.innerHTML=messages.length?messages.map(m=>{
    const status=m.status;
    const content=status==='streaming'&&m.metadata.mode!=='discuss'?'正文正在生成，完成校验后将在右侧展开。':m.content;
    const isNew=!creative.painted.has(m.id);creative.painted.add(m.id);
    const candidate=m.metadata.candidate_id&&data.candidates.find(c=>c.id===m.metadata.candidate_id);
    return `<article class="chat-message ${m.role} ${isNew?'chat-message-enter':''}" data-message-id="${esc(m.id)}"><div class="chat-speaker">${m.role==='user'?'你':ci('message-square')+'编辑助手'}<span>${esc(creativeStatus[status]||status)}</span></div><div class="chat-message-body">${renderMarkdown(content||(status==='streaming'?'等待模型回复…':'（没有正文）'))}</div>${m.metadata.history?.length?`<details class="chat-sources"><summary>参考 ${m.metadata.history.length} 篇正文 · ${m.metadata.title_count} 个标题 · 下一期 ${m.metadata.next_episode}</summary>${m.metadata.history.map(r=>`<p>${esc(r.episode)} · ${esc(r.title)}</p>`).join('')}</details>`:''}${candidate?`<div class="candidate-card"><div><strong>${esc(candidate.title)}</strong><small>${esc(creativeStatus[candidate.status])} · ${candidate.body.length.toLocaleString()} 字符</small></div><button class="button secondary small" data-chat-candidate="${esc(candidate.id)}">查看候选 ${ci('arrow-up-right')}</button></div>`:''}${['failed','stopped','interrupted'].includes(status)?`<button class="button text-button small" data-chat-action="retry" data-chat-retry="${esc(m.id)}">重新生成</button>`:''}</article>`;
  }).join(''):`<div class="chat-welcome"><div class="welcome-mark">${ci('message-square')}</div><span class="eyebrow">YOUR EDITORIAL PARTNER</span><h2>想法先说出来，<br>文章慢慢打磨。</h2><p>讨论观点、引用已有文章，或从下一期选题开始。<br>完成后同步审批，由你决定采用哪些修改。</p><div class="welcome-actions"><button data-chat-seed="根据本栏目前五篇文章、全部历史标题和预设大纲，帮我准备下一期选题与标题。" data-chat-mode="discuss">${ci('history')}准备下一期选题</button><button data-chat-seed="请根据我的想法写一份完整文章候选稿，先指出需要补充的资料。" data-chat-mode="draft">${ci('file-text')}把想法整理成稿</button><button data-chat-seed="分析这篇文章需要哪些配图，依据公众号风格为每张图准备英文生图提示词。" data-chat-mode="images">${ci('image')}规划文章配图</button></div></div>`;
  const desired=[...incoming.children].map(node=>{
    const message=messages.find(m=>m.id===node.dataset.messageId);
    const candidate=message?.metadata.candidate_id&&data.candidates.find(c=>c.id===message.metadata.candidate_id);
    const signature=JSON.stringify([message,candidate||null]),old=previousNodes.get(node.dataset.messageId);
    if(old?.iceMessageSignature===signature)return old;
    node.iceMessageSignature=signature;return node;
  });
  desired.forEach((node,index)=>{if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);});
  for(const node of [...container.children])if(!desired.includes(node))node.remove();
  for(const message of messages.filter(m=>m.status==='completed')){const host=container.querySelector(`[data-message-id="${message.id}"]`);if(host&&!host.querySelector('.chat-message-more'))host.insertAdjacentHTML('beforeend',`<details class="chat-message-more"><summary>更多</summary><button type="button" data-chat-fork="${esc(message.id)}">${ci('git-branch')}以此消息新建分支会话</button><small>日常续聊直接在下方输入，无需新建。</small></details>`);}
  const question=messages.filter(m=>m.role==='assistant'&&m.metadata.questions?.length).at(-1);
  const lastAssistant=messages.filter(m=>m.role==='assistant').at(-1);
  if(question&&question.id===lastAssistant?.id&&question.metadata.progress?.phase==='awaiting_input')paintClarification(container,question);
  if(nearBottom)container.scrollTop=container.scrollHeight;else container.scrollTop=previousScrollTop;
  window.iceMotion?.messages(container,conv?.id);
  for(const message of messages){const host=container.querySelector(`[data-message-id="${message.id}"]`),node=host?.querySelector('.chat-speaker>span');if(node&&message.status==='completed'&&node.textContent!==(message.metadata.model_id||''))node.textContent=message.metadata.model_id||'';if(message.metadata.documents?.length&&!host?.querySelector('.chat-message-documents'))host?.insertAdjacentHTML('beforeend',`<p class="chat-muted chat-message-documents">文档引用：${message.metadata.documents.map(d=>esc(d.source_name)).join(' · ')}</p>`);}
  const busy=messages.some(m=>m.status==='streaming');
  document.querySelector('.chat-send').hidden=busy;document.querySelector('.chat-stop').hidden=!busy;document.querySelector('#chat-generate-draft').disabled=busy||creative.sending;paintCreativeProgress();
  chatIcons();
  if(nearBottom){const paintedTop=container.scrollTop;requestAnimationFrame(()=>{if(container.isConnected&&Math.abs(container.scrollTop-paintedTop)<2)container.scrollTop=container.scrollHeight;});}
}
function creativeDiff(before,after){
  // Match prefix/suffix in order, including duplicate blank lines. Highlight the
  // complete changed range so moves and repeated paragraphs cannot disappear.
  const oldLines=before.split('\n'),newLines=after.split('\n');let prefix=0,suffix=0;
  while(prefix<Math.min(oldLines.length,newLines.length)&&oldLines[prefix]===newLines[prefix])prefix++;
  while(suffix<Math.min(oldLines.length-prefix,newLines.length-prefix)&&oldLines.at(-1-suffix)===newLines.at(-1-suffix))suffix++;
  const lines=(items,tone)=>items.map((line,i)=>`<span class="${i>=prefix&&i<items.length-suffix?tone:''}">${esc(line)||' '}</span>`).join('');
  return `<div class="diff-legend"><span>− 原稿</span><span>＋ 候选稿</span><span>标记本次变化范围</span></div><h3>原稿</h3><pre class="chat-diff-text">${lines(oldLines,'diff-removed')}</pre><h3>候选稿</h3><pre class="chat-diff-text">${lines(newLines,'diff-added')}</pre>`;
}
function paintCreativePreview(){
  if(!creativeMountMatches())return;
  const candidate=chatCandidate(),current=creative.data?.current,candidates=creative.data?.candidates||[];
  const busy=creative.data?.messages.some(m=>m.status==='streaming');
  const displayed=candidate?.status==='accepted'?(candidate.review.body||candidate.body):candidate?.body;
  const versions=`<select id="chat-candidate-select" aria-label="候选历史版本">${current?.body?`<option value="current" ${!candidate?'selected':''}>当前已保存正文</option>`:''}${candidates.map((c,i)=>`<option value="${esc(c.id)}" ${candidate?.id===c.id?'selected':''}>候选 ${candidates.length-i} · ${esc(creativeStatus[c.status])}</option>`).join('')}</select>`;
  document.querySelector('#chat-article').innerHTML=candidate?`<div class="preview-status"><span class="badge blue">${candidate.saved_draft?'已保存初稿':esc(creativeStatus[candidate.status])} · ${candidate.status==='accepted'?'已采用':'未审批'}</span><span>版本 ${candidates.length}</span></div><div class="candidate-tools">${versions}${candidate.status==='draft'?'<button class="button secondary small" data-chat-action="edit-candidate">手动修改</button>':''}<button class="button text-button small" data-chat-action="selection">修改选中文段</button></div><div class="markdown-preview chat-paper">${renderMarkdown(displayed)}</div>`:current?.body?`<div class="preview-status"><span class="badge">当前已保存正文</span></div><div class="candidate-tools">${versions}<button class="button secondary small" data-chat-action="rebase">基于本稿改稿</button></div><div class="markdown-preview chat-paper">${renderMarkdown(current.body)}</div>`:`<div class="preview-empty ${busy?'preview-generating':''}">${ci(busy?'file-pen-line':'file-text')}<h3>${busy?'初稿正在准备':'文章将在这里展开'}</h3><p>${busy?'左侧显示实际生成阶段。完成后即可预览和决定保存。':'点击“生成初稿”，或选择改稿模式。完成后在这里预览、比较和修改。'}</p>${busy?'<div class="preview-lines" aria-hidden="true"><span></span><span></span><span></span></div>':''}</div>`;
  document.querySelector('#chat-diff').innerHTML=candidate?creativeDiff(candidate.base.body,displayed):'<div class="preview-empty"><p>生成候选稿后查看修改对比。</p></div>';
  document.querySelector('#chat-images').innerHTML=`<div class="image-workflow"><h3>让配图接住文字</h3><p>使用配图模式准备提示词。在内嵌 TapNow 手动生图，再导入资源箱。</p><button class="button secondary" data-chat-action="tapnow">${ci('globe')}打开 TapNow</button><button class="button secondary" data-view="resources">配图资源箱</button></div>${candidate?.prompts.map((p,i)=>`<section class="chat-prompt"><strong>P${i+1} · 生图提示词</strong><pre>${esc(p)}</pre><button class="button secondary small" data-chat-copy="${i}">${ci('copy')}复制提示词</button></section>`).join('')||'<p class="chat-muted">还没有配图提示词，可以在对话中提出需求。</p>'}`;
  document.querySelector('#chat-handoff').innerHTML=candidate?`<p>${candidate.base.type?'基于关联原稿':'新的文章候选'} → ${esc(creativeStatus[candidate.status])}</p><button class="button primary" data-chat-action="submit" ${candidate.status!=='draft'?'disabled':''}>${ci('check-check')}${candidate.status==='draft'?'同步至文章审批':'已同步至文章审批'}</button><button class="button text-button small" data-view="editorial">查看审批</button>`:`<p>${current?.body?'这是已保存的当前正文。上方可选择历史候选，或继续改稿。':'生成初稿后由你决定是否保存。讨论不会自动创建文章或推进期号。'}</p>`;
  paintDraftDecision(candidate);
  const conflict=candidate?.status==='draft'&&(candidate.saved_draft?.changed||(!candidate.saved_draft&&candidate.base.content_hash!==current?.content_hash));
  if(conflict){document.querySelector('#chat-handoff').insertAdjacentHTML('afterbegin','<p class="chat-conflict">原稿已有新修改。旧候选保留，不会覆盖新版本。</p><button class="button secondary small" data-chat-action="rebase">基于最新稿继续</button>');document.querySelector('[data-chat-action="submit"]').disabled=true;}
  document.querySelector('#chat-candidate-select')?.addEventListener('change',e=>{creative.selected=e.target.value;creative.useCurrent=creative.selected==='current';paintCreativePreview();});
  chatIcons();
}
async function openCreativeConversation(id){
  if((ui.dirty||ui.draftDirty||ui.accountDirty)&&!confirm('有未保存修改，确认离开？'))return;
  ui.draftDirty=false;ui.accountDirty=false;
  for(const node of document.querySelectorAll('.creative-toolbar button,#chat-composer button,#chat-composer textarea,#chat-generate-draft'))node.disabled=true;
  creative.id=id;creative.requestError='';creative.retryMessage=null;creative.tab='article';creative.selected=null;creative.data=null;creative.refs=[];creative.documents=[];creative.selectedText='';creative.useCurrent=false;creative.text='';creative.dirty=false;ui.dirty=false;
  return changeView('chat');
}
async function startCreativeFrom(target,series=''){
  if(ui.dirty||ui.draftDirty||ui.accountDirty){toast('请先保存当前修改');return;}
  if(creative.creating)return;creative.creating=true;let result;const aid=activeAccount().id;try{result=await chatApi('chat.create',{target,series,reuse_target:true});}finally{creative.creating=false;}if(aid!==activeAccount().id)return;
  creative.account=activeAccount().id;creative.id=result.conversation.id;creative.retryMessage=null;creative.tab='article';creative.data=result;creative.selected=result.current?.body?'current':null;creative.refs=[];creative.documents=[];creative.selectedText='';creative.useCurrent=Boolean(result.current?.body);creative.text='';creative.mode='edit';
  return changeView('chat');
}
function chatDialog(html){
  let dialog=document.querySelector('#creative-dialog');if(dialog)dialog.remove();
  dialog=document.createElement('dialog');dialog.id='creative-dialog';dialog.className='modal creative-dialog';dialog.innerHTML=html;document.body.append(dialog);dialog.showModal();chatIcons();return dialog;
}
function closeCreativeDialog(){
  const dialog=document.querySelector('#creative-dialog');
  if(!dialog?.open)return true;
  if(!dialog.dispatchEvent(new Event('cancel',{cancelable:true})))return false;
  dialog.close();return true;
}
async function newCreativeConversation(options={}){
  if(ui.dirty||ui.draftDirty||ui.accountDirty){toast('请先保存当前修改再新建对话');return;}
  const dialog=chatDialog(`<form id="creative-new"><div class="modal-head"><div><span class="eyebrow">NEW CONVERSATION</span><h2>开启一次创作讨论</h2></div><button type="button" class="icon-button" data-chat-action="close-dialog" aria-label="关闭">×</button></div><label>会话名称<input name="title" maxlength="120" placeholder="例如：下一期选题与开头"></label><label>关联栏目<select name="series"><option value="">自由讨论 · 不关联栏目</option>${activeAccount().columns.map(c=>`<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('')}</select></label><p class="muted">选择栏目后，助手会读取前五篇正文、全部标题和对应期大纲。不会直接创建文章或改变发布进度。</p><div class="modal-actions"><button class="button primary" type="submit">开始对话 →</button></div></form>`);
  const requestId=crypto.randomUUID();let submitting=false;
  dialog.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();if(submitting)return;submitting=true;const aid=activeAccount().id;const button=e.submitter||e.target.querySelector('[type=submit]');button.disabled=true;try{const result=await chatApi('chat.create',{...Object.fromEntries(new FormData(e.target)),request_id:requestId});if(aid!==activeAccount().id)return;dialog.close();creative.id=result.conversation.id;creative.retryMessage=null;creative.tab='article';creative.account=activeAccount().id;creative.selected=null;creative.refs=options.references||[];creative.documents=options.documents||[];creative.selectedText='';creative.useCurrent=false;creative.text=options.generateDraft?options.text||'请根据当前栏目的历史和大纲生成完整初稿；缺少必要资料时先问我。':options.sendMessage?options.text||'':'';creative.mode=options.generateDraft?'draft':options.sendMessage?options.mode||'discuss':'discuss';await changeView('chat');if(options.sendMessage)window.iceWriting?.submitted({accountId:aid,conversationId:null,text:options.text});if((options.generateDraft||options.sendMessage)&&aid===activeAccount().id&&creative.id===result.conversation.id)await sendCreativeMessage({preventDefault(){}});}catch(error){toast(error.message);}finally{button.disabled=false;submitting=false;}});
}
async function sendCreativeMessage(event){
  event.preventDefault();if(creative.sending||creative.data?.messages.some(m=>m.status==='streaming'))return;
  if(creative.dirty){toast('请先保存右侧候选稿修改');return;}
  if(!creative.id){if(!creative.text.trim())return;await newCreativeConversation({sendMessage:true,text:creative.text,mode:creative.mode,references:[...creative.refs],documents:[...creative.documents]});return;}
  const text=creative.text.trim();if(!text)return;
  const messageList=document.querySelector('#chat-messages');if(messageList)messageList.scrollTop=messageList.scrollHeight;
  const candidate=chatCandidate();
  const payload={conversation_id:creative.id,text,mode:creative.mode,references:creative.refs,documents:creative.documents,selected_text:creative.selectedText,profile_id:document.querySelector('#chat-model').value};
  if(creative.retryMessage)payload.retry_message_id=creative.retryMessage;
  if(creative.useCurrent)payload.candidate_id=null;
  if(candidate?.status==='draft'&&!creative.useCurrent&&!creative.retryMessage)payload.candidate_id=candidate.id;
  const button=document.querySelector('.chat-send');button.disabled=true;creative.sending=true;const id=creative.id,aid=activeAccount().id;
  creative.requestError='';paintCreativeRequestError();
  try{await chatApi('chat.send',payload);window.iceWriting?.submitted({accountId:aid,conversationId:id,text});if(id!==creative.id||aid!==activeAccount().id)return;creative.useCurrent=false;creative.retryMessage=null;if(creative.text.trim()===text){creative.text='';const input=document.querySelector('#chat-input');if(input)input.value='';}creative.selectedText='';await pollCreative(true);await refreshConversationList();}catch(error){if(id===creative.id&&aid===activeAccount().id){creative.requestError=error.message;paintCreativeRequestError();}toast(error.message);}finally{creative.sending=false;button.disabled=false;if(id===creative.id&&aid===activeAccount().id)paintCreativeControls();}
}
async function pollCreative(force=false){
  if(creative.polling||!creative.id||!creativeMountMatches())return;
  // Fast refresh while streaming; avoid rereading article folders continuously
  // when the conversation is idle. Explicit saves/sends still refresh at once.
  if(!force&&!creative.data?.messages.some(m=>m.status==='streaming')&&Date.now()-creative.lastPoll<5000)return;
  creative.lastPoll=Date.now();
  creative.polling=true;const id=creative.id,aid=activeAccount().id,token=creative.token;
  try{const data=await chatApi('chat.get',{conversation_id:id});if(id!==creative.id||aid!==activeAccount().id||!creativeMountMatches()||token!==creative.token)return;
    const signature=JSON.stringify([data.conversation.archived,data.conversation.deleted,data.messages.map(m=>[m.id,m.status,m.content,m.metadata.progress,m.metadata.questions]),data.candidates.map(c=>[c.id,c.status,c.saved_draft]),data.current.content_hash]);
    if(Boolean(creative.data?.conversation.archived)!==Boolean(data.conversation.archived)||Boolean(creative.data?.conversation.deleted)!==Boolean(data.conversation.deleted)){creative.data=data;if(!creative.dirty){await renderCreativeChat();return;}paintConversationAccess();}
    if(signature!==creative.signature||force){const previous=creative.data?.candidates[0]?.id;const previewKey=d=>JSON.stringify([d?.candidates.map(c=>[c.id,c.status,c.saved_draft]),d?.current.content_hash,d?.messages.some(m=>m.status==='streaming')]);const previewChanged=force||previewKey(creative.data)!==previewKey(data);creative.signature=signature;creative.data=data;paintCreativeMessages();if(!creative.dirty&&previewChanged){if(previous!==data.candidates[0]?.id){creative.selected=data.candidates[0]?.id;creative.useCurrent=false;if(data.messages.at(-1)?.metadata.mode==='draft'){creative.tab='article';document.querySelector('#creative-tabs').show('article');}}paintCreativePreview();}}
  }catch(error){toast(error.message);}finally{creative.polling=false;}
}
function editCreativeCandidate(){
  const candidate=chatCandidate();if(!candidate||candidate.status!=='draft')return;
  document.querySelector('#chat-article').innerHTML=`<form id="candidate-editor"><label>标题<input name="title" maxlength="300" value="${esc(candidate.title)}" required></label><label>Markdown 正文<textarea name="body" class="chat-candidate-editor" maxlength="100000" required>${esc(candidate.body)}</textarea></label>${candidate.prompts.map((p,i)=>`<label>P${i+1} 提示词<textarea data-prompt-index="${i}" maxlength="12000">${esc(p)}</textarea></label>`).join('')}<div class="button-row"><button type="submit" class="button primary">保存新版本</button><button type="button" class="button secondary" data-chat-action="cancel-edit">取消</button></div><p class="muted">保存只生成新候选版本，仍需同步审批。</p></form>`;
  document.querySelector('#candidate-editor').addEventListener('input',()=>{creative.dirty=true;ui.dirty=true;});
  document.querySelector('#candidate-editor').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter||e.target.querySelector('[type=submit]');button.disabled=true;try{const result=await chatApi('chat.candidate_save',{candidate_id:candidate.id,content_hash:candidate.content_hash,...Object.fromEntries(new FormData(e.target)),prompts:[...e.target.querySelectorAll('[data-prompt-index]')].map(n=>n.value)});creative.selected=result.id;creative.dirty=false;ui.dirty=false;await pollCreative(true);toast('新候选版本已保存');}catch(error){toast(error.message);}finally{button.disabled=false;}});
}
async function pickCreativeReferences(){
  const aid=activeAccount().id,id=creative.id,token=creative.token,sources=await chatApi('chat.sources');if(aid!==activeAccount().id||id!==creative.id||token!==creative.token||ui.view!=='chat')return;creative.sources=sources;
  const dialog=chatDialog(`<form id="creative-references"><div class="modal-head"><h2>引用已有文章</h2><button type="button" class="icon-button" data-chat-action="close-dialog" aria-label="关闭">×</button></div><input id="reference-search" placeholder="搜索标题或栏目" aria-label="搜索引用文章"><div class="reference-list">${creative.sources.map(r=>`<label data-ref-title="${esc((r.title+r.series).toLowerCase())}"><input type="checkbox" name="reference" value="${esc(r.id)}" ${creative.refs.includes(r.id)?'checked':''}><span><strong>${esc(r.title)}</strong><small>${esc(r.series||'未标注栏目')} ${esc(r.episode??'')} · ${r.status==='published'?'已发布':'未标记发布'}</small></span></label>`).join('')||'<p>还没有文章，请在公众号与品牌设置存稿目录，或保存草稿。</p>'}</div><div class="modal-actions"><button type="submit" class="button primary">引用所选文章</button></div></form>`);
  dialog.querySelector('#reference-search').addEventListener('input',e=>dialog.querySelectorAll('[data-ref-title]').forEach(n=>n.hidden=!n.dataset.refTitle.includes(e.target.value.toLowerCase())));
  dialog.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const ids=new FormData(e.target).getAll('reference');if(ids.length>8){toast('一次最多引用8篇文章');return;}creative.refs=ids;dialog.close();paintCreativeMessages();});
}
async function renderEditorialReviews(){
  const token=++creative.token,aid=activeAccount().id;const reviews=await chatApi('chat.reviews');
  if(ui.view!=='editorial'||token!==creative.token||aid!==activeAccount().id)return;
  await refreshConversationList();
  if(ui.view!=='editorial'||token!==creative.token||aid!==activeAccount().id)return;
  workspace.innerHTML=pageHeading('YOUR EDITORIAL DECISION','文章审批','对话产生的候选稿在这里审阅。采用前仍可手动修改；采用后进入草稿箱或原文章任务。',`<button class="button primary" data-view="chat">继续创作对话 ${ci('arrow-up-right')}</button>`)+`<div class="editorial-list">${reviews.map(c=>`<article class="editorial-card"><div><span class="badge ${c.status==='pending'?'blue':''}">${esc(creativeStatus[c.status])}</span><h3>${esc(c.title)}</h3><p>${c.body.length.toLocaleString()} 字符 · ${dateString(c.created_at)} · ${c.base.type==='history'?'原文只读 · 采用后建立新草稿':c.base.type?'关联现有文章':'新的创作稿'}</p></div><button class="button secondary" data-chat-review="${esc(c.id)}">${c.status==='pending'?'审阅与修改':'查看审批记录'} →</button></article>`).join('')||'<div class="empty-state"><h3>等待你的下一份候选稿。</h3><p>在创作对话中生成文章，点击“同步至文章审批”。</p></div>'}</div>`;chatIcons();
}
async function openCreativeReview(id){
  const aid=activeAccount().id;const reviews=await chatApi('chat.reviews'),candidate=reviews.find(c=>c.id===id);if(!candidate||aid!==activeAccount().id)return;
  const pending=candidate.status==='pending';
  const dialog=chatDialog(`<form id="creative-review-form"><div class="modal-head"><div><span class="eyebrow">ARTICLE REVIEW</span><h2>${pending?'审阅并决定采用':'审批记录'}</h2></div><button type="button" class="icon-button" data-chat-action="close-dialog" aria-label="关闭">×</button></div><label>标题<input name="title" value="${esc(candidate.review.title||candidate.title)}" maxlength="300" required ${pending?'':'readonly'}></label><sl-tab-group><sl-tab slot="nav" panel="edit">${pending?'手动修改':'采用内容'}</sl-tab><sl-tab slot="nav" panel="compare">原稿对比</sl-tab><sl-tab-panel name="edit"><textarea class="review-body-editor" name="body" maxlength="100000" required ${pending?'':'readonly'}>${esc(candidate.review.body||candidate.body)}</textarea></sl-tab-panel><sl-tab-panel name="compare">${creativeDiff(candidate.base.body,candidate.body)}</sl-tab-panel></sl-tab-group><label>审批说明 / 退回修改意见<textarea name="note" maxlength="2000" rows="2" ${pending?'':'readonly'}>${esc(candidate.review.note||'')}</textarea></label><p class="muted">采用仅保存文章，不代表事实、图片已核验或已经发布。原文和配图资源会保留。</p><div class="modal-actions"><button type="button" class="button secondary" data-chat-open="${esc(candidate.conversation_id)}">返回关联对话</button>${pending?'<button type="submit" class="button secondary" name="decision" value="rejected">退回修改</button><button type="submit" class="button primary" name="decision" value="accepted">采用并保存文章</button>':''}</div></form>`);
  const form=dialog.querySelector('form');let dirty=false;form.addEventListener('input',()=>dirty=true);
  if(candidate.status==='accepted'&&candidate.review.target?.type==='draft')form.querySelector('.modal-actions').insertAdjacentHTML('beforeend',`<button type="button" class="button primary" data-chat-assets="${esc(candidate.id)}">准备配图与发布包 →</button>`);
  form.querySelector('[data-chat-assets]')?.addEventListener('click',async e=>{e.target.disabled=true;try{const draft=await chatApi('drafts.get',{draft_id:candidate.review.target.id});const result=await chatApi('chat.prepare_assets',{candidate_id:candidate.id,content_hash:draft.content_hash});dialog.close();ui.jobs=await api('jobs.list');await openJob(result.job_id);ui.tab='assets';renderDetail();}catch(error){toast(error.message);}finally{e.target.disabled=false;}});
  dialog.addEventListener('cancel',e=>{if(dirty&&!confirm('审批修改尚未保存，确认关闭？'))e.preventDefault();});
  form.addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const result=await chatApi('chat.review',{candidate_id:id,content_hash:candidate.content_hash,decision:button.value,...Object.fromEntries(new FormData(form))});dirty=false;dialog.close();toast(result.status==='accepted'?'已采用并保存，可到草稿箱或文章任务继续编辑':'已退回，意见已写入关联对话');await renderEditorialReviews();}catch(error){toast(error.message);}finally{button.disabled=false;}});
}
document.addEventListener('click',async event=>{
  const open=event.target.closest('[data-chat-open]'),review=event.target.closest('[data-chat-review]'),select=event.target.closest('[data-chat-candidate]'),seed=event.target.closest('[data-chat-seed]'),copy=event.target.closest('[data-chat-copy]'),from=event.target.closest('[data-chat-from]');
  try{
    const fork=event.target.closest('[data-chat-fork]');if(fork){if(creative.dirty){toast('请先保存候选修改');return;}await confirmCreativeFork(fork.dataset.chatFork);return;}
    const remove=event.target.closest('[data-chat-document-remove]');if(remove){creative.documents.splice(Number(remove.dataset.chatDocumentRemove),1);paintCreativeMessages();return;}
    if(open){if(!closeCreativeDialog())return;await openCreativeConversation(open.dataset.chatOpen);return;}
    if(review){await openCreativeReview(review.dataset.chatReview);return;}
    if(select){if(creative.dirty){toast('请先保存候选修改');return;}creative.selected=select.dataset.chatCandidate;paintCreativePreview();return;}
    const option=event.target.closest('[data-clarify-option]');if(option){const field=document.querySelector('#chat-clarification [name="'+CSS.escape(option.dataset.questionId)+'"]');if(field){field.value=option.dataset.clarifyOption;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();}return;}
    const draft=event.target.closest('[data-chat-draft]');if(draft){await startCreativeFrom({type:'draft',id:draft.dataset.chatDraft});return;}
    if(seed){creative.retryMessage=null;creative.text=seed.dataset.chatSeed;creative.mode=seed.dataset.chatMode;document.querySelector('#chat-input').value=creative.text;document.querySelector('#chat-mode').value=creative.mode;paintComposerMode();document.querySelector('#chat-input').focus();return;}
    if(copy){const value=chatCandidate()?.prompts[Number(copy.dataset.chatCopy)];if(value)await window.ice.copyText(value);toast('提示词已复制');return;}
    if(from){await startCreativeFrom({type:from.dataset.chatFrom,id:from.dataset.chatId},from.dataset.chatSeries||'');return;}
    const button=event.target.closest('[data-chat-action]');if(!button)return;
    switch(button.dataset.chatAction){
      case 'new':await newCreativeConversation();break;
      case 'generate-draft':creative.retryMessage=null;creative.tab='article';document.querySelector('#creative-tabs').show('article');if(!creative.id){await newCreativeConversation({generateDraft:true,text:creative.text});break;}creative.mode='draft';document.querySelector('#chat-mode').value='draft';if(!creative.text.trim())creative.text='请根据本会话已讨论的观点、当前栏目历史和预设大纲，生成一篇完整初稿。如果关键资料不足，先问我，等待回答后再写。';document.querySelector('#chat-input').value=creative.text;paintComposerMode();document.querySelector('#chat-composer').requestSubmit();break;
      case 'save-draft':await saveCreativeDraft();break;
      case 'later-draft':if(chatCandidate()){creative.deferred.add(chatCandidate().id);paintCreativePreview();toast('暂不保存，可随时在预览下方保存初稿');}break;
      case 'close-dialog':closeCreativeDialog();break;
      case 'references':await pickCreativeReferences();break;
      case 'document':{if(creative.documents.length>=3){toast('一次最多附加3份文档');break;}const aid=activeAccount().id;const file=await window.ice.importCreativeDocument(aid);if(file&&aid===activeAccount().id){if(file.text.length>30000){toast('文档超过3万字，请拆分后引用');break;}creative.documents.push(file);paintCreativeMessages();}break;}
      case 'rebase':creative.retryMessage=null;creative.useCurrent=true;creative.selected='current';paintCreativePreview();creative.mode='edit';document.querySelector('#chat-mode').value='edit';paintComposerMode();creative.text='请基于当前最新版原稿继续修改，旧候选仅供参考：';document.querySelector('#chat-input').value=creative.text;document.querySelector('#chat-input').focus();toast('下一条请求将使用最新版原稿');break;
      case 'stop':if(creative.id){await chatApi('chat.stop',{conversation_id:creative.id});await pollCreative(true);}break;
      case 'edit-candidate':editCreativeCandidate();break;
      case 'cancel-edit':if(!creative.dirty||confirm('放弃候选稿未保存修改？')){creative.dirty=false;ui.dirty=false;paintCreativePreview();}break;
      case 'selection':if(creative.selectedText){creative.mode='edit';document.querySelector('#chat-mode').value='edit';creative.text='请只修改我选中的这一段，保留其他内容：';document.querySelector('#chat-input').value=creative.text;document.querySelector('#chat-input').focus();paintCreativeMessages();}else toast('先在文章预览中选中需要修改的文字');break;
      case 'preview':document.querySelector('.creative-shell').classList.toggle('preview-collapsed');break;
      case 'tapnow':await window.ice.openTapNow();break;
      case 'submit':{if(creative.dirty){toast('请先保存候选修改');break;}const candidate=chatCandidate();if(candidate){await chatApi('chat.submit',{candidate_id:candidate.id,content_hash:candidate.content_hash});await pollCreative(true);await refreshConversationList();toast('候选稿已同步，等待文章审批');}break;}
      case 'retry':{const messages=creative.data?.messages||[];const index=messages.findIndex(m=>m.id===button.dataset.chatRetry);const last=messages.slice(0,index).findLast(m=>m.role==='user');if(last){creative.retryMessage=button.dataset.chatRetry;creative.text=last.content;creative.mode=last.metadata.mode;document.querySelector('#chat-input').value=last.content;document.querySelector('#chat-mode').value=creative.mode;paintComposerMode();document.querySelector('#chat-input').focus();toast('已恢复这次请求，发送后保留原资料重新生成');}break;}
      case 'rename':{if(!creative.id)break;const dialog=chatDialog(`<form><div class="modal-head"><h2>会话名称</h2><button type="button" class="icon-button" data-chat-action="close-dialog" aria-label="关闭">×</button></div><input name="title" maxlength="120" required value="${esc(creative.data.conversation.title)}"><div class="modal-actions"><button class="button primary">保存</button></div></form>`);dialog.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();await chatApi('chat.update',{conversation_id:creative.id,title:new FormData(e.target).get('title')});dialog.close();await renderCreativeChat();});break;}
      case 'archive':if(creative.id)await manageConversation('archive',creative.id);break;
      case 'sessions':await openConversationManager();break;
    }
  }catch(error){toast(error.message);}
});
// Augment article screens with the single AI editor entry, leaving manual editors intact.
const chatScreenObserver=new MutationObserver(()=>{
  if(ui.view==='studio'&&ui.currentJob){const heading=workspace.querySelector('.detail-heading>.button-row');if(heading&&!heading.querySelector('[data-chat-from]'))heading.insertAdjacentHTML('beforeend',`<button class="button secondary" data-chat-from="job" data-chat-id="${esc(ui.currentJob)}" data-chat-series="${esc(ui.detail?.article.series||'')}">在创作对话中修改</button>`);}
  if(ui.view==='drafts'&&ui.currentDraft?.draft_id){const button=workspace.querySelector('[data-pub-action="draft-to-brief"]');if(button){button.removeAttribute('data-pub-action');button.dataset.chatFrom='draft';button.dataset.chatId=ui.currentDraft.draft_id;button.textContent='在创作对话中修改 →';}}
  if(ui.view==='library'){const button=workspace.querySelector('[data-supp-action="library"]');if(button&&!workspace.querySelector('[data-chat-library]'))button.insertAdjacentHTML('afterend',`<button class="button secondary" data-chat-library="${esc(button.dataset.folder)}">在创作对话中修改 →</button>`);}
});
chatScreenObserver.observe(workspace,{childList:true,subtree:true});
document.addEventListener('click',async e=>{const button=e.target.closest('[data-chat-library]');if(!button)return;try{const sources=await chatApi('chat.sources');const library=await api('library.read',{folder:button.dataset.chatLibrary});const key='library:'+await hashText(library.file_path);const source=sources.find(r=>r.source_key===key);if(!source)throw Error('原文索引尚未找到，请刷新存稿');await startCreativeFrom({type:'history',id:source.id},source.series);}catch(error){toast(error.message);}});
setInterval(()=>{if(ui.bootstrap)pollCreative();},650);
bootReady.then(()=>{chatIcons();if(ui.bootstrap)changeView('chat');});


const creativePhases={queued:'排队中',reading_context:'读取资料',waiting_model:'等待模型',receiving:'接收内容',validating:'校验初稿',awaiting_input:'等待你补充',ready:'已完成',stopped:'已停止',failed:'生成失败'};
function paintComposerMode(){
  const input=document.querySelector('#chat-input');if(!input)return;
  input.placeholder=creative.mode==='draft'?'写下主题、希望读者带走什么；也可以从已有讨论生成初稿…':creative.mode==='edit'?'告诉我想改哪一段、语气或结构…':creative.mode==='images'?'描述配图需求，助手会准备可修改的生图提示词…':'讨论一个观点，或一起想下一期的主题…';
}
function paintCreativeProgress(){
  const host=document.querySelector('#chat-progress');if(!host)return;
  const message=creative.data?.messages.filter(m=>m.role==='assistant').at(-1),progress=message?.metadata.progress;
  if(!message||!progress){host.hidden=true;return;}host.hidden=false;
  const busy=message.status==='streaming',phase=progress.phase;
  const stages=['reading_context','waiting_model','receiving','validating','ready'];
  const seen=new Set((progress.transitions||[]).map(t=>typeof t==='string'?t:t.phase));
  const brief=message.metadata;
  host.dataset.started=progress.started_at||'';host.dataset.busy=String(busy);
  const signature=JSON.stringify([message.id,phase,busy,[...seen],brief.history?.length,brief.title_count,brief.documents?.length]);
  if(host.dataset.renderSignature===signature){const volume=host.querySelector('.progress-volume');if(volume)volume.textContent=Number(progress.received_chars||0).toLocaleString()+' 字符已接收';updateCreativeElapsed();return;}
  host.dataset.renderSignature=signature;
  host.innerHTML=`<div class="progress-heading"><span class="progress-pulse ${busy?'running':''}">${ci(busy?'loader-circle':phase==='awaiting_input'?'message-circle-question':phase==='ready'?'check':'circle-alert')}</span><strong>${esc(creativePhases[phase]||phase)}</strong><span id="chat-progress-time"></span><span class="progress-volume">${Number(progress.received_chars||0).toLocaleString()} 字符已接收</span></div><ol class="progress-stages">${stages.map(p=>`<li data-phase="${p}" class="${p===phase?'is-active':seen.has(p)?'is-done':''}"><span></span>${creativePhases[p]}</li>`).join('')}</ol><p>${busy?'你可以继续阅读原稿，也可以停止这次生成。':phase==='awaiting_input'?'下方的问题需要你的选择，回答后继续同一会话。':phase==='ready'?'内容已完成。先预览，再决定保存或交给审批。':message.status==='stopped'?'本次未完成的回复不会保存为草稿。':'本次没有产生可用初稿，可以重新生成。'}<small>参考 ${brief.history?.length||0} 篇正文 · ${brief.title_count||0} 个标题${brief.documents?.length?' · '+brief.documents.length+' 份文档':''}</small></p>`;
  updateCreativeElapsed();chatIcons();window.iceMotion?.enter(host);
}
function updateCreativeElapsed(){const host=document.querySelector('#chat-progress'),time=document.querySelector('#chat-progress-time');if(!time||host.hidden)return;const start=Date.parse(host.dataset.started),seconds=Number.isFinite(start)?Math.max(0,Math.floor((Date.now()-start)/1000)):0;time.textContent=host.dataset.busy==='true'?(seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'):'';}
function paintDraftDecision(candidate){
  const host=document.querySelector('#chat-handoff');if(!candidate)return;
  if(candidate.saved_draft){host.insertAdjacentHTML('afterbegin',`<div id="chat-draft-decision" class="draft-decision saved"><span>${ci('check')}已保存到草稿箱，${candidate.status==='accepted'?'已采用':'等待审批'}。</span><button class="button secondary small" data-chat-draft="${esc(candidate.saved_draft.draft_id)}">打开已存草稿</button></div>`);return;}
  if(candidate.status!=='draft')return;
  const deferred=creative.deferred.has(candidate.id);
  host.insertAdjacentHTML('afterbegin',`<div id="chat-draft-decision" class="draft-decision"><div><strong>${deferred?'候选稿尚未保存到草稿箱':'初稿已完成，是否保存到草稿箱？'}</strong><p>保存后显示在侧栏，仍可编辑并交给审批。</p></div><div class="button-row"><button class="button primary small" data-chat-action="save-draft">${ci('save')}保存初稿</button>${deferred?'':'<button class="button secondary small" data-chat-action="later-draft">暂不保存</button>'}</div></div>`);
}
async function saveCreativeDraft(){
  if(creative.dirty){toast('请先保存右侧的手动修改');return;}
  const candidate=chatCandidate();if(!candidate||candidate.saved_draft)return;
  const button=document.querySelector('[data-chat-action="save-draft"]');if(button?.disabled)return;if(button)button.disabled=true;
  const aid=activeAccount().id,id=creative.id;
  try{await chatApi('chat.save_draft',{candidate_id:candidate.id,content_hash:candidate.content_hash});if(aid!==activeAccount().id)return;creative.deferred.delete(candidate.id);if(id===creative.id)await pollCreative(true);await refreshConversationList();toast('初稿已保存，在侧栏或草稿箱中继续编辑');}catch(error){toast(error.message);}finally{if(button)button.disabled=false;}
}
function paintClarification(container,message){
  if(container.querySelector(`[data-message-id="${message.id}"] #chat-clarification`))return;
  const values=creative.answers[message.id]||{};
  container.querySelector(`[data-message-id="${message.id}"]`)?.insertAdjacentHTML('beforeend',`<form id="chat-clarification" class="chat-clarification"><div class="clarification-heading">${ci('message-circle-question')}先确认几项资料，再继续写</div>${message.metadata.questions.map(q=>`<label>${esc(q.question)}<textarea name="${esc(q.id)}" rows="2" maxlength="2000" required placeholder="填写你的答案，也可选择下方建议">${esc(values[q.id]||'')}</textarea></label><div class="clarification-options">${q.options.map(o=>`<button type="button" data-question-id="${esc(q.id)}" data-clarify-option="${esc(o)}">${esc(o)}</button>`).join('')}</div>`).join('')}<button class="button primary small" type="submit">补充并继续生成</button><small>答案会保存在当前会话，草稿不会提前创建。</small></form>`);
  const form=document.querySelector('#chat-clarification');if(!form)return;
  form.addEventListener('input',()=>creative.answers[message.id]=Object.fromEntries(new FormData(form)));
  form.addEventListener('submit',async e=>{e.preventDefault();if(creative.sending)return;const button=form.querySelector('[type=submit]');button.disabled=true;creative.sending=true;const aid=activeAccount().id,id=creative.id;try{const answers=Object.fromEntries(new FormData(form));await chatApi('chat.send',{conversation_id:id,text:'已补充以上资料，请据此继续。',mode:message.metadata.mode,references:creative.refs,documents:creative.documents,selected_text:creative.selectedText,clarification_message_id:message.id,clarification_answers:answers,profile_id:document.querySelector('#chat-model').value});if(aid===activeAccount().id&&id===creative.id){delete creative.answers[message.id];await pollCreative(true);await refreshConversationList();}}catch(error){toast(error.message);}finally{button.disabled=false;creative.sending=false;if(id===creative.id&&aid===activeAccount().id)paintCreativeControls();}});
}
async function confirmCreativeFork(messageId){
  const title=(creative.data?.conversation.title||'创作讨论').replace(/(?: · 分支)+$/g,'').slice(0,92)+' · 新方向';
  const dialog=chatDialog(`<form id="creative-fork"><div class="modal-head"><h2>新建一个分支会话</h2><button type="button" class="icon-button" data-chat-action="close-dialog" aria-label="关闭">×</button></div><p>会复制这条消息之前的对话，建立一个独立会话。日常继续讨论可以关闭窗口，在原会话下方直接输入。</p><label>分支名称<input name="title" maxlength="120" value="${esc(title)}" required></label><div class="modal-actions"><button type="button" class="button secondary" data-chat-action="close-dialog">留在当前会话</button><button class="button primary" type="submit">确认新建分支</button></div></form>`);
  let submitting=false;const aid=activeAccount().id,id=creative.id;
  dialog.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();if(submitting)return;submitting=true;const button=e.submitter||e.target.querySelector('[type=submit]');button.disabled=true;try{const result=await chatApi('chat.fork',{conversation_id:id,message_id:messageId,title:new FormData(e.target).get('title')});dialog.close();if(aid===activeAccount().id)await openCreativeConversation(result.conversation.id);}catch(error){toast(error.message);}finally{submitting=false;button.disabled=false;}});
}
setInterval(updateCreativeElapsed,1000);
