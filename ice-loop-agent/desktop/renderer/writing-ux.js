'use strict';
(function (root) {
  const STORAGE_KEY = 'ice-writing-input-v1';
  const INPUT_LIMIT = 12000;
  const DRAFT_LIMIT = 30;
  const DRAFT_TTL = 30 * 24 * 60 * 60 * 1000;
  const keyFor = (accountId, conversationId) => JSON.stringify([String(accountId || ''), String(conversationId || '__new__')]);
  const normalize = text => String(text || '').trim();

  // Keep only unsent message text. Do not copy model settings, referenced
  // documents or saved articles from their source stores into this ledger.
  // The existing article save APIs own article drafts.
  function createInputStore(storage, now = () => Date.now()) {
    let rows = [], persistent = true;
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (saved?.version === 1 && Array.isArray(saved.drafts)) rows = saved.drafts;
    } catch (_) { persistent = false; }
    const clean = () => {
      const byKey = new Map();
      for (const row of rows) {
        if (!row || typeof row.accountId !== 'string' || !row.accountId || row.accountId.length > 240 ||
            typeof row.conversationId !== 'string' || row.conversationId.length > 240 || typeof row.text !== 'string' ||
            !Number.isFinite(row.updatedAt) || row.updatedAt < now() - DRAFT_TTL || row.updatedAt > now() + 60000 || !row.text) continue;
        const item = {accountId: row.accountId, conversationId: row.conversationId, text: row.text.slice(0, INPUT_LIMIT), updatedAt: row.updatedAt};
        const key = keyFor(item.accountId, item.conversationId), old = byKey.get(key);
        if (!old || old.updatedAt <= item.updatedAt) byKey.set(key, item);
      }
      rows = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DRAFT_LIMIT);
    };
    const write = () => {
      clean();
      try { storage.setItem(STORAGE_KEY, JSON.stringify({version: 1, drafts: rows})); persistent = true; }
      catch (_) { persistent = false; }
      return persistent;
    };
    clean();
    return {
      get(accountId, conversationId) { clean(); return rows.find(row => keyFor(row.accountId, row.conversationId) === keyFor(accountId, conversationId))?.text || ''; },
      set(accountId, conversationId, text) {
        if (!accountId || String(accountId).length > 240 || String(conversationId || '__new__').length > 240) return false;
        const key = keyFor(accountId, conversationId);
        rows = rows.filter(row => keyFor(row.accountId, row.conversationId) !== key);
        const value = String(text || '').slice(0, INPUT_LIMIT);
        if (value) rows.unshift({accountId: String(accountId), conversationId: String(conversationId || '__new__'), text: value, updatedAt: now()});
        return write();
      },
      clearSubmitted(accountId, conversationId, text) {
        const key = keyFor(accountId, conversationId);
        const found = rows.find(row => keyFor(row.accountId, row.conversationId) === key);
        if (!found || normalize(found.text) !== normalize(text)) return false;
        rows = rows.filter(row => keyFor(row.accountId, row.conversationId) !== key);
        write(); return true;
      },
      persistent: () => persistent,
      count: () => { clean(); return rows.length; }
    };
  }
  function articleMetrics(body) {
    const text = String(body || '');
    return {characters: [...text.replace(/\s/g, '')].length, paragraphs: text.trim() ? text.trim().split(/\n\s*\n/).length : 0};
  }
  function submittedInput(current, sent) {
    return normalize(current) === normalize(sent) ? '' : current;
  }
  function contextMatches(context, accountId, conversationId) {
    return Boolean(context && context.accountId && accountId && context.accountId === String(accountId) && context.conversationId === String(conversationId || '__new__'));
  }
  const helpers = {createInputStore, articleMetrics, submittedInput, contextMatches, keyFor, STORAGE_KEY, INPUT_LIMIT, DRAFT_LIMIT, DRAFT_TTL};
  if (typeof module !== 'undefined' && module.exports) { module.exports = helpers; return; }
  if (!root.document) return;

  let storage;
  try { storage = root.localStorage; } catch (_) { storage = {getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); }}; }
  const inputStore = createInputStore(storage);
  let mounted = null, saveTimer = null, enhancementFrame = null, scrollRevision = 0;
  const currentAccount = () => typeof activeAccount === 'function' ? activeAccount()?.id || '' : '';
  const readonly = () => Boolean(creative.data?.conversation.archived || creative.data?.conversation.deleted);
  const sameContext = context => contextMatches(context, currentAccount(), creative.id);
  const canEditMounted = input => Boolean(sameContext(mounted) && mounted.input === input && input === document.querySelector('#chat-input') && input?.isConnected && !input.disabled && ui.view === 'chat' && !readonly());
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };

  function updateInputStatus(restored = false) {
    if (!mounted?.input.isConnected || !sameContext(mounted)) return;
    const host = mounted.input.closest('#chat-composer');
    let status = host?.querySelector('.writing-input-status');
    if (!status) {
      status = document.createElement('div'); status.className = 'writing-input-status';
      status.innerHTML = '<span class="writing-input-memory"></span><span class="writing-input-count"></span>';
      host?.append(status);
    }
    if (!status) return;
    const text = mounted.input.value;
    setText(status.querySelector('.writing-input-memory'), readonly() ? '恢复会话后可继续编辑' : restored ? '已恢复未发送输入 · 仅在本机保留' : inputStore.persistent() ? '未发送输入自动保留在本机' : '输入暂存在当前窗口');
    setText(status.querySelector('.writing-input-count'), `${text.length.toLocaleString()} / ${INPUT_LIMIT.toLocaleString()}`);
    status.classList.toggle('near-limit', text.length > INPUT_LIMIT * .9);
  }
  function persistMounted() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!mounted) return;
    // A detached textarea still belongs to its original account and conversation.
    // Never use the currently selected account to label text during navigation.
    // Navigation temporarily disables the old composer before rendering the
    // next conversation. Its text still needs saving under the mounted key.
    if (!mounted.readonly) inputStore.set(mounted.accountId, mounted.conversationId, mounted.input.value);
    updateInputStatus();
  }
  function schedulePersist(event) {
    if (!canEditMounted(event?.target || mounted?.input)) return;
    clearTimeout(saveTimer); saveTimer = setTimeout(persistMounted, 240);
    updateInputStatus();
  }
  function mountComposer() {
    const input = document.querySelector('#chat-input');
    if (input === mounted?.input) { if (sameContext(mounted)) { mounted.readonly = readonly(); updateInputStatus(); } return; }
    persistMounted();
    if (!input || ui.view !== 'chat') { mounted = null; return; }
    mounted = {input, accountId: currentAccount(), conversationId: String(creative.id || '__new__'), readonly: readonly()};
    const saved = inputStore.get(mounted.accountId, mounted.conversationId);
    let restored = false;
    if (!mounted.readonly && !input.value && saved) { input.value = saved; creative.text = saved; restored = true; }
    if (!mounted.readonly && input.value) inputStore.set(mounted.accountId, mounted.conversationId, input.value);
    // This capture listener runs before creative-chat's target bubble listener.
    // A stale composer cannot assign account A's text to account B's state.
    input.addEventListener('input', event => { if (!canEditMounted(input)) event.stopImmediatePropagation(); }, {capture: true});
    input.addEventListener('input', schedulePersist);
    updateInputStatus(restored);
    addInputTemplates();
    mountLatestButton();
  }
  function submitted({accountId, conversationId, text}) {
    const context = {accountId, conversationId: String(conversationId || '__new__')};
    // Flush before comparing: a new sentence typed while chat.send is awaiting
    // must survive even when its debounce has not reached localStorage yet.
    if (mounted && keyFor(mounted.accountId, mounted.conversationId) === keyFor(accountId, conversationId)) {
      persistMounted();
      if (normalize(mounted.input.value) !== normalize(text)) {
        inputStore.set(accountId, conversationId, mounted.input.value);
        return false;
      }
    }
    const cleared = inputStore.clearSubmitted(accountId, conversationId, text);
    if (sameContext(context)) queueMicrotask(updateInputStatus);
    return cleared;
  }
  const templates = [
    {label: '讨论选题', mode: 'discuss', text: '结合本栏目前五篇正文、全部历史标题和大纲，提出下一期选题。说明承接关系、读者收益和需要我确认的地方。'},
    {label: '检查论据', mode: 'discuss', text: '检查这篇文章的关键论据，区分已有依据和仍需核验的事实。缺少资料时请问我，不要补造来源。'},
    {label: '精简文章', mode: 'edit', text: '精简重复表达，保留关键论据、可运行示例和公众号语气。先说明你建议删改的范围。'},
    {label: '规划配图', mode: 'images', text: '根据正文和公众号视觉风格规划配图，区分可截图内容与需要生图的内容，并准备可修改的 TapNow 提示词。'}
  ];
  function addInputTemplates() {
    const composer = document.querySelector('#chat-composer');
    if (!composer || composer.querySelector('.writing-templates')) return;
    const details = document.createElement('details'); details.className = 'writing-templates';
    details.innerHTML = '<summary>写作快捷指令 <span>补到输入框，发送前可修改</span></summary><div></div>';
    const row = details.querySelector('div');
    templates.forEach((template, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.writingTemplate = String(index);
      button.textContent = template.label; row.append(button);
    });
    composer.insertBefore(details, composer.firstChild);
  }
  function paintReferenceRemoval() {
    for (const chip of document.querySelectorAll('#chat-context [data-writing-reference]')) {
      const existing = chip.querySelector('[data-writing-remove-reference]');
      if (existing) { existing.disabled = !canEditMounted(document.querySelector('#chat-input')); continue; }
      const id = chip.dataset.writingReference, title = chip.textContent;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'writing-chip-remove';
      button.dataset.writingRemoveReference = id; button.textContent = '×';
      button.title = `取消引用：${title}`; button.setAttribute('aria-label', button.title); button.disabled = !canEditMounted(document.querySelector('#chat-input'));
      chip.classList.add('writing-reference-chip'); chip.append(button);
    }
    const context = document.querySelector('#chat-context');
    if (creative.selectedText && context && !context.querySelector('[data-writing-remove-selection]')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'context-pill writing-selection-chip';
      button.dataset.writingRemoveSelection = ''; button.textContent = '取消选中文段 ×'; button.disabled = !canEditMounted(document.querySelector('#chat-input')); context.append(button);
    }
  }
  function paintArticleStatus() {
    const pane = document.querySelector('.article-pane'); if (!pane || ui.view !== 'chat') return;
    let bar = pane.querySelector('.writing-reading-bar');
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'writing-reading-bar';
      bar.innerHTML = '<div><strong class="writing-article-state"></strong><span class="writing-article-metrics"></span></div><button type="button" data-writing-focus>专注阅读</button><p class="writing-article-next"></p>';
      pane.prepend(bar);
    }
    const candidate = chatCandidate(), editor = document.querySelector('#candidate-editor [name="body"]');
    const body = editor?.value ?? (candidate?.status === 'accepted' ? candidate.review?.body || candidate.body : candidate?.body) ?? creative.data?.current?.body ?? '';
    const metrics = articleMetrics(body);
    let state = '文章工作区', next = '在对话中生成初稿，完成后预览、保存并审批。';
    if (editor) { state = creative.dirty ? '手动修改 · 未保存' : '手动编辑'; next = '保存新版本后，再将候选稿同步到文章审批。'; }
    else if (candidate?.status === 'accepted') { state = '已采用的正文'; next = '继续修改可生成新候选，或到草稿箱准备配图与发布包。'; }
    else if (candidate?.status === 'pending') { state = '等待文章审批'; next = '在文章审批中检查全文，采用后才会更新保存的正文。'; }
    else if (candidate?.status === 'draft') { state = candidate.saved_draft ? '初稿已保存 · 尚未审批' : '候选初稿 · 尚未保存'; next = candidate.saved_draft ? '可继续修改；准备好后同步至文章审批。' : '预览全文后，在下方选择保存初稿或暂不保存。'; }
    else if (body) { state = '当前已保存正文'; next = '选中文段可让助手定点修改；历史版本保留在上方菜单。'; }
    else if (creative.data?.messages.some(message => message.status === 'streaming')) { state = '初稿正在准备'; next = '左侧显示实际进度，完成校验后文章会在这里展开。'; }
    setText(bar.querySelector('.writing-article-state'), state);
    setText(bar.querySelector('.writing-article-metrics'), body ? `${metrics.characters.toLocaleString()} 字符 · ${metrics.paragraphs.toLocaleString()} 段` : '');
    setText(bar.querySelector('.writing-article-next'), next);
    bar.classList.toggle('is-unsaved', Boolean(creative.dirty));
    const focused = document.querySelector('.creative-shell')?.classList.contains('writing-focus-article');
    setText(bar.querySelector('[data-writing-focus]'), focused ? '退出专注' : '专注阅读');
    const toolbar = document.querySelector('.creative-toolbar .button-row');
    if (toolbar && !toolbar.querySelector('[data-writing-focus-exit]')) {
      const exit = document.createElement('button'); exit.type = 'button'; exit.dataset.writingFocusExit = '';
      exit.className = 'button secondary small writing-focus-exit'; exit.textContent = '返回对话 · Esc'; toolbar.prepend(exit);
    }
    for (const button of document.querySelectorAll('[data-writing-template],[data-writing-remove-selection]')) button.disabled = !canEditMounted(document.querySelector('#chat-input'));
  }
  function mountLatestButton() {
    const scroller = document.querySelector('#chat-messages'); if (!scroller || scroller.dataset.writingMounted) return;
    scroller.dataset.writingMounted = 'true';
    const wrap = document.createElement('div'); wrap.className = 'writing-latest-wrap'; wrap.hidden = true;
    wrap.innerHTML = '<button type="button" data-writing-latest aria-label="回到最新消息">回到最新消息 ↓</button>';
    scroller.after(wrap);
    scroller.addEventListener('scroll', () => updateLatestButton(scroller), {passive: true});
    updateLatestButton(scroller);
  }
  function updateLatestButton(scroller, updated = false) {
    if (!scroller?.isConnected) return;
    const wrap = scroller.parentNode.querySelector('.writing-latest-wrap'); if (!wrap) return;
    const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 90;
    if (wrap.hidden === away) wrap.hidden = !away;
    if (!away) scroller.dataset.writingUnread = '';
    else if (updated) scroller.dataset.writingUnread = 'true';
    setText(wrap.querySelector('button'), scroller.dataset.writingUnread ? '有新内容 · 回到最新 ↓' : '回到最新消息 ↓');
  }
  function enhanceWriting() { mountComposer(); paintReferenceRemoval(); paintArticleStatus(); }
  function scheduleEnhance() {
    if (enhancementFrame !== null) return;
    enhancementFrame = requestAnimationFrame(() => { enhancementFrame = null; enhanceWriting(); });
  }
  const baseRender = renderCreativeChat;
  renderCreativeChat = async function (...args) { persistMounted(); const result = await baseRender(...args); if (ui.view === 'chat') enhanceWriting(); return result; };
  const baseMessages = paintCreativeMessages;
  paintCreativeMessages = function (...args) {
    const scroller = document.querySelector('#chat-messages'), top = scroller?.scrollTop || 0;
    const preserve = scroller && scroller.scrollHeight - top - scroller.clientHeight >= 90;
    const oldContent = scroller?.textContent, revision = ++scrollRevision;
    const result = baseMessages(...args);
    if (scroller?.isConnected) {
      if (preserve) scroller.scrollTop = top;
      mountLatestButton(); updateLatestButton(scroller, oldContent !== scroller.textContent);
      if (preserve) requestAnimationFrame(() => {
        // A click on “latest” or a user scroll between paint and the next frame
        // wins over preserving the previous location.
        if (revision === scrollRevision && scroller.isConnected && Math.abs(scroller.scrollTop - top) < 2) { scroller.scrollTop = top; updateLatestButton(scroller); }
      });
    }
    paintReferenceRemoval(); paintArticleStatus(); return result;
  };
  const basePreview = paintCreativePreview;
  paintCreativePreview = function (...args) { const result = basePreview(...args); paintArticleStatus(); return result; };
  const baseEditor = editCreativeCandidate;
  editCreativeCandidate = function (...args) { const result = baseEditor(...args); paintArticleStatus(); return result; };
  const observer = new MutationObserver(scheduleEnhance); observer.observe(workspace, {childList: true, subtree: true});
  document.addEventListener('input', event => { if (event.target.closest('#candidate-editor')) paintArticleStatus(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-writing-template],[data-writing-remove-reference],[data-writing-remove-selection],[data-writing-focus],[data-writing-focus-exit],[data-writing-latest]');
    if (!button) { if (event.target.closest('[data-chat-seed],[data-chat-action="rebase"],[data-chat-action="retry"],[data-chat-action="selection"]')) queueMicrotask(() => { persistMounted(); updateInputStatus(); }); return; }
    if (button.disabled) return;
    event.preventDefault();
    if (button.hasAttribute('data-writing-template')) {
      const template = templates[Number(button.dataset.writingTemplate)], input = document.querySelector('#chat-input');
      if (!template || !canEditMounted(input)) return;
      const value = input.value.trim() ? `${input.value.trimEnd()}\n\n${template.text}` : template.text;
      if (value.length > INPUT_LIMIT) { toast('输入已接近长度限制，先精简内容再添加快捷指令'); return; }
      creative.retryMessage = null; creative.text = value; creative.mode = template.mode; input.value = value;
      document.querySelector('#chat-mode').value = template.mode; paintComposerMode();
      input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); input.setSelectionRange(value.length, value.length);
      button.closest('details').open = false; persistMounted();
    } else if (button.hasAttribute('data-writing-remove-reference')) {
      if (!canEditMounted(document.querySelector('#chat-input'))) return; creative.refs = creative.refs.filter(id => id !== button.dataset.writingRemoveReference); paintCreativeMessages();
    } else if (button.hasAttribute('data-writing-remove-selection')) {
      if (!canEditMounted(document.querySelector('#chat-input'))) return; creative.selectedText = ''; window.getSelection()?.removeAllRanges(); paintCreativeMessages();
    } else if (button.hasAttribute('data-writing-latest')) {
      const scroller = document.querySelector('#chat-messages'); if (!scroller) return;
      ++scrollRevision;
      scroller.dataset.writingUnread = '';
      const reduced = window.iceMotion?.reduced?.() || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
      scroller.scrollTo({top: scroller.scrollHeight, behavior: reduced ? 'auto' : 'smooth'});
    } else {
      const shell = document.querySelector('.creative-shell'); shell?.classList.toggle('writing-focus-article');
      document.querySelector('#creative-tabs')?.show('article'); creative.tab = 'article'; paintArticleStatus();
      if (shell?.classList.contains('writing-focus-article')) window.iceMotion?.enter?.(document.querySelector('.article-pane'));
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    const shell = document.querySelector('.creative-shell.writing-focus-article'); if (!shell) return;
    shell.classList.remove('writing-focus-article'); paintArticleStatus(); event.preventDefault();
  });
  window.addEventListener('beforeunload', persistMounted);
  window.iceWriting = {...helpers, submitted, persist: persistMounted, enhance: enhanceWriting};
  scheduleEnhance();
})(globalThis);
