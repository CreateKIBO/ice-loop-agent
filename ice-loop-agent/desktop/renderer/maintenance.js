'use strict';
let backupReview = null;
const revisionKinds = {draft:'AI 初稿',integrated:'回填运行证据',final:'已确认标题',manual:'手动编辑',before_edit:'编辑前快照',restore:'恢复版本'};
async function loadRevisions(data) {
  const jobId = data.job.job_id;
  const target = document.querySelector('#revision-history');
  if (!target) return;
  try {
    const result = await api('articles.revisions',{job_id:jobId});
    if(!target.isConnected||ui.currentJob!==jobId)return;
    target.innerHTML = `<div class="review-header"><h2>正文版本</h2><span class="muted">${result.revisions.length} 份记录</span></div><p class="review-summary">选择历史版本，逐行比较后再恢复。恢复前的正文会保留，发布状态会重新进入待复检。</p><div class="version-list">${result.revisions.map(row=>`<button class="version-row" data-revision="${esc(row.revision_id)}" ${!row.valid?'disabled':''}><span><strong>${esc(revisionKinds[row.kind]||row.kind)}</strong><small>${esc(row.created_at)} · ${row.characters.toLocaleString()} 字符</small></span><span>${!row.valid?'校验失败':row.content_hash===result.current_hash?'与当前相同':'对比 →'}</span></button>`).join('')||'<p class="muted">正文生成后，版本会在这里保存。</p>'}</div><div id="revision-comparison"></div>`;
  } catch(error){if(target.isConnected)target.textContent=error.message;}
}
async function showRevision(revisionId) {
  const jobId = ui.currentJob;
  const result = await api('articles.compare',{job_id:jobId,revision_id:revisionId});
  const target = document.querySelector('#revision-comparison');
  if(!target||ui.currentJob!==jobId)return;
  const editable = ui.detail.job.state==='completed'||ui.detail.job.state==='failed'&&['article_review','style_review'].includes(ui.detail.job.current_node);
  target.innerHTML=`<div class="version-comparison"><div class="review-header"><h3>历史版本 → 当前正文</h3><span class="muted">${esc(revisionKinds[result.revision.kind]||result.revision.kind)}</span></div><p class="muted">红色 − 是历史版本中的行；绿色 + 是当前正文中的行。</p><pre class="version-diff">${result.diff?result.diff.split('\n').map(line=>`<span class="${line.startsWith('+')?'diff-added':line.startsWith('-')?'diff-removed':'diff-context'}">${esc(line)}</span>`).join('\n'):'两份正文完全一致。'}</pre><details><summary>查看历史正文全文</summary><pre class="version-body">${esc(result.revision.content)}</pre></details>${editable&&result.diff?`<div class="review-actions"><button class="button secondary" data-restore-revision="${esc(revisionId)}" data-current-hash="${esc(result.current_hash)}">恢复这份正文</button><span class="muted">保留当前正文快照，恢复后请复检。</span></div>`:''}</div>`;
}
function renderBackups() {
  workspace.innerHTML=pageHeading('KEEP YOUR WORK','把创作进度，稳稳留住。','备份所有公众号的配置、任务、正文版本、草稿、真实运行证据与配图资源。')+`<div class="backup-grid"><section class="review-panel"><span class="eyebrow">01 / SAVE</span><h2>保存工作台备份</h2><p class="review-summary">生成经过文件哈希校验的 ZIP 包。备份前请等待任务停止；文件保存在工作数据目录之外。</p><button class="button primary" data-maintenance="create">选择位置并备份 ↗</button></section><section class="review-panel"><span class="eyebrow">02 / RESTORE</span><h2>从备份继续创作</h2><p class="review-summary">先检查备份，再恢复到新建目录。当前数据保留；关闭并重新打开桌面程序后使用恢复的数据。</p><button class="button secondary" data-maintenance="inspect">选择备份包 →</button></section></div><div id="backup-result" aria-live="polite"></div><div class="note-box backup-note">模型 Key、登录会话和浏览器缓存不会进入备份。恢复后请重新配置 Key、测试连接，并在「公众号与品牌」重新关联外部存稿目录。已索引的历史文章正文与发布记录保留。</div><p class="muted">当前工作数据：${esc(ui.bootstrap.runtime_root)}</p>`;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-revision],[data-restore-revision],[data-maintenance]');
  if(!button)return;
  button.disabled=true;
  try {
    if(button.dataset.revision)await showRevision(button.dataset.revision);
    else if(button.dataset.restoreRevision){
      await api('articles.restore',{job_id:ui.currentJob,revision_id:button.dataset.restoreRevision,content_hash:button.dataset.currentHash});
      ui.detail=await api('jobs.get',{job_id:ui.currentJob});ui.bodyHash=await hashText(ui.detail.body);renderDetail();
      toast('已恢复正文并保留恢复前快照，请复检与导出');
    } else {
      const action=button.dataset.maintenance;
      if(action==='create'){
        const result=await window.ice.createBackup();
        const target=document.querySelector('#backup-result');
        if(result&&target)target.innerHTML=`<div class="note-box"><strong>备份已保存</strong><p>${esc(result.file_path)}</p><span>${result.files} 个文件 · ${result.accounts.length} 个公众号 · ${(result.bytes/1048576).toFixed(1)} MB</span></div>`;
      } else if(action==='inspect'){
        backupReview=await window.ice.inspectBackup();const target=document.querySelector('#backup-result');
        if(backupReview&&target)target.innerHTML=`<div class="review-panel"><h2>备份校验通过</h2><p>${esc(backupReview.created_at)} · v${esc(backupReview.app_version)} · ${backupReview.files} 个文件</p><p>${backupReview.accounts.map(account=>esc(account.name)).join(' / ')}</p><p class="muted">恢复到新目录后，下次启动会切换到恢复的数据。当前目录保留。</p><button class="button primary" data-maintenance="restore">恢复到新工作目录 ↗</button></div>`;
      } else if(action==='restore'){
        if(!backupReview)throw Error('请先预览备份');
        const result=await window.ice.restoreBackup(backupReview.token);const target=document.querySelector('#backup-result');
        if(result&&target){backupReview=null;target.innerHTML=`<div class="note-box"><strong>恢复完成，重新打开程序后使用</strong><p>${esc(result.runtime_root)}</p><p>请先保存当前未完成的工作，再关闭并重新打开桌面程序。恢复的正文、历史与配图已校验，模型凭据需要重新配置。</p></div>`;}
      }
    }
  }catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
});
window.__ICE_MAINTENANCE_SMOKE__=async function(){
  const job=ui.jobs.find(row=>row.state==='completed');
  if(!job)throw Error('缺少版本验收文章');
  await openJob(job.job_id);
  const original=ui.detail.body,originalHash=await hashText(original);
  const saved=await api('articles.save',{job_id:job.job_id,body:original+'\n版本测试的补充段落。\n',content_hash:originalHash});
  const history=await api('articles.revisions',{job_id:job.job_id});
  const baseline=history.revisions.find(row=>row.content_hash===originalHash);
  const comparison=await api('articles.compare',{job_id:job.job_id,revision_id:baseline.revision_id});
  await api('articles.restore',{job_id:job.job_id,revision_id:baseline.revision_id,content_hash:saved.content_hash});
  ui.detail=await api('jobs.get',{job_id:job.job_id});
  const restored=ui.detail.body===original&&ui.detail.article.readiness==='review_pending';
  await api('articles.finalize',{job_id:job.job_id});
  ui.detail=await api('jobs.get',{job_id:job.job_id});ui.bodyHash=await hashText(ui.detail.body);
  ui.tab='versions';renderDetail();
  for(let attempt=0;attempt<160&&document.querySelectorAll('.version-row').length<5;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  for(let attempt=0;attempt<40&&!document.querySelector('.diff-removed');attempt++){await showRevision(saved.revision_id);await new Promise(resolve=>setTimeout(resolve,50));}
  return {saved:Boolean(saved.revision_id),diff:comparison.diff.includes('+版本测试的补充段落。'),restored,
    historyUI:document.querySelectorAll('.version-row').length>=5,diffUI:Boolean(document.querySelector('.diff-removed')),
    htmlEntry:Boolean(document.querySelector('[data-action="open-html"]')),job_id:job.job_id,export_folder:ui.detail.export.folder};
};
