'use strict';
// Test-only DOM timeline. Expected removals must match one captured node and
// occur inside the explicit user action, never merely share a dialog title.
async function startTrace(e, label) {
  await e(`(()=>{
    const trace=window.__d6={label:${JSON.stringify(label)},started:Date.now(),samples:[],removals:[],insertions:[],actions:[]};
    const ids=new WeakMap();let seq=0;
    const id=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++seq);return ids.get(n);};
    const relevant=n=>n.nodeType===1?[...(n.matches('.ice-asset-tabs,[role="dialog"],.ice-editor')?[n]:[]),...n.querySelectorAll('.ice-asset-tabs,[role="dialog"],.ice-editor')]:[];
    const describe=n=>({id:id(n),kind:n.matches('.ice-asset-tabs')?'tabs':n.matches('.ice-editor')?'editor':'dialog',title:n.querySelector('h2')?.textContent});
    window.__d6Expect=(name,nodes)=>{trace.actions.push({name,at:Date.now(),nodes:nodes.map(describe)});};
    const sample=()=>trace.samples.push({at:Date.now(),tabs:[...document.querySelectorAll('.ice-asset-tabs')].map(describe),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(describe),editor:id(document.querySelector('.ice-editor')),account:document.querySelector('#ice-account-select')?.value,focus:{id:id(document.activeElement),dialog:id(document.activeElement?.closest('[role="dialog"]')),tag:document.activeElement?.tagName,text:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.slice(0,60)},motion:matchMedia('(prefers-reduced-motion: reduce)').matches?'reduce':'normal',resetNote:document.body.textContent.includes('已恢复默认视图'),detailError:document.body.textContent.includes('图位读取失败')});
    window.__d6Observer=new MutationObserver(rows=>{for(const row of rows){for(const n of row.removedNodes)for(const t of relevant(n))trace.removals.push({at:Date.now(),...describe(t)});for(const n of row.addedNodes)for(const t of relevant(n))trace.insertions.push({at:Date.now(),...describe(t)});}sample();});
    window.__d6Observer.observe(document.body,{childList:true,subtree:true});
    window.__d6Sample=setInterval(sample,100);sample();
  })()`);
}
async function expectRemoval(e, name, nodes) {
  await e(`void window.__d6Expect(${JSON.stringify(name)},${nodes})`);
}
async function finishAction(e) {
  await e('void(window.__d6.actions.at(-1).finished=Date.now())');
}
async function stopTrace(e) {
  return e(`(()=>{window.__d6Observer.disconnect();clearInterval(window.__d6Sample);window.__d6.finished=Date.now();return window.__d6;})()`);
}
function auditRemovals(trace, kinds = ['tabs', 'dialog']) {
  const removals = trace.removals.filter(n => kinds.includes(n.kind));
  const expected = trace.actions.flatMap(action => action.nodes.filter(n => kinds.includes(n.kind)).map(node => ({ ...node, action })));
  const matches = (event, node) => event.id === node.id && event.kind === node.kind && event.title === node.title
    && event.at >= node.action.at && event.at <= node.action.finished;
  return {
    unexpected: removals.filter(event => !expected.some(node => matches(event, node))),
    missingOrRepeated: expected.filter(node => removals.filter(event => matches(event, node)).length !== 1),
  };
}
module.exports = { startTrace, expectRemoval, finishAction, stopTrace, auditRemovals };
