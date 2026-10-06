'use strict';
// Native Electron smoke helper. The caller must provide an isolated test app and
// a visible creative chat with no active generation; it does not send a model request.
module.exports = async function runWritingUxChecks(evaluate) {
  return evaluate(`(async () => {
    if (!window.iceWriting || !document.querySelector('#chat-input')) throw Error('Writing UX was not loaded');
    if (creative.data?.messages.some(m => m.status === 'streaming')) throw Error('Wait for generation before checking Writing UX');
    const check = (condition, label) => { if (!condition) throw Error('Writing UX: ' + label); };
    const initial = {text:document.querySelector('#chat-input').value, mode:creative.mode, refs:[...creative.refs], selectedText:creative.selectedText, data:creative.data, motion:document.documentElement.dataset.motion};
    const result = {};
    try {
      const marker = '待发送测试：请保留我正在输入的内容';
      let input = document.querySelector('#chat-input');
      input.value = marker; input.dispatchEvent(new Event('input',{bubbles:true})); window.iceWriting.persist();
      await renderCreativeChat();
      input = document.querySelector('#chat-input');
      check(input.value === marker, 'restores text after composer remount'); result.inputRecovery = true;
      const context = {accountId:activeAccount().id, conversationId:creative.id};
      input.value = marker + '，这是新的补充'; input.dispatchEvent(new Event('input',{bubbles:true}));
      check(window.iceWriting.submitted({...context,text:marker}) === false, 'late acknowledgement preserves new typing');
      check(window.iceWriting.createInputStore(localStorage).get(context.accountId, context.conversationId) === input.value, 'preserved typing reaches local storage'); result.concurrentInputPreserved = true;
      check(window.iceWriting.submitted({...context,text:input.value}) === true, 'matched submitted input is cleared');
      check(window.iceWriting.createInputStore(localStorage).get(context.accountId,context.conversationId) === '', 'submitted message has no recovery record'); result.submittedInputCleared = true;
      input.value = '我的原始观点'; input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-writing-template="0"]').click();
      check(input.value.startsWith('我的原始观点') && input.value.includes('前五篇正文'), 'template appends without replacing ideas');
      check(creative.text === input.value, 'template updates composer state'); result.templatePreservesInput = true;
      const reference = 'writing-ui-test-reference'; creative.refs = [...initial.refs, reference]; paintCreativeMessages();
      const remove = document.querySelector('[data-writing-remove-reference="' + reference + '"]');
      check(remove, 'reference has an explicit removal control'); remove.click();
      check(!creative.refs.includes(reference), 'reference can be removed without reopening picker'); result.referenceRemoval = true;
      const messages = creative.data.messages;
      const historyMessage = {id:'writing-ui-test-long-message',role:'user',status:'completed',content:Array.from({length:90},(_,i)=>'历史阅读位置测试 ' + i).join('\\n\\n'),metadata:{mode:'discuss'}};
      creative.data.messages = [...messages,historyMessage];
      paintCreativeMessages(); const scroller = document.querySelector('#chat-messages');
      check(scroller.scrollHeight > scroller.clientHeight + 100, 'history has a real scroll range');
      const readingNode = scroller.querySelector('[data-message-id="writing-ui-test-long-message"]');
      const readingBody = readingNode.querySelector('.chat-message-body');
      const readingParagraph = readingBody.querySelector('p'), readingText = readingParagraph?.firstChild;
      const readingDetails = readingNode.querySelector('.chat-message-more');
      check(readingText?.nodeType === Node.TEXT_NODE && readingText.textContent.length > 5 && readingDetails, 'completed history exposes selectable text and details');
      readingDetails.open = true;
      const selection = window.getSelection(), range = document.createRange();
      range.setStart(readingText, 1); range.setEnd(readingText, Math.min(readingText.textContent.length, 9));
      selection.removeAllRanges(); selection.addRange(range);
      const selectedWords = selection.toString(); check(selectedWords.length > 0, 'history text has a real Range selection');
      const streamingMessage = {id:'writing-ui-test-streaming-message',role:'assistant',status:'streaming',content:'这条新回复正在接收。',metadata:{mode:'discuss'}};
      creative.data.messages = [...messages,historyMessage,streamingMessage]; paintCreativeMessages();
      streamingMessage.content += '现在接收了更多文字。'; paintCreativeMessages();
      check(scroller.querySelector('[data-message-id="writing-ui-test-long-message"]') === readingNode && readingNode.querySelector('.chat-message-body') === readingBody && readingBody.querySelector('p') === readingParagraph && readingParagraph.firstChild === readingText, 'unchanged history keeps article, paragraph and text-node identity');
      check(readingNode.querySelector('.chat-message-more') === readingDetails && readingDetails.open, 'history details stay expanded during another reply');
      check(selection.toString() === selectedWords && selection.rangeCount === 1 && selection.getRangeAt(0).startContainer === readingText && selection.getRangeAt(0).endContainer === readingText, 'history Range selection survives another reply repaint');
      result.messageReadingStatePreserved = true;
      selection.removeAllRanges(); creative.data.messages = [...messages,historyMessage]; paintCreativeMessages();
      scroller.scrollTop = 70; paintCreativeMessages();
      check(Math.abs(scroller.scrollTop - 70) < 2, 'stream repaint preserves history reading position');
      check(!document.querySelector('.writing-latest-wrap').hidden, 'return-to-latest appears while reading history'); result.historyReadingPreserved = true;
      document.documentElement.dataset.motion = 'off'; document.querySelector('[data-writing-latest]').click();
      check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 3, 'return-to-latest reaches bottom'); result.returnToLatest = true;
      creative.data.messages = messages; paintCreativeMessages();
      document.querySelector('[data-writing-focus]').click();
      check(document.querySelector('.creative-shell').classList.contains('writing-focus-article'), 'focus mode opens');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const articleWidth = document.querySelector('.article-pane').getBoundingClientRect().width;
      const shellWidth = document.querySelector('.creative-shell').getBoundingClientRect().width;
      check(articleWidth > shellWidth * .85, 'focus mode gives article the available width');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      check(!document.querySelector('.creative-shell').classList.contains('writing-focus-article'), 'Escape exits focus mode'); result.articleFocusMode = true;
      check(Boolean(document.querySelector('.writing-article-state').textContent), 'article state is visible');
      check(Boolean(document.querySelector('.writing-article-next').textContent), 'next action guidance is visible'); result.articleGuidance = true;
      const archived = creative.data.conversation.archived;
      creative.data.conversation.archived = true; paintCreativeMessages(); window.iceWriting.enhance();
      check(document.querySelector('[data-writing-template]').disabled, 'templates respect archived read-only access');
      creative.data.conversation.archived = archived; paintCreativeMessages(); result.readonlyRespected = true;
      return result;
    } finally {
      creative.data = initial.data; creative.refs = initial.refs; creative.selectedText = initial.selectedText; creative.mode = initial.mode; creative.text = initial.text;
      if (initial.motion === undefined) delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = initial.motion;
      window.getSelection()?.removeAllRanges();
      document.querySelector('.creative-shell')?.classList.remove('writing-focus-article');
      const input = document.querySelector('#chat-input'); if(input){input.value=initial.text;input.disabled=false;}
      const mode = document.querySelector('#chat-mode'); if(mode)mode.value=initial.mode;
      window.iceWriting.persist(); paintCreativeMessages(); paintCreativePreview(); paintComposerMode();
    }
  })()`);
};
