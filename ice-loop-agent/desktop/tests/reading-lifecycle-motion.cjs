'use strict';
// Production UI/real offline reads. Record scrollTo options while delegating to
// the browser unchanged, then inspect the actual two-frame/final DOM position.
module.exports = async function readingMotion({ e, call, ui, btn, click, check, until, wait, rpc, requests, fixture, report }) {
  const frames = () => e('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const settleScroll = async node => {
    let previous, stableSince = performance.now();
    await until(async () => {
      const top = await e(`(${node}).scrollTop`);
      if (top !== previous) { previous = top; stableSince = performance.now(); }
      return performance.now() - stableSince >= 200;
    }, 'native scroll finishes before the next journey', 5000);
    return previous;
  };
  const wheelOn = async node => {
    const point = await e(`(()=>{const n=${node},r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hitInside:n.contains(document.elementFromPoint(x,y))};})()`);
    if (!point.hitInside) throw Error('Wheel probe must hit the intended visible reader');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -300 });
    const finalTop = await settleScroll(node);
    (report.motion.wheels ??= []).push({ node, ...point, finalTop });
    await frames();
  };
  const preference = async policy => {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: policy === 'system' ? 'reduce' : 'no-preference' }] });
    await e(`document.documentElement.dataset.reduceMotion=${JSON.stringify(policy === 'manual' ? 'true' : 'false')}`);
    await frames();
  };
  const reduced = policy => ['manual', 'system'].includes(policy);
  await click(`document.querySelector('button[title="键盘验收会话1"]')`);
  await ui(`document.querySelector('.ice-chat-log')?.scrollHeight>document.querySelector('.ice-chat-log')?.clientHeight+500`);
  await e(`(()=>{
    window.__motionScrolls=[];window.__motionLog=document.querySelector('.ice-chat-log');
    const original=Element.prototype.scrollTo;
    Element.prototype.scrollTo=function(...args){
      if(this===window.__motionLog||this===window.__motionPaneScroll)window.__motionScrolls.push({stage:window.__motionStage,behavior:args[0]?.behavior,top:args[0]?.top});
      return original.apply(this,args);
    };
  })()`);
  report.motion = { chat: [], compare: [] };
  for (const policy of ['normal', 'manual', 'restored', 'system']) {
    await preference(policy);
    // The wheel intent and scroll event go through the real reading-window
    // state machine. This is renderer geometry, not OS wheel hardware evidence.
    await e(`(()=>{const n=window.__motionLog;n.dispatchEvent(new WheelEvent('wheel',{deltaY:-600,bubbles:true}));n.scrollTop=Math.max(0,n.scrollHeight-n.clientHeight-600);n.dispatchEvent(new Event('scroll',{bubbles:true}));})()`);
    await ui(`Boolean(document.querySelector('.ice-jump-latest button'))`);
    const entry = await e(`(()=>{const n=document.querySelector('.ice-jump-latest');return {transform:getComputedStyle(n).transform,y:new DOMMatrix(getComputedStyle(n).transform).m42};})()`);
    if (reduced(policy)) check('chat_' + policy + '_jump_feedback_has_no_displacement', Math.abs(entry.y) < 0.01);
    await e(`window.__motionStage=${JSON.stringify('chat-' + policy)};document.querySelector('.ice-jump-latest button').click()`);
    await frames();
    const sample = await e(`({policy:${JSON.stringify(policy)},entry:${JSON.stringify(entry)},call:window.__motionScrolls.filter(r=>r.stage===${JSON.stringify('chat-' + policy)}).at(-1),distance:window.__motionLog.scrollHeight-window.__motionLog.clientHeight-window.__motionLog.scrollTop})`);
    report.motion.chat.push(sample);
    check('chat_' + policy + '_scroll_uses_requested_policy', reduced(policy) ? ['auto', 'instant'].includes(sample.call?.behavior) : sample.call?.behavior === 'smooth');
    if (reduced(policy)) check('chat_' + policy + '_arrives_without_smooth_travel', Math.abs(sample.distance) <= 2);
    await until(() => e('Math.abs(window.__motionLog.scrollHeight-window.__motionLog.clientHeight-window.__motionLog.scrollTop)<=2'), 'chat motion settled ' + policy, 5000);
  }
  await preference('normal');
  const pair = [fixture.compare_candidates[0], fixture.compare_cr_candidate];
  for (const id of pair) await click(`[...document.getElementById('candidate-expand-${id}').parentElement.querySelectorAll('button')].find(n=>n.textContent.trim()==='加入对照')`);
  await e(`(${btn('打开对照')}).focus()`); await click(btn('打开对照'));
  const flex = `document.querySelector('[role="dialog"] .ice-dialog-body > div')`, pane = `(${flex}).children[1]`;
  const inButton = text => `[...(${pane}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&!n.disabled)`;
  await click(inButton('Markdown 原文'));
  await click(`(${pane}).querySelector('button[aria-controls="compare-toc-${pair[1]}"]')`);
  await e(`void(window.__motionPane=${pane});void(window.__motionPaneScroll=(${pane}).querySelector('pre').parentElement);void(window.__motionOther=(${flex}).children[0]);void(window.__motionOtherScroll=[...window.__motionOther.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px'))`);
  const body = (await rpc('chat.get', { account_id: fixture.account_a, conversation_id: fixture.conversations[0] })).candidates.find(row => row.id === pair[1]).body;
  const target = `window.__motionPane.querySelectorAll('[data-compare-heading]')`;
  const position = () => e(`(()=>{const n=[...${target}].find(n=>n.textContent.startsWith('## tail-section')),s=window.__motionPaneScroll;return {top:s.scrollTop,offset:n.getBoundingClientRect().top-s.getBoundingClientRect().top};})()`);
  const heading = `[...(${pane}).querySelectorAll('nav button')].find(n=>n.textContent==='tail-section')`;
  // Freeze the real CSS entrance at its first frame so the coordinate test is
  // deterministic, rather than relying on a fast click during scale(.96).
  const scaled = await e(`(()=>{
    const n=document.querySelector('[role="dialog"]'),a=n.getAnimations().find(a=>a.animationName==='ice-dialog-in');
    if(!a)return null;a.pause();a.currentTime=0;window.__motionEntrance=a;
    return {transform:getComputedStyle(n).transform,scale:new DOMMatrix(getComputedStyle(n).transform).m22};
  })()`);
  report.motion.scaledEntrance = { frame: scaled };
  check('compare_entrance_probe_uses_real_scaled_animation', scaled?.scale > 0 && scaled.scale < 0.99);
  if (scaled) {
    await e(`window.__motionStage='compare-scaled-entrance'`); await click(heading); await wait(1200);
    const final = await position(); report.motion.scaledEntrance.final = final;
    report.motion.scaledEntrance.call = await e(`window.__motionScrolls.filter(r=>r.stage==='compare-scaled-entrance').at(-1)`);
    check('compare_heading_during_scaled_entrance_reaches_target', final.top > 30 && final.offset >= 0 && final.offset < 40);
    await e('window.__motionEntrance.finish();window.__motionPaneScroll.scrollTop=0'); await frames();
  }
  for (const policy of ['normal', 'manual', 'system', 'restored']) {
    await preference(policy);
    await e(`window.__motionPaneScroll.scrollTop=0;window.__motionOtherTop=window.__motionOtherScroll.scrollTop;window.__motionStage=${JSON.stringify('compare-heading-' + policy)}`);
    await click(heading); await frames();
    const headingCall = await e(`window.__motionScrolls.filter(r=>r.stage===${JSON.stringify('compare-heading-' + policy)}).at(-1)`);
    const immediate = await position();
    const row = { policy, headingCall, immediate }; report.motion.compare.push(row);
    check('compare_' + policy + '_heading_uses_requested_policy', reduced(policy) ? ['auto', 'instant'].includes(headingCall?.behavior) : headingCall?.behavior === 'smooth');
    if (reduced(policy)) check('compare_' + policy + '_heading_arrives_without_travel', immediate.top > 30 && immediate.offset >= 0 && immediate.offset < 40);
    try {
      await until(async () => { const p = await position(); return p.top > 30 && p.offset >= 0 && p.offset < 40; }, 'compare heading settled ' + policy, 5000);
    } catch (error) {
      row.final = await position();
      row.geometry = await e('({height:window.__motionPaneScroll.clientHeight,total:window.__motionPaneScroll.scrollHeight,rect:window.__motionPaneScroll.getBoundingClientRect().toJSON(),visibility:document.visibilityState,focused:document.hasFocus()})');
      throw error;
    }
    check('compare_' + policy + '_only_own_pane_scrolls', await e('window.__motionOtherScroll.scrollTop===window.__motionOtherTop'));
    await e(`window.__motionStage=${JSON.stringify('compare-top-' + policy)}`);
    await click(inButton('回到开头')); await frames();
    const backCall = await e(`window.__motionScrolls.filter(r=>r.stage===${JSON.stringify('compare-top-' + policy)}).at(-1)`), backPosition = await position();
    check('compare_' + policy + '_back_uses_requested_policy', reduced(policy) ? ['auto', 'instant'].includes(backCall?.behavior) : backCall?.behavior === 'smooth');
    if (reduced(policy)) check('compare_' + policy + '_back_arrives_without_travel', backPosition.top === 0);
    await until(() => e('window.__motionPaneScroll.scrollTop===0'), 'compare top settled ' + policy, 5000);
    Object.assign(row, { backCall, backPosition });
  }
  // Reduce motion while a real native smooth scroll is still travelling.
  // Later user wheel intent must invalidate that destination.
  const resetCompare = async () => {
    await preference('normal'); await e('window.__motionPaneScroll.scrollTo({top:0,behavior:"instant"})'); await frames();
    await until(() => e('window.__motionPaneScroll.scrollTop===0'), 'compare reset settles before next journey', 5000);
  };
  const compareInFlight = async label => {
    const trace = { label, start: await position() }; (report.motion.inFlight ??= []).push(trace);
    try { await until(async () => { const p = await position(); return p.top > 5 && p.offset > 80; }, label, 5000); }
    finally { trace.observed = await position(); trace.calls = await e('window.__motionScrolls.slice(-2)'); }
    return trace.observed;
  };
  await resetCompare(); await click(heading);
  const compareBefore = await compareInFlight('compare smooth scroll is genuinely in flight');
  await preference('manual'); const compareAfter = await position();
  report.motion.compareInterruptions = { before: compareBefore, reduced: compareAfter };
  report.motion.compareInterruptions.callsAfterReduce = await e('window.__motionScrolls.slice(-4)');
  await settleScroll('window.__motionPaneScroll'); const compareSettled = await position();
  check('compare_reducing_mid_scroll_finishes_at_requested_heading', [compareAfter, compareSettled].every(p => p.top > 30 && p.offset >= 0 && p.offset < 40));
  await resetCompare(); await click(heading);
  await compareInFlight('compare scroll before reader wheel interruption');
  await wheelOn('window.__motionPaneScroll'); const compareUser = await position();
  await preference('manual'); const compareUserAfter = await position();
  check('compare_user_interruption_discards_old_scroll_destination', Math.abs(compareUserAfter.top - compareUser.top) <= 2 && compareUser.offset > 40);
  await resetCompare(); await click(heading);
  await compareInFlight('compare scroll before opposite navigation');
  await click(inButton('回到开头')); await preference('manual'); const compareReverse = await position();
  await settleScroll('window.__motionPaneScroll'); const reverseSettled = await position();
  check('compare_reducing_after_new_navigation_uses_latest_destination', compareReverse.top === 0 && reverseSettled.top === 0);
  Object.assign(report.motion.compareInterruptions, { settled: compareSettled, user: compareUser, afterUser: compareUserAfter, reversed: compareReverse, reverseSettled });
  check('live_preferences_keep_reader_nodes_and_exact_source', await e(`window.__motionPane===${pane}&&window.__motionPaneScroll.isConnected&&window.__motionPane.querySelector('pre').textContent===${JSON.stringify(body)}`));

  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await ui(`!document.querySelector('[role="dialog"]')`);
  const chatPosition = () => e('({top:window.__motionLog.scrollTop,distance:window.__motionLog.scrollHeight-window.__motionLog.clientHeight-window.__motionLog.scrollTop})');
  const startChatScroll = async () => {
    await preference('normal');
    await e(`(()=>{const n=window.__motionLog;n.dispatchEvent(new WheelEvent('wheel',{deltaY:-600,bubbles:true}));n.scrollTop=Math.max(0,n.scrollHeight-n.clientHeight-600);n.dispatchEvent(new Event('scroll',{bubbles:true}));})()`);
    await frames();
    await ui(`Boolean(document.querySelector('.ice-jump-latest button'))`);
    await e(`document.querySelector('.ice-jump-latest button').click()`);
    await until(async () => { const p = await chatPosition(); return p.distance > 20 && p.distance < 550; }, 'chat native scroll genuinely in flight', 5000);
    return chatPosition();
  };
  const chatBefore = await startChatScroll(); await preference('manual'); const chatAfter = await chatPosition();
  report.motion.chatInterruptions = { before: chatBefore, reduced: chatAfter };
  await settleScroll('window.__motionLog'); const chatSettled = await chatPosition();
  check('chat_reducing_mid_scroll_finishes_at_latest', Math.abs(chatAfter.distance) <= 2 && Math.abs(chatSettled.distance) <= 2);
  await startChatScroll();
  await wheelOn('window.__motionLog'); const chatUser = await chatPosition();
  await preference('manual'); const chatUserAfter = await chatPosition();
  check('chat_user_interruption_discards_old_latest_destination', Math.abs(chatUserAfter.top - chatUser.top) <= 2 && chatUserAfter.distance > 80
    && await e(`window.__motionLog===document.querySelector('.ice-chat-log')&&Boolean(document.querySelector('.ice-jump-latest button'))`));
  report.motion.chatInterruptions = { before: chatBefore, reduced: chatAfter, settled: chatSettled, user: chatUser, afterUser: chatUserAfter };
  check('reading_motion_has_no_write_or_model_requests', !requests.some(r => /^(chat\.(send|create|update|submit)|prompts\.(generate|save)|articles\.save|budgets\.save|jobs\.resume|approvals\.decide)$/.test(r.method)));
  await preference('system');
};
