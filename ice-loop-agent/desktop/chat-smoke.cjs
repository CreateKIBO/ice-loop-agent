/* Real Electron UI acceptance with an isolated, explicitly offline fixture. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function({window,request,runtime}){
  // Activate only this isolated test window's compositor, without taking focus.
  // Hidden Chromium windows can freeze entrance animations at their first frame.
  window.showInactive();
  const trace=stage=>fs.appendFileSync(path.join(runtime,'chat-trace.log'),new Date().toISOString()+' '+stage+'\n');
  const consoleIssues=[];
  // Electron supports both the historical argument list and the details object.
  const onConsole=(_event,detailsOrLevel,message,line,source)=>{
    const details=typeof detailsOrLevel==='object'&&detailsOrLevel?detailsOrLevel:{level:detailsOrLevel,message,lineNumber:line,sourceId:source};
    if(details.level===3||details.level==='error')consoleIssues.push({kind:'webcontents-console',message:String(details.message||''),stack:`${details.sourceId||''}:${details.lineNumber||0}`,time:new Date().toISOString()});
  };
  window.webContents.on('console-message',onConsole);
  const saveRuntimeIssues=async()=>{
    let renderer=[];
    try{renderer=await window.webContents.executeJavaScript('window.chatSmokeRuntimeIssues||[]');}catch(error){renderer=[{kind:'instrumentation',message:error.message,stack:error.stack}];}
    const rows=[...renderer,...consoleIssues];
    fs.writeFileSync(path.join(runtime,'chat-runtime-issues.json'),JSON.stringify(rows,null,2));
    return rows;
  };
  const js=async code=>{let timer;try{return await Promise.race([window.webContents.executeJavaScript(code),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Renderer evaluation exceeded 30 seconds')),30000);})]);}catch(error){await saveRuntimeIssues();throw Error(code.slice(0,140)+' :: '+error.message);}finally{clearTimeout(timer);}};
  const wait=async code=>{for(let i=0;i<600;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}await capture('chat-failure.png');throw Error('Timed out: '+code+' :: '+await js('document.body.innerText.slice(-1800)'));};
  const capture=async name=>{trace('capture:start '+name);await new Promise(r=>setTimeout(r,250));const frame=await js('Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve("painted")))),new Promise(resolve=>setTimeout(()=>resolve("frame-timeout"),1000))])');trace('capture:frame '+frame);fs.writeFileSync(path.join(runtime,name),(await window.webContents.capturePage()).toPNG());trace('capture:done '+name);};
  const send=async(text,mode)=>{
    const previous=await js('creative.data?.messages.length||0');
    await js(`creative.mode=${JSON.stringify(mode)};document.querySelector('#chat-mode').value=creative.mode;creative.text=${JSON.stringify(text)};document.querySelector('#chat-input').value=creative.text;document.querySelector('#chat-composer').requestSubmit();`);
    await wait(`creative.data?.messages?.length>=${previous+2}&&creative.data?.messages?.at(-1)?.status==='completed'`);
  };
  const newConversation=async title=>{
    await js('newCreativeConversation()');await wait('Boolean(document.querySelector("#creative-new"))');
    await js(`document.querySelector('#creative-new [name=title]').value=${JSON.stringify(title)};document.querySelector('#creative-new [name=series]').value='PY';document.querySelector('#creative-new').requestSubmit();`);
    await wait(`!document.querySelector('#creative-dialog').open&&creative.data?.conversation.title===${JSON.stringify(title)}`);
    return js('creative.id');
  };
  await js(`(() => {
    window.chatSmokeRuntimeIssues=[];
    const record=(kind,message,stack,operation,errorName)=>{
      let accountId='';try{accountId=typeof activeAccount==='function'?activeAccount()?.id||'':'';}catch(_){}
      window.chatSmokeRuntimeIssues.push({kind,message:String(message||''),stack:String(stack||''),operation:operation||'',error_name:errorName||'',time:new Date().toISOString(),view:typeof ui==='undefined'?'':ui.view,account_id:accountId,conversation_id:typeof creative==='undefined'?'':creative.id||'',chat_mounted:Boolean(document.querySelector('#chat-context'))});
    };
    const originalToast=toast;
    toast=function(message){record('toast',message,new Error('Toast origin').stack,'toast');return originalToast(message);};
    const originalConsoleError=console.error;
    console.error=function(...args){const error=args.find(value=>value instanceof Error);record('console',args.map(String).join(' '),error?.stack||new Error('Console origin').stack,'console.error',error?.name);return originalConsoleError.apply(console,args);};
    window.addEventListener('error',event=>record('error',event.message,event.error?.stack||event.filename+':'+event.lineno,'window.error',event.error?.name));
    window.addEventListener('unhandledrejection',event=>record('rejection',event.reason?.message||event.reason,event.reason?.stack||new Error('Unhandled rejection origin').stack,'window.unhandledrejection',event.reason?.name));
    for(const name of ['paintCreativeMessages','paintCreativePreview','paintCreativeProgress','renderCreativeChat']){
      const original=window[name];if(typeof original!=='function')continue;
      window[name]=function(...args){
        try{const value=original.apply(this,args);if(value&&typeof value.then==='function')return value.catch(error=>{record('operation',error.message,error.stack,name,error.name);throw error;});return value;}
        catch(error){record('operation',error.message,error.stack,name,error.name);throw error;}
      };
    }
    return true;
  })()`);
  trace('boot:start');await js('bootReady');trace('boot:done');await wait('ui.view==="chat"&&Boolean(document.querySelector("#chat-input"))');trace('chat:rendered');
  await js('customElements.whenDefined("sl-split-panel").then(()=>true)');await js('customElements.whenDefined("sl-tab-group").then(()=>true)');
  trace('components:defined');
  const result={components:true};
  await capture('chat-welcome.png');
  const before=(await request('jobs.list')).length;
  const initialId=await js('creative.id'),initialCount=(await request('chat.list')).length;
  await send('根据前四篇文章的标题与内容，讨论下一期主题，并给我几个标题。','discuss');
  result.discussionNoArticle=(await request('jobs.list')).length===before&&(await request('drafts.list')).length===0;
  const state=await js('creative.data');
  assert.equal(state.candidates.length,0);
  result.history=state.messages[0].metadata.history.length===4&&state.messages[0].metadata.title_count===4&&state.messages[0].metadata.next_episode===5;
  await send('在同一会话继续讨论：哪一个题目更适合零基础读者？','discuss');
  await send('继续这个话题，给我一个开头方向。','discuss');
  result.sameConversation=(await js('creative.id'))===initialId&&(await request('chat.list')).length===initialCount;
  await js('refreshConversationList()');
  result.uniqueRecentEntries=await js('(()=>{const ids=[...document.querySelectorAll("#recent-conversations [data-chat-open]")].map(b=>b.dataset.chatOpen);return ids.length===new Set(ids).size&&ids.filter(id=>id===creative.id).length===1;})()');
  result.explicitBranch=await js('Boolean(document.querySelector(".chat-message-more [data-chat-fork]"))&&[...document.querySelectorAll("[data-chat-fork]")].every(b=>b.closest("details.chat-message-more")&&!b.closest("details").open)');
  await js('document.querySelector(".chat-message-more summary").click();document.querySelector("[data-chat-fork]").click()');
  await wait('Boolean(document.querySelector("#creative-fork"))');
  await js('document.querySelector("#creative-fork [data-chat-action=close-dialog]").click()');
  result.branchCancel=(await request('chat.list')).length===initialCount;
  await js('document.querySelector("[data-chat-fork]").click()');await wait('Boolean(document.querySelector("#creative-fork"))');
  await js('document.querySelector("#creative-fork [name=title]").value="PY/005 · 另一种开头";document.querySelector("#creative-fork [type=submit]").click()');
  await wait('creative.data?.conversation.title==="PY/005 · 另一种开头"');
  result.branchConfirmed=(await request('chat.list')).length===initialCount+1&&(await js('creative.id'))!==initialId;
  await js(`openCreativeConversation(${JSON.stringify(initialId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(initialId)}`);
  const initialDraftMessages=await js('creative.data.messages.length');
  await js('window.chatSmokePhases=[];window.chatSmokePhaseTimer=setInterval(()=>{const phase=document.querySelector("#chat-progress [data-phase].is-active")?.dataset.phase;if(phase&&!window.chatSmokePhases.includes(phase))window.chatSmokePhases.push(phase);},50);creative.text="把我们的讨论写成完整文章，优化标题和开头。";document.querySelector("#chat-input").value=creative.text;document.querySelector("#chat-generate-draft").click()');
  result.draftOption=await js('creative.mode==="draft"&&document.querySelector("#chat-mode").value==="draft"');
  await wait('Boolean(document.querySelector("#chat-progress [data-phase=receiving].is-active"))');
  await js('window.iceMotion.setPreference("on")');
  await wait('window.iceMotion.activeCount>0&&document.querySelector("#chat-progress .progress-pulse.running")?.getAnimations().some(animation=>animation.playState==="running")');
  result.motionLibraryActive=await js('Boolean(window.iceMotion.effect)&&window.iceMotion.activeCount>0&&Boolean(document.querySelector("#chat-progress .progress-pulse.running")?.getAnimations().some(animation=>animation.playState==="running"))');
  await capture('chat-generating.png');
  const debuggerAlreadyAttached=window.webContents.debugger.isAttached();
  if(!debuggerAlreadyAttached)window.webContents.debugger.attach('1.3');
  try{
    await js('window.iceMotion.setPreference("system")');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await wait('matchMedia("(prefers-reduced-motion: reduce)").matches&&window.iceMotion.reduced()&&window.iceMotion.activeCount===0');
    result.reducedMotion=await js('(()=>{const pulse=document.querySelector("#chat-progress .progress-pulse");return matchMedia("(prefers-reduced-motion: reduce)").matches&&window.iceMotion.reduced()&&window.iceMotion.activeCount===0&&Boolean(pulse)&&pulse.getAnimations().length===0&&getComputedStyle(pulse).animationName==="none";})()');
  }finally{
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    if(!debuggerAlreadyAttached)window.webContents.debugger.detach();
  }
  await wait(`creative.data?.messages?.length>=${initialDraftMessages+2}&&creative.data?.messages?.at(-1)?.status==='completed'`);
  await wait('creative.data?.candidates.length===1&&Boolean(document.querySelector("[data-chat-action=edit-candidate]"))');
  await wait('Boolean(document.querySelector("#chat-draft-decision [data-chat-action=save-draft]"))');
  await wait('document.querySelector("#studio-journey")?.dataset.signature==="1:初稿待确认"');
  result.journeyCandidate=true;
  result.saveChoice=(await request('drafts.list')).length===0&&await js('Boolean(document.querySelector("#chat-draft-decision [data-chat-action=later-draft]"))');
  result.progress=await js('clearInterval(window.chatSmokePhaseTimer);window.chatSmokePhases.length>=2&&window.chatSmokePhases.includes("receiving")&&!/\\d+%/.test(document.querySelector("#chat-progress").textContent)');
  fs.writeFileSync(path.join(runtime,'chat-progress-stages.json'),JSON.stringify(await js('window.chatSmokePhases'),null,2));
  await capture('chat-draft-decision.png');
  await js('document.querySelector("#chat-draft-decision [data-chat-action=later-draft]").click()');
  result.deferSave=(await request('drafts.list')).length===0;
  result.candidate=await js('Boolean(document.querySelector("[data-chat-action=submit]"))&&document.querySelector("#chat-article").textContent.includes("for 和 while")');
  await capture('chat-article.png');
  await js('document.querySelector("#creative-tabs").show("diff")');await capture('chat-diff.png');
  result.diff=await js('document.querySelector("#chat-diff").textContent.includes("候选稿")');
  await js('document.querySelector("#creative-tabs").show("article");editCreativeCandidate();document.querySelector("#candidate-editor textarea[name=body]").value+="\\n\\n人工补充的观点。";document.querySelector("#candidate-editor textarea[name=body]").dispatchEvent(new Event("input",{bubbles:true}));');
  await new Promise(r=>setTimeout(r,1000));
  result.unsavedProtected=await js('document.querySelector("#candidate-editor textarea").value.includes("人工补充")');
  await js('document.querySelector("#candidate-editor").requestSubmit();');await wait('creative.data?.candidates.length===2&&!creative.dirty');
  await js('document.querySelector("[data-chat-action=submit]").click();');await wait('chatCandidate()?.status==="pending"');
  await wait('document.querySelector("#chat-review-count").textContent==="1"');
  await wait('document.querySelector("#studio-journey")?.dataset.signature==="2:等待审批"');
  result.journeyPending=true;
  result.pending=await js('document.querySelector("#chat-review-count").textContent==="1"');
  await js('changeView("editorial")');await wait('Boolean(document.querySelector("[data-chat-review]"))');await capture('chat-approval-list.png');
  await js('document.querySelector("[data-chat-review]").click()');await wait('Boolean(document.querySelector("#creative-review-form"))');await capture('chat-review.png');
  result.reviewUnsavedProtected=await js('document.querySelector("#creative-review-form textarea[name=note]").value="尚未保存的意见";document.querySelector("#creative-review-form textarea[name=note]").dispatchEvent(new Event("input",{bubbles:true}));window.iceOriginalConfirm=window.confirm;window.confirm=()=>false;document.querySelector("#creative-review-form [data-chat-action=close-dialog]").click();const protectedEdit=document.querySelector("#creative-dialog").open;window.confirm=window.iceOriginalConfirm;protectedEdit');
  await js('document.querySelector("#creative-review-form textarea[name=body]").value+="\\n\\n审批时再次修改。";document.querySelector("#creative-review-form").requestSubmit(document.querySelector("#creative-review-form button[value=accepted]"));');
  await wait('!document.querySelector("#creative-dialog").open');
  const drafts=await request('drafts.list');assert.equal(drafts.length,1);
  const draft=await request('drafts.get',{draft_id:drafts[0].draft_id});
  result.approvalEdited=draft.body.includes('人工补充')&&draft.body.includes('审批时再次修改');
  await js('changeView("drafts")');await wait('Boolean(document.querySelector("[data-pub-action=open-draft]"))');
  await js('document.querySelector("[data-pub-action=open-draft]").click()');await wait('Boolean(document.querySelector("[data-chat-from=draft]"))');result.draftEntry=true;
  const beforeReopen=(await request('chat.list')).length;
  await js('document.querySelector("[data-chat-from=draft]").click()');await wait('ui.view==="chat"&&creative.data?.current?.type==="draft"&&Boolean(document.querySelector("#chat-mode"))');
  const reusedId=await js('creative.id');
  await js(`startCreativeFrom({type:'draft',id:${JSON.stringify(drafts[0].draft_id)}})`);await wait(`creative.data?.conversation.id===${JSON.stringify(reusedId)}`);
  result.reuseArticle=(await request('chat.list')).length===beforeReopen&&(await js('creative.id'))===initialId;
  result.sharedBody=await js('creative.data.current.body.includes("审批时再次修改")&&document.querySelector("#chat-article").textContent.includes("审批时再次修改")');
  await js('const adopted=creative.data.candidates.find(c=>c.status==="accepted");document.querySelector("#chat-candidate-select").value=adopted.id;document.querySelector("#chat-candidate-select").dispatchEvent(new Event("change",{bubbles:true}))');
  await wait('document.querySelector("#studio-journey")?.dataset.signature==="3:文章已采用"');
  result.journeyAccepted=true;
  await js('creative.selected="current";creative.useCurrent=true;paintCreativePreview()');
  const priorCandidates=await js('creative.data.candidates.length');
  await send('请为这篇文章设计一张封面提示词。','images');await wait(`creative.data?.candidates.length===${priorCandidates+1}`);
  await js('document.querySelector("#creative-tabs").show("images")');result.prompts=await js('Boolean(document.querySelector("[data-chat-copy]"))&&Boolean(document.querySelector("[data-chat-action=tapnow]"))');await capture('chat-image-prompts.png');
  const convId=await js('creative.id');
  await window.setSize(1040,760);await new Promise(r=>setTimeout(r,300));await capture('chat-compact.png');
  result.compact=await js('document.body.scrollWidth<=innerWidth');
  await window.setSize(1460,940);
  await js('creative.selectedText="不能带入其他公众号的旧原文选区"');
  const another=await request('accounts.save',{account:{name:'隔离测试公众号',audience:'测试读者',columns:[{code:'ART',name:'文章'}]}});
  await js('useBootstrap('+JSON.stringify(another)+',"chat")');await wait('ui.view==="chat"&&creative.account===activeAccount().id');
  result.isolation=(await request('chat.list')).length===0&&await js('!creative.selectedText&&creative.refs.length===0&&creative.documents.length===0');
  const restored=await request('accounts.switch',{account_id:'ice-loop'});await js('useBootstrap('+JSON.stringify(restored)+',"chat")');await wait('creative.conversations.length>=1');
  result.persisted=(await request('chat.get',{conversation_id:convId})).messages.length>0;
  await js('creative.documents=[{source_name:"旧会话文档",text:"不可带入新会话"}];creative.selectedText="旧选区";creative.useCurrent=true;newCreativeConversation();');await wait('Boolean(document.querySelector("#creative-new"))');
  await js('document.querySelector("#creative-new").requestSubmit();');await wait('!document.querySelector("#creative-dialog").open&&creative.data?.conversation.title==="新的创作讨论"');
  result.newContextReset=await js('creative.documents.length===0&&!creative.selectedText&&!creative.useCurrent');
  const savingId=await newConversation('PY/005 · 可保存的初稿');
  await send('请围绕 for 和 while 的区别生成初稿，用九九乘法表解释循环。','draft');
  await wait('creative.data?.candidates.length===1&&Boolean(document.querySelector("#chat-draft-decision [data-chat-action=save-draft]"))');
  const beforeSaveDrafts=await request('drafts.list'),saveCandidate=await js('chatCandidate()');
  await capture('chat-save-request.png');
  await js('document.querySelector("#chat-draft-decision [data-chat-action=save-draft]").click()');
  await wait('Boolean(creative.data?.candidates[0]?.saved_draft)&&Boolean(document.querySelector("#sidebar-drafts [data-chat-draft]"))');
  const savedDrafts=await request('drafts.list'),savedDraft=savedDrafts.find(d=>!beforeSaveDrafts.some(previous=>previous.draft_id===d.draft_id));
  assert.ok(savedDraft,'New draft must share the existing draft library');
  result.saveDraft=savedDrafts.length===beforeSaveDrafts.length+1;
  await wait('document.querySelector("#studio-journey")?.dataset.signature==="1:已有保存稿"');
  result.journeySaved=true;
  const latestSaveCandidate=(await request('chat.get',{conversation_id:savingId})).candidates.find(c=>c.id===saveCandidate.id);
  await request('chat.save_draft',{candidate_id:saveCandidate.id,content_hash:latestSaveCandidate.content_hash});
  result.saveIdempotent=(await request('drafts.list')).length===savedDrafts.length;
  const sidebarDrafts=await request('chat.drafts');
  result.draftSidebar=sidebarDrafts.some(d=>d.draft_id===savedDraft.draft_id&&d.conversation_id===savingId&&d.status==='unapproved')&&await js(`Boolean(document.querySelector('#sidebar-drafts [data-chat-draft="${savedDraft.draft_id}"]'))`);
  await capture('chat-saved-sidebar.png');
  await js(`document.querySelector('#sidebar-drafts [data-chat-draft="${savedDraft.draft_id}"]').click()`);await wait(`creative.data?.conversation.id===${JSON.stringify(savingId)}`);
  result.savedDraftContinues=await js(`creative.id===${JSON.stringify(savingId)}&&creative.data.current.body.includes('for')`);
  const beforeQuestionCount=(await request('chat.list')).length,clarifyId=await newConversation('PY/005 · 先确认资料');
  await send('请先问清楚资料，再生成初稿。读者水平和案例方向尚未确定。','draft');
  await wait('Boolean(document.querySelector("#chat-clarification"))&&creative.data?.messages.at(-1)?.metadata.questions?.length>0');
  result.clarificationFirst=await js('creative.data.candidates.length===0&&creative.data.messages.at(-1).metadata.progress.phase==="awaiting_input"&&[...document.querySelectorAll("#chat-clarification textarea")].every(field=>getComputedStyle(field).display==="block"&&field.getBoundingClientRect().width>=document.querySelector("#chat-clarification").getBoundingClientRect().width-45)')&&(await request('drafts.list')).length===savedDrafts.length;
  await capture('chat-clarification.png');
  const beforeAnswerMessages=await js('creative.data.messages.length');
  await js('document.querySelectorAll("#chat-clarification [name]").forEach(field=>{field.value="零基础在校学生，用九九乘法表作为案例；不宣称代码已运行。";field.dispatchEvent(new Event("input",{bubbles:true}));});');
  await js('pollCreative(true)');
  result.clarificationFirst&&=await js('[...document.querySelectorAll("#chat-clarification [name]")].every(field=>field.value.includes("不宣称代码已运行"))');
  await js('document.querySelector("#chat-clarification").requestSubmit();');
  await wait(`creative.data?.messages?.length>=${beforeAnswerMessages+2}&&creative.data?.messages?.at(-1)?.status==='completed'&&creative.data?.candidates?.length===1`);
  result.clarificationReply=(await js('creative.id'))===clarifyId&&(await request('chat.list')).length===beforeQuestionCount+1&&(await request('drafts.list')).length===savedDrafts.length;
  await js('changeView("library")');await wait('Boolean(document.querySelector("[data-library]"))');
  await js('document.querySelector("[data-library]").click()');await wait('Boolean(document.querySelector("[data-chat-library]"))');
  await new Promise(r=>setTimeout(r,500));
  result.libraryEntryStable=await js('document.querySelectorAll("[data-chat-library]").length===1');
  await capture('chat-library-entry.png');
  // Management uses rendered controls, confirmation and the existing article store.
  await js(`openCreativeConversation(${JSON.stringify(savingId)})`);await wait(`creative.id===${JSON.stringify(savingId)}&&Boolean(document.querySelector('[data-life-conversation=delete]'))`);
  await js('creative.dirty=true;ui.dirty=true;document.querySelector("[data-chat-action=archive]").click()');
  result.archiveDirtyNotice=await js('!document.querySelector("#lifecycle-confirm")&&document.querySelector("#toast").textContent.includes("请先保存")');
  await js('creative.dirty=false;ui.dirty=false;document.querySelector("[data-chat-action=archive]").click()');await wait('Boolean(document.querySelector("#lifecycle-confirm"))');
  await js('document.querySelector("#lifecycle-confirm [data-life-close]").click()');await new Promise(r=>setTimeout(r,150));
  result.archiveCancelled=(await request('chat.list')).some(c=>c.id===savingId);
  await js('document.querySelector("[data-chat-action=archive]").click()');await wait('Boolean(document.querySelector("#lifecycle-confirm"))');await js('document.querySelector("[data-life-confirm]").click()');
  await wait(`creative.id!==${JSON.stringify(savingId)}`);
  result.archiveConversation=(await request('chat.list',{archived:true})).some(c=>c.id===savingId)&&!(await request('chat.list')).some(c=>c.id===savingId);
  await js('openConversationManager()');await wait('Boolean(document.querySelector("#conversation-visibility"))');
  await js('document.querySelector("#conversation-visibility").value="archived";document.querySelector("#conversation-visibility").dispatchEvent(new Event("change",{bubbles:true}));');
  await wait(`Boolean(document.querySelector('#conversation-manager [data-life-conversation="restore"][data-id="${savingId}"]'))`);
  await capture('chat-archived-list.png');await js(`document.querySelector('#conversation-manager [data-life-conversation="restore"][data-id="${savingId}"]').click()`);
  result.archiveConversation&&=await js('document.querySelector("#conversation-search").getBoundingClientRect().width>240&&document.querySelector("#conversation-visibility").getBoundingClientRect().width<=240');
  await wait(`!document.querySelector('#conversation-manager [data-id="${savingId}"]')`);
  result.restoreConversation=(await request('chat.list')).some(c=>c.id===savingId);
  await js('document.querySelector("#conversation-manager").close()');await js(`openCreativeConversation(${JSON.stringify(savingId)})`);await wait(`creative.id===${JSON.stringify(savingId)}&&Boolean(document.querySelector('[data-life-conversation=delete]'))`);
  await js('document.querySelector(".creative-toolbar [data-life-conversation=delete]").click()');await wait('Boolean(document.querySelector("#lifecycle-confirm"))');await js('document.querySelector("[data-life-confirm]").click()');await wait(`creative.id!==${JSON.stringify(savingId)}`);
  result.deleteConversation=(await request('chat.list',{deleted:true})).some(c=>c.id===savingId)&&!(await request('chat.list')).some(c=>c.id===savingId);
  result.deleteKeepsSavedDraft=(await request('drafts.get',{draft_id:savedDraft.draft_id})).body=== (await request('chat.get',{conversation_id:savingId})).current.body;
  await js('openConversationManager()');await wait('Boolean(document.querySelector("#conversation-visibility"))');
  await js('document.querySelector("#conversation-visibility").value="deleted";document.querySelector("#conversation-visibility").dispatchEvent(new Event("change",{bubbles:true}));');await wait(`Boolean(document.querySelector('#conversation-manager [data-life-conversation="restore"][data-id="${savingId}"]'))`);
  await capture('chat-recycle-bin.png');await js(`document.querySelector('#conversation-manager [data-life-conversation="restore"][data-id="${savingId}"]').click()`);await wait(`!document.querySelector('#conversation-manager [data-id="${savingId}"]')`);
  result.restoreDeletedConversation=(await request('chat.list')).some(c=>c.id===savingId)&&(await request('drafts.get',{draft_id:savedDraft.draft_id})).body.includes('for');await js('document.querySelector("#conversation-manager").close()');
  // Force completion before the first UI poll, exposing the old permanently-disabled shortcut.
  await js(`openCreativeConversation(${JSON.stringify(savingId)})`);await wait(`creative.id===${JSON.stringify(savingId)}&&Boolean(document.querySelector('#chat-generate-draft'))`);
  const beforeFast=await js('creative.data.messages.length');
  await js('window.originalFastPoll=pollCreative;window.delayFirstDraftPoll=true;pollCreative=async function(force){if(force&&creative.sending&&window.delayFirstDraftPoll){window.delayFirstDraftPoll=false;for(let i=0;i<300;i++){const snapshot=await chatApi("chat.get",{conversation_id:creative.id});if(!snapshot.messages.some(m=>m.status==="streaming"))break;await new Promise(r=>setTimeout(r,30));}}return window.originalFastPoll(force);};document.querySelector("#chat-generate-draft").click()');
  await wait(`creative.data?.messages?.length>=${beforeFast+2}&&!creative.sending&&!creative.data?.messages?.some(m=>m.status==='streaming')`);
  result.fastCompletionUnlocks=await js('!document.querySelector("#chat-generate-draft").disabled&&!document.querySelector(".chat-send").disabled');await js('pollCreative=window.originalFastPoll;delete window.originalFastPoll');
  const managedJob=await request('jobs.create',{demo:true});
  await js('changeView("studio")');await wait('Boolean(document.querySelector("[data-life-manage-tasks]"))');await js('openTaskManager()');await wait(`Boolean(document.querySelector('#task-manager [data-life-task="archive"][data-id="${managedJob.job_id}"]'))`);
  await js(`document.querySelector('#task-manager [data-life-task="archive"][data-id="${managedJob.job_id}"]').click()`);await wait('Boolean(document.querySelector("#lifecycle-confirm"))');await js('document.querySelector("[data-life-confirm]").click()');await wait(`!document.querySelector('#task-manager [data-id="${managedJob.job_id}"]')`);
  for(let i=0;i<150&&(await request('jobs.get',{job_id:managedJob.job_id})).job.stopping;i++)await new Promise(r=>setTimeout(r,100));
  result.archiveTask=!(await request('jobs.list')).some(j=>j.job_id===managedJob.job_id)&&(await request('jobs.list',{visibility:'archived'})).some(j=>j.job_id===managedJob.job_id);
  result.archiveTask&&=await js('document.querySelector("#task-search").getBoundingClientRect().width>240&&document.querySelector("#task-visibility").getBoundingClientRect().width<=240');
  await js('document.querySelector("#task-visibility").value="archived";document.querySelector("#task-visibility").dispatchEvent(new Event("change",{bubbles:true}));');await wait(`Boolean(document.querySelector('#task-manager [data-life-task="restore"][data-id="${managedJob.job_id}"]'))`);await capture('chat-archived-tasks.png');
  await js(`document.querySelector('#task-manager [data-life-task="restore"][data-id="${managedJob.job_id}"]').click()`);await wait(`!document.querySelector('#task-manager [data-id="${managedJob.job_id}"]')`);
  result.restoreTaskPaused=(await request('jobs.get',{job_id:managedJob.job_id})).job.state==='paused';
  await js('document.querySelector("#task-visibility").value="active";document.querySelector("#task-visibility").dispatchEvent(new Event("change",{bubbles:true}));');await wait(`Boolean(document.querySelector('#task-manager [data-life-task="delete"][data-id="${managedJob.job_id}"]'))`);
  const taskBeforeDelete=await request('jobs.get',{job_id:managedJob.job_id});
  await js(`document.querySelector('#task-manager [data-life-task="delete"][data-id="${managedJob.job_id}"]').click()`);await wait('Boolean(document.querySelector("#lifecycle-confirm"))');await js('document.querySelector("[data-life-confirm]").click()');await wait(`!document.querySelector('#task-manager [data-id="${managedJob.job_id}"]')`);
  result.deleteTask=(await request('jobs.list',{visibility:'deleted'})).some(j=>j.job_id===managedJob.job_id);
  result.deleteTaskKeepsArticle=(await request('jobs.get',{job_id:managedJob.job_id})).body===taskBeforeDelete.body;
  await js('document.querySelector("#task-visibility").value="deleted";document.querySelector("#task-visibility").dispatchEvent(new Event("change",{bubbles:true}));');await wait(`Boolean(document.querySelector('#task-manager [data-life-task="restore"][data-id="${managedJob.job_id}"]'))`);await capture('chat-task-recycle-bin.png');
  await js(`document.querySelector('#task-manager [data-life-task="restore"][data-id="${managedJob.job_id}"]').click()`);await wait(`!document.querySelector('#task-manager [data-id="${managedJob.job_id}"]')`);
  result.restoreDeletedTask=(await request('jobs.list')).some(j=>j.job_id===managedJob.job_id);await js('document.querySelector("#task-manager").close()');
  await js('changeView("chat")');await wait('Boolean(document.querySelector("#chat-generate-draft"))');
  await js('creative.id=null;creative.data=null;creative.text="为零基础学生写一篇循环入门初稿。";document.querySelector("#chat-generate-draft").click()');await wait('Boolean(document.querySelector("#creative-new"))');
  await js('document.querySelector("#creative-new [name=title]").value="直接开始的初稿";document.querySelector("#creative-new [name=series]").value="PY";document.querySelector("#creative-new").requestSubmit()');
  await wait('creative.data?.conversation?.title==="直接开始的初稿"&&creative.data?.messages?.at(-1)?.status==="completed"&&creative.data?.candidates?.length===1&&!creative.sending');
  result.newConversationStartsDraft=await js('creative.mode==="draft"&&!document.querySelector("#chat-generate-draft").disabled&&Boolean(document.querySelector("#chat-draft-decision"))');
  await capture('chat-new-conversation-draft.png');
  // v1.5 UX checks reuse the already generated conversations, drafts and task.
  // Only the final acknowledgement race sends one additional offline discussion.
  trace('v1.5:ux:start');
  const finalConversationId=await js('creative.id');
  Object.assign(result,await require('./tests/writing-ux-ui.cjs')(js));
  await capture('v1.5-creative-workspace.png');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))');
  await wait('Boolean(document.querySelector("#command-palette")?.open)&&document.querySelector("#command-results")?.getAttribute("aria-busy")==="false"');
  result.commandKeyboard=await js('document.activeElement.id==="command-input"&&document.querySelector("#command-input").getAttribute("role")==="combobox"&&document.querySelector("#command-account").textContent===activeAccount().name');
  await js('document.querySelector("#command-input").value="PY";document.querySelector("#command-input").dispatchEvent(new Event("input",{bubbles:true}))');
  await wait('document.querySelectorAll("#command-results [data-command-result]").length>=2');
  const searchKinds=await js('[...document.querySelectorAll("#command-results [data-command-result]")].map(node=>node.querySelector(".command-kind").textContent)');
  result.commandSearchRecords=searchKinds.includes('对话')&&searchKinds.includes('草稿');
  await capture('v1.5-command-search.png');
  await js(`document.querySelector('#command-input').value=${JSON.stringify(savedDraft.draft_id)};document.querySelector('#command-input').dispatchEvent(new Event('input',{bubbles:true}))`);
  await wait('document.querySelectorAll("#command-results [data-command-result]").length===1&&document.querySelector("#command-results .command-kind").textContent==="草稿"');
  await js('window.originalDraftNavigation=startCreativeFrom;startCreativeFrom=async function(...args){const opened=await window.originalDraftNavigation(...args);await new Promise(resolve=>{window.releaseDraftNavigation=resolve;});return opened;};true');
  await js('const input=document.querySelector("#command-input");const draftIndex=[...document.querySelectorAll("#command-results [data-command-result]")].findIndex(node=>node.querySelector(".command-kind").textContent==="草稿");for(let i=0;i<draftIndex;i++)input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await wait(`!document.querySelector('#command-palette')?.open&&creative.id===${JSON.stringify(savingId)}&&creative.data?.current?.id===${JSON.stringify(savedDraft.draft_id)}&&Boolean(document.querySelector('#chat-input'))`);
  result.commandOpensDraft=await js(`creative.account===activeAccount().id&&creative.data?.current?.id===${JSON.stringify(savedDraft.draft_id)}`);
  await wait('Boolean(window.releaseDraftNavigation)&&window.iceNavigation.busy');
  await js('window.iceNavigation.open();window.releaseDraftNavigation();startCreativeFrom=window.originalDraftNavigation;delete window.originalDraftNavigation;delete window.releaseDraftNavigation;true');
  await wait('document.querySelector("#command-palette").open&&document.querySelector("#command-results").getAttribute("aria-busy")==="false"');
  result.commandQueuedReopen=await js('!window.iceNavigation.busy&&document.activeElement.id==="command-input"&&document.querySelector("#command-results [data-command-result]")!==null');
  await js('window.iceNavigation.close();window.iceNavigation.open();true');
  await wait('document.querySelector("#command-palette").open&&document.querySelector("#command-results").getAttribute("aria-busy")==="false"');
  await new Promise(resolve=>setTimeout(resolve,150));
  result.commandCloseReopen=await js('document.querySelector("#command-palette").open&&document.activeElement.id==="command-input"&&document.querySelector("#command-results [data-command-result]")!==null');
  await js('document.querySelector("#command-input").value="直接开始的初稿";document.querySelector("#command-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#command-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await wait(`creative.id===${JSON.stringify(finalConversationId)}&&creative.data?.conversation?.id===${JSON.stringify(finalConversationId)}&&Boolean(document.querySelector('#chat-input'))`);
  result.commandOpensConversation=await js(`creative.account===activeAccount().id&&creative.id===${JSON.stringify(finalConversationId)}`);
  await js('window.iceNavigation.open()');await wait('document.querySelector("#command-palette").open&&document.querySelector("#command-results").getAttribute("aria-busy")==="false"');
  await js(`document.querySelector('#command-input').value=${JSON.stringify(managedJob.job_id)};document.querySelector('#command-input').dispatchEvent(new Event('input',{bubbles:true}));`);
  await wait('document.querySelector("#command-results .command-kind")?.textContent==="任务"');
  await js('document.querySelector("#command-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await wait(`ui.currentJob===${JSON.stringify(managedJob.job_id)}&&ui.detail?.job?.job_id===${JSON.stringify(managedJob.job_id)}&&Boolean(document.querySelector('.detail-heading'))`);
  result.commandOpensTask=await js(`ui.currentJob===${JSON.stringify(managedJob.job_id)}&&activeAccount().id==="ice-loop"`);
  // Switching publication closes a palette and never reveals prior-account rows.
  await js('window.iceNavigation.open()');await wait('document.querySelector("#command-palette").open&&document.querySelector("#command-results").getAttribute("aria-busy")==="false"');
  const switchedUx=await request('accounts.switch',{account_id:another.account.id});
  await js('useBootstrap('+JSON.stringify(switchedUx)+',"chat")');await wait('activeAccount().id!=="ice-loop"&&ui.view==="chat"&&Boolean(document.querySelector("#chat-input"))&&!document.querySelector("#command-palette").open');
  await js('window.iceNavigation.open()');await wait('document.querySelector("#command-palette").open&&document.querySelector("#command-results").getAttribute("aria-busy")==="false"');
  result.commandAccountIsolation=await js('document.querySelector("#command-account").textContent===activeAccount().name&&[...document.querySelectorAll("#command-results .command-kind")].every(node=>node.textContent==="页面")');
  await js('window.iceNavigation.close()');
  const restoredUx=await request('accounts.switch',{account_id:'ice-loop'});await js('useBootstrap('+JSON.stringify(restoredUx)+',"chat")');
  await js(`openCreativeConversation(${JSON.stringify(finalConversationId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(finalConversationId)}&&Boolean(document.querySelector('#chat-input'))`);
  // Input values are stored under mounted account/conversation IDs during real
  // navigation, not merely under the current selection at debounce completion.
  const textA='v1.5 输入恢复：留在这一会话的观点',textB='v1.5 输入恢复：另一会话的独立观点';
  await js(`document.querySelector('#chat-input').value=${JSON.stringify(textA)};document.querySelector('#chat-input').dispatchEvent(new Event('input',{bubbles:true}));`);
  await js(`openCreativeConversation(${JSON.stringify(savingId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(savingId)}&&Boolean(document.querySelector('#chat-input'))`);
  await js(`document.querySelector('#chat-input').value=${JSON.stringify(textB)};document.querySelector('#chat-input').dispatchEvent(new Event('input',{bubbles:true}));changeView('models')`);
  await wait('ui.view==="models"&&!document.querySelector("#chat-input")');
  await js(`openCreativeConversation(${JSON.stringify(finalConversationId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(finalConversationId)}&&document.querySelector('#chat-input')?.value===${JSON.stringify(textA)}`);
  result.inputAcrossConversations=true;
  await js(`openCreativeConversation(${JSON.stringify(savingId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(savingId)}&&document.querySelector('#chat-input')?.value===${JSON.stringify(textB)}`);
  result.inputAcrossPages=true;
  await js('document.querySelector("#chat-input").value="";document.querySelector("#chat-input").dispatchEvent(new Event("input",{bubbles:true}));window.iceWriting.persist()');
  await js(`openCreativeConversation(${JSON.stringify(finalConversationId)})`);await wait(`creative.data?.conversation.id===${JSON.stringify(finalConversationId)}&&Boolean(document.querySelector('#chat-input'))`);
  await js('document.querySelector("#chat-input").value="";document.querySelector("#chat-input").dispatchEvent(new Event("input",{bubbles:true}));window.iceWriting.persist()');
  // Hold the publication-list request after selecting B. The old account's
  // composer must already be detached while that request is still pending.
  const switchingInput='v1.5 账号切换：这是 A 公众号尚未发送的私人观点';
  await js(`window.originalAccountList=refreshConversationList;window.delayAccountList=true;window.accountListBlocked=false;window.oldAccountComposer=document.querySelector('#chat-input');window.oldAccountComposer.value=${JSON.stringify(switchingInput)};window.oldAccountComposer.dispatchEvent(new Event('input',{bubbles:true}));refreshConversationList=async function(...args){if(window.delayAccountList&&activeAccount().id!=='ice-loop'){window.delayAccountList=false;window.accountListBlocked=true;await new Promise(resolve=>{window.releaseAccountList=resolve;});}return window.originalAccountList(...args);};true`);
  const delayedPublication=await request('accounts.switch',{account_id:another.account.id});
  try {
    await js('window.accountSwitchPromise=useBootstrap('+JSON.stringify(delayedPublication)+',"chat");true');
    await wait('window.accountListBlocked&&activeAccount().id!=="ice-loop"');
    result.accountSwitchUnloadsComposer=await js('!window.oldAccountComposer.isConnected&&!document.querySelector("#chat-input")');
    await capture('v1.5-account-switch-pending.png');
    await js('window.releaseAccountList();true');
    await js('window.accountSwitchPromise');
    await wait('ui.view==="chat"&&creative.account===activeAccount().id&&Boolean(document.querySelector("#chat-input"))');
    result.accountSwitchInputIsolated=await js(`document.querySelector('#chat-input').value!==${JSON.stringify(switchingInput)}&&!creative.text.includes(${JSON.stringify(switchingInput)})&&window.iceWriting.createInputStore(localStorage).get(activeAccount().id,null)!==${JSON.stringify(switchingInput)}`);
  } finally { await js('window.releaseAccountList?.();refreshConversationList=window.originalAccountList;delete window.originalAccountList;delete window.releaseAccountList;delete window.accountSwitchPromise;delete window.oldAccountComposer;delete window.delayAccountList;delete window.accountListBlocked;true'); }
  const recoveredPublication=await request('accounts.switch',{account_id:'ice-loop'});
  await js('useBootstrap('+JSON.stringify(recoveredPublication)+',"chat")');
  await js(`openCreativeConversation(${JSON.stringify(finalConversationId)})`);
  await wait(`creative.data?.conversation.id===${JSON.stringify(finalConversationId)}&&document.querySelector('#chat-input')?.value===${JSON.stringify(switchingInput)}`);
  result.accountSwitchInputRecovered=await js(`window.iceWriting.createInputStore(localStorage).get('ice-loop',${JSON.stringify(finalConversationId)})===${JSON.stringify(switchingInput)}`);
  // A real conversation remains selected while its renderer is temporarily
  // absent. Forced polling must wait for the correct mounted chat shell.
  await js('window.iceWriting.persist();workspace.innerHTML="<div id=chat-poll-loading role=status>正在载入创作工作区…</div>";true');
  await js('pollCreative(true)');
  await wait('!creative.polling');
  result.pollDefersUntilChatMounted=await js(`creative.id===${JSON.stringify(finalConversationId)}&&Boolean(document.querySelector('#chat-poll-loading'))&&!document.querySelector('#chat-context')&&!document.querySelector('#chat-messages')`);
  await capture('v1.5-deferred-poll.png');
  await js('renderCreativeChat()');
  await wait(`creative.data?.conversation?.id===${JSON.stringify(finalConversationId)}&&document.querySelector('#chat-input')?.value===${JSON.stringify(switchingInput)}`);
  await js('document.querySelector("#chat-input").value="";document.querySelector("#chat-input").dispatchEvent(new Event("input",{bubbles:true}));window.iceWriting.persist();true');
  const expanded=await js('(()=>{document.body.classList.remove("sidebar-collapsed");localStorage.setItem("ice-sidebar-collapsed","false");return document.querySelector(".sidebar").getBoundingClientRect().width;})()');
  await js('document.querySelector("[data-sidebar-toggle]").click()');await new Promise(r=>setTimeout(r,100));
  result.sidebarCollapse=await js(`document.body.classList.contains('sidebar-collapsed')&&document.querySelector('.sidebar').getBoundingClientRect().width<${expanded/2}&&document.querySelector('[data-sidebar-toggle]').getAttribute('aria-expanded')==='false'&&localStorage.getItem('ice-sidebar-collapsed')==='true'`);
  await capture('v1.5-sidebar-collapsed.png');
  await js('document.querySelector("[data-sidebar-toggle]").click()');
  result.sidebarRestore=await js(`!document.body.classList.contains('sidebar-collapsed')&&Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width-${expanded})<2&&document.querySelector('[data-sidebar-toggle]').getAttribute('aria-expanded')==='true'&&document.body.scrollWidth<=innerWidth`);
  await js('document.querySelector("[data-studio-preferences]").click()');await wait('Boolean(document.querySelector("#studio-preferences")?.open)');
  await js('document.querySelector("#studio-motion").value="on";document.querySelector("#studio-motion").dispatchEvent(new Event("change",{bubbles:true}));window.iceMotion.effect(document.querySelector("#studio-preferences"),{opacity:[.8,1]},{duration:2,repeat:Infinity});true');
  await wait('window.iceMotion.activeCount>0&&document.querySelector("#studio-preferences").getAnimations().some(animation=>animation.playState==="running")');
  await js('document.querySelector("#studio-motion").value="off";document.querySelector("#studio-motion").dispatchEvent(new Event("change",{bubbles:true}))');
  await wait('window.iceMotion.reduced()&&window.iceMotion.activeCount===0');
  result.motionPreferenceClears=await js('window.iceMotion.preference==="off"&&document.documentElement.dataset.motion==="off"&&document.querySelector("#studio-preferences").getAnimations().length===0&&localStorage.getItem("ice-motion")==="off"');
  await js('document.querySelector("#studio-density").value="compact";document.querySelector("#studio-density").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#studio-preferences .modal-actions button").click();document.querySelector("[data-studio-preferences]").click()');
  result.densityPreference=await js('document.documentElement.dataset.density==="compact"&&localStorage.getItem("ice-density")==="compact"&&document.querySelector("#studio-density").value==="compact"');
  await capture('v1.5-display-preferences.png');
  await js('document.querySelector("#studio-density").value="comfortable";document.querySelector("#studio-density").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#studio-motion").value="system";document.querySelector("#studio-motion").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#studio-preferences .modal-actions button").click()');
  // Inject typing at the acknowledgement boundary of an actual offline send.
  // This keeps the real send path and production admission API unchanged.
  const acknowledgedText='v1.5 已发送：继续讨论这一篇文章的观点',nextTypedText='v1.5 未发送：这是等待回复时输入的新问题';
  const messagesBeforeTyping=await js('creative.data.messages.length');
  await js(`window.originalTypingSubmitted=window.iceWriting.submitted;window.iceWriting.submitted=function(context){const input=document.querySelector('#chat-input');input.value=${JSON.stringify(nextTypedText)};input.dispatchEvent(new Event('input',{bubbles:true}));return window.originalTypingSubmitted(context);};creative.mode='discuss';document.querySelector('#chat-mode').value='discuss';document.querySelector('#chat-input').value=${JSON.stringify(acknowledgedText)};document.querySelector('#chat-input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chat-composer').requestSubmit()`);
  try {
    await wait(`creative.data?.messages?.length>=${messagesBeforeTyping+2}&&creative.data?.messages?.at(-1)?.status==='completed'&&!creative.sending`);
    result.pendingSendPreservesTyping=await js(`document.querySelector('#chat-input').value===${JSON.stringify(nextTypedText)}&&creative.text===${JSON.stringify(nextTypedText)}&&window.iceWriting.createInputStore(localStorage).get(activeAccount().id,creative.id)===${JSON.stringify(nextTypedText)}`);
  } finally { await js('window.iceWriting.submitted=window.originalTypingSubmitted;delete window.originalTypingSubmitted'); }
  await capture('v1.5-input-preserved.png');
  // Empty-selection handoff uses the normal send button, preserves a cancelled
  // setup, and sends the original message once after setup is confirmed.
  const firstMessage='v1.5 首次消息：先讨论这篇文章应如何说明循环的用途';
  const beforeFirstMessage=(await request('chat.list')).length;
  await js(`creative.id=null;creative.data=null;creative.text='';creative.mode='discuss';creative.refs=[];creative.documents=[];creative.selectedText='';creative.useCurrent=false;creative.retryMessage=null;const oldInput=document.querySelector('#chat-input'),emptyInput=oldInput.cloneNode(true);emptyInput.value='';oldInput.replaceWith(emptyInput);emptyInput.addEventListener('input',event=>creative.text=event.target.value);emptyInput.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.querySelector('#chat-composer').requestSubmit();}});document.querySelector('#chat-mode').value='discuss';window.iceWriting.enhance();emptyInput.value=${JSON.stringify(firstMessage)};emptyInput.dispatchEvent(new Event('input',{bubbles:true}));window.iceWriting.persist();document.querySelector('#chat-composer').requestSubmit()`);
  await wait('Boolean(document.querySelector("#creative-new"))&&document.querySelector("#creative-dialog").open');
  const firstInputRetained=await js(`window.iceWriting.createInputStore(localStorage).get(activeAccount().id,null)===${JSON.stringify(firstMessage)}`);
  await js('document.querySelector("#creative-new [data-chat-action=close-dialog]").click()');
  await wait('!document.querySelector("#creative-dialog").open');
  const firstCancelRetained=await js(`creative.id===null&&document.querySelector('#chat-input').value===${JSON.stringify(firstMessage)}&&creative.text===${JSON.stringify(firstMessage)}`);
  await js('document.querySelector("#chat-composer").requestSubmit()');await wait('Boolean(document.querySelector("#creative-new"))&&document.querySelector("#creative-dialog").open');
  await js('document.querySelector("#creative-new [name=title]").value="v1.5 首次消息自动衔接";document.querySelector("#creative-new [name=series]").value="PY";document.querySelector("#creative-new").requestSubmit()');
  await wait('creative.data?.conversation?.title==="v1.5 首次消息自动衔接"&&creative.data?.messages?.at(-1)?.status==="completed"&&!creative.sending');
  result.firstMessageHandoff=firstInputRetained&&firstCancelRetained&&(await request('chat.list')).length===beforeFirstMessage+1&&await js(`creative.data.messages.filter(message=>message.role==='user').length===1&&creative.data.messages.find(message=>message.role==='user').content===${JSON.stringify(firstMessage)}&&creative.mode==='discuss'&&document.querySelector('#chat-input').value===''&&creative.text===''&&window.iceWriting.createInputStore(localStorage).get(activeAccount().id,null)===''&&window.iceWriting.createInputStore(localStorage).get(activeAccount().id,creative.id)===''`);
  await capture('v1.5-first-message-handoff.png');
  trace('v1.5:ux:done');
  const runtimeIssues=await saveRuntimeIssues();
  // Handled fixture/API permission errors remain in the diagnostic record;
  // native JavaScript failures and uncaught window errors fail acceptance.
  const unexpectedRuntimeIssues=runtimeIssues.filter(row=>row.kind==='error'||/^(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)$/.test(row.error_name||'')||/TypeError|ReferenceError|SyntaxError|Cannot set properties|Cannot read properties|is not defined|is not a function/i.test(row.message));
  result.noUnexpectedRendererErrors=unexpectedRuntimeIssues.length===0;
  window.webContents.removeListener('console-message',onConsole);
  assert.equal(unexpectedRuntimeIssues.length,0,'Unexpected renderer errors: '+JSON.stringify(unexpectedRuntimeIssues));
  for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
  return result;
};
