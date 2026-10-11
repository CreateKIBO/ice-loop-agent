'use strict';
const { escapeHTML: esc, renderMarkdown } = window.iceMarkdown;
const api = (method, params = {}) => window.ice.request(method, params);
const nodeNames = { ingest: '整理需求', topic: '选题审核', research: '整理事实', outline: '骨架审核', draft: '撰写正文', verify_code: '代码验证', integrate_evidence: '回填真实输出', article_review: '内容审校', style_review: '风格审校', title_workshop: '标题审核', asset_plan: '配图计划', assets: '准备配图', final_check: '发布检查', export: '文章包导出' };
const nodes = Object.keys(nodeNames);
const stages = ['topic', 'outline', 'draft', 'article_review', 'title_workshop', 'asset_plan', 'export'];
const seriesNames = { PY: 'Python 从 0 到 1', JV: 'Java 打怪升级', AI: 'AI 实作实验室', WK: '工具周刊' };
const stateNames = { queued: '准备开始', running: '正在创作', awaiting_approval: '待你审核', awaiting_user: '需要处理', completed: '写作完成', failed: '任务中断', paused: '已暂停', cancelled: '已取消' };
const readinessNames = { draft: '草稿', text_verified: '代码已验证', assets_pending: '待补配图', images_ready:'补图完成 · 正文待审核', review_pending: '待复检', ready_for_publish: '可进入发布预览' };
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
    if(snapshot.title_mode!==newForm.elements.title_mode?.value){briefStatus('题目来源已修改，本次建议未填入。');return;}
    if(snapshot.title_mode!=='ai')result.fields={...result.fields,topic:snapshot.topic};
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
function stateBadge(job) { if(job.image_only||job.spec?.image_only)return badge(job.readiness==='images_ready'?'补图完成':'原稿补图','blue'); const tone = job.state === 'awaiting_approval' ? 'blue' : job.state === 'failed' ? 'red' : job.readiness === 'ready_for_publish' ? 'green' : job.state === 'awaiting_user' ? 'amber' : ''; return badge(job.readiness === 'ready_for_publish' ? readinessNames[job.readiness] : stateNames[job.state] || job.state, tone); }
function dateString(value) { return value ? new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : ''; }
function articleSeriesLabel(article){return article.series==='UNSPECIFIED'?'栏目 / 期号未标注':`${article.series} / ${String(article.episode).padStart(3,'0')}`;}
function eventSummary(event){const payload=JSON.parse(event.payload);return event.event_type==='asset.reviewed'?`配图${payload.decision==='accepted'?'接受':'否决'} · ${payload.candidate_id} · ${payload.note||'未填写说明'}`:nodeNames[payload.node]||event.event_type;}
function progress(job) { if(job.image_only||job.spec?.image_only)return `<div class="progress-track" aria-label="原稿已保留，配图${job.readiness==='images_ready'?'已准备':'待准备'}，正文待审核"><i class="done"></i><i class="${job.readiness==='images_ready'?'done':'current'}"></i><i></i></div>`; const index = nodes.indexOf(job.current_node); return `<div class="progress-track" aria-label="当前进度：${esc(nodeNames[job.current_node])}">${nodes.map((_node, i) => `<i class="${i < index || job.state === 'completed' ? 'done' : i === index ? 'current' : ''}"></i>`).join('')}</div>`; }
function flowPanel(job) { if(job?.image_only||job?.spec?.image_only)return supplementTaskFlow(job); const index = job ? nodes.indexOf(job.current_node) : -1; return `<div class="side-panel"><div class="panel-heading">文章生产流程 <span class="eyebrow">01—07</span></div><ol class="step-list">${stages.map((node, i) => { const n = nodes.indexOf(node); const active = job && n <= index && (i === stages.length - 1 || nodes.indexOf(stages[i + 1]) > index); const done = job && (n < index && !active || job.state === 'completed'); return `<li class="${done ? 'done' : active ? 'current' : ''}"><span class="step-dot">${done ? '✓' : String(i + 1).padStart(2, '0')}</span><div>${{ topic: '确定选题', outline: '搭建骨架', draft: '撰写与验证', article_review: '审校文章', title_workshop: '确认标题', asset_plan: '配图与截图', export: '检查与导出' }[node]}<div class="step-sub">${{ topic: '你的判断，决定文章方向', outline: '先想清楚，再写下来', draft: '代码输出来自真实运行', article_review: '事实、结构与品牌检查', title_workshop: '标题承诺与正文一致', asset_plan: '按图位审阅每个候选', export: '形成可预览的文章包' }[node]}</div></div></li>`; }).join('')}</ol><div class="panel-foot">关键决定由你确认。<br>写作、验证和素材归档交给工作台。</div></div>`; }
function pageHeading(eyebrow, title, description, right = '') { return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${right}</div>`; }
function renderHome() {
  const pending = ui.jobs.filter(job => ['awaiting_approval', 'awaiting_user'].includes(job.state));
  const completed = ui.jobs.filter(job => job.state === 'completed');
  const ready = ui.jobs.filter(job => job.readiness === 'ready_for_publish');
  const jobs = ui.jobs.filter(job => (!ui.series || job.series === ui.series) && (ui.filter === 'all' || ui.filter === 'pending' && pending.includes(job) || ui.filter === 'completed' && completed.includes(job)));
  workspace.innerHTML = pageHeading('MAKE IDEAS EXECUTABLE', ui.series ? seriesNames[ui.series] : '从一个想法，到一篇好文章。', '有依据地写作，有节奏地审阅。今天的创作，从这里开始。', '<div class="heading-meta">CONTENT WORKSPACE</div>') +
    `<div class="overview"><div class="stat"><div><div class="stat-label">正在制作的文章</div><div class="stat-desc">从需求到可发布文章包</div></div><span class="stat-number">${String(ui.jobs.filter(j => !['cancelled'].includes(j.state)).length).padStart(2, '0')}</span></div><div class="stat"><div><div class="stat-label">等待你的决定</div><div class="stat-desc">审核或补充素材后继续</div></div><span class="stat-number blue">${String(pending.length).padStart(2, '0')}</span></div><div class="stat"><div><div class="stat-label">可以进入发布预览</div><div class="stat-desc">真实代码与配图已核对</div></div><span class="stat-number">${String(ready.length).padStart(2, '0')}</span></div></div>` +
`<div class="workspace-grid"><section><div class="section-bar"><h2>创作中的文章</h2><button class="button text-button" data-action="new">新建文章 ↗</button></div><div class="filter-tabs">${[['all', '全部文章'], ['pending', '等待审核'], ['completed', '写作完成']].map(([value, label]) => `<button data-filter="${value}" class="${ui.filter === value ? 'active' : ''}">${label}</button>`).join('')}</div><div class="task-list">${jobs.length ? jobs.map(job => `<article class="task-card" data-job="${esc(job.job_id)}" tabindex="0" role="button" aria-label="打开文章 ${esc(job.topic)}"><div class="task-card-top"><span class="series-label"><span class="series-square ${job.series.toLowerCase()}">${job.series==='UNSPECIFIED'?'—':esc(job.series)}</span>${esc(articleSeriesLabel(job))}${job.demo ? ' · 离线演示' : ''}</span>${stateBadge(job)}</div><h3>${esc(job.final_title || job.topic)}</h3><div class="task-meta"><span>${esc(nodeNames[job.current_node])}</span><span>·</span><span>${esc(readinessNames[job.readiness] || '草稿')}</span><span class="push-right">${dateString(job.updated_at)} &nbsp; ↗</span></div>${progress(job)}</article>`).join('') : `<div class="empty-state"><div class="empty-graphic">↗</div><h3>下一篇文章，从你的想法开始。</h3><p>选一个主题，准备一点素材。工作台会在关键节点等你审阅。</p><button class="button primary" data-action="new">开始创作 ＋</button></div>`}</div></section><aside>${flowPanel(pending[0] || jobs[0])}<div class="quiet-card"><span class="eyebrow">EXPLORE THE WORKFLOW</span><h3>先走一遍，再开始。</h3><p>离线示例使用内置内容与真实代码执行，不调用模型，也不产生费用。</p><button class="button secondary small" data-action="demo">体验离线示例 ↗</button></div></aside></div>`;
  workspace.querySelector('.heading-meta').insertAdjacentHTML('beforebegin','<button class="button secondary" data-supp-action="import">导入文章补图 ↗</button>');
}
function detailContext(data) { const profileSnapshot = data.job.model_route_snapshot; const writerId = profileSnapshot.routes?.writer?.primary; const writer = profileSnapshot.profiles?.[writerId]; return `<aside>${flowPanel(data.job)}<div class="side-panel context-panel"><div class="panel-heading">本篇信息</div><ul class="context-list"><li><span>栏目</span><strong>${esc(articleSeriesLabel(data.article))}</strong></li><li><span>生成来源</span><strong>${data.article.spec.demo ? '离线 Mock 示例' : esc(writer?.model_id || '已冻结模型配置')}</strong></li><li><span>模型调用</span><strong>${data.invocations.length} / ${data.job.limits.max_model_calls}</strong></li><li><span>代码验证</span><strong>${Object.keys(data.runs).length} 条运行记录</strong></li><li><span>配图就绪</span><strong>${data.slots.filter(s => s.valid).length} / ${data.slots.length}</strong></li></ul></div></aside>`; }
function renderDetail() {
  const data = ui.detail; if (!data) return;
  const approval = data.pending_approval;
  const tabNames = data.supplement?{article:'原稿与配图预览',assets:'图位与候选审核',evidence:'原稿代码与运行',activity:'补图记录'}:{ article: '正文与预览', review: approval ? '待你审核' : '审核记录', assets: '配图素材', evidence: '运行与事实', versions: '版本历史', activity: '任务记录' };
  const title = data.article.final_title || data.article.working_title || data.article.topic;
  document.querySelector('#page-name').textContent = '文章工作区';
  workspace.innerHTML = `<button class="button text-button" data-action="back">← 返回创作工作台</button><div class="detail-heading"><div><span class="series-label">${esc(articleSeriesLabel(data.article))} ${data.article.spec.demo ? ' · 离线演示' : ''}</span><h1>${esc(title)}</h1><div class="button-row">${stateBadge({ ...data.article, ...data.job })}<span class="muted">${esc(nodeNames[data.job.current_node])}</span></div></div><div class="button-row">${data.job.state === 'running' ? '<button class="button secondary" data-action="pause">暂停</button>' : ['paused', 'failed'].includes(data.job.state) ? '<button class="button secondary" data-action="resume">继续任务</button>' : ''}${data.job.state === 'completed' ? '<button class="button primary" data-action="finalize">复检与导出 ↗</button>' : ''}${data.export.folder ? '<button class="button secondary" data-action="open-folder">打开文章包</button>' : ''}</div></div><div class="detail-tabs">${Object.entries(tabNames).map(([tab, name]) => `<button data-tab="${tab}" class="${ui.tab === tab ? 'active' : ''}">${name}${tab === 'review' && approval ? ' ·' : ''}</button>`).join('')}</div><div class="detail-grid"><section>${data.job.state === 'failed' ? `<div class="note-box error">${esc(data.job.pause_reason)}</div>` : ''}${data.job.state === 'awaiting_user' ? `<div class="note-box">${esc(data.job.pause_reason)}</div>` : ''}${renderDetailTab(data)}</section>${detailContext(data)}</div>`;
  if(data.article.spec.production_mode==='auto_prepare'){
    const note=document.createElement('div');note.className='visual-notice automation-summary';
    note.innerHTML=`<strong>自动准备 · 完成后统一审阅</strong><p>标题、大纲、正文与生图提示词由Agent准备。可用运行记录会自动截图；各实截图包含本文全部运行记录，请核对图位。需要生图的图片请在程序内TapNow生成后导入。</p>${Object.entries(data.auto_capture_errors||{}).map(([figure,error])=>`<p>图${esc(figure)}自动截图未完成：${esc(error)}。可在配图素材中改选单条记录截图。</p>`).join('')}`;
    workspace.querySelector('.detail-tabs').before(note);
  }
  loadImages(data);
  if(ui.tab==='versions')loadRevisions(data);
  if(data.export.folder)document.querySelector('.detail-heading > .button-row').insertAdjacentHTML('beforeend','<button class="button secondary" data-action="open-html">HTML 排版预览 ↗</button>');
  if(data.export.folder){document.querySelector('[data-action="open-folder"]').textContent='打开发布包 · 文本/图片';document.querySelector('.detail-heading > .button-row').insertAdjacentHTML('beforeend','<button class="button secondary" data-action="wechat">内嵌公众号后台 →</button>');}
  document.querySelector('[data-action="finalize"]')?.replaceChildren(document.createTextNode(data.article.spec.production_mode==='auto_prepare'?'已统一审阅，复检并导出 ↗':'复检并导出发布包 ↗'));
  if(data.supplement){document.querySelector('[data-action="finalize"]')?.replaceChildren(document.createTextNode('导出补图候选 ↗'));document.querySelector('.detail-grid > aside').innerHTML=supplementContext(data);}
}
function renderDetailTab(data) {
  if(data.supplement&&ui.tab==='evidence')return supplementEvidence(data)+renderEvidence(data);
  if (ui.tab === 'versions') return '<div id="revision-history" class="review-panel" aria-live="polite">正在读取版本记录…</div>';
  if (ui.tab === 'review') return renderReview(data);
  if (ui.tab === 'assets') return renderAssets(data);
  if (ui.tab === 'evidence') return renderEvidence(data);
  if (ui.tab === 'activity') return `<div class="review-panel"><h2>任务记录</h2><div class="activity-list">${data.events.filter(event => event.event_type !== 'model.delta').slice().reverse().map(event => `<div class="activity-item"><span>${esc(event.occurred_at)} / ${event.sequence}</span>${esc(eventSummary(event))}</div>`).join('')}</div></div>`;
  if (!data.body) return `<div class="editor-panel"><div class="editor-toolbar"><span>正文工作区</span>${badge('等待上游审核')}</div>${ui.stream ? `<div class="live-draft">${esc(ui.stream)}</div>` : '<div class="empty-state"><div class="empty-graphic">¶</div><h3>文章会在骨架确认后生成。</h3><p>先在审核页确认选题方向和正文骨架。</p><button class="button secondary" data-tab="review">查看待审核内容 →</button></div>'}</div>`;
  const figures = Object.fromEntries(data.slots.map(slot => [slot.figure_no, ui.images[slot.selected_candidate]]));
  const editable = !data.supplement&&(data.job.state === 'completed' || data.job.state === 'failed' && ['article_review','style_review'].includes(data.job.current_node));
  return `<div class="editor-panel"><div class="editor-toolbar"><div class="editor-mode">${[['preview', '阅读预览'], ['edit', data.supplement?'原稿 · 只读':'Markdown'], ['mobile', '手机视图']].map(([mode, label]) => `<button data-mode="${mode}" class="${ui.mode === mode ? 'active' : ''}">${label}</button>`).join('')}</div><span>${data.body.length.toLocaleString()} 字符 ${ui.dirty ? ' · 有未保存修改' : ''}</span>${ui.mode === 'edit' && editable ? '<button class="button primary small" data-action="save-body">保存正文</button>' : ''}</div>${ui.mode === 'edit' ? `<textarea id="body-editor" class="markdown-editor" spellcheck="false" aria-label="文章 Markdown 正文" ${!editable ? 'readonly' : ''}>${esc(data.body)}</textarea>` : `<div class="markdown-preview ${ui.mode === 'mobile' ? 'mobile-paper' : ''}">${renderMarkdown(data.supplement?.preview_md||data.body, figures)}</div>`}</div>`;
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
  const plan=data.supplement?supplementPlanBar(data):'';
  if (!data.slots.length) return plan+'<div class="empty-state"><h3>'+ (data.supplement?'原稿中没有独立图片行。':'先完成配图计划审核。')+'</h3><p>'+ (data.supplement?'编辑配图计划，选择标题之后、章节之前或文章结尾，添加图位。':'工作台会按文章内容建立每个图位。')+'</p></div>';
  const blocked=Boolean(data.job.lease||data.pending_approval?.scope==='asset_plan');
  return plan+'<div class="section-bar"><h2>按图位管理素材</h2><button class="button secondary small" data-view="resources">打开配图资源箱 ↗</button></div>'+ (blocked?'<p class="visual-notice">请先确认配图计划，再准备素材。</p>':'') + '<div class="asset-grid">'+data.slots.map(slot=>`<article class="asset-card"><div class="asset-visual" data-image-slot="${slot.figure_no}">${ui.images[slot.selected_candidate]?`<img src="${ui.images[slot.selected_candidate]}" alt="${esc(slot.caption)}">`:`<span>0${slot.figure_no}</span>`}${badge(slot.valid?'已就绪':'待准备',slot.valid?'green':'')}</div><div class="asset-info">${visualSlotActions(data,slot,blocked)}${slot.candidates.length?`<label>已接受候选<select class="candidate-select" data-candidate-slot="${slot.slot_id}" aria-label="选择图 ${slot.figure_no} 候选"><option value="" ${!slot.selected_candidate?'selected':''} disabled>请选择已接受的图片</option>${slot.candidates.filter(candidate=>candidate.review_status==='accepted').map((candidate,i)=>`<option value="${candidate.candidate_id}" ${candidate.candidate_id===slot.selected_candidate?'selected':''}>已接受 ${i+1}${candidate.candidate_id===slot.selected_candidate?' · 当前采用':''}</option>`).join('')}</select></label>`:''}${candidateReviewRows(data,slot,blocked)}</div></article>`).join('')+'</div>';
}
function renderEvidence(data) {
  let html = '<div class="section-bar"><h2>真实运行记录</h2><small>RunRecord · 源码与输出绑定</small></div>';
  html += executionPanel(data);
  html += Object.entries(data.runs).map(([id, run]) => {
    const expected=run.verdict==='expected_failure_ok';
    const status=run.timed_out?'执行超时':run.runtime.output_limited==='true'?'输出达到上限':expected?'预期报错 · 已验证':run.exit_code===0?'真实执行通过':'运行失败';
    const cleanup=run.runtime.workspace_cleanup;
    const note=cleanup==='removed_owned_workspace'?'临时源码、编译产物和运行临时文件已清理；源码与执行证据已归档。':cleanup?.startsWith('retained:')?'临时目录已保留，请检查：'+cleanup.slice(10):cleanup==='preserved_external_directory'?'外部指定目录已保留。':'旧版执行记录未记录清理状态，历史文件保持原样。';
    return `<div class="run-card">${badge(status,expected?'amber':run.exit_code===0?'green':'red')}<h3>${esc(run.filename)}</h3><div class="run-meta">${esc(id)} / exit ${run.exit_code} / ${run.duration_ms} ms / ${esc(run.runtime.python || '')}</div><pre class="run-output">${esc(run.stdout)}${run.stderr ? '\n[stderr]\n' + esc(run.stderr) : ''}</pre><p class="muted run-cleanup-note">${run.runtime.process_cleanup?'本次进程树已退出。':''}${esc(note)}</p><details><summary class="muted">源码和示例输入</summary><pre class="run-output">${esc(run.source || '')}\n输入：${esc(run.stdin_events.join(''))}</pre></details></div>`;
  }).join('');
  if (!Object.keys(data.runs).length && data.job.current_node !== 'verify_code') html += '<p class="muted">代码将在正文生成后执行，这里只展示实际运行记录。</p>';
  html += '<div class="section-bar evidence-heading"><h2>事实与来源</h2><small>核验状态由你的证据决定</small></div>' + data.claims.map(claim => `<div class="claim-card">${badge(claim.status === 'verified' ? '已人工核验' : claim.status === 'qualified' ? '稳定事实 · 待审阅' : '需要核验', claim.status === 'verified' ? 'green' : 'amber')}<p>${esc(claim.text)}</p><div class="button-row"><small class="muted">${esc(claim.risk_type)}</small><button class="button text-button small" data-action="verify-claim" data-claim="${claim.claim_id}">记录来源 →</button></div></div>`).join('');
  return html;
}
async function loadImages(data) {
  let changed = false;
  const accountId=activeAccount().id;
  const selected=new Set(data.slots.map(slot=>slot.selected_candidate));
  for(const id of Object.keys(ui.images))if(!selected.has(id))delete ui.images[id];
  for (const slot of data.slots) {
    const id = slot.selected_candidate;
    if (!id || ui.images[id]) continue;
    try { const url = await api('assets.preview', { job_id: data.job.job_id, candidate_id: id }); if(ui.currentJob!==data.job.job_id||activeAccount().id!==accountId)return; ui.images[id] = url; changed = true; if (ui.tab === 'assets') { const target = document.querySelector(`[data-image-slot="${slot.figure_no}"]`); if (target) { const image = document.createElement('img'); image.src = url; image.alt = slot.caption; target.prepend(image); target.querySelector(':scope > span:not(.badge)')?.remove(); } } }
    catch { /* Missing assets are shown as pending by the engine. */ }
  }
  if (changed && ui.currentJob === data.job.job_id && ui.tab === 'article' && !ui.dirty) {
    const preview = document.querySelector('.markdown-preview');
    if (preview) preview.innerHTML = renderMarkdown(ui.detail.supplement?.preview_md||ui.detail.body, Object.fromEntries(ui.detail.slots.map(slot => [slot.figure_no, ui.images[slot.selected_candidate]])));
  }
}
function renderModels() {
  const profiles = ui.bootstrap.settings.profiles;
  workspace.innerHTML = pageHeading('TOOLS FOR YOUR VOICE', '给每个写作角色，选对模型。', '国内供应商分别配置。新设置用于新任务，正在进行的文章继续使用原配置。') + `<div class="model-grid">${profiles.map(profile => { const [mark, title, service] = providers[profile.provider]; return `<section class="model-card" data-provider="${profile.provider}"><div class="model-head"><div class="provider-title"><span class="provider-mark">${mark}</span><div><h3>${title}</h3><small>${service}</small></div></div>${badge(profile.status === 'verified' ? '连接已验证' : profile.has_key ? '可测试连接' : '未配置 Key', profile.status === 'verified' ? 'green' : '')}</div><label>模型 ID<input class="model-id-input" value="${esc(profile.model_id)}" aria-label="${title} 模型 ID"></label><label>API Key<div class="key-row"><input class="key-input" type="password" autocomplete="off" placeholder="${profile.has_key ? '已配置 · 留空保持原凭据' : '填写供应商控制台的 Key'}" aria-label="${title} API Key"><button class="button secondary small" data-action="save-key" data-provider="${profile.provider}">保存 Key</button></div></label><div class="endpoint">${esc(profile.base_url)}</div><div class="model-actions"><button class="button secondary small" data-action="probe-model" data-provider="${profile.provider}">测试连接 ↗</button><small>发送一次短请求，可能计费</small></div></section>`; }).join('')}</div><section class="route-panel"><h2>角色分工与请求预算</h2><p>为正文、审稿和规划选择主模型。回退仅使用明确配置的供应商。</p><div class="route-grid">${Object.entries(roles).map(([role, name]) => `<label>${name}<select data-role="${role}">${profiles.map(profile => `<option value="${profile.profile_id}" ${ui.bootstrap.settings.routes[role]?.primary === profile.profile_id ? 'selected' : ''}>${providers[profile.provider][1]}</option>`).join('')}</select></label>`).join('')}<label>单篇模型请求上限<input id="model-budget" type="number" min="1" max="100" value="${ui.bootstrap.settings.max_model_calls}"></label><label>正文思考策略<select id="thinking-policy">${[['prefer_off', '优先关闭思考'], ['provider_default', '供应商默认'], ['prefer_on', '优先开启思考'], ['required_off', '必须关闭思考']].map(([value, label]) => `<option value="${value}" ${ui.bootstrap.settings.routes.writer.thinking_policy === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="button-row"><button class="button primary" data-action="save-models">保存模型与角色配置</button><span class="muted">凭据由系统加密存储，正文和日志不包含 Key。</span></div></section>`;
  workspace.insertAdjacentHTML('beforeend',visualModelPanel());bindVisualModelForm();
}
async function renderLibrary() {
  ui.library = await api('library.list');
  workspace.innerHTML = pageHeading('A LIBRARY OF EXECUTABLE IDEAS', '把每篇文章，留成下一篇的起点。', '已有存稿以只读方式打开，保留原文件与原发布状态。') + `<div class="library-grid">${ui.library.map(article => `<article class="library-card" data-library="${esc(article.folder)}" tabindex="0" role="button"><span class="eyebrow">${esc(article.folder.split('-')[0])} / ARCHIVE</span><h3>${esc(article.title)}</h3><p>查看已有正文 <span>↗</span></p></article>`).join('') || '<div class="empty-state"><h3>还没有找到已有存稿。</h3><p>在「公众号与品牌」配置自己的存稿目录。</p></div>'}</div>`;
  workspace.querySelector('.page-heading').insertAdjacentHTML('beforeend','<button class="button secondary" data-supp-action="import">导入 Markdown 补图 ↗</button>');
}
function changeView(view) {
  if ((ui.dirty || ui.draftDirty || ui.accountDirty) && !confirm('还有未保存修改。确认放弃修改并离开？')) return;
  if(typeof creative!=='undefined')creative.dirty=false;
  if(typeof unmountBrowser==='function')unmountBrowser();
  ui.draftDirty = false; ui.accountDirty = false; ui.currentDraft = null;
  ui.dirty = false; ui.view = view; ui.currentJob = null; ui.series = null; ui.images={};
  workspace.classList.toggle('chat-workspace', view === 'chat');
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelector('#page-name').textContent = { studio: '创作工作台', library: '文章存稿', models: '模型与设置', accounts:'公众号与品牌', drafts:'草稿箱', resources:'配图资源箱', history:'发布记录与历史', backups:'备份与恢复',outlines:'栏目选题大纲' }[view];
  if(view==='chat'){document.querySelector('#page-name').textContent='创作对话';return renderCreativeChat().catch(error=>toast(error.message));}
  if(view==='editorial'){document.querySelector('#page-name').textContent='文章审批';renderEditorialReviews().catch(error=>toast(error.message));return;}
  if(view==='backups'){renderBackups();return;}
  if(view==='browser'){document.querySelector('#page-name').textContent='网页工作台';renderBrowser();return;}
  if(view==='tools'){document.querySelector('#page-name').textContent='规则与工具';renderWorkbench().catch(error=>toast(error.message));return;}
  if (view === 'studio') renderHome(); else if (view === 'models') renderModels(); else if (view === 'accounts') renderAccounts(); else if (view === 'drafts') renderDrafts().catch(error => toast(error.message)); else if (view === 'resources') renderResources().catch(error => toast(error.message)); else if (view === 'history') renderHistory().catch(error => toast(error.message)); else if(view==='outlines')renderOutlines().catch(error=>toast(error.message)); else renderLibrary().catch(error => toast(error.message));
}
async function openJob(jobId) {
  const jobAccount=activeAccount().id;
  if ((ui.dirty || ui.draftDirty || ui.accountDirty) && !confirm('还有未保存修改。确认离开？')) return;
  ui.draftDirty=false;ui.accountDirty=false;
  if(typeof unmountBrowser==='function')unmountBrowser();
  if(ui.currentJob!==jobId)ui.images={};
  ui.currentJob = jobId; ui.dirty = false; ui.after = 0; ui.stream = ''; ui.choice = null; ui.mode = 'preview';
  ui.view = 'studio';
  workspace.classList.remove('chat-workspace');
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'studio'));
  const detail = await api('jobs.get', { job_id: jobId,account_id:jobAccount });
  if (ui.currentJob !== jobId||jobAccount!==activeAccount().id) return;
  ui.detail = detail;
  ui.after = ui.detail.events.at(-1)?.sequence || 0;
  ui.bodyHash = await hashText(ui.detail.body);
  ui.tab = ui.detail.pending_approval ? 'review' : ui.detail.job.current_node === 'verify_code' && ui.detail.job.state === 'awaiting_user' ? 'evidence' : 'article';
  if (ui.currentJob === jobId&&jobAccount===activeAccount().id&&ui.view==='studio') renderDetail();
}
async function hashText(text) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function refresh() {
  const jobAccount=activeAccount().id,jobs=await api('jobs.list',{account_id:jobAccount});
  if(jobAccount!==activeAccount().id)return;
  ui.jobs = jobs; document.querySelector('#job-count').textContent = ui.jobs.length;
  if (ui.currentJob) {
    const activeJob = ui.currentJob;
    const data = await api('jobs.get', { job_id: activeJob, after: ui.after,account_id:jobAccount });
    if (ui.currentJob !== activeJob || ui.view !== 'studio'||jobAccount!==activeAccount().id) return;
    if (data.pending_approval?.approval_id !== ui.detail?.pending_approval?.approval_id) ui.choice = null;
    for (const event of data.events) {
      const payload = JSON.parse(event.payload);
      if (event.event_type === 'step.started' && payload.node === 'draft') ui.stream = '';
      if (event.event_type === 'model.delta' && payload.node === 'draft') ui.stream += payload.content;
    }
    ui.after = data.events.at(-1)?.sequence || ui.after;
    data.events = [...(ui.detail?.events || []), ...data.events].slice(-400);
    const fingerprint = JSON.stringify([data.job.state, data.job.current_node, data.job.pause_reason,data.execution_hash,data.execution?.approved,data.execution?.status,data.runs,data.auto_capture_errors,data.pending_approval?.content_hash, data.article.readiness, data.slots.map(slot => [slot.selected_candidate, slot.valid,slot.prompt]), data.body, data.invocations.length, ui.stream.length]);
    if (!ui.dirty && fingerprint !== ui.fingerprint) { const hash = await hashText(data.body); if (ui.currentJob !== activeJob||jobAccount!==activeAccount().id) return; ui.detail = data; ui.fingerprint = fingerprint; ui.bodyHash = hash; renderDetail(); }
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
    ui.bootstrap = await api('models.save', { provider: card.dataset.provider, model_id: card.querySelector('.model-id-input').value,base_url:card.querySelector('.endpoint-edit')?.value||undefined,service:card.querySelector('.service-edit')?.value||undefined,region:card.querySelector('.region-edit')?.value||undefined, routes, max_model_calls: budget });
  }
  renderModels(); toast('模型设置已保存，新任务将使用这份配置');
}
document.addEventListener('click', async event => {
  const view = event.target.closest('[data-view]'); if (view) { changeView(view.dataset.view); return; }
  const series = event.target.closest('[data-series]'); if (series) { changeView('studio'); ui.series = series.dataset.series; renderHome(); return; }
  const job = event.target.closest('[data-job]'); if (job) { try { await openJob(job.dataset.job); } catch (error) { toast(error.message); } return; }
  const library = event.target.closest('[data-library]'); if (library) { try { const data = await api('library.read', { folder: library.dataset.library }); workspace.innerHTML = `<button class="button text-button" data-action="back-library">← 返回存稿</button>${pageHeading('READ ONLY', esc(library.dataset.library), '已有文章 · 原文件保持只读',`<button class="button secondary" data-supp-action="library" data-folder="${esc(library.dataset.library)}" data-source-hash="${esc(data.source_hash)}">为这篇文章补图 ↗</button>`)}<div class="editor-panel"><div class="markdown-preview">${renderMarkdown(data.body)}</div></div>`; } catch (error) { toast(error.message); } return; }
  const filter = event.target.closest('[data-filter]'); if (filter) { ui.filter = filter.dataset.filter; renderHome(); return; }
  const tab = event.target.closest('[data-tab]'); if (tab) { if (ui.dirty) { toast('请先保存正文修改'); return; } ui.tab = tab.dataset.tab; renderDetail(); return; }
  const mode = event.target.closest('[data-mode]'); if (mode) { if (ui.dirty) { toast('请先保存正文修改'); return; } ui.mode = mode.dataset.mode; renderDetail(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'fill-brief') { await fillBrief(); return; }
  button.disabled = true;
  try {
    if (action === 'new') await newCreativeConversation();
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
    else if (action === 'finalize') { if (ui.dirty) throw new Error('请先保存正文修改'); const result = await api('articles.finalize', { job_id: ui.currentJob,confirm_delivery:ui.detail.article.spec.production_mode==='auto_prepare',delivery_hash:ui.detail.delivery_hash }); toast(ui.detail.supplement?(result.assets_ready?'补图候选已导出，正文仍需人工审核':'补图草稿已导出，仍有图片待准备'):result.readiness === 'ready_for_publish' ? '就绪文章包已导出，请进入发布预览' : '草稿包已导出，仍有检查项或配图待完成'); await refresh(); }
    else if (action === 'open-folder') await window.ice.openFolder(ui.currentJob);
    else if (action === 'open-html') {if(ui.dirty)throw Error('正文尚未保存，请保存并复检后预览');await window.ice.openHTML(ui.currentJob);}
    else if (action === 'import-image') { const result = await window.ice.importImage(ui.currentJob, Number(button.dataset.figure)); if (result) { toast('图片已归档并选用'); await refresh(); } }
    else if (action === 'tapnow') await window.ice.openTapNow();
    else if (action === 'switch-new-ui') { if (ui.dirty) throw new Error('请先保存正文修改，再切换到新工作台'); await window.ice.switchUi('new'); }
    else if (action === 'wechat') openBrowserSite('wechat');
    else if (action === 'capture-window') { const result = await window.ice.captureWindow(); toast('当前窗口截图已保存：' + result.file); }
    else if (action === 'verify-claim') { const claim = ui.detail.claims.find(c => c.claim_id === button.dataset.claim); document.querySelector('#verify-claim').textContent = claim.text; document.querySelector('#verify-form [name="claim_id"]').value = claim.claim_id; document.querySelector('#verify-dialog').showModal(); }
    else if (action === 'approve-execution') { const jobId=ui.currentJob,contentHash=ui.detail.execution_hash,inputs=executionInputsFromPanel(ui.detail);await api('execution.approve', { job_id: jobId, content_hash: contentHash,stdin_by_filename:inputs,expected_failures:executionExpectedFromPanel() });ui.fingerprint='';await refresh(); }
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
  const context_hash=planningState.context.context_hash, plan_id=values.title_mode==='ai'?planningState.proposal?.plan_id:undefined;
  controls.forEach(node=>node.disabled=true);
  try {
    const confirmation=values.production_mode==='auto_prepare'&&values.title_mode==='ai'?{}:await api('planning.confirm',{fields:values,account_id:accountId,context_hash,plan_id,...(typeof outlineConfirmation==='function'?outlineConfirmation():{})});
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && ui.currentJob && ui.mode === 'edit') { event.preventDefault(); if(!ui.detail?.supplement)saveBody().catch(error => toast(error.message)); }
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) newCreativeConversation().catch(error=>toast(error.message));
  if (event.key === 'Enter' && document.activeElement.dataset.job) openJob(document.activeElement.dataset.job).catch(error => toast(error.message));
});
window.__ICE_SMOKE__ = async function () {
  await bootReady;
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
  const realSlot=data.slots.find(slot=>slot.kind==='body_real');
  if(!realSlot)throw Error('没有真实截图图位');
  await openRunCapture(created.job_id,realSlot.figure_no);
  const captureForm=document.querySelector('#run-capture-form');captureForm.requestSubmit(captureForm.querySelector('[type="submit"]'));
  for(let attempt=0;attempt<100&&document.querySelector('#run-capture-dialog').open;attempt++)await new Promise(resolve=>setTimeout(resolve,100));
  if(document.querySelector('#run-capture-dialog').open)throw Error(document.querySelector('#run-capture-status').textContent);
  const captured=await api('jobs.get',{job_id:created.job_id}),capturedSlot=captured.slots.find(slot=>slot.figure_no===realSlot.figure_no);
  base.runCapture={valid:capturedSlot.valid,source:capturedSlot.candidates[0].source,resource:(await api('resources.list')).some(resource=>resource.usage==='screenshot'),file:capturedSlot.candidates[0].file_path};
  base.promptReady=Boolean(promptForSlot(captured,captured.slots.find(slot=>slot.kind==='cover')));
  const copied=await window.ice.copyText(promptForSlot(captured,captured.slots.find(slot=>slot.kind==='cover')));
  base.promptCopied=copied.ok;
  if(!copied.ok){const dialog=showCopyFallback(copied);base.promptCopyFallback=dialog.querySelector('textarea').value===copied.text;dialog.close();}
  base.maintenance=await window.__ICE_MAINTENANCE_SMOKE__();
  changeView('models');
  base.visionPanel=Boolean(document.querySelector('#vision-form'));
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
  if(view==='versions'){await openJob(ui.jobs.find(job=>job.state==='completed').job_id);ui.tab='versions';renderDetail();for(let attempt=0;attempt<100&&!document.querySelector('[data-revision]');attempt++)await new Promise(resolve=>setTimeout(resolve,50));const result=await api('articles.revisions',{job_id:ui.currentJob});const edited=result.revisions.find(row=>row.kind==='manual');if(edited)await showRevision(edited.revision_id);return true;}
  if(view==='backups'){newDialog.close();changeView('backups');return true;}
  if (view === 'models') changeView('models');
  else if (view === 'article'||view === 'assets') { const job = ui.jobs.find(job => job.state === 'completed'); await openJob(job.job_id); ui.tab = view==='assets'?'assets':'article'; renderDetail(); }
  else if (view === 'accounts') changeView('accounts');
  else if (view === 'resources') { changeView('resources'); await renderResources(); if(ui.jobs.length){document.querySelector('#visual-job').value=ui.jobs[0].job_id;await loadVisualPipeline();for(let attempt=0;attempt<100&&document.querySelector('#visual-pipeline')?.dataset.state!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,100));if(document.querySelector('#visual-pipeline')?.dataset.state!=='ready')throw Error('资源箱配图计划未能加载：'+document.querySelector('#visual-pipeline')?.textContent);} }
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
  const resource=visualState.resources[0];openMetadata(resource);
  const form=document.querySelector('#resource-edit-form');form.elements.title.value='蓝色工作台视觉参考';form.elements.description.value='工作台截图，适合界面演示与视觉参考';form.elements.tags.value='工作台, 参考';form.elements.usage.value='reference';form.requestSubmit(form.querySelector('[type="submit"]'));
  for(let attempt=0;attempt<80&&document.querySelector('#visual-edit').open;attempt++)await new Promise(resolve=>setTimeout(resolve,80));
  if(document.querySelector('#visual-edit').open)throw Error('资源说明未能保存');
  await renderResources();
  const search=document.querySelector('#resource-search');search.value='工作台';search.dispatchEvent(new Event('input'));const searchable=!document.querySelector('[data-resource]').hidden;
  search.value='不匹配的标签';search.dispatchEvent(new Event('input'));const filterWorks=document.querySelector('[data-resource]').hidden;
  search.value='';search.dispatchEvent(new Event('input'));
  return {editable:(await api('resources.list'))[0].tags.includes('工作台'),searchable,filterWorks,tapnowEntry:Boolean(document.querySelector('[data-v-action="open-tapnow"]')),cards:document.querySelectorAll('[data-resource]').length,palette:document.querySelectorAll('[data-color]').length,
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
const bootReady=boot();
