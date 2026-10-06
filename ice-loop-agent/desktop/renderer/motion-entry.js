import { animate, stagger, hover, press } from 'motion';

// Motion is bundled locally. No remote scripts, premium plugins or fake progress.
const system = matchMedia('(prefers-reduced-motion: reduce)');
const running = new Map();
const seenMessages = new Set();
let preference = 'system';
try { preference = localStorage.getItem('ice-motion') || 'system'; } catch {}
const reduced = () => preference === 'off' || preference === 'system' && system.matches;
const gestures = new Map();

function clear(node) {
  const record = running.get(node);
  if (!record) return;
  record.controls.cancel();
  for (const [key, value] of Object.entries(record.original)) node.style[key] = value;
  running.delete(node);
}
function effect(node, frames, options = {}) {
  if (!node?.isConnected || node.hidden || node.closest('[hidden]') || reduced()) return null;
  clear(node);
  const original = Object.fromEntries(Object.keys(frames).map(key => [key, node.style[key]]));
  const { retain=false, ...animationOptions } = options;
  const controls = animate(node, frames, { duration: .26, ease: [0.22, 1, 0.36, 1], ...animationOptions });
  const record = { controls, original };
  running.set(node, record);
  if (!retain && options.repeat !== Infinity) controls.finished.then(() => {
    if (running.get(node) === record) clear(node);
  }).catch(() => {});
  return controls;
}
function enter(node) { return effect(node, { opacity: [.5, 1], transform: ['translateY(6px)', 'translateY(0px)'] }); }
function messages(container, conversationId) {
  for (const node of container?.querySelectorAll('[data-message-id]') || []) {
    const key = `${conversationId}:${node.dataset.messageId}`;
    if (!seenMessages.has(key)) { seenMessages.add(key); enter(node); }
  }
  while (seenMessages.size > 600) seenMessages.delete(seenMessages.values().next().value);
}
function scan() {
  for (const [node] of running) if (!node.isConnected || node.hidden || node.closest('[hidden]')) clear(node);
  for (const [node, stop] of gestures) if (!node.isConnected) { stop(); gestures.delete(node); }
  for (const node of document.querySelectorAll('.button,.icon-button,.chat-icon-button,.new-button,.sidebar-search,.nav-item')) {
    if(gestures.has(node))continue;
    const stopHover=hover(node, element=>{if(!element.disabled)effect(element,{opacity:[.82,1]},{duration:.22});});
    const stopPress=press(node, element=>{
      if(element.disabled||reduced())return;
      effect(element,{transform:['scale(1)','scale(.97)']},{duration:.1,retain:true});
      return ()=>{if(element.isConnected)effect(element,{transform:['scale(.97)','scale(1)']},{duration:.22});};
    });
    gestures.set(node,()=>{stopHover();stopPress();});
  }
  if (reduced()) return;
  for (const node of document.querySelectorAll('.progress-pulse.running, .spinner')) {
    if (!running.has(node)) effect(node, { transform: ['rotate(0deg)', 'rotate(360deg)'] }, { duration: 1.4, repeat: Infinity, ease: 'linear' });
  }
  for (const node of document.querySelectorAll('.preview-lines span')) {
    if (!running.has(node)) effect(node, { opacity: [.45, 1, .45] }, { duration: 1.8, repeat: Infinity, ease: 'easeInOut', delay: stagger(.12)([...node.parentNode.children].indexOf(node), node.parentNode.children.length) });
  }
}
function setPreference(value) {
  preference = ['off', 'system', 'on'].includes(value) ? value : 'system';
  try { localStorage.setItem('ice-motion', preference); } catch {}
  document.documentElement.dataset.motion = reduced() ? 'off' : 'on';
  if (reduced()) for (const [node] of running) clear(node);
  scan();
}
system.addEventListener('change', () => setPreference(preference));
let queued = false, previousPage;
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes' && record.target.tagName === 'DIALOG' && record.target.open) effect(record.target,{opacity:[.4,1],transform:['translateY(12px) scale(.985)','translateY(0px) scale(1)']},{duration:.28});
    if (record.type === 'attributes' && record.target.id === 'toast' && record.target.classList.contains('show')) effect(record.target, { opacity: [.5, 1] });
  }
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const page = document.querySelector('#workspace')?.firstElementChild;
    if (page && page !== previousPage) {
      previousPage = page; enter(page);
      [...document.querySelectorAll('#workspace .task-card, #workspace .library-card, #workspace .editorial-card, #workspace .model-card, #workspace .asset-card, #workspace .budget-panel')].slice(0, 8).forEach((node, index, items) => {
        effect(node, { opacity: [.5, 1], transform: ['translateY(10px)', 'translateY(0px)'] }, { delay: stagger(.045)(index, items.length), duration: .3 });
      });
    }
    scan();
  });
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] });
window.iceMotion = { enter, messages, effect, clear, setPreference, reduced, get preference() { return preference; }, get activeCount() { return running.size; }, get gestureCount(){return gestures.size;} };
setPreference(preference);
window.addEventListener('pagehide', () => { for (const [node] of running) clear(node); for(const stop of gestures.values())stop();gestures.clear(); });
