'use strict';

// The command palette only searches the current publication's local records.
// Its model stays independent of the DOM so account races can be verified.
(function installNavigation(root) {
  const pages = [
    ['chat', '创作对话', '讨论 选题 写作 生成初稿 编辑助手'],
    ['editorial', '文章审批', '审阅 候选稿 确认 采用'],
    ['studio', '制作任务', '工作流 制作 进度 审核 导出'],
    ['drafts', '草稿箱', '保存 初稿 手动编辑 Markdown'],
    ['resources', '配图资源箱', '图片 素材 生图 提示词 资产'],
    ['browser', '网页工作台', 'TapNow 微信 公众号 发布 浏览器'],
    ['library', '文章存稿', '文章 历史 归档 导入'],
    ['outlines', '栏目选题大纲', '期号 预设标题 选题 排期'],
    ['accounts', '公众号与品牌', '账号 导入 配色 定位 读者'],
    ['models', '模型与预算', 'API Key 连接 预算 调用上限 DeepSeek 通义 Kimi GLM 豆包'],
    ['history', '发布记录与历史', '已发布 期号 标题 历史 导入'],
    ['backups', '备份与恢复', '数据 导出 备份 还原'],
    ['tools', '规则与工具', '工具 扩展 工作流 规则'],
  ].map(([id, title, keywords]) => ({kind: 'page', id, title, meta: '打开页面', keywords}));
  const kinds = {conversation: '会话', draft: '草稿', job: '制作任务', page: '页面'};
  const labels = {completed: '写作完成', running: '进行中', paused: '已暂停', awaiting_approval: '待审核', awaiting_user: '需要处理', failed: '任务中断', unapproved: '初稿 · 未审批', accepted: '已采用'};
  const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  function isVisible(row, accountId) {
    return row && !row.deleted && !row.deleted_at && !row.archived && !row.archived_at && (!row.visibility || row.visibility === 'active') && (!row.account_id || row.account_id === accountId);
  }
  function records({conversations = [], drafts = [], jobs = []}, accountId) {
    const rows = [
      ...conversations.filter(row => isVisible(row, accountId)).map(row => ({kind: 'conversation', id: String(row.id), title: row.title || '未命名会话', meta: [row.series, '继续对话'].filter(Boolean).join(' · '), keywords: '会话 对话', updated: row.updated_at || ''})),
      ...drafts.filter(row => isVisible(row, accountId)).map(row => ({kind: 'draft', id: String(row.draft_id), title: row.title || '未命名草稿', meta: [row.series, labels[row.status] || '已保存草稿'].filter(Boolean).join(' · '), keywords: '草稿 初稿 编辑', updated: row.updated_at || ''})),
      ...jobs.filter(row => isVisible(row, accountId)).map(row => ({kind: 'job', id: String(row.job_id), title: row.final_title || row.topic || '未命名制作任务', meta: [row.series && `${row.series}${row.episode ? ` / ${String(row.episode).padStart(3, '0')}` : ''}`, labels[row.state] || row.state].filter(Boolean).join(' · '), keywords: '任务 工作流 制作', updated: row.updated_at || ''})),
    ].filter(row => row.id && row.id !== 'undefined');
    // Same titles belong to different records; only duplicate identities collapse.
    return [...new Map(rows.map(row => [`${row.kind}:${row.id}`, row])).values()].sort((a, b) => b.updated.localeCompare(a.updated));
  }
  function search(rows, query, limit = 60) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const matches = [...rows, ...pages].map((row, index) => {
      const title = normalize(row.title), text = normalize(`${row.title} ${row.meta} ${row.keywords || ''} ${kinds[row.kind]} ${row.id}`);
      if (!terms.every(term => text.includes(term))) return null;
      const score = terms.length ? terms.reduce((sum, term) => sum + (title.startsWith(term) ? 8 : title.includes(term) ? 4 : 1), 0) : 0;
      return {row, index, score};
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index);
    return {items: matches.slice(0, limit).map(match => match.row), total: matches.length};
  }
  class LocalSearch {
    constructor(request, getAccount) { this.request = request; this.getAccount = getAccount; this.token = 0; this.rows = []; this.accountId = ''; }
    invalidate() { ++this.token; this.rows = []; this.accountId = ''; }
    async load() {
      const account = this.getAccount(), token = ++this.token;
      this.rows = []; this.accountId = account.id;
      const methods = ['chat.list', 'chat.drafts', 'jobs.list'];
      const results = await Promise.allSettled(methods.map(method => this.request(method, {account_id: account.id, ...(method === 'chat.list' ? {archived: false, deleted: false} : method === 'jobs.list' ? {visibility: 'active'} : {})})));
      if (token !== this.token || account.id !== this.getAccount().id) return {stale: true};
      const valid = result => result.status === 'fulfilled' && Array.isArray(result.value);
      this.rows = records({conversations: valid(results[0]) ? results[0].value : [], drafts: valid(results[1]) ? results[1].value : [], jobs: valid(results[2]) ? results[2].value : []}, account.id);
      return {stale: false, rows: this.rows, errors: results.flatMap((result, index) => !valid(result) ? [kinds[['conversation', 'draft', 'job'][index]]] : [])};
    }
  }
  class NavigationGate {
    constructor() { this.busy = false; this.pendingAccount = ''; }
    begin() { this.busy = true; }
    requestOpen(accountId) { if (!this.busy) return true; this.pendingAccount = accountId; return false; }
    cancelOpen() { this.pendingAccount = ''; }
    finish(accountId) { const reopen = Boolean(this.pendingAccount) && this.pendingAccount === accountId; this.busy = false; this.pendingAccount = ''; return reopen; }
  }
  const exported = {pages, records, search, LocalSearch, NavigationGate};
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (!root.document) return;

  const document = root.document;
  const account = () => { try { return (typeof activeAccount === 'function' && activeAccount()) || {id: '', name: ''}; } catch (_error) { return {id: '', name: ''}; } };
  const model = new LocalSearch((method, params) => api(method, params), account);
  const gate = new NavigationGate();
  let dialog, input, list, status, selected = 0, matches = [], previousFocus, loading = false, errors = [], selectionMoved = false, pendingWaiters = [];
  function current() { return dialog?.open && model.accountId === account().id; }
  function clearSearch() { model.invalidate(); loading = false; matches = []; list?.replaceChildren(); }
  function close() {
    gate.cancelOpen(); pendingWaiters.splice(0).forEach(waiter => waiter.resolve(false));
    if (dialog?.open) dialog.close();
    // close events are queued by Chromium. Clear immediately so an older load
    // cannot finish between close() and the browser's eventual close event.
    clearSearch();
  }
  function paint() {
    if (!current()) { close(); return; }
    const result = search(model.rows, input.value), previous = selectionMoved && matches[selected];
    matches = result.items;
    const remembered = previous ? matches.findIndex(row => row.kind === previous.kind && row.id === previous.id) : -1;
    selected = remembered >= 0 ? remembered : Math.min(Math.max(selected, 0), Math.max(matches.length - 1, 0));
    list.innerHTML = matches.map((row, index) => `<button type="button" tabindex="-1" class="command-result ${index === selected ? 'selected' : ''}" id="command-result-${index}" role="option" aria-selected="${index === selected}" data-command-result="${index}"><span class="command-kind" aria-hidden="true">${row.kind === 'conversation' ? '对话' : row.kind === 'draft' ? '草稿' : row.kind === 'job' ? '任务' : '页面'}</span><span class="command-result-content"><strong>${html(row.title)}</strong><small>${html(row.meta)}</small></span><span class="command-result-arrow" aria-hidden="true">↵</span></button>`).join('') || '<div class="command-empty"><strong>没有找到匹配内容</strong><p>试试标题中的关键词、栏目代码或“草稿”“任务”。</p></div>';
    list.setAttribute('aria-busy', String(loading));
    input.setAttribute('aria-activedescendant', matches.length ? `command-result-${selected}` : '');
    status.textContent = loading ? '正在读取本地会话、草稿与制作任务…' : errors.length ? `${errors.join('、')}未能读取。其他结果仍可使用，关闭后重新搜索可重试。` : result.total > matches.length ? `找到 ${result.total} 项，显示前 ${matches.length} 项。输入更多关键词缩小范围。` : `${result.total} 项结果 · 仅搜索当前公众号`;
  }
  function select(index) {
    if (!matches.length) return;
    selectionMoved = true;
    selected = (index + matches.length) % matches.length;
    list.querySelectorAll('[data-command-result]').forEach((node, item) => { node.classList.toggle('selected', item === selected); node.setAttribute('aria-selected', String(item === selected)); });
    input.setAttribute('aria-activedescendant', `command-result-${selected}`);
    document.querySelector(`#command-result-${selected}`)?.scrollIntoView({block: 'nearest'});
  }
  async function activate(index) {
    if (!current() || gate.busy) return;
    const row = matches[index], aid = account().id;
    if (!row) return;
    // These existing actions handle unsaved article text themselves. Draft and
    // brand forms additionally stay protected before entering a task.
    if (row.kind === 'job' && (ui.draftDirty || ui.accountDirty)) { toast('请先保存当前修改，再打开制作任务'); return; }
    if (row.kind === 'draft' && ui.accountDirty) { toast('请先保存公众号配置，再打开草稿'); return; }
    gate.begin(); input.disabled = true;
    try {
      if (aid !== account().id) return;
      close();
      if (row.kind === 'conversation') await openCreativeConversation(row.id);
      else if (row.kind === 'draft') await startCreativeFrom({type: 'draft', id: row.id});
      else if (row.kind === 'job') await openJob(row.id);
      else await changeView(row.id);
    } catch (error) { if (aid === account().id) toast(error.message); }
    finally {
      const reopen = gate.finish(account().id), waiters = pendingWaiters.splice(0);
      if (input) input.disabled = false;
      // A quick second Ctrl K is retained while the target page finishes
      // rendering, rather than being silently discarded during navigation.
      if (reopen) {
        let opened = false;
        try { opened = await open(); } finally { waiters.forEach(waiter => waiter.resolve(Boolean(opened && waiter.accountId === account().id))); }
      } else waiters.forEach(waiter => waiter.resolve(false));
    }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'command-palette'; dialog.className = 'command-palette';
    dialog.setAttribute('aria-labelledby', 'command-title');
    dialog.innerHTML = '<header class="command-head"><div><h2 id="command-title">找到内容，继续创作</h2><p id="command-account"></p></div><button type="button" class="command-close" aria-label="关闭快捷搜索">×</button></header><div class="command-input-row"><span aria-hidden="true">⌕</span><input id="command-input" type="search" maxlength="200" placeholder="搜索会话、草稿、任务或页面…" aria-label="搜索当前公众号的内容" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="command-results" autocomplete="off"><kbd>Esc</kbd></div><p id="command-status" class="command-status" role="status" aria-live="polite"></p><div id="command-results" class="command-results" role="listbox" aria-label="快捷搜索结果"></div><footer class="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span>本地内容 · 不调用 AI</span></footer>';
    document.body.append(dialog);
    input = dialog.querySelector('#command-input'); list = dialog.querySelector('#command-results'); status = dialog.querySelector('#command-status');
    dialog.querySelector('.command-close').addEventListener('click', close);
    input.addEventListener('input', () => { selected = 0; selectionMoved = false; paint(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); select(selected + (event.key === 'ArrowDown' ? 1 : -1)); }
      else if (event.key === 'Enter') { event.preventDefault(); activate(selected); }
    });
    list.addEventListener('click', event => { const button = event.target.closest('[data-command-result]'); if (button) activate(Number(button.dataset.commandResult)); });
    dialog.addEventListener('close', () => {
      // A close event from the previous opening can arrive after showModal().
      // It must not erase the newly opened palette or move its focus away.
      if (dialog.open) return;
      clearSearch();
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  }
  async function open() {
    const aid = account().id;
    if (!aid) return false;
    if (!gate.requestOpen(aid)) return new Promise(resolve => pendingWaiters.push({accountId: aid, resolve}));
    // Another confirmation or editor dialog retains its focus and decision.
    if (document.querySelector('dialog[open]:not(#command-palette)')) return false;
    ensureDialog();
    if (dialog.open) { input.focus(); return true; }
    previousFocus = document.activeElement; selected = 0; selectionMoved = false; errors = []; loading = true; input.value = ''; input.disabled = false;
    model.accountId = account().id; model.rows = [];
    dialog.querySelector('#command-account').textContent = account().name;
    dialog.showModal(); paint(); input.focus(); root.iceMotion?.enter?.(dialog);
    const result = await model.load();
    if (result.stale || !current()) { if (dialog.open && model.accountId !== account().id) close(); return false; }
    errors = result.errors; loading = false; paint();
    return true;
  }
  function paintSidebar() {
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    document.querySelectorAll('[data-sidebar-toggle]').forEach(button => { button.setAttribute('aria-expanded', String(!collapsed)); button.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏'); button.title = collapsed ? '展开侧栏' : '收起侧栏'; });
  }
  function toggleSidebar() {
    document.body.classList.toggle('sidebar-collapsed');
    try { root.localStorage.setItem('ice-sidebar-collapsed', String(document.body.classList.contains('sidebar-collapsed'))); } catch (_error) { /* Preferences never block navigation. */ }
    paintSidebar();
    // The embedded browser follows the new content bounds through its observer.
    root.dispatchEvent(new Event('resize'));
  }
  try { document.body.classList.toggle('sidebar-collapsed', root.localStorage.getItem('ice-sidebar-collapsed') === 'true'); } catch (_error) { /* Default to expanded. */ }
  paintSidebar();
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing) { event.preventDefault(); dialog?.open || gate.pendingAccount ? close() : open(); } });
  document.addEventListener('click', event => { if (event.target.closest('[data-command-open]')) open(); if (event.target.closest('[data-sidebar-toggle]')) toggleSidebar(); });
  document.querySelector('#account-switch')?.addEventListener('change', close);
  const accountSelect = document.querySelector('#account-switch');
  if (accountSelect && typeof MutationObserver !== 'undefined') new MutationObserver(() => { if (dialog?.open && model.accountId !== account().id) close(); }).observe(accountSelect, {childList: true, subtree: true});
  root.iceNavigation = {open, close, toggleSidebar, get busy() { return gate.busy; }, ...exported};
  root.ice?.onCommandPalette?.(open);
})(typeof window === 'undefined' ? globalThis : window);
