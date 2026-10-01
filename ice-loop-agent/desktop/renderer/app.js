'use strict';
const { escapeHTML: esc, renderMarkdown } = window.iceMarkdown;
const api = (method, params = {}) => window.ice.request(method, params);
const nodeNames = { ingest: '整理需求', topic: '选题审核', research: '整理事实', outline: '骨架审核', draft: '撰写正文', verify_code: '代码验证', integrate_evidence: '回填真实输出', article_review: '内容审校', style_review: '风格审校', title_workshop: '标题审核', asset_plan: '配图计划', assets: '准备配图', final_check: '发布检查', export: '文章包导出' };
const nodes = Object.keys(nodeNames);
const stages = ['topic', 'outline', 'draft', 'article_review', 'title_workshop', 'asset_plan', 'export'];
const seriesNames = { PY: 'Python 从 0 到 1', JV: 'Java 打怪升级', AI: 'AI 实作实验室', WK: '工具周刊' };
const stateNames = { queued: '准备开始', running: '正在创作', awaiting_approval: '待你审核', awaiting_user: '需要处理', completed: '写作完成', failed: '任务中断', paused: '已暂停', cancelled: '已取消' };
const readinessNames = { draft: '草稿', text_verified: '代码已验证', assets_pending: '待补配图', review_pending: '待复检', ready_for_publish: '可进入发布预览' };
const providers = { qwen: ['Q', '通义千问', '阿里云百炼'], deepseek: ['D', 'DeepSeek', '原厂 API'], kimi: ['K', 'Kimi', 'Moonshot 中国平台'], bigmodel: ['G', 'GLM', '智谱 BigModel'], ark: ['豆', '豆包', '火山方舟'] };
const roles = { writer: '正文写作', reviewer: '内容审稿', planner: '选题与骨架', researcher: '事实整理', title_editor: '标题工坊', code_helper: '代码辅助' };
const ui = { view: 'studio', jobs: [], bootstrap: null, currentJob: null, detail: null, tab: 'article', mode: 'preview', filter: 'all', series: null, dirty: false, choice: null, bodyHash: '', fingerprint: '', after: 0, stream: '', images: {}, library: [] };
const workspace = document.querySelector('#workspace');
let toastTimer;
const briefState = { token: 0, busy: false, touched: new Set() };
const newDialog = document.querySelector('#new-dialog');
const newForm = document.querySelector('#new-form');
function briefStatus(text, error = false) { const node = document.querySelector('#brief-status'); node.textContent = text; node.classList.toggle('error', error); }
function briefBusy(busy) {
  briefState.busy = busy;
  document.querySelector('#brief-fill').disabled = busy;
  document.querySelector('#brief-fill').textContent = busy ? '正在补全…' : '◇ AI 自动填充';
  newForm.querySelector('[type="submit"]').disabled = busy;
  newForm.setAttribute('aria-busy', String(busy));
  if (typeof planningButtons === 'function') planningButtons();
}
async function fillBrief(request = api) {
  if (briefState.busy || planningState.busy || planningState.loading) return;
  const snapshot = Object.fromEntries(new FormData(newForm));
  if (!snapshot.topic.trim()) { briefStatus('先写一句文章想法，再让 AI 补全。', true); newForm.elements.topic.focus(); return; }
  if (!newForm.elements.episode.checkValidity()) { newForm.elements.episode.reportValidity(); return; }
  const token = ++briefState.token;
  briefState.touched.clear();
  const replace = document.querySelector('#brief-replace').checked;
  briefBusy(true); briefStatus('正在使用当前公众号的策划模型补全需求，生成期间仍可编辑…');
  try {
    const result = await request('brief.suggest', { fields: snapshot, account_id: activeAccount().id });
    if (token !== briefState.token || !newDialog.open) return;
    const merged = window.iceBrief.merge(snapshot, Object.fromEntries(new FormData(newForm)), result.fields, replace, [...briefState.touched]);
    for (const name of merged.changed) { newForm.elements[name].value = merged.values[name]; newForm.elements[name].classList.add('ai-filled'); }
    briefStatus(merged.stale ? '栏目或期号已修改，本次建议未填入，请重新生成。' : `${merged.changed.length ? `AI 已补全 ${merged.changed.length} 项，可继续修改。` : '已保留当前填写内容；勾选改写选项可重新生成。'} ${result.notes?.join(' ') || ''}`);
  } catch (error) { if (token === briefState.token && newDialog.open) briefStatus(error.message, true); }
  finally { if (token === briefState.token) briefBusy(false); }
}
newDialog.addEventListener('close', () => { ++briefState.token; briefBusy(false); briefStatus('默认补全空白项 · 使用「策划」模型 · 生成后可逐项修改'); });
newForm.addEventListener('input', event => { briefState.touched.add(event.target.name); event.target.classList.remove('ai-filled'); });
newForm.addEventListener('change', event => { briefState.touched.add(event.target.name); });
function toast(message) { const node = document.querySelector('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 4500); }
function badge(text, tone = '') { return `<span class="badge ${tone}">${esc(text)}</span>`; }
function stateBadge(job) { const tone = job.state === 'awaiting_approval' ? 'blue' : job.state === 'failed' ? 'red' : job.readiness === 'ready_for_publish' ? 'green' : job.state === 'awaiting_user' ? 'amber' : ''; return badge(job.readiness === 'ready_for_publish' ? readinessNames[job.readiness] : stateNames[job.state] || job.state, tone); }
function dateString(value) { return value ? new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : ''; }
function progress(job) { const index = nodes.indexOf(job.current_node); return `<div class="progress-track" aria-label="当前进度：${esc(nodeNames[job.current_node])}">${nodes.map((_node, i) => `<i class="${i < index || job.state === 'completed' ? 'done' : i === index ? 'current' : ''}"></i>`).join('')}</div>`; }
function flowPanel(job) { const index = job ? nodes.indexOf(job.current_node) : -1; return `<div class="side-panel"><div class="panel-heading">文章生产流程 <span class="eyebrow">01—07</span></div><ol class="step-list">${stages.map((node, i) => { const n = nodes.indexOf(node); const active = job && n <= index && (i === stages.length - 1 || nodes.indexOf(stages[i + 1]) > index); const done = job && (n < index && !active || job.state === 'completed'); return `<li class="${done ? 'done' : active ? 'current' : ''}"><span class="step-dot">${done ? '✓' : String(i + 1).padStart(2, '0')}</span><div>${{ topic: '确定选题', outline: '搭建骨架', draft: '撰写与验证', article_review: '审校文章', title_workshop: '确认标题', asset_plan: '配图与截图', export: '检查与导出' }[node]}<div class="step-sub">${{ topic: '你的判断，决定文章方向', outline: '先想清楚，再写下来', draft: '代码输出来自真实运行', article_review: '事实、结构与品牌检查', title_workshop: '标题承诺与正文一致', asset_plan: '按图位审阅每个候选', export: '形成可预览的文章包' }[node]}</div></div></li>`; }).join('')}</ol><div class="panel-foot">关键决定由你确认。<br>写作、验证和素材归档交给工作台。</div></div>`; }
function pageHeading(eyebrow, title, description, right = '') { return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${right}</div>`; }
function renderHome() {
  const pending = ui.jobs.filter(job => ['awaiting_approval', 'awaiting_user'].includes(job.state));
  const completed = ui.jobs.filter(job => job.state === 'completed');
  const ready = ui.jobs.filter(job => job.readiness === 'ready_for_publish');
  const jobs = ui.jobs.filter(job => (!ui.series || job.series === ui.series) && (ui.filter === 'all' || ui.filter === 'pending' && pending.includes(job) || ui.filter === 'completed' && completed.includes(job)));
  workspace.innerHTML = pageHeading('MAKE IDEAS EXECUTABLE', ui.series ? seriesNames[ui.series] : '从一个想法，到一篇好文章。', '有依据地写作，有节奏地审阅。今天的创作，从这里开始。', '<div class="heading-meta">CONTENT WORKSPACE</div>') +
    `<div class="overview"><div class="stat"><div><div class="stat-label">正在制作的文章</div><div class="stat-desc">从需求到可发布文章包</div></div><span class="stat-number">${String(ui.jobs.filter(j => !['cancelled'].includes(j.state)).length).padStart(2, '0')}</span></div><div class="stat"><div><div class="stat-label">等待你的决定</div><div class="stat-desc">审核或补充素材后继续</div></div><span class="stat-number blue">${String(pending.length).padStart(2, '0')}</span></div><div class="stat"><div><div class="stat-label">可以进入发布预览</div><div class="stat-desc">真实代码与配图已核对</div></div><span class="stat-number">${String(ready.length).padStart(2, '0')}</span></div></div>` +
    `<div class="workspace-grid"><section><div class="section-bar"><h2>创作中的文章</h2><button class="button text-button" data-action="new">新建文章 ↗</button></div><div class="filter-tabs">${[['all', '全部文章'], ['pending', '等待审核'], ['completed', '写作完成']].map(([value, label]) => `<button data-filter="${value}" class="${ui.filter === value ? 'active' : ''}">${label}</button>`).join('')}</div><div class="task-list">${jobs.length ? jobs.map(job => `<article class="task-card" data-job="${esc(job.job_id)}" tabindex="0" role="button" aria-label="打开文章 ${esc(job.topic)}"><div class="task-card-top"><span class="series-label"><span class="series-square ${job.series.toLowerCase()}">${job.series}</span>${job.series} / ${String(job.episode).padStart(3, '0')}${job.demo ? ' · 离线演示' : ''}</span>${stateBadge(job)}</div><h3>${esc(job.final_title || job.topic)}</h3><div class="task-meta"><span>${esc(nodeNames[job.current_node])}</span><span>·</span><span>${esc(readinessNames[job.readiness] || '草稿')}</span><span class="push-right">${dateString(job.updated_at)} &nbsp; ↗</span></div>${progress(job)}</article>`).join('') : `<div class="empty-state"><div class="empty-graphic">↗</div><h3>下一篇文章，从你的想法开始。</h3><p>选一个主题，准备一点素材。工作台会在关键节点等你审阅。</p><button class="button primary" data-action="new">开始创作 ＋</button></div>`}</div></section><aside>${flowPanel(pending[0] || jobs[0])}<div class="quiet-card"><span class="eyebrow">EXPLORE THE WORKFLOW</span><h3>先走一遍，再开始。</h3><p>离线示例使用内置内容与真实代码执行，不调用模型，也不产生费用。</p><button class="button secondary small" data-action="demo">体验离线示例 ↗</button></div></aside></div>`;
}
function detailContext(data) { const profileSnapshot = data.job.model_route_snapshot; const writerId = profileSnapshot.routes?.writer?.primary; const writer = profileSnapshot.profiles?.[writerId]; return `<aside>${flowPanel(data.job)}<div class="side-panel context-panel"><div class="panel-heading">本篇信息</div><ul class="context-list"><li><span>栏目</span><strong>${data.article.series} / ${String(data.article.episode).padStart(3, '0')}</strong></li><li><span>生成来源</span><strong>${data.article.spec.demo ? '离线 Mock 示例' : esc(writer?.model_id || '已冻结模型配置')}</strong></li><li><span>模型调用</span><strong>${data.invocations.length} / ${data.job.limits.max_model_calls}</strong></li><li><span>代码验证</span><strong>${Object.keys(data.runs).length} 条运行记录</strong></li><li><span>配图就绪</span><strong>${data.slots.filter(s => s.valid).length} / ${data.slots.length}</strong></li></ul></div></aside>`; }
function renderDetail() {
  const data = ui.detail; if (!data) return;
  const approval = data.pending_approval;
  const tabNames = { article: '正文与预览', review: approval ? '待你审核' : '审核记录', assets: '配图素材', evidence: '运行与事实', activity: '任务记录' };
  const title = data.article.final_title || data.article.working_title || data.article.topic;
  document.querySelector('#page-name').textContent = '文章工作区';
  workspace.innerHTML = `<button class="button text-button" data-action="back">← 返回创作工作台</button><div class="detail-heading"><div><span class="series-label">${data.article.series} / ${String(data.article.episode).padStart(3, '0')} ${data.article.spec.demo ? ' · 离线演示' : ''}</span><h1>${esc(title)}</h1><div class="button-row">${stateBadge({ ...data.article, ...data.job })}<span class="muted">${esc(nodeNames[data.job.current_node])}</span></div></div><div class="button-row">${data.job.state === 'running' ? '<button class="button secondary" data-action="pause">暂停</button>' : ['paused', 'failed'].includes(data.job.state) ? '<button class="button secondary" data-action="resume">继续任务</button>' : ''}${data.job.state === 'completed' ? '<button class="button primary" data-action="finalize">复检与导出 ↗</button>' : ''}${data.export.folder ? '<button class="button secondary" data-action="open-folder">打开文章包</button>' : ''}</div></div><div class="detail-tabs">${Object.entries(tabNames).map(([tab, name]) => `<button data-tab="${tab}" class="${ui.tab === tab ? 'active' : ''}">${name}${tab === 'review' && approval ? ' ·' : ''}</button>`).join('')}</div><div class="detail-grid"><section>${data.job.state === 'failed' ? `<div class="note-box error">${esc(data.job.pause_reason)}</div>` : ''}${data.job.state === 'awaiting_user' ? `<div class="note-box">${esc(data.job.pause_reason)}</div>` : ''}${renderDetailTab(data)}</section>${detailContext(data)}</div>`;
  loadImages(data);
}
function renderDetailTab(data) {
  if (ui.tab === 'review') return renderReview(data);
  if (ui.tab === 'assets') return renderAssets(data);
  if (ui.tab === 'evidence') return renderEvidence(data);
  if (ui.tab === 'activity') return `<div class="review-panel"><h2>任务记录</h2><div class="activity-list">${data.events.filter(event => event.event_type !== 'model.delta').slice().reverse().map(event => `<div class="activity-item"><span>${esc(event.occurred_at)} / ${event.sequence}</span>${esc(nodeNames[JSON.parse(event.payload).node] || event.event_type)}</div>`).join('')}</div></div>`;
  if (!data.body) return `<div class="editor-panel"><div class="editor-toolbar"><span>正文工作区</span>${badge('等待上游审核')}</div>${ui.stream ? `<div class="live-draft">${esc(ui.stream)}</div>` : '<div class="empty-state"><div class="empty-graphic">¶</div><h3>文章会在骨架确认后生成。</h3><p>先在审核页确认选题方向和正文骨架。</p><button class="button secondary" data-tab="review">查看待审核内容 →</button></div>'}</div>`;
  const figures = Object.fromEntries(data.slots.map(slot => [slot.figure_no, ui.images[slot.selected_candidate]]));
  const editable = data.job.state === 'completed' || data.job.state === 'failed' && ['article_review','style_review'].includes(data.job.current_node);
  return `<div class="editor-panel"><div class="editor-toolbar"><div class="editor-mode">${[['preview', '阅读预览'], ['edit', 'Markdown'], ['mobile', '手机视图']].map(([mode, label]) => `<button data-mode="${mode}" class="${ui.mode === mode ? 'active' : ''}">${label}</button>`).join('')}</div><span>${data.body.length.toLocaleString()} 字符 ${ui.dirty ? ' · 有未保存修改' : ''}</span>${ui.mode === 'edit' && editable ? '<button class="button primary small" data-action="save-body">保存正文</button>' : ''}</div>${ui.mode === 'edit' ? `<textarea id="body-editor" class="markdown-editor" spellcheck="false" aria-label="文章 Markdown 正文" ${!editable ? 'readonly' : ''}>${esc(data.body)}</textarea>` : `<div class="markdown-preview ${ui.mode === 'mobile' ? 'mobile-paper' : ''}">${renderMarkdown(data.body, figures)}</div>`}</div>`;
}
function renderReview(data) {
  const ap = data.pending_approval;
  if (!ap) return `<div class="review-panel"><h2>当前没有待审核决定</h2><p class="review-summary">${data.job.state === 'completed' ? '四个审核节点已完成。你可以继续检查正文、运行记录与配图。' : '工作台会在需要你确认时停下来。'}</p>${data.report?.rules?.report?.blocking?.length ? `<ul class="issue-list">${data.report.rules.report.blocking.map(issue => `<li>${esc(issue.message)}</li>`).join('')}</ul>` : '<div class="note-box">审核决定与内容版本绑定，模型不能替你跳过。</div>'}</div>`;
  const p = ap.payload; let content = '';
  if (ap.scope === 'topic') content = (p.directions || []).map((direction, i) => `<div class="candidate-row"><label><input type="radio" name="topic-choice" value="${i}" ${i === (ui.choice ?? p.recommended) ? 'checked' : ''}>${esc(direction['标题候选'])}</label><p>${esc(direction['核心角度'])}</p><p>${esc(direction['文章类型'])} · ${esc(direction['证据要求'] || '')}</p></div>`).join('');
  else if (ap.scope === 'outline') content = `<h3>${esc(p.working_title)}</h3><ul class="structured-list">${(p.sections || []).map(section => `<li>${esc(section.h2)}<small>${esc(section.goal || section.summary || '')}</small></li>`).join('')}</ul>`;
  else if (ap.scope === 'final_title') content = (p.candidates || []).map((candidate, i) => `<div class="candidate-row ${i === (ui.choice ?? p.recommended) ? 'selected' : ''}"><label><input type="radio" name="title-choice" value="${i}" ${i === (ui.choice ?? p.recommended) ? 'checked' : ''}>${esc(candidate.title)}</label><p>${esc(candidate.mechanism)} · ${candidate.total}/25</p></div>`).join('') + `<p class="muted">${esc(p.recommend_reason)}</p>`;
  else content = `<ul class="structured-list">${(p.slots || []).map(slot => `<li>图 ${slot.figure_no} · ${esc(slot.caption)}<small>${esc(slot.position)} / ${esc(slot.obtain)}</small></li>`).join('')}</ul><div class="note-box">当前采用手动导入。打开 TapNow 生成图片后，可在配图页导入并选择候选。</div>`;
  return `<div class="review-panel"><div class="review-header"><h2>${{ topic: '确认这篇文章的方向', outline: '先确认文章的骨架', final_title: '选择最终标题', asset_plan: '确认每张图的用途' }[ap.scope]}</h2>${badge('需要你的决定', 'blue')}</div><p class="review-summary">这是已保存的候选。批准之后，工作台会继续使用这份内容。</p>${content}<div class="review-actions"><button class="button primary" data-action="approve">确认并继续 →</button>${ap.scope !== 'asset_plan' ? '<button class="button secondary" data-action="edit-approval">编辑候选</button>' : ''}<button class="button text-button danger" data-action="reject">否决方向</button></div></div>`;
}
function renderAssets(data) {
  if (!data.slots.length) return '<div class="empty-state"><div class="empty-graphic">▧</div><h3>配图方案还没有生成。</h3><p>确认最终标题后，工作台会整理封面和正文插图位置。</p></div>';
  return `<div class="section-bar"><h2>按图位管理素材</h2><button class="button secondary small" data-action="tapnow">打开 TapNow ↗</button></div><div class="asset-grid">${data.slots.map(slot => `<article class="asset-card"><div class="asset-visual" data-image-slot="${slot.figure_no}">${ui.images[slot.selected_candidate] ? `<img src="${ui.images[slot.selected_candidate]}" alt="${esc(slot.caption)}">` : `<span>0${slot.figure_no}</span>`}${badge(slot.valid ? '已就绪' : '待导入', slot.valid ? 'green' : '')}</div><div class="asset-info"><h3>图 ${slot.figure_no} · ${esc(slot.caption)}</h3><p>${esc(slot.position)} · ${esc(slot.obtain)}</p>${slot.candidates.length ? `<select class="candidate-select" data-candidate-slot="${slot.slot_id}" aria-label="选择图 ${slot.figure_no} 候选">${slot.candidates.map((candidate, i) => `<option value="${candidate.candidate_id}" ${candidate.candidate_id === slot.selected_candidate ? 'selected' : ''}>候选 ${i + 1}${candidate.candidate_id === slot.selected_candidate ? ' · 当前采用' : ''}</option>`).join('')}</select>` : ''}<button class="button secondary small" data-action="import-image" data-figure="${slot.figure_no}">${slot.candidates.length ? '导入新候选' : '导入图片'} ＋</button>${slot.prompt ? `<details><summary class="muted">查看生图提示词</summary><div class="prompt-block">${esc(slot.prompt)}</div></details>` : ''}</div></article>`).join('')}</div>`;
}
function renderEvidence(data) {
  let html = '<div class="section-bar"><h2>真实运行记录</h2><small>RunRecord · 源码与输出绑定</small></div>';
  if (data.job.state === 'awaiting_user' && data.job.current_node === 'verify_code') html += `<div class="review-panel"><h3>审阅即将运行的代码</h3><p class="review-summary">确认后将在本机执行当前代码。请检查源码与输入，批准仅对当前内容有效。</p><pre class="run-output">${esc(data.draft)}</pre><details><summary>补充示例输入</summary><p class="muted">Python 依次命名为 demo_1.py、demo_2.py；Java 使用 public 类名。填写文件名到输入文本的 JSON，例如 {&quot;demo_1.py&quot;: &quot;小冰\n18&quot;}。输入每行用 \\n 分隔。</p><textarea id="execution-inputs" class="code-editor" rows="5" spellcheck="false" aria-label="示例输入 JSON">${esc(JSON.stringify(data.stdin_by_filename || {}, null, 2))}</textarea><button class="button secondary small" data-action="save-inputs">保存示例输入</button></details><button class="button primary" data-action="approve-execution">已审阅代码，允许本次执行</button></div>`;
  html += Object.entries(data.runs).map(([id, run]) => `<div class="run-card">${badge(run.exit_code === 0 ? '真实执行通过' : '运行失败', run.exit_code === 0 ? 'green' : 'red')}<h3>${esc(run.filename)}</h3><div class="run-meta">${id} / exit ${run.exit_code} / ${run.duration_ms} ms / ${esc(run.runtime.python || '')}</div><pre class="run-output">${esc(run.stdout)}${run.stderr ? '\n[stderr]\n' + esc(run.stderr) : ''}</pre><details><summary class="muted">源码和示例输入</summary><pre class="run-output">${esc(run.source || '')}\n输入：${esc(run.stdin_events.join(''))}</pre></details></div>`).join('');
  if (!Object.keys(data.runs).length && data.job.current_node !== 'verify_code') html += '<p class="muted">代码将在正文生成后执行，这里只展示实际运行记录。</p>';
  html += '<div class="section-bar evidence-heading"><h2>事实与来源</h2><small>核验状态由你的证据决定</small></div>' + data.claims.map(claim => `<div class="claim-card">${badge(claim.status === 'verified' ? '已人工核验' : claim.status === 'qualified' ? '稳定事实 · 待审阅' : '需要核验', claim.status === 'verified' ? 'green' : 'amber')}<p>${esc(claim.text)}</p><div class="button-row"><small class="muted">${esc(claim.risk_type)}</small><button class="button text-button small" data-action="verify-claim" data-claim="${claim.claim_id}">记录来源 →</button></div></div>`).join('');
  return html;
}
async function loadImages(data) {
  let changed = false;
  for (const slot of data.slots) {
    const id = slot.selected_candidate;
    if (!id || ui.images[id]) continue;
    try { const url = await api('assets.preview', { job_id: data.job.job_id, candidate_id: id }); ui.images[id] = url; changed = true; if (ui.currentJob === data.job.job_id && ui.tab === 'assets') { const target = document.querySelector(`[data-image-slot="${slot.figure_no}"]`); if (target) { const image = document.createElement('img'); image.src = url; image.alt = slot.caption; target.prepend(image); target.querySelector(':scope > span:not(.badge)')?.remove(); } } }
    catch { /* Missing assets are shown as pending by the engine. */ }
  }
  if (changed && ui.currentJob === data.job.job_id && ui.tab === 'article' && !ui.dirty) {
    const preview = document.querySelector('.markdown-preview');
    if (preview) preview.innerHTML = renderMarkdown(ui.detail.body, Object.fromEntries(ui.detail.slots.map(slot => [slot.figure_no, ui.images[slot.selected_candidate]])));
  }
}
function renderModels() {
  const profiles = ui.bootstrap.settings.profiles;
  workspace.innerHTML = pageHeading('TOOLS FOR YOUR VOICE', '给每个写作角色，选对模型。', '国内供应商分别配置。新设置用于新任务，正在进行的文章继续使用原配置。') + `<div class="model-grid">${profiles.map(profile => { const [mark, title, service] = providers[profile.provider]; return `<section class="model-card" data-provider="${profile.provider}"><div class="model-head"><div class="provider-title"><span class="provider-mark">${mark}</span><div><h3>${title}</h3><small>${service}</small></div></div>${badge(profile.status === 'verified' ? '连接已验证' : profile.has_key ? '可测试连接' : '未配置 Key', profile.status === 'verified' ? 'green' : '')}</div><label>模型 ID<input class="model-id-input" value="${esc(profile.model_id)}" aria-label="${title} 模型 ID"></label><label>API Key<div class="key-row"><input class="key-input" type="password" autocomplete="off" placeholder="${profile.has_key ? '已配置 · 留空保持原凭据' : '填写供应商控制台的 Key'}" aria-label="${title} API Key"><button class="button secondary small" data-action="save-key" data-provider="${profile.provider}">保存 Key</button></div></label><div class="endpoint">${esc(profile.base_url)}</div><div class="model-actions"><button class="button secondary small" data-action="probe-model" data-provider="${profile.provider}">测试连接 ↗</button><small>发送一次短请求，可能计费</small></div></section>`; }).join('')}</div><section class="route-panel"><h2>角色分工与请求预算</h2><p>为正文、审稿和规划选择主模型。回退仅使用明确配置的供应商。</p><div class="route-grid">${Object.entries(roles).map(([role, name]) => `<label>${name}<select data-role="${role}">${profiles.map(profile => `<option value="${profile.profile_id}" ${ui.bootstrap.settings.routes[role]?.primary === profile.profile_id ? 'selected' : ''}>${providers[profile.provider][1]}</option>`).join('')}</select></label>`).join('')}<label>单篇模型请求上限<input id="model-budget" type="number" min="1" max="100" value="${ui.bootstrap.settings.max_model_calls}"></label><label>正文思考策略<select id="thinking-policy">${[['prefer_off', '优先关闭思考'], ['provider_default', '供应商默认'], ['prefer_on', '优先开启思考'], ['required_off', '必须关闭思考']].map(([value, label]) => `<option value="${value}" ${ui.bootstrap.settings.routes.writer.thinking_policy === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="button-row"><button class="button primary" data-action="save-models">保存模型与角色配置</button><span class="muted">凭据由系统加密存储，正文和日志不包含 Key。</span></div></section>`;
}
async function renderLibrary() {
  ui.library = await api('library.list');
  workspace.innerHTML = pageHeading('A LIBRARY OF EXECUTABLE IDEAS', '把每篇文章，留成下一篇的起点。', '已有存稿以只读方式打开，保留原文件与原发布状态。') + `<div class="library-grid">${ui.library.map(article => `<article class="library-card" data-library="${esc(article.folder)}" tabindex="0" role="button"><span class="eyebrow">${esc(article.folder.split('-')[0])} / ARCHIVE</span><h3>${esc(article.title)}</h3><p>查看已有正文 <span>↗</span></p></article>`).join('') || '<div class="empty-state"><h3>还没有找到已有存稿。</h3><p>在「公众号与品牌」配置自己的存稿目录。</p></div>'}</div>`;
}
function changeView(view) {
  if ((ui.dirty || ui.draftDirty || ui.accountDirty) && !confirm('还有未保存修改。确认放弃修改并离开？')) return;
  ui.draftDirty = false; ui.accountDirty = false; ui.currentDraft = null;
  ui.dirty = false; ui.view = view; ui.currentJob = null; ui.series = null;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelector('#page-name').textContent = { studio: '创作工作台', library: '文章存稿', models: '模型与设置', accounts:'公众号与品牌', drafts:'草稿箱', resources:'配图资源箱', history:'发布记录与历史' }[view];
  if (view === 'studio') renderHome(); else if (view === 'models') renderModels(); else if (view === 'accounts') renderAccounts(); else if (view === 'drafts') renderDrafts().catch(error => toast(error.message)); else if (view === 'resources') renderResources().catch(error => toast(error.message)); else if (view === 'history') renderHistory().catch(error => toast(error.message)); else renderLibrary().catch(error => toast(error.message));
}
async function openJob(jobId) {
  if (ui.dirty && !confirm('正文还有未保存修改。确认离开？')) return;
  ui.currentJob = jobId; ui.dirty = false; ui.after = 0; ui.stream = ''; ui.choice = null; ui.mode = 'preview';
  ui.view = 'studio';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'studio'));
  const detail = await api('jobs.get', { job_id: jobId });
  if (ui.currentJob !== jobId) return;
  ui.detail = detail;
  ui.after = ui.detail.events.at(-1)?.sequence || 0;
  ui.bodyHash = await hashText(ui.detail.body);
  ui.tab = ui.detail.pending_approval ? 'review' : ui.detail.job.current_node === 'verify_code' && ui.detail.job.state === 'awaiting_user' ? 'evidence' : 'article';
  if (ui.currentJob === jobId) renderDetail();
}
async function hashText(text) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function refresh() {
  ui.jobs = await api('jobs.list'); document.querySelector('#job-count').textContent = ui.jobs.length;
  if (ui.currentJob) {
    const activeJob = ui.currentJob;
    const data = await api('jobs.get', { job_id: activeJob, after: ui.after });
    if (ui.currentJob !== activeJob || ui.view !== 'studio') return;
    if (data.pending_approval?.approval_id !== ui.detail?.pending_approval?.approval_id) ui.choice = null;
    for (const event of data.events) {
      const payload = JSON.parse(event.payload);
      if (event.event_type === 'step.started' && payload.node === 'draft') ui.stream = '';
      if (event.event_type === 'model.delta' && payload.node === 'draft') ui.stream += payload.content;
    }
    ui.after = data.events.at(-1)?.sequence || ui.after;
    data.events = [...(ui.detail?.events || []), ...data.events].slice(-400);
    const fingerprint = JSON.stringify([data.job.state, data.job.current_node, data.pending_approval?.content_hash, data.article.readiness, data.slots.map(slot => [slot.selected_candidate, slot.valid]), data.body, data.invocations.length, ui.stream.length]);
    if (!ui.dirty && fingerprint !== ui.fingerprint) { const hash = await hashText(data.body); if (ui.currentJob !== activeJob) return; ui.detail = data; ui.fingerprint = fingerprint; ui.bodyHash = hash; renderDetail(); }
    else if (ui.detail) { ui.detail.job = data.job; ui.detail.events = data.events; }
  } else if (ui.view === 'studio' && !document.querySelector('dialog[open]')) renderHome();
}
async function saveBody() {
  const editor = document.querySelector('#body-editor'); if (!editor) return;
  const jobId = ui.currentJob;
  await api('articles.save', { job_id: jobId, body: editor.value, content_hash: ui.bodyHash });
  if (ui.currentJob !== jobId) return;
  ui.dirty = false; toast('正文已保存，请复检后导出'); await refresh();
}
async function saveModels() {
  const routes = structuredClone(ui.bootstrap.settings.routes);
  for (const select of document.querySelectorAll('[data-role]')) {
    const primary = select.value;
    const old = routes[select.dataset.role];
    routes[select.dataset.role] = { ...old, primary, fallbacks: old.fallbacks.filter(id => id !== primary) };
  }
  routes.writer.thinking_policy = document.querySelector('#thinking-policy').value;
  const budget = Number(document.querySelector('#model-budget').value);
  for (const card of document.querySelectorAll('[data-provider].model-card')) {
    ui.bootstrap = await api('models.save', { provider: card.dataset.provider, model_id: card.querySelector('.model-id-input').value, routes, max_model_calls: budget });
  }
  renderModels(); toast('模型设置已保存，新任务将使用这份配置');
}
document.addEventListener('click', async event => {
  const view = event.target.closest('[data-view]'); if (view) { changeView(view.dataset.view); return; }
  const series = event.target.closest('[data-series]'); if (series) { changeView('studio'); ui.series = series.dataset.series; renderHome(); return; }
  const job = event.target.closest('[data-job]'); if (job) { try { await openJob(job.dataset.job); } catch (error) { toast(error.message); } return; }
  const library = event.target.closest('[data-library]'); if (library) { try { const data = await api('library.read', { folder: library.dataset.library }); workspace.innerHTML = `<button class="button text-button" data-action="back-library">← 返回存稿</button>${pageHeading('READ ONLY', esc(library.dataset.library), '已有文章 · 原文件保持只读')}<div class="editor-panel"><div class="markdown-preview">${renderMarkdown(data.body)}</div></div>`; } catch (error) { toast(error.message); } return; }
  const filter = event.target.closest('[data-filter]'); if (filter) { ui.filter = filter.dataset.filter; renderHome(); return; }
  const tab = event.target.closest('[data-tab]'); if (tab) { if (ui.dirty) { toast('请先保存正文修改'); return; } ui.tab = tab.dataset.tab; renderDetail(); return; }
  const mode = event.target.closest('[data-mode]'); if (mode) { if (ui.dirty) { toast('请先保存正文修改'); return; } ui.mode = mode.dataset.mode; renderDetail(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'fill-brief') { await fillBrief(); return; }
  button.disabled = true;
  try {
    if (action === 'new') await openNewArticle();
    else if (action === 'close-new') document.querySelector('#new-dialog').close();
    else if (action === 'close-approval') document.querySelector('#edit-approval-dialog').close();
    else if (action === 'close-verify') document.querySelector('#verify-dialog').close();
    else if (action === 'back') changeView('studio');
    else if (action === 'back-library') changeView('library');
    else if (action === 'refresh') { await refresh(); toast('工作空间已刷新'); }
    else if (action === 'demo') { const job = await api('jobs.create', { demo: true }); await openJob(job.job_id); }
    else if (action === 'approve' || action === 'reject') { const ap = ui.detail.pending_approval; const decision = action === 'approve' ? 'approve' : 'reject'; if (decision === 'reject' && !confirm('确认否决此候选？当前任务会停止。')) return; await api('approvals.decide', { job_id: ui.currentJob, approval_id: ap.approval_id, content_hash: ap.content_hash, decision, choice: ap.scope === 'final_title' ? ui.choice ?? ap.payload.recommended : null }); ui.choice = null; await refresh(); }
    else if (action === 'edit-approval') { document.querySelector('#approval-json').value = JSON.stringify(ui.detail.pending_approval.payload, null, 2); document.querySelector('#edit-approval-dialog').showModal(); }
    else if (action === 'pause') { await api('jobs.stop', { job_id: ui.currentJob }); await refresh(); }
    else if (action === 'resume') { await api('jobs.resume', { job_id: ui.currentJob }); await refresh(); }
    else if (action === 'save-body') await saveBody();
    else if (action === 'finalize') { if (ui.dirty) throw new Error('请先保存正文修改'); const result = await api('articles.finalize', { job_id: ui.currentJob }); toast(result.readiness === 'ready_for_publish' ? '就绪文章包已导出，请进入发布预览' : '草稿包已导出，仍有检查项或配图待完成'); await refresh(); }
    else if (action === 'open-folder') await window.ice.openFolder(ui.currentJob);
    else if (action === 'import-image') { const result = await window.ice.importImage(ui.currentJob, Number(button.dataset.figure)); if (result) { toast('图片已归档并选用'); await refresh(); } }
    else if (action === 'tapnow') await window.ice.openTapNow();
    else if (action === 'capture-window') { const result = await window.ice.captureWindow(); toast('当前窗口截图已保存：' + result.file); }
    else if (action === 'verify-claim') { const claim = ui.detail.claims.find(c => c.claim_id === button.dataset.claim); document.querySelector('#verify-claim').textContent = claim.text; document.querySelector('#verify-form [name="claim_id"]').value = claim.claim_id; document.querySelector('#verify-dialog').showModal(); }
    else if (action === 'approve-execution') { if (!confirm('确认已审阅当前源码，允许在本机执行？')) return; await api('execution.approve', { job_id: ui.currentJob, content_hash: ui.detail.execution_hash }); await refresh(); }
    else if (action === 'save-inputs') { const inputs = JSON.parse(document.querySelector('#execution-inputs').value); await api('execution.inputs', {job_id:ui.currentJob, content_hash:ui.detail.execution_hash, stdin_by_filename:inputs}); ui.fingerprint = ''; await refresh(); toast('示例输入已保存，请重新审阅并批准执行'); }
    else if (action === 'save-key') { const input = button.closest('.model-card').querySelector('.key-input'); const key = input.value; if (!key.trim()) throw new Error('请输入新的 Key；留空不会清除原凭据'); try { await window.ice.saveKey(button.dataset.provider, key.trim()); } finally { input.value = ''; } ui.bootstrap = await api('bootstrap'); renderModels(); toast('凭据已加密保存'); }
    else if (action === 'save-models') await saveModels();
    else if (action === 'probe-model') { const card = button.closest('.model-card'); await api('models.save', { provider: button.dataset.provider, model_id: card.querySelector('.model-id-input').value }); const result = await api('models.probe', { provider: button.dataset.provider }); toast(`连接通过：${result.model}`); ui.bootstrap = await api('bootstrap'); renderModels(); }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('input', event => { if (event.target.id === 'body-editor') { ui.dirty = true; } });
document.addEventListener('change', async event => {
  if (['title-choice','topic-choice'].includes(event.target.name)) ui.choice = Number(event.target.value);
  if (event.target.dataset.candidateSlot) { try { await api('assets.select', { job_id: ui.currentJob, candidate_id: event.target.value }); await refresh(); } catch (error) { toast(error.message); } }
});
document.querySelector('#new-form').addEventListener('submit', async event => {
  event.preventDefault(); if (briefState.busy || planningState.busy || planningState.loading) return;
  if (!planningState.context) { planningStatus('请先刷新历史与发布进度，再确认需求。',true); return; }
  const values = Object.fromEntries(new FormData(newForm)), accountId=activeAccount().id;
  const controls=[...newForm.elements], disabled=controls.map(node=>node.disabled);
  const context_hash=planningState.context.context_hash, plan_id=planningState.proposal?.plan_id;
  controls.forEach(node=>node.disabled=true);
  try {
    const confirmation=await api('planning.confirm',{fields:values,account_id:accountId,context_hash,plan_id});
    const materials = values.materials_text ? [{ title: '用户参考素材', summary: values.materials_text, url: values.materials_text.match(/https:\/\/[^\s]+/)?.[0], tier: 3 }] : [];
    const result = await api('jobs.create', { ...confirmation,account_id:accountId,spec:{ ...values,episode:Number(values.episode),materials } });
    newDialog.close();await openJob(result.job_id);
  } catch(error) {planningStatus(error.message,true);toast(error.message);}
  finally {controls.forEach((node,index)=>node.disabled=disabled[index]);planningButtons();}
});
document.querySelector('#approval-edit-form').addEventListener('submit', async event => {
  event.preventDefault(); try { const ap = ui.detail.pending_approval; await api('approvals.edit', { job_id: ui.currentJob, approval_id: ap.approval_id, content_hash: ap.content_hash, payload: JSON.parse(document.querySelector('#approval-json').value) }); document.querySelector('#edit-approval-dialog').close(); toast('候选新版本已保存'); await refresh(); } catch (error) { toast(error.message); }
});
document.querySelector('#verify-form').addEventListener('submit', async event => {
  event.preventDefault(); try { await api('claims.verify', { ...Object.fromEntries(new FormData(event.target)), job_id: ui.currentJob }); document.querySelector('#verify-dialog').close(); toast('事实核验记录已保存'); ui.fingerprint = ''; await refresh(); } catch (error) { toast(error.message); }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && ui.currentJob && ui.mode === 'edit') { event.preventDefault(); saveBody().catch(error => toast(error.message)); }
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) openNewArticle().catch(error=>toast(error.message));
  if (event.key === 'Enter' && document.activeElement.dataset.job) openJob(document.activeElement.dataset.job).catch(error => toast(error.message));
});
window.__ICE_SMOKE__ = async function () {
  const base = { title: document.title, connected: document.querySelector('#engine-indicator').classList.contains('connected'),
    heading: document.querySelector('h1')?.textContent, jobs: ui.jobs.length, bodyWidth: document.body.scrollWidth, viewport: innerWidth };
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```');
  base.previewEscaped = !html.includes('<script>') && !html.includes('<img src=x');
  const created = await api('jobs.create', { demo: true });
  base.gates = [];
  const deadline = Date.now() + 100000;
  let data;
  while (Date.now() < deadline) {
    data = await api('jobs.get', { job_id: created.job_id });
    if (data.job.state === 'awaiting_approval' && data.pending_approval) {
      await openJob(created.job_id);
      if (!document.querySelector('[data-action="approve"]')) throw Error('审核按钮未渲染');
      const approval = data.pending_approval;
      base.gates.push(approval.scope);
      await api('approvals.decide', { job_id: created.job_id, approval_id: approval.approval_id,
        content_hash: approval.content_hash, decision: 'approve', choice: approval.scope === 'final_title' ? 0 : null });
    } else if (data.job.state === 'completed') break;
    else if (['failed', 'awaiting_user'].includes(data.job.state)) throw Error(data.job.pause_reason);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (data.job.state !== 'completed') throw Error('离线流程超时');
  await openJob(created.job_id);
  base.completed = true;
  base.readiness = data.article.readiness;
  base.runs = Object.keys(data.runs).length;
  base.exported = Boolean(data.export.folder);
  ui.tab = 'evidence'; renderDetail();
  base.evidenceCards = document.querySelectorAll('.run-card').length;
  ui.tab = 'assets'; renderDetail();
  base.assetCards = document.querySelectorAll('.asset-card').length;
  changeView('models');
  base.modelCards = document.querySelectorAll('.model-card').length;
  base.libraryArticles = (await api('library.list')).length;
  const opening = openJob(created.job_id);
  changeView('models');
  await opening;
  base.navigationStable = ui.view === 'models' && document.querySelector('h1').textContent === '给每个写作角色，选对模型。';
  await refresh(); changeView('studio');
  base.jobs = ui.jobs.length;
  base.bodyWidth = document.body.scrollWidth;
  base.viewport = innerWidth;
  return base;
};
window.__ICE_CAPTURE_VIEW__ = async function (view) {
  if (view === 'models') changeView('models');
  else if (view === 'article') { const job = ui.jobs.find(job => job.state === 'completed'); await openJob(job.job_id); ui.tab = 'article'; renderDetail(); }
  else if (view === 'accounts') changeView('accounts');
  else if (view === 'resources') { changeView('resources'); await renderResources(); }
  else if (view === 'drafts') { changeView('drafts'); await renderDrafts(); }
  else if (view === 'history') { newDialog.close(); changeView('history'); await renderHistory(); }
  else if (view === 'new') { await openNewArticle({reset:true}); await proposeHistory(async()=>window.__ICE_SAMPLE_PROPOSAL__()); choosePlanningCandidate(0); planningStatus('离线界面测试样例：分析历史后选择候选，可继续编辑。'); newDialog.scrollTop=0; }
  else { newDialog.close(); changeView('studio'); }
};
window.__ICE_PUBLICATION_SMOKE__ = async function () {
  const before = (await api('jobs.list')).length;
  newForm.reset(); newForm.elements.topic.value = '用循环做乘法表'; newDialog.showModal();
  await fillBrief(async () => ({fields:{core_benefit:'独立跑通循环练习',next_episode_plan:'学习列表',materials_text:'待查证素材建议：Python 循环官方文档。'},notes:[]}));
  const filled = newForm.elements.core_benefit.value === '独立跑通循环练习';
  newForm.elements.core_benefit.value = '我自己修改的收益';
  newForm.elements.core_benefit.dispatchEvent(new Event('input',{bubbles:true}));
  const editable = newForm.elements.core_benefit.value === '我自己修改的收益' && !newForm.elements.core_benefit.disabled;
  newForm.elements.core_benefit.value = '';
  let release;
  const filling = fillBrief(() => new Promise(resolve => {release=resolve;}));
  newForm.elements.core_benefit.value = '等待期间手写内容'; newForm.elements.core_benefit.dispatchEvent(new Event('input',{bubbles:true}));
  release({fields:{core_benefit:'晚到的AI内容'},notes:[]}); await filling;
  const protectedEdit = newForm.elements.core_benefit.value === '等待期间手写内容';
  newDialog.close();
  const noTask = (await api('jobs.list')).length === before;
  const config = {...freshAccount(),name:'生活观察',audience:'喜欢记录日常的读者',positioning:'让日常生活中的细节变成文章',columns:[{code:'LIFE',name:'生活发现'}]};
  await useBootstrap(await api('accounts.save',{account:config}));
  const accountId = activeAccount().id;
  const customColumn = newForm.elements.series.value === 'LIFE' && Boolean(document.querySelector('[data-series="LIFE"]'));
  changeView('drafts'); renderDraftEditor();
  const form = document.querySelector('#draft-form'); form.elements.title.value = '阳台上的阅读角'; form.elements.body.value = '# 阳台上的阅读角\n\n先记录光线与动线，再安排椅子和书。'; ui.draftDirty = true; form.requestSubmit();
  const deadline = Date.now()+15000; while (ui.draftDirty && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
  if (!ui.currentDraft.draft_id) throw Error('桌面草稿未保存');
  const draftId = ui.currentDraft.draft_id;
  const body = (await api('drafts.get',{draft_id:draftId})).body;
  await useBootstrap(await api('accounts.switch',{account_id:'ice-loop'}),'studio');
  const isolated = (await api('drafts.list')).every(d=>d.draft_id!==draftId);
  await useBootstrap(await api('accounts.switch',{account_id:accountId}),'accounts');
  const restored = (await api('drafts.get',{draft_id:draftId})).body === body;
  return {filled,editable,protectedEdit,noTask,customColumn,draftSaved:Boolean(draftId),isolated,restored,accountId};
};
window.__ICE_RESOURCE_SMOKE__ = async function () {
  changeView('resources'); await renderResources();
  return {cards:document.querySelectorAll('[data-resource]').length,palette:document.querySelectorAll('[data-color]').length,
    measured:(await api('resources.list'))[0].palette.length>0,preview:document.querySelector('[data-resource-image]')?.src.startsWith('data:image/png;base64,')};
};
window.__ICE_SAMPLE_PROPOSAL__=function(){return {plan_id:'offline-ui-example',analysis:'历史文章记录了阳台的光线与动线，下一篇可以延续阅读角的使用体验，避免重复介绍布局。',recommended:0,model:'离线界面样例',history:planningState.context.known_titles,candidates:['阳台阅读角：让布置变成习惯','一盏灯，让阅读角更好用','整理一个愿意停留的角落'].map(title=>({title,topic:'从实际使用体验出发，记录布局后的调整',core_benefit:'根据自己的使用记录，改善阅读空间',reason:'延续已有文章中的光线与动线，增加实际使用观察',next_episode_plan:'整理一周的观察笔记',source_ids:[]}))};};
window.__ICE_PLANNING_SMOKE__=async function(){
  const before=(await api('jobs.list')).length;
  const record=(await api('history.list')).find(row=>row.source_key.startsWith('draft:'));
  const today=new Date(),published_at=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  await api('history.update',{...record,series:'LIFE',episode:5,status:'published',published_at});
  await openNewArticle({reset:true});
  const nextEpisode=newForm.elements.episode.value==='6';
  const initialContext=planningState.context;let contextRelease;
  const loading=loadPlanningContext(true,()=>new Promise(resolve=>contextRelease=resolve));
  newForm.elements.episode.value='8';newForm.elements.episode.dispatchEvent(new Event('input',{bubbles:true}));
  contextRelease(initialContext);await loading;
  const manualEpisodeProtected=newForm.elements.episode.value==='8'&&!planningState.loading&&Boolean(planningState.context);
  planningState.episodeTouched=false;await loadPlanningContext();
  let release;const pending=proposeHistory(()=>new Promise(resolve=>{release=resolve;}));
  newForm.elements.topic.value='等待期间我自己写的标题';newForm.elements.topic.dispatchEvent(new Event('input',{bubbles:true}));
  release(window.__ICE_SAMPLE_PROPOSAL__());await pending;
  const protectedTitle=newForm.elements.topic.value==='等待期间我自己写的标题';
  const candidates=document.querySelectorAll('[data-plan-card]').length===3;
  choosePlanningCandidate(1);const adopted=newForm.elements.topic.value==='一盏灯，让阅读角更好用';
  newForm.elements.topic.value='我修改后的阅读角标题';
  const fields=Object.fromEntries(new FormData(newForm));
  const confirmation=await api('planning.confirm',{fields,context_hash:planningState.context.context_hash,account_id:activeAccount().id});
  const confirmed=Boolean(confirmation.confirmation_hash)&&!newForm.elements.topic.disabled;
  const late=proposeHistory(()=>new Promise(resolve=>{release=resolve;}));
  newForm.elements.episode.value='7';newForm.elements.episode.dispatchEvent(new Event('input',{bubbles:true}));
  release(window.__ICE_SAMPLE_PROPOSAL__());await late;
  const staleIgnored=!planningState.proposal&&!document.querySelector('[data-plan-card]');
  newDialog.close();await new Promise(resolve=>setTimeout(resolve,20));
  changeView('history');await renderHistory();
  const historyPage=Boolean(document.querySelector('#history-progress-form'))&&document.querySelectorAll('.history-record').length>0;
  return {nextEpisode,manualEpisodeProtected,protectedTitle,candidates,adopted,confirmed,staleIgnored,historyPage,noTask:(await api('jobs.list')).length===before};
};
async function boot() {
  try { ui.bootstrap = await api('bootstrap'); syncPublication(); ui.jobs = ui.bootstrap.jobs; document.querySelector('#job-count').textContent = ui.jobs.length; document.querySelector('#engine-indicator').classList.add('connected'); document.querySelector('#engine-status').textContent = '本地引擎已连接'; renderHome(); }
  catch (error) { workspace.innerHTML = `<div class="loading-view"><h2>工作空间暂时未连接</h2><p>${esc(error.message)}</p><button class="button secondary" data-action="refresh">重新连接</button></div>`; }
}
window.ice.onEngineExit(() => { document.querySelector('#engine-indicator').classList.remove('connected'); document.querySelector('#engine-status').textContent = '引擎已退出'; toast('文章引擎已退出，请重新启动工作台'); });
let polling = false;
setInterval(async () => { if (polling || !ui.bootstrap) return; polling = true; try { await refresh(); } catch (error) { if (!document.querySelector('#toast').classList.contains('show')) toast(error.message); } finally { polling = false; } }, 2200);
initPlanning();
boot();
