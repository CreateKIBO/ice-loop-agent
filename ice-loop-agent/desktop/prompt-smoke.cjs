/* Native end-to-end acceptance, only against an explicit isolated fixture. */
const fs=require('node:fs'),path=require('node:path');
const {PreparationQueue}=require('./automation.cjs');
module.exports=async function({window,request,captureRun,runtime}){
  const trace=stage=>fs.appendFileSync(path.join(runtime,'prompt-trace.log'),new Date().toISOString()+' '+stage+'\n');
  const evaluate=window.webContents.executeJavaScript.bind(window.webContents);
  window.webContents.executeJavaScript=async(source,...args)=>{
    trace('js:start '+source.slice(0,140));let timer;
    try{const value=await Promise.race([evaluate(source,...args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Renderer evaluation timed out: '+source.slice(0,180))),30000);})]);trace('js:done');return value;}
    finally{clearTimeout(timer);}
  };
  window.webContents.on('console-message',(_event,...args)=>trace('console '+JSON.stringify(args)));
  trace('boot:start');
  // Let Chromium paint after each DOM transition before recording the visible UI.
  async function captureUI(name){await new Promise(resolve=>setTimeout(resolve,250));fs.writeFileSync(path.join(runtime,name),(await window.webContents.capturePage()).toPNG());}
  await window.webContents.executeJavaScript('bootReady');
  trace('boot:done');
  const fixture=JSON.parse(fs.readFileSync(path.join(runtime,'prompt-fixture.json'),'utf8'));
  const before=await request('jobs.get',{job_id:fixture.job_id});
  if(!before.article.spec.demo||before.article.spec.production_mode!=='auto_prepare')throw Error('Controlled automatic fixture required');
  const queue=new PreparationQueue(request,captureRun);await queue.tick();
  trace('capture:done');
  const data=await request('jobs.get',fixture),real=data.slots.filter(s=>s.kind==='body_real');
  const candidate=real[0]?.selected_candidate;
  const result={automaticScreenshots:real.length>0&&real.every(s=>s.valid),finalReviewPending:data.article.readiness==='review_pending',
    cachedPromptCalls:data.invocations.filter(row=>row.node_key==='image_prompts').length===1};
  await request('resources.import_style',{account_id:'ice-loop'});
  trace('style:done');
  await window.webContents.executeJavaScript('openJob('+JSON.stringify(fixture.job_id)+')');
  await window.webContents.executeJavaScript('openPromptEditor('+JSON.stringify(fixture.job_id)+',1)');
  trace('editor:done');
  result.editorVisible=await window.webContents.executeJavaScript('document.querySelector("#prompt-editor").open&&Boolean(document.querySelector("[data-prompt-generate]"))');
  result.coverUsesEditTemplate=data.slots[0].prompt.startsWith('Edit image 1')&&data.slots[0].prompt.includes('intertwined double-O');
  result.referenceUploadOrderVisible=await window.webContents.executeJavaScript('document.querySelector(".prompt-references").innerText.includes("图片 1")&&document.querySelector(".prompt-references").innerText.includes("图片 2")');
  result.approvedReferencePreviews=await window.webContents.executeJavaScript('[...document.querySelectorAll(".prompt-references img")].length===2&&[...document.querySelectorAll(".prompt-references img")].every(img=>img.src.startsWith("data:image/png"))');
  await captureUI('prompt-editor.png');
  await window.webContents.executeJavaScript('document.querySelector("#prompt-editor textarea[name=prompt]").value="Use case: manual reviewed cover. Keep approved ICE Loop identity unchanged.";document.querySelector("#prompt-editor form").requestSubmit();');
  for(let i=0;i<60;i++){
    if(await window.webContents.executeJavaScript('!document.querySelector("#prompt-editor").open'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const edited=await request('jobs.get',fixture);
  result.manualPromptSaved=edited.slots[0].prompt.startsWith('Use case: manual reviewed cover.');
  result.screenshotPreserved=edited.slots.find(s=>s.figure_no===real[0].figure_no).selected_candidate===candidate;
  const first=await request('resources.import_style',{account_id:'ice-loop'}),second=await request('resources.import_style',{account_id:'ice-loop'});
  result.styleImport=first.resources.length===7&&first.resources.every(s=>s.style_reference);
  result.styleImportIdempotent=JSON.stringify(first.resources.map(s=>s.resource_id))===JSON.stringify(second.resources.map(s=>s.resource_id));
  await window.webContents.executeJavaScript('changeView("resources");renderResources()');
  await captureUI('style-resources.png');
  result.referencesVisible=await window.webContents.executeJavaScript('document.querySelectorAll("[data-resource]").length>=7&&workspace.textContent.includes("风格参考")');
  await window.webContents.executeJavaScript('changeView("models");renderModels()');
  result.deepseekOption=await window.webContents.executeJavaScript('Boolean(document.querySelector("#vision-form option[value=deepseek]"))');
  result.budgetAtPageTop=await window.webContents.executeJavaScript('document.querySelector("#global-model-budget").getBoundingClientRect().top<document.querySelector(".model-grid").getBoundingClientRect().top&&Boolean(document.querySelector(".budget-shortcut"))');
  await captureUI('global-budget.png');
  async function waitFor(expression){for(let i=0;i<120;i++){if(await window.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('UI wait failed: '+expression);}
  await window.webContents.executeJavaScript('document.querySelector("#default-budget-form input[name=max_image_model_calls]").value=8;document.querySelector("#default-budget-form").requestSubmit(document.querySelector("#default-budget-form button[type=submit]"));');
  await waitFor('document.querySelector("#default-budget-form [role=status]").textContent.startsWith("已保存")');
  result.defaultBudgetSave=(await request('budgets.get')).max_image_model_calls===8;
  trace('budget:defaults-saved');
  const supplemental={job_id:fixture.supplement_job_id};const original=await request('jobs.get',supplemental);
  result.oldImageTaskIsZero=original.job.limits.max_model_calls===0&&!('max_image_model_calls' in original.job.limits);
  await window.webContents.executeJavaScript('openJob('+JSON.stringify(supplemental.job_id)+')');
  await window.webContents.executeJavaScript('openPromptEditor('+JSON.stringify(supplemental.job_id)+',1)');
  await window.webContents.executeJavaScript('document.querySelector("[data-prompt-generate]").click()');
  await waitFor('!document.querySelector("[data-prompt-generate]").disabled&&document.querySelector("#prompt-editor [role=status]").textContent.includes("候选来自")');
  let budget=await request('budgets.get',supplemental);
  result.realOfflineBudgetReservation=budget.job.used===1&&budget.job.limit===8&&!budget.job.legacy_budget;
  trace('budget:first-generation');
  await window.webContents.executeJavaScript('window.iceControls.openBudget('+JSON.stringify(supplemental.job_id)+')');
  await captureUI('current-budget.png');
  await window.webContents.executeJavaScript('document.querySelector("#current-budget-form input").value=1;document.querySelector("#current-budget-form").requestSubmit(document.querySelector("#current-budget-form button"));');
  await waitFor('document.querySelector("#current-budget-form [role=status]").textContent.includes("已保存")');
  await window.webContents.executeJavaScript('document.querySelector("#model-budget-dialog").close();document.querySelector("[data-prompt-generate]").click()');
  await waitFor('!document.querySelector("[data-prompt-generate]").disabled&&document.querySelector("#prompt-editor [role=status]").textContent.includes("预算已用完")');
  result.budgetErrorRecoverable=await window.webContents.executeJavaScript('Boolean(document.querySelector("#prompt-editor [data-budget-open]"))&&document.querySelector("#prompt-editor textarea").value.startsWith("Edit image 1")');
  result.exhaustionAddsNoInvocation=(await request('budgets.get',supplemental)).job.used===1;
  trace('budget:exhaustion');
  await captureUI('budget-error-recovery.png');
  await window.webContents.executeJavaScript('window.iceControls.openBudget('+JSON.stringify(supplemental.job_id)+')');
  trace('budget:reopened');
  await window.webContents.executeJavaScript('document.querySelector("#current-budget-form input").value=2;document.querySelector("#current-budget-form").requestSubmit(document.querySelector("#current-budget-form button"));');
  await waitFor('document.querySelector("#current-budget-form [role=status]").textContent.includes("已保存")');
  trace('budget:raised');
  await window.webContents.executeJavaScript('document.querySelector("#model-budget-dialog").close();document.querySelector("[data-prompt-generate]").click()');
  await waitFor('!document.querySelector("[data-prompt-generate]").disabled&&document.querySelector("#prompt-editor [role=status]").textContent.includes("候选来自")');
  result.increasedBudgetResumes=(await request('budgets.get',supplemental)).job.used===2;
  trace('budget:regenerated');
  const after=await request('jobs.get',supplemental);
  result.importedDraftProtected=after.body===original.body&&after.slots[0].prompt===original.slots[0].prompt&&after.job.limits.max_model_calls===0;
  await window.webContents.executeJavaScript('document.querySelector("#prompt-editor").close()');
  await window.webContents.executeJavaScript('window.iceMotion.setPreference("on");window._controlProbe=document.createElement("button");_controlProbe.className="button secondary";_controlProbe.textContent="交互验证";_controlProbe.style.cssText="position:fixed;left:600px;top:140px;z-index:9999";document.body.append(_controlProbe);window._probeWidth=_controlProbe.getBoundingClientRect().width;window.iceControls.run(_controlProbe,()=>new Promise(resolve=>window._probeResolve=resolve));void 0;');
  result.busyFeedback=await window.webContents.executeJavaScript('window.iceControls.pendingCount===1&&_controlProbe.getAttribute("aria-busy")==="true"&&Boolean(_controlProbe.querySelector(".control-spinner"))&&!document.querySelector("#control-activity").hidden&&Math.abs(_probeWidth-_controlProbe.getBoundingClientRect().width)<1');
  await captureUI('processing-feedback.png');
  await window.webContents.executeJavaScript('_probeResolve()');
  await waitFor('window.iceControls.pendingCount===0&&!_controlProbe.disabled');
  result.busyFeedbackClears=await window.webContents.executeJavaScript('!_controlProbe.hasAttribute("aria-busy")&&getComputedStyle(document.querySelector("#control-activity")).display==="none"');
  await new Promise(resolve=>setTimeout(resolve,350));
  const point=await window.webContents.executeJavaScript('(()=>{const r=_controlProbe.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  window.webContents.sendInputEvent({type:'mouseMove',...point});window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  await new Promise(resolve=>setTimeout(resolve,180));
  result.motionPressVisible=await window.webContents.executeJavaScript('getComputedStyle(_controlProbe).transform!=="none"&&window.iceMotion.gestureCount>0');
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  window.webContents.debugger.attach('1.3');
  try{
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await new Promise(resolve=>setTimeout(resolve,50));
    result.explicitMotionOverridesSystem=await window.webContents.executeJavaScript('window.iceMotion.setPreference("system");window._systemReduced=window.iceMotion.reduced();window.iceMotion.setPreference("on");_systemReduced&&!window.iceMotion.reduced()');
  }finally{await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});window.webContents.debugger.detach();}
  await window.webContents.executeJavaScript('window.iceMotion.setPreference("off")');
  result.motionOffStops=await window.webContents.executeJavaScript('window.iceMotion.reduced()&&window.iceMotion.activeCount===0');
  await window.webContents.executeJavaScript('_controlProbe.remove();window.iceMotion.setPreference("on")');
  await window.webContents.executeJavaScript('openNewArticle({reset:true}).then(()=>{newForm.elements.production_mode.value="auto_prepare";syncTitleMode();})');
  result.automaticForm=await window.webContents.executeJavaScript('newForm.elements.production_mode.value==="auto_prepare"&&!newForm.elements.topic.required');
  await waitFor('document.querySelector("#brief-replace").getBoundingClientRect().width===16');
  result.checkboxAndDialogGeometry=await window.webContents.executeJavaScript('(()=>{const c=document.querySelector("#brief-replace"),d=newForm.closest("dialog"),r=c.getBoundingClientRect(),b=d.getBoundingClientRect();return r.width===16&&r.height===16&&b.top>=0&&b.bottom<=innerHeight&&b.width<=innerWidth})()');
  await captureUI('automatic-form.png');
  window.setSize(1040,720);await new Promise(resolve=>setTimeout(resolve,350));
  result.compactDialogFits=await window.webContents.executeJavaScript('(()=>{const r=newForm.closest("dialog").getBoundingClientRect(),c=document.querySelector("#brief-replace").getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&c.width===16&&document.body.scrollWidth<=innerWidth})()');
  await captureUI('compact-dialog.png');
  fs.writeFileSync(path.join(runtime,'prompt-smoke.json'),JSON.stringify(result,null,2));
  Object.assign(result,await require('./tests/execution-viewer-ui.cjs')({window,request,captureRun,runtime}));
  fs.writeFileSync(path.join(runtime,'prompt-smoke.json'),JSON.stringify(result,null,2));
  if(!Object.values(result).every(Boolean))throw Error('Prompt/automation acceptance failed: '+JSON.stringify(result));
};
