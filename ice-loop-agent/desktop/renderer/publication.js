'use strict';
function activeAccount() { return ui.bootstrap.account; }
function syncPublication() {
  const account = activeAccount();
  document.title = `${account.name} · 公众号创作工作台`;
  document.querySelector('.wordmark strong').textContent = account.name;
  document.querySelector('.sidebar-bottom p').textContent = account.slogan || '让内容成为你的作品。';
  document.querySelector('#account-switch').innerHTML = ui.bootstrap.accounts.map(a => `<option value="${esc(a.id)}" ${a.id === account.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  document.querySelector('#series-label').innerHTML = `栏目 <span>${account.columns.length} 条内容线</span>`;
  document.querySelector('.series-nav').innerHTML = account.columns.map(c => `<button data-series="${esc(c.code)}"><span class="series-square ${esc(c.code.toLowerCase())}">${esc(c.code)}</span>${esc(c.name)}</button>`).join('');
  for (const key of Object.keys(seriesNames)) delete seriesNames[key];
  for (const column of account.columns) seriesNames[column.code] = column.name;
  newForm.elements.series.innerHTML = account.columns.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  document.querySelector('.avatar').textContent = account.name.slice(0, 1);
}
async function useBootstrap(result, view = 'accounts') {
  if (ui.bootstrap?.account?.id !== result.account.id) { newDialog.close(); newForm.reset(); newForm.querySelectorAll('.ai-filled').forEach(n => n.classList.remove('ai-filled')); newForm.elements.episode.value = '1'; planningState.autoExercise=''; }
  ui.bootstrap = result; ui.jobs = result.jobs; ui.dirty = false; ui.draftDirty = false; ui.accountDirty = false;
  syncPublication(); document.querySelector('#job-count').textContent = ui.jobs.length;
  changeView(view);
}
function accountInput(label, name, value, extra = '') { return `<label>${label}<input name="${name}" value="${esc(value || '')}" ${extra}></label>`; }
function renderAccounts(account = activeAccount(), fresh = false) {
  ui.editAccount = fresh ? null : account;
  workspace.innerHTML = pageHeading('YOUR PUBLICATION', fresh ? '给你的公众号，建立一份创作档案。' : `${esc(account.name)} 的内容与视觉规范`, '账号配置用于新文章和 AI 填充；已有任务继续使用创建时保存的规范。', '<button class="button secondary" data-pub-action="new-account">＋ 新增公众号</button>') +
    `<div class="publication-layout"><form id="account-form" class="publication-panel"><div class="section-bar"><h2>定位与读者</h2><span class="eyebrow">01 / IDENTITY</span></div>
    <div class="form-row">${accountInput('公众号名称','name',account.name,'required maxlength="100"')}${accountInput('目标读者','audience',account.audience,'required maxlength="500"')}</div>
    <label>内容定位<textarea name="positioning" rows="2" maxlength="2000">${esc(account.positioning || '')}</textarea></label>
    <div class="form-row">${accountInput('表达风格与人格','persona',account.persona,'maxlength="500"')}${accountInput('品牌口号（可选）','slogan',account.slogan,'maxlength="500"')}</div>
    <div class="section-bar"><h2>栏目与文章规范</h2><span class="eyebrow">02 / EDITORIAL</span></div>
    <label>栏目：每行「代码 = 栏目名称」<textarea name="columns_text" rows="4" required>${esc(account.columns.map(c => `${c.code} = ${c.name}`).join('\n'))}</textarea></label>
    <div class="form-row">${accountInput('目标字数下限','words_lo',account.words_range[0],'type="number" min="300" max="10000" required')}${accountInput('目标字数上限','words_hi',account.words_range[1],'type="number" min="300" max="10000" required')}</div>
    <div class="form-row">${accountInput('结尾章节标题','ending_heading',account.ending_heading,'required maxlength="50"')}${accountInput('结尾品牌句（可选；{X} 为主题）','closing_sentence',account.closing_sentence,'maxlength="500"')}</div>
    <label>禁用表达：每行一个<textarea name="banned_words_text" rows="3">${esc((account.banned_words || []).join('\n'))}</textarea></label>
    <label>规则模板<select name="preset"><option value="general" ${account.preset !== 'ice-loop' ? 'selected' : ''}>通用公众号 · 代码与教学练习可选</option>${!fresh && account.id === 'ice-loop' ? `<option value="ice-loop" ${account.preset === 'ice-loop' ? 'selected' : ''}>ICE Loop · 保留教学与品牌规范</option>` : ''}</select></label>
    <div class="section-bar"><h2>配色与资产</h2><span class="eyebrow">03 / VISUAL</span></div>
    ${accountInput('主题色（HEX，以逗号分隔）','colors',account.colors,'required maxlength="100"')}
    ${accountInput('配图风格','image_style',account.image_style,'maxlength="500"')}
    <p class="muted">可到「配图资源箱」导入封面或视觉样例，从真实像素提取颜色并生成 AI 配色建议。</p>
    <div class="section-bar"><h2>导入规范与存储</h2><span class="eyebrow">04 / SOURCES</span></div>
    <label>品牌说明 / 写作规范<textarea name="brand_document" rows="6" maxlength="20000" placeholder="粘贴或导入自己的品牌手册、语言风格、内容结构说明。">${esc(account.brand_document || '')}</textarea></label>
    ${accountInput('文章输出目录（留空时自动分配）','article_root',account.article_root)}
    ${accountInput('已有存稿目录（可选）','library_root',account.library_root)}
    <p class="muted">存稿目录下按文章建子文件夹，正文使用 01-公众号正文.md 或 正文.md。工作台只读查看。</p>
    <div class="modal-actions"><button class="button primary" type="submit">保存并使用此公众号 ↗</button></div></form>
    <aside><div class="side-panel"><div class="panel-heading">带入自己的规范</div><p class="muted">导入 Markdown / TXT 品牌说明，或其他工作台导出的 JSON 配置。导入后可逐项调整。</p><div class="stack-actions"><button class="button secondary" data-pub-action="import-account">导入配置 / 品牌说明 ↗</button><button class="button secondary" data-pub-action="export-account">导出当前公众号配置 ↗</button></div></div><div class="quiet-card"><h3>每个公众号，独立归档。</h3><p>任务、草稿、配图资源与输出目录按账号管理。模型接口与加密凭据在本机共享，配置导出不包含 Key。</p></div></aside></div>`;
  document.querySelector('#account-form').addEventListener('input', () => { ui.accountDirty = true; });
  document.querySelector('#account-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.target));
      const columns = values.columns_text.split('\n').filter(line => line.trim()).map(line => { const [code, ...parts] = line.split('='); return {code:code.trim().toUpperCase(), name:parts.join('=').trim()}; });
      const account = {...values, columns, words_range:[Number(values.words_lo),Number(values.words_hi)], banned_words:values.banned_words_text.split('\n').map(s => s.trim()).filter(Boolean)};
      if (ui.editAccount) account.id = ui.editAccount.id;
      await useBootstrap(await api('accounts.save', {account})); toast('公众号配置已保存，新文章将使用这份规范');
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
  });
}
function freshAccount() { return {name:'',audience:'',positioning:'',persona:'自然、准确、清晰',slogan:'',columns:[{code:'ART',name:'日常文章'}],words_range:[1200,2400],ending_heading:'写在最后',closing_sentence:'',colors:'#2448DB, #15191F, #F3F2ED',image_style:'flat editorial',banned_words:[],brand_document:'',article_root:'',library_root:'',preset:'general'}; }
async function renderDrafts() {
  const aid = activeAccount().id; const drafts = await api('drafts.list');
  if (ui.view !== 'drafts' || activeAccount().id !== aid) return;
  workspace.innerHTML = pageHeading('ROOM FOR YOUR WORDS','草稿箱','独立保存想法、导入文章草稿，编辑后再交给写作流程。', '<div class="button-row"><button class="button secondary" data-pub-action="import-draft">导入草稿</button><button class="button primary" data-pub-action="new-draft">＋ 写一份草稿</button></div>') + `<div class="library-grid">${drafts.map(d => `<article class="library-card"><span class="eyebrow">PERSONAL DRAFT / ${dateString(d.updated_at)}</span><h3>${esc(d.title)}</h3><button class="button text-button" data-pub-action="open-draft" data-id="${esc(d.draft_id)}">继续编辑 ↗</button></article>`).join('') || '<div class="empty-state"><h3>先把想法，放在这里。</h3><p>支持 Markdown 草稿；保存和预览后仍可继续修改。</p></div>'}</div><div class="section-bar"><h2>当前公众号的文章任务</h2></div><div class="library-grid">${ui.jobs.map(j => `<article class="library-card" data-job="${esc(j.job_id)}" tabindex="0" role="button"><span class="eyebrow">${esc(stateNames[j.state])}</span><h3>${esc(j.final_title || j.topic)}</h3><p>打开写作与审核工作区 ↗</p></article>`).join('')}</div>`;
}
function renderDraftEditor(draft = {title:'',body:'',content_hash:''}) {
  ui.currentDraft = draft; ui.draftDirty = false;
  workspace.innerHTML = `<button class="button text-button" data-view="drafts">← 返回草稿箱</button>` + pageHeading('DRAFT IN PROGRESS','把文字留住，再慢慢完善。','手动草稿独立保存，不代表已经完成事实与发布审核。') + `<div class="editor-panel"><form id="draft-form"><div class="draft-title-row"><label>草稿标题<input name="title" required maxlength="300" value="${esc(draft.title)}" placeholder="为这篇草稿起个名字"></label><button class="button primary" type="submit">保存草稿</button></div><textarea name="body" id="draft-editor" class="markdown-editor" placeholder="写下想法，或粘贴已有文章…">${esc(draft.body)}</textarea><div class="draft-title-row"><span id="draft-save-status" class="muted">${draft.draft_id ? '已保存的本地草稿' : '尚未保存'}</span><div class="button-row"><button type="button" class="button secondary" data-pub-action="draft-preview">阅读预览</button><button type="button" class="button secondary" data-pub-action="draft-to-brief">交给 AI 继续创作 ↗</button><button type="button" class="button secondary" data-pub-action="export-draft">导出 Markdown</button></div></div></form><div id="draft-preview" class="markdown-preview" hidden></div></div>`;
  document.querySelector('#draft-form').addEventListener('input', () => { ui.draftDirty = true; document.querySelector('#draft-save-status').textContent = '有未保存修改'; });
  document.querySelector('#draft-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter || event.target.querySelector('[type="submit"]'); button.disabled = true; try { const values = Object.fromEntries(new FormData(event.target)); ui.currentDraft = await api('drafts.save', {...values, draft_id:ui.currentDraft.draft_id, content_hash:ui.currentDraft.content_hash}); ui.draftDirty = false; document.querySelector('#draft-save-status').textContent = '已保存'; toast('草稿已保存'); } catch (error) {toast(error.message);} finally {button.disabled = false;} });
}
function paletteHTML(colors) { return `<div class="palette-row">${colors.map(c => `<span class="palette-item"><i data-color="${esc(c.hex || c)}"></i><small>${esc(c.hex || c)}${c.share === undefined ? '' : ` · ${Math.round(c.share*100)}%`}</small></span>`).join('')}</div>`; }
function paintPalettes() { workspace.querySelectorAll('[data-color]').forEach(node => { if (/^#[\da-f]{6}$/i.test(node.dataset.color)) node.style.backgroundColor = node.dataset.color; }); }
let pickingResource, pickerToken = 0;
async function loadResourceSlots() {
  const form = document.querySelector('#resource-pick-form');
  const token = ++pickerToken;
  form.elements.figure_no.innerHTML = '';
  form.querySelector('[type="submit"]').disabled = true;
  const jobId = form.elements.job_id.value;
  if (!jobId) return;
  try {
    const data = await api('jobs.get', {job_id:jobId});
    if (token !== pickerToken || form.elements.job_id.value !== jobId) return;
    form.elements.figure_no.innerHTML = data.slots.map(s => `<option value="${s.figure_no}">图${s.figure_no} · ${esc(s.caption || s.kind)}</option>`).join('');
    form.querySelector('[type="submit"]').disabled = !data.slots.length;
    document.querySelector('#resource-pick-status').textContent = data.slots.length ? '选用后会复制到文章资产目录，并登记为当前图位的候选。' : '此文章尚未生成配图计划，请先完成前面的审核。';
  } catch (error) { document.querySelector('#resource-pick-status').textContent = error.message; }
}
async function openResourcePicker(resourceId) {
  if (!ui.jobs.length) throw Error('先创建一篇文章并完成配图计划，再选用资源');
  pickingResource = resourceId;
  const form = document.querySelector('#resource-pick-form');
  form.elements.job_id.innerHTML = ui.jobs.map(j => `<option value="${esc(j.job_id)}">${esc(j.final_title || j.topic)}</option>`).join('');
  document.querySelector('#resource-picker').showModal();
  await loadResourceSlots();
}
document.querySelector('#resource-pick-form [name="job_id"]').addEventListener('change', loadResourceSlots);
document.querySelector('#resource-picker').addEventListener('close', () => { ++pickerToken; });
document.querySelector('#resource-pick-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const form = event.target; await api('resources.use', {resource_id:pickingResource,job_id:form.elements.job_id.value,figure_no:Number(form.elements.figure_no.value)}); document.querySelector('#resource-picker').close(); toast('图片已选入文章图位，可到文章工作区预览'); }
  catch (error) {toast(error.message);} finally {button.disabled = false;}
});
async function renderResources() {
  const aid = activeAccount().id; const resources = await api('resources.list');
  if (ui.view !== 'resources' || activeAccount().id !== aid) return;
  workspace.innerHTML = pageHeading('YOUR VISUAL LIBRARY','配图资源箱与资产分析','从你的封面、插图和视觉参考中，建立公众号的配色依据。', '<div class="button-row"><button class="button secondary" data-pub-action="analyze-all-resources">综合分析配色 ↗</button><button class="button primary" data-pub-action="import-resource">＋ 导入图片</button></div>') + `<div class="asset-grid resource-grid">${resources.map(r => `<article class="asset-card" data-resource="${esc(r.resource_id)}"><div class="asset-visual"><img alt="${esc(r.title)}" data-resource-image="${esc(r.resource_id)}"></div><div class="asset-info"><h3>${esc(r.title)}</h3><p>${r.width} × ${r.height} · 已归档副本</p><div class="resource-label">实际像素主色</div>${paletteHTML(r.palette)}${r.analysis ? `<div class="resource-analysis"><div class="resource-label">AI 主题配色建议 · ${r.analysis.source_resource_ids?.length || 1} 项参考</div>${paletteHTML(r.analysis.theme_colors)}<p>${esc(r.analysis.explanation)}</p><label>应用前可调整色值<input class="resource-colors" value="${esc(r.analysis.theme_colors.join(', '))}" maxlength="100"></label><button class="button primary small" data-pub-action="apply-palette" data-id="${esc(r.resource_id)}">应用到当前公众号</button></div>` : ''}<div class="button-row"><button class="button secondary small" data-pub-action="analyze-resource" data-id="${esc(r.resource_id)}">${r.analysis ? '重新分析配色' : 'AI 分析配色'} ↗</button><button class="button secondary small" data-pub-action="use-resource" data-id="${esc(r.resource_id)}">用于文章配图</button></div><p class="resource-caption">颜色由本地像素统计提取；AI 仅接收色值、占比与账号定位。</p></div></article>`).join('') || '<div class="empty-state"><h3>把你的视觉参考，放进资源箱。</h3><p>支持 PNG、JPEG、WebP，导入即提取主色；AI 建议由你点击生成。</p></div>'}</div>`;
  paintPalettes();
  await Promise.allSettled(resources.map(async r => { const preview = await api('resources.preview', {resource_id:r.resource_id}); if (ui.view !== 'resources' || activeAccount().id !== aid) return; const image = workspace.querySelector(`[data-resource-image="${r.resource_id}"]`); if (image) image.src = preview.data_url; }));
}
document.querySelector('#account-switch').addEventListener('change', async event => {
  const aid = event.target.value;
  if ((ui.dirty || ui.draftDirty || ui.accountDirty) && !confirm('有未保存修改，确认切换公众号并放弃修改？')) { event.target.value = activeAccount().id; return; }
  try { newDialog.close(); newForm.reset(); await useBootstrap(await api('accounts.switch', {account_id:aid}), 'studio'); toast('已切换公众号'); } catch (error) { event.target.value = activeAccount().id; toast(error.message); }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-pub-action]'); if (!button) return;
  const action = button.dataset.pubAction; button.disabled = true;
  try {
    if (action === 'new-account') { if (ui.accountDirty && !confirm('有未保存配置，确认新建？')) return; ui.accountDirty = false; renderAccounts(freshAccount(), true); }
    else if (action === 'import-account') { if (ui.accountDirty && !confirm('有未保存配置，确认导入？')) return; const result = await window.ice.importPublication(); if (result) { await useBootstrap(result); toast('已导入，请核对定位、读者和栏目后保存'); } }
    else if (action === 'export-account') { const result = await window.ice.exportPublication(); if (result) toast('已导出不含 Key 的公众号配置'); }
    else if (action === 'new-draft') renderDraftEditor();
    else if (action === 'open-draft') renderDraftEditor(await api('drafts.get', {draft_id:button.dataset.id}));
    else if (action === 'import-draft') { const result = await window.ice.importDraft(); if (result) renderDraftEditor(result); }
    else if (action === 'draft-preview') { const preview = document.querySelector('#draft-preview'); preview.innerHTML = renderMarkdown(document.querySelector('#draft-editor').value); preview.hidden = !preview.hidden; if (!preview.hidden) preview.scrollIntoView({behavior:'smooth'}); }
    else if (action === 'draft-to-brief') { const form = document.querySelector('#draft-form'); if (!form.reportValidity()) return; if (!ui.currentDraft.draft_id || ui.draftDirty) { ui.currentDraft = await api('drafts.save', {...Object.fromEntries(new FormData(form)), draft_id:ui.currentDraft.draft_id, content_hash:ui.currentDraft.content_hash}); ui.draftDirty = false; document.querySelector('#draft-save-status').textContent = '已保存'; } newForm.reset(); newForm.elements.topic.value = form.elements.title.value.slice(0,30); newForm.elements.materials_text.value = form.elements.body.value.slice(0,12000); await openNewArticle(); }
    else if (action === 'export-draft') { if (!ui.currentDraft.draft_id || ui.draftDirty) throw Error('请先保存当前草稿，再导出'); await window.ice.exportDraft(ui.currentDraft.draft_id); }
    else if (action === 'import-resource') { const result = await window.ice.importResource(); if (result) { await renderResources(); toast('图片已归档，主要颜色已提取'); } }
    else if (action === 'analyze-resource') { const original = button.textContent; button.textContent = '正在分析…'; try { await api('resources.analyze', {resource_id:button.dataset.id}); await renderResources(); toast('配色建议已生成，可调整后应用'); } finally { button.textContent = original; } }
    else if (action === 'analyze-all-resources') { const original = button.textContent; button.textContent = '正在综合分析…'; try { await api('resources.analyze', {aggregate:true}); await renderResources(); toast('已综合最近20项内的资源，建议显示在最新资源卡片中'); } finally { button.textContent = original; } }
    else if (action === 'apply-palette') { const colors = button.closest('.asset-card').querySelector('.resource-colors').value; await useBootstrap(await api('resources.apply', {resource_id:button.dataset.id, colors}), 'resources'); toast('主题配色已应用，新文章配图将使用这组颜色'); }
    else if (action === 'use-resource') await openResourcePicker(button.dataset.id);
    else if (action === 'close-resource-picker') document.querySelector('#resource-picker').close();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && ui.view === 'drafts' && ui.currentDraft) { event.preventDefault(); document.querySelector('#draft-form').requestSubmit(); } });
