'use strict';

// Runs after codex3 in a new serial fixture. No consumer, model or budget write.
module.exports = async function codex4({ e, ui, click, check, requests, report }) {
  const workspace = `[...document.querySelectorAll('[role="dialog"]')].find(n=>n.querySelector('h2')?.textContent==='文章配图工作台')`;
  const prompt = `(${workspace}).querySelector('section[aria-label="生图提示词"]')`;
  const button = label => `[...(${prompt}).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`;
  const input = `(${prompt}).querySelector('input[aria-label="本篇模型调用上限"]')`;
  const start = requests.length;
  await click(button('调整本篇预算'));
  await ui(`Boolean(${input})`);
  const original = await e(`(${input}).value`);
  const edited = original === '37' ? '38' : '37';
  await e(`(()=>{const n=${input};window.__c4Limit=n;window.__c4Prompt=(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]');window.__c4Text=window.__c4Prompt.value;window.__c4Tabs=document.querySelector('.ice-asset-tabs');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(edited)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await ui(`(${input}).value===${JSON.stringify(edited)}`);
  report.c4 = { original, edited, beforeRepeat: await e(`(${prompt}).innerText`) };
  check('c4_adjust_entry_disabled_while_form_is_open', await e(`(${button('调整本篇预算')}).disabled`));
  // Native DOM click follows the button's disabled semantics. Before the fix it
  // invokes the still-active handler and resets the unsaved limit to the cache.
  await e(`(${button('调整本篇预算')}).click()`);
  report.c4.afterRepeat = { value: await e(`(${input}).value`), text: await e(`(${prompt}).innerText`) };
  check('c4_repeat_adjust_keeps_unsaved_limit', await e(`(${input})===window.__c4Limit&&(${input}).value===${JSON.stringify(edited)}`));
  await click(button('取消预算调整'));
  check('c4_cancel_reenables_adjust_entry', await e(`!(${input})&&!(${button('调整本篇预算')}).disabled`));
  await click(button('调整本篇预算'));
  check('c4_explicit_reopen_uses_saved_limit', await e(`(${input}).value===${JSON.stringify(original)}`));
  await click(button('取消预算调整'));
  check('c4_no_write_or_prompt_node_change', !requests.slice(start).some(r => /^(budgets.save|prompts\.(save|generate))$/.test(r.method))
    && await e(`window.__c4Prompt===(${prompt}).querySelector('textarea[aria-label="当前图位生图提示词"]')&&window.__c4Prompt.value===window.__c4Text&&window.__c4Tabs===document.querySelector('.ice-asset-tabs')&&window.__c4Tabs.isConnected`));
};
