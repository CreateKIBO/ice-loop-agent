'use strict';
// Linux fallback: production renderer + real offline DesktopService, no Electron/OS clipboard.
// First build ui and run tests/seed_reading_upgrade_native.py. Requires Chrome and
// Node's WebSocket (or ws via NODE_PATH on Node 20). Never uses a personal profile.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline'), assert = require('node:assert/strict');
const WebSocketImpl = globalThis.WebSocket || require('ws');
const repo = path.resolve(__dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'docs/上线准备/reading-upgrade-fixture.json')));
assert.equal(path.dirname(fixture.root), path.join(repo, '.test-tmp/release-interaction-lists'));
assert(fs.existsSync(path.join(fixture.root, '.test-owner.json')));
const evidence = fs.mkdtempSync(path.join(fixture.root, 'browser-lifecycle-'));
const report = { scope: 'Chrome production renderer; real offline service over test-only loopback bridge; memory clipboard; no Electron IPC', runtime: fixture.runtime, checks: {}, errors: [] };
const productFiles = ['features/chat/ChatPane.tsx', 'features/chat/CandidateHistory.tsx', 'features/chat/CandidateCompare.tsx', 'features/tasks/RightPane.tsx', 'features/tasks/jobViewPrefs.ts', 'features/assets/AssetWorkspace.tsx', 'features/assets/PromptPanel.tsx', 'features/editor/ArticleEditor.tsx'];
const fingerprint = () => Object.fromEntries(productFiles.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo, 'desktop/ui/src', file))).digest('hex')]));
report.sources = fingerprint();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [], pending = new Map();
const faults = new Map(); // Test-only read failures/delays; never replace service data.
let engine, chrome, server, ws, evaluate, sequence = 0, failChat = false;
const python = `
import json, sys
from pathlib import Path
from ice_agent.desktop_service import DesktopService
from ice_agent.rpc_channel import RpcChannel
s = DesktopService(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), auto_consumer=False)
c = RpcChannel(s.call)
try:
    for line in sys.stdin.buffer:
        c.handle_raw(line)
finally:
    s.close()
`;
async function rpc(method, params) {
  const row = { method, params, started: Date.now() }; requests.push(row);
  const fault = faults.get(method);
  if (fault?.delay) await wait(fault.delay);
  if ((method === 'chat.get' && failChat) || fault?.fail) {
    row.failed = true; row.finished = Date.now(); row.injected = true;
    throw Error('Injected offline read failure: ' + method);
  }
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout ' + method)); }, 30000);
    pending.set(id, packet => {
      clearTimeout(timer); row.finished = Date.now(); row.failed = Boolean(packet.error);
      if (method === 'jobs.get' && packet.result) row.identity = {
        job: packet.result.job?.job_id, account: packet.result.article?.spec?.account_id,
        body_hash: packet.result.body_hash, slots: packet.result.slots?.map(s => s.slot_id),
      };
      packet.error ? reject(Error(packet.error.message)) : resolve(packet.result);
    });
    engine.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const count = method => requests.filter(row => row.method === method && row.finished && !row.failed).length;
async function until(test, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await wait(100); }
  throw Error('Timeout: ' + label);
}
async function run() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.endsWith('_API_KEY')) delete env[key];
  engine = spawn(process.env.ICE_PYTHON || 'python3', ['-u', '-c', python, repo, fixture.runtime, path.join(fixture.root, 'articles')], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  engine.stderr.pipe(fs.createWriteStream(path.join(evidence, 'engine.log')));
  readline.createInterface({ input: engine.stdout }).on('line', line => {
    const packet = JSON.parse(line), reply = pending.get(packet.id);
    if (reply) { pending.delete(packet.id); reply(packet); }
  });
  await rpc('bootstrap', {});
  const dist = path.join(repo, 'desktop/ui/dist');
  const bridge = `window.__copies=[];window.ice=Object.freeze({
    request:async(method,params={})=>{const r=await(await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})})).json();if(r.error)throw Error(r.error);return r.result;},
    copyText:async text=>{window.__copies.push(text);return {ok:true};}
  });`;
  server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/rpc' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const { method, params } = JSON.parse(body);
        const result = await rpc(method, params);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result })); return;
      }
      if (req.url === '/test-bridge.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bridge); return; }
      const relative = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).slice(1);
      const file = path.resolve(dist, relative);
      if (!file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
      let bytes = fs.readFileSync(file);
      if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script src="/test-bridge.js"></script>'));
      res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'); res.end(bytes);
    } catch (error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  chrome = spawn(process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=1440,1000', '--user-data-dir=' + path.join(evidence, 'chrome-profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.pipe(fs.createWriteStream(path.join(evidence, 'chrome.log')));
  const portFile = path.join(evidence, 'chrome-profile/DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 'Chrome startup');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  ws = new WebSocketImpl(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let callId = 0; const calls = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++callId, timer = setTimeout(() => { calls.delete(id); reject(Error('CDP timeout ' + method)); }, 30000);
    calls.set(id, packet => { clearTimeout(timer); packet.error ? reject(Error(JSON.stringify(packet.error))) : resolve(packet.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (packet.id) { const cb = calls.get(packet.id); calls.delete(packet.id); cb?.(packet); }
    if (packet.method === 'Runtime.exceptionThrown') report.errors.push(packet.params.exceptionDetails.exception?.description || packet.params.exceptionDetails.text);
  });
  const e = evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const ui = expression => until(() => e(expression), expression);
  const btn = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`;
  const click = async expression => { await ui(`Boolean(${expression})`); await e(`(${expression}).click()`); };
  const check = (name, value) => {
    report.checks[name] = Boolean(value);
    fs.writeFileSync(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ check: name, passed: Boolean(value) }));
  };
  const same = (id, ref) => `window.${ref}===document.getElementById(${JSON.stringify(id)})&&window.${ref}?.isConnected&&window.${ref}.getAttribute('aria-expanded')==='true'`;
  await call('Runtime.enable'); await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*'] });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url });
  await click(`document.querySelector('button[title="键盘验收会话1"]')`);
  // Latest window: object replacement and failed background reads must preserve the card.
  const latestId = 'candidate-expand-reading-recent-5';
  await click(`document.getElementById('${latestId}')`); await click(btn('Markdown 原文'));
  await e(`void(window.__latest=document.getElementById('${latestId}'))`);
  const before = count('chat.get'); await until(() => count('chat.get') > before, 'successful live poll');
  check('latest_survives_successful_poll', await e(same(latestId, '__latest')));
  failChat = true;
  await until(() => requests.some(r => r.method === 'chat.get' && r.failed), 'failed live poll'); await wait(200);
  check('latest_survives_failed_poll', await e(same(latestId, '__latest')));
  check('background_read_failure_visible', await e(`document.body.textContent.includes('会话刷新失败')`));
  failChat = false;
  const recovery = count('chat.get'); await until(() => count('chat.get') > recovery, 'recovered live poll'); await wait(200);
  check('latest_source_survives_recovery', await e(same(latestId, '__latest') + `&&Boolean(document.querySelector('.ice-candidate-reader pre'))`));
  // Known handoff boundary: TOC must locate the actual section in both views.
  const compareStart = requests.length;
  for (const id of fixture.compare_candidates) {
    await click(`[...document.getElementById('candidate-expand-${id}').parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='加入对照')`);
  }
  await click(btn('打开对照'));
  const dialog = `document.querySelector('[role="dialog"]')`;
  const pane = `${dialog}.querySelector('.ice-dialog-body > div > div')`;
  await ui(`${pane}.querySelectorAll('h1').length===1`);
  await click(`[...${pane}.querySelectorAll('button')].find(b=>b.textContent.startsWith('目录（'))`);
  await e(`(()=>{const p=${pane};window.__compareScroll=[...p.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px');window.__compareOther=[...${dialog}.querySelectorAll('div')].filter(n=>n.style.maxHeight==='460px')[1];window.__compareOuter=document.querySelector('.ice-chat-messages')?.scrollTop;})()`);
  check('compare_toc_excludes_quoted_and_fenced_headings', await e(`${pane}.querySelector('nav').textContent.includes('level-five')&&!${pane}.querySelector('nav').textContent.includes('quoted-not-heading')&&!${pane}.querySelector('nav').textContent.includes('fence-not-heading')`));
  for (const view of ['reading', 'source']) {
    if (view === 'source') await click(`[...${pane}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Markdown 原文')`);
    for (const title of ['level-five', 'level-six', 'tail-section']) {
      await e(`window.__compareScroll.scrollTop=0`);
      await click(`[...${pane}.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(title)})`);
      await wait(150);
      const position = await e(`(()=>{const n=window.__compareScroll;const target=[...n.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-compare-heading]')].find(h=>h.textContent.split('\\n')[0].replace(/^#+\\s*/,'')===${JSON.stringify(title)});return {scroll:n.scrollTop,offset:target?target.getBoundingClientRect().top-n.getBoundingClientRect().top:null,other:window.__compareOther.scrollTop};})()`);
      (report.comparePositions ??= {})[view + ':' + title] = position;
      check('compare_' + view + '_toc_' + title, position.scroll > 30 && position.offset >= 0 && position.offset < 40 && position.other === 0);
    }
    if (view === 'source') {
      const body = await rpc('chat.get', { account_id: fixture.account_a, conversation_id: fixture.conversations[0] });
      check('compare_anchored_source_preserves_full_text', await e(`window.__compareScroll.querySelector('pre').textContent===${JSON.stringify(body.candidates.find(c => c.id === fixture.compare_candidates[0]).body)}`));
      await click(`${pane}.querySelector('button[aria-label="复制此份原文"]')`);
      check('compare_copy_preserves_full_source', await e(`window.__copies.at(-1)===window.__compareScroll.querySelector('pre').textContent`));
    }
  }
  const comparePoll = count('chat.get'); await until(() => count('chat.get') > comparePoll, 'compare open over live poll');
  check('compare_survives_live_poll_without_writes', await e(`Boolean(${dialog})&&Boolean(window.__compareScroll.isConnected)&&Boolean(window.__compareScroll.querySelector('pre'))`) && !requests.slice(compareStart).some(r => /^(articles\.(save|editor_draft_save)|chat\.(update|save_draft|submit)|prompts\.(save|generate))$/.test(r.method)));
  // 目标一（2026-10-26）：目录 Markdown 边界——setext、重复标题按条目定位、CRLF 严格保留。
  // 定位断言用有界收敛轮询等待平滑滚动停止（稳定条件断言，不用固定 sleep）；判定阈值与既有检查一致。
  const flexRoot = `${dialog}.querySelector('.ice-dialog-body > div')`;
  const paneRootA = `${flexRoot}.children[0]`, paneRootB = `${flexRoot}.children[1]`;
  const positionIn = (scopeExpr, matcher) => e(`(()=>{const n=${scopeExpr};const target=${matcher};if(!target)return null;return {scroll:n.scrollTop,offset:target.getBoundingClientRect().top-n.getBoundingClientRect().top};})()`);
  const settleTo = async (scopeExpr, matcher) => {
    const end = Date.now() + 5000; let pos = null;
    while (Date.now() < end) {
      pos = await positionIn(scopeExpr, matcher);
      if (pos && pos.scroll > 30 && pos.offset >= 0 && pos.offset < 40) return { pos, settled: true };
      await wait(120);
    }
    return { pos, settled: false };
  };
  for (const view of ['reading', 'source']) {
    const isSource = view === 'source';
    await click(`[...${paneRootA}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(isSource ? 'Markdown 原文' : '阅读预览')})`);
    // setext：目录包含且定位到真实标题（阅读视图元素 / 原文锚点片段按标记查找，不取首个锚点）。
    await e(`window.__compareScroll.scrollTop=0`);
    await click(`[...${paneRootA}.querySelectorAll('nav button')].find(b=>b.textContent==='Setext 小节')`);
    const setextMatcher = isSource
      ? `[...window.__compareScroll.querySelectorAll('[data-compare-heading]')].find(sp=>sp.textContent.startsWith('Setext 小节'))`
      : `[...window.__compareScroll.querySelector('.ice-markdown').children].filter(c=>/^H[1-6]$/.test(c.tagName)).find(c=>c.textContent==='Setext 小节')`;
    const setext = await settleTo('window.__compareScroll', setextMatcher);
    (report.comparePositions ??= {})[view + ':setext'] = setext.pos;
    check('compare_' + view + '_toc_setext', setext.settled);
    if (isSource) {
      // 锚点片段开头与编号带回 Node 侧比较（模板串内反斜杠会被吞，正则/换行不再内嵌页面代码）。
      const anchor = await e(`(()=>{const sp=[...window.__compareScroll.querySelectorAll('[data-compare-heading]')].find(sp=>sp.textContent.startsWith('Setext 小节'));return sp?{head:sp.textContent.slice(0,14),anchor:sp.dataset.compareHeading}:null;})()`);
      (report.setextAnchor ??= {}).source = anchor;
      check('compare_source_setext_anchor_keeps_underline', Boolean(anchor) && anchor.head.startsWith('Setext 小节\n-') && /^[0-9]+$/.test(String(anchor.anchor)));
    }
    // 重复标题：两个同名目录项各自定位到对应出现（按锚点内文区分第一/第二处）。
    const dupButtons = `[...${paneRootA}.querySelectorAll('nav button')].filter(b=>b.textContent==='重复标题')`;
    check('compare_' + view + '_toc_lists_both_duplicates', await e(`${dupButtons}.length===2`));
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      await e(`window.__compareScroll.scrollTop=0`);
      await click(`(${dupButtons})[${occurrence}]`);
      const marker = occurrence === 0 ? '第一处重复内容' : '第二处重复内容';
      const dupMatcher = isSource
        ? `[...window.__compareScroll.querySelectorAll('[data-compare-heading]')].find(sp=>sp.textContent.includes(${JSON.stringify(marker)}))`
        : `[...window.__compareScroll.querySelector('.ice-markdown').children].filter(c=>/^H[1-6]$/.test(c.tagName)&&c.textContent==='重复标题')[${occurrence}]`;
      const dup = await settleTo('window.__compareScroll', dupMatcher);
      (report.comparePositions ??= {})[view + ':duplicate' + occurrence] = dup.pos;
      check('compare_' + view + '_toc_duplicate_' + occurrence, dup.settled);
      if (isSource) {
        const anchor = await e(`(()=>{const sp=[...window.__compareScroll.querySelectorAll('[data-compare-heading]')].find(sp=>sp.textContent.includes(${JSON.stringify(marker)}));return sp?sp.dataset.compareHeading:null;})()`);
        check('compare_source_duplicate_' + occurrence + '_targets_own_section', anchor !== null && await e(`window.__compareScroll.querySelector('[data-compare-heading="${anchor}"]').textContent.includes(${JSON.stringify(marker)})`));
      }
    }
  }
  // CRLF 乙份（真实第二栏）：原文展示与复制都必须逐字符等于服务返回正文（不归一化 CR）。
  const bodyB = (await rpc('chat.get', { account_id: fixture.account_a, conversation_id: fixture.conversations[0] })).candidates.find(c => c.id === fixture.compare_candidates[1]).body;
  check('crlf_body_has_carriage_returns', bodyB.includes('\r'));
  const paneBScroll = `[...${paneRootB}.querySelectorAll('div')].find(n=>n.style.maxHeight==='460px')`;
  await click(`[...${paneRootB}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Markdown 原文')`);
  await ui(`Boolean(${paneRootB}.querySelector('pre'))`);
  const crlfDisplay = await e(`(()=>{const pre=${paneRootB}.querySelector('pre');const expected=${JSON.stringify(bodyB)};let first=-1;for(let i=0;i<Math.min(pre.textContent.length,expected.length);i++)if(pre.textContent[i]!==expected[i]){first=i;break;}if(first<0&&pre.textContent.length!==expected.length)first=Math.min(pre.textContent.length,expected.length);return {exact:pre.textContent===expected,hasCR:pre.textContent.includes(String.fromCharCode(13)),shown:pre.textContent.length,expected:expected.length,firstDiff:first};})()`);
  (report.crlf ??= {}).display = crlfDisplay;
  check('crlf_source_display_exact_bytes', crlfDisplay.exact);
  await click(`${paneRootB}.querySelector('button[aria-label="复制此份原文"]')`);
  let crlfCopied = false;
  try { await until(() => e(`window.__copies.at(-1)===${JSON.stringify(bodyB)}`), 'crlf copy exact', 3000); crlfCopied = true; } catch {}
  check('crlf_copy_exact_bytes', crlfCopied);
  await click(`[...${paneRootB}.querySelectorAll('button')].find(b=>b.textContent.trim()==='阅读预览')`);
  await ui(`Boolean(${paneRootB}.querySelector('.ice-markdown'))`);
  await click(`[...${paneRootB}.querySelectorAll('button')].find(b=>b.textContent.startsWith('目录（'))`);
  await ui(`Boolean(${paneRootB}.querySelector('nav'))`);
  await e(`${paneBScroll}.scrollTop=0`);
  await click(`[...${paneRootB}.querySelectorAll('nav button')].find(b=>b.textContent==='tail-section')`);
  const crlfTail = await settleTo(paneBScroll, `[...${paneBScroll}.querySelector('.ice-markdown').children].filter(c=>/^H[1-6]$/.test(c.tagName)).find(c=>c.textContent==='tail-section')`);
  (report.comparePositions)['reading:crlf-tail'] = crlfTail.pos;
  check('crlf_reading_toc_locates_by_ast_line', crlfTail.settled);
  // 目标二（2026-10-26）：同一打开的对照弹窗内宽→窄→宽视口响应；几何用两栏根节点（不受单栏目录展开影响），记录翻转时延。
  const rootBox = async pane => e(`(()=>{const r=${pane}.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom};})()`);
  const innerWidth = () => e('window.innerWidth');
  const sideBySide = (a, b) => b.left >= a.right - 1 && Math.abs(a.top - b.top) < 2;
  const stackedVertically = (a, b) => b.top >= a.bottom - 1 && Math.abs(a.left - b.left) < 2;
  const wideA = await rootBox(paneRootA), wideB = await rootBox(paneRootB);
  (report.viewport ??= {}).wide1 = { inner: await innerWidth(), wideA, wideB };
  check('viewport_wide_side_by_side', sideBySide(wideA, wideB));
  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrowStart = Date.now(); let narrowA = null, narrowB = null, narrowOk = false;
  while (Date.now() - narrowStart < 4000) {
    narrowA = await rootBox(paneRootA); narrowB = await rootBox(paneRootB);
    if (stackedVertically(narrowA, narrowB)) { narrowOk = true; break; }
    await wait(120);
  }
  report.viewport.narrow = { afterMs: Date.now() - narrowStart, inner: await innerWidth(), narrowA, narrowB };
  check('viewport_narrow_stacks_vertically', narrowOk);
  check('viewport_narrow_no_horizontal_overflow', await e(`${dialog}.scrollWidth<=${dialog}.clientWidth+2&&document.documentElement.scrollWidth<=window.innerWidth+2`));
  // 窄屏下两栏仍各自可定位、可复制（甲栏定位不串到乙栏，乙栏复制仍是乙的正文）。
  await click(`[...${paneRootA}.querySelectorAll('button')].find(b=>b.textContent.trim()==='阅读预览')`);
  await ui(`Boolean(${paneRootA}.querySelector('.ice-markdown'))`);
  await e(`window.__compareScroll.scrollTop=0`);
  await click(`[...${paneRootA}.querySelectorAll('nav button')].find(b=>b.textContent==='level-five')`);
  const narrowToc = await settleTo('window.__compareScroll', `[...window.__compareScroll.querySelector('.ice-markdown').children].filter(c=>/^H[1-6]$/.test(c.tagName)).find(c=>c.textContent==='level-five')`);
  (report.comparePositions)['reading:narrow-level-five'] = narrowToc.pos;
  check('viewport_narrow_toc_still_targets_pane', narrowToc.settled);
  await click(`${paneRootB}.querySelector('button[aria-label="复制此份原文"]')`);
  let narrowCopied = false;
  try { await until(() => e(`window.__copies.at(-1)===${JSON.stringify(bodyB)}`), 'narrow copy exact', 3000); narrowCopied = true; } catch {}
  check('viewport_narrow_copy_still_exact', narrowCopied);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const wide2Start = Date.now(); let wide2A = null, wide2B = null, wide2Ok = false;
  while (Date.now() - wide2Start < 4000) {
    wide2A = await rootBox(paneRootA); wide2B = await rootBox(paneRootB);
    if (sideBySide(wide2A, wide2B)) { wide2Ok = true; break; }
    await wait(120);
  }
  report.viewport.wide2 = { afterMs: Date.now() - wide2Start, inner: await innerWidth(), wide2A, wide2B };
  check('viewport_restored_side_by_side', wide2Ok);
  // 恢复宽屏后乙栏内容逐字符不变（切回原文视图比较）。
  await click(`[...${paneRootB}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Markdown 原文')`);
  await ui(`Boolean(${paneRootB}.querySelector('pre'))`);
  check('viewport_restored_pane_b_body_unchanged', await e(`${paneRootB}.querySelector('pre').textContent===${JSON.stringify(bodyB)}`));
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await ui(`!${dialog}`);
  // Historical page also stays mounted while the independent live query fails.
  for (let page = 0; page < 8; page++) {
    await ui(`document.querySelectorAll('[id^="candidate-expand-"]').length>0`);
    if (await e(`Boolean(document.getElementById('candidate-expand-${fixture.candidate}'))`)) break;
    await click(btn('更早的候选稿')); await wait(400);
  }
  const historicId = 'candidate-expand-' + fixture.candidate;
  await click(`document.getElementById('${historicId}')`); await click(btn('Markdown 原文'));
  await e(`void(window.__historic=document.getElementById('${historicId}'))`);
  const failures = requests.filter(r => r.method === 'chat.get' && r.failed).length; failChat = true;
  await until(() => requests.filter(r => r.method === 'chat.get' && r.failed).length > failures, 'failed live poll over historical candidates'); await wait(200);
  check('history_survives_failed_live_poll', await e(same(historicId, '__historic')));
  failChat = false;
  await click(btn('复制全文'));
  check('history_copy_complete_source', await e(`window.__copies.at(-1)===${JSON.stringify(fixture.candidate_body)}`));
  const startD6 = async label => {
    await e(`(()=>{
      const trace=window.__d6={label:${JSON.stringify(label)},started:Date.now(),samples:[],removals:[],insertions:[]};
      const ids=new WeakMap();let seq=0;
      const id=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++seq);return ids.get(n);};
      const relevant=n=>n.nodeType===1?[...(n.matches('.ice-asset-tabs,[role="dialog"],.ice-editor')?[n]:[]),...n.querySelectorAll('.ice-asset-tabs,[role="dialog"],.ice-editor')]:[];
      const describe=n=>({id:id(n),kind:n.matches('.ice-asset-tabs')?'tabs':n.matches('.ice-editor')?'editor':'dialog',title:n.querySelector('h2')?.textContent});
      const sample=()=>trace.samples.push({at:Date.now(),tabs:[...document.querySelectorAll('.ice-asset-tabs')].map(describe),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(describe),editor:id(document.querySelector('.ice-editor')),account:document.querySelector('#ice-account-select')?.value,focus:{tag:document.activeElement?.tagName,text:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.slice(0,60)},resetNote:document.body.textContent.includes('已恢复默认视图'),detailError:document.body.textContent.includes('图位读取失败')});
      window.__d6Observer=new MutationObserver(rows=>{for(const row of rows){for(const n of row.removedNodes)for(const t of relevant(n))trace.removals.push({at:Date.now(),...describe(t)});for(const n of row.addedNodes)for(const t of relevant(n))trace.insertions.push({at:Date.now(),...describe(t)});}sample();});
      window.__d6Observer.observe(document.body,{childList:true,subtree:true});
      window.__d6Sample=setInterval(sample,100);sample();
    })()`);
  };
  const stopD6 = async label => {
    const trace = await e(`(()=>{window.__d6Observer.disconnect();clearInterval(window.__d6Sample);window.__d6.finished=Date.now();return window.__d6;})()`);
    (report.d6 ??= []).push(trace);
    check('d6_' + label + '_no_tabs_or_dialog_removal', !trace.removals.some(n => n.kind === 'tabs' || n.kind === 'dialog') && trace.insertions.some(n => n.kind === 'tabs'));
    check('d6_' + label + '_account_stable', trace.samples.every(s => s.account === fixture.account_a));
    if (trace.label.includes('reset')) check('d6_' + label + '_tabs_cross_actual_reset_expiry',
      trace.samples.some(s => s.tabs.length && s.resetNote) && trace.samples.some(s => s.tabs.length && !s.resetNote));
  };
  // Reset while editing, then save and immediately open the lazy workspace with Enter.
  await startD6('cold-reset');
  await e(`(()=>{const n=document.querySelector('[aria-label="任务状态筛选"]');n.value='mine';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(btn('恢复默认视图'));
  check('reset_focus_local', await e(`document.activeElement===document.querySelector('[aria-label="任务状态筛选"]')`));
  const edit = `[...document.querySelectorAll('[data-job-id="${fixture.jobs.completed}"] button')].find(b=>b.textContent.trim()==='编辑正文')`;
  await ui(`Boolean(${edit})`); await e(`(${edit}).focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await e(`document.querySelector('.ice-editor').focus()`); await call('Input.insertText', { text: '正文生命周期验收 ' });
  const saves = count('articles.save'); await click(btn('保存新版本'));
  await until(() => count('articles.save') > saves, 'save real revision');
  await ui(`Boolean(${btn('保存新版本')})`);
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  await e(`(()=>{window.__tabs=document.querySelector('.ice-asset-tabs');window.__tabsRemoved=false;window.__tabsObserver=new MutationObserver(rows=>{if(rows.some(row=>[...row.removedNodes].some(n=>n===window.__tabs||n.contains?.(window.__tabs))))window.__tabsRemoved=true;});window.__tabsObserver.observe(document.body,{subtree:true,childList:true});})()`);
  const jobPolls = count('jobs.list'); await until(() => count('jobs.list') > jobPolls, 'task list poll while workspace open');
  await wait(3000);
  check('workspace_survives_reset_note_and_task_poll', await e(`window.__tabs===document.querySelector('.ice-asset-tabs')&&window.__tabs.isConnected`));
  await click(btn('刷新配图')); await ui(`Boolean(document.querySelector('[aria-label="品牌参考图"]'))`);
  check('workspace_survives_detail_refresh', await e(`window.__tabs===document.querySelector('.ice-asset-tabs')`));
  check('workspace_never_removed_during_observation', await e(`!window.__tabsRemoved`));
  await e(`window.__tabsObserver.disconnect()`);
  await stopD6('cold_reset');
  const refs = `document.querySelector('[aria-label="品牌参考图"]')`;
  await click(`${refs}.querySelector('[aria-expanded]')`);
  check('references_expand', await e(`${refs}.querySelector('[aria-expanded]').getAttribute('aria-expanded')==='true'`));
  await ui(`${refs}.querySelectorAll('img').length>=2&&[...${refs}.querySelectorAll('img')].every(n=>n.complete&&n.naturalWidth>0)`);
  check('references_decode_real_service_images', true);
  await click(`${refs}.querySelector('button[aria-label^="复制文件名（图片"]')`);
  await ui(`window.__copies.length>1`);
  check('reference_filename_copy', await e(`window.__copies.at(-1)===${refs}.querySelector('li p').textContent`));
  await click(btn('关闭配图工作台')); await ui(`!document.querySelector('.ice-asset-tabs')`);
  // Warm cached workspace, no reset: delayed failing reference reads retain the
  // actual cached reference controls, including collapse/release while offline.
  faults.set('prompts.references', { fail: true, delay: 1000 });
  await startD6('warm-read-failure');
  const referenceStart = requests.length;
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  check('workspace_reopens', true);
  await click(`${refs}.querySelector('[aria-expanded]')`);
  await ui(`${refs}.querySelectorAll('img').length>=2&&[...${refs}.querySelectorAll('img')].every(n=>n.complete&&n.naturalWidth>0)`);
  await until(() => requests.slice(referenceStart).some(r => r.method === 'prompts.references' && r.failed), 'reference read failure');
  await ui(`document.body.textContent.includes('重新读取参考图')`);
  check('reference_controls_retained_after_failed_refresh', await e(`Boolean(${refs}.querySelector('[aria-expanded="true"]'))&&${refs}.querySelectorAll('li').length===2`));
  check('reference_cached_status_explained', await e(`document.body.textContent.includes('已保留上次读取的参考图')&&!${refs}.textContent.includes('本图位暂无参考图')`));
  await e(`window.__revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revoked.push(url);revoke(url);};window.__referenceUrls=[...${refs}.querySelectorAll('img')].map(n=>n.src);`);
  const canCollapse = await e(`Boolean(${refs}.querySelector('[aria-expanded="true"]'))`);
  if (canCollapse) await click(`${refs}.querySelector('[aria-expanded]')`);
  check('cached_reference_collapse_releases_images_during_failure', canCollapse && await e(`${refs}.querySelectorAll('img').length===0&&window.__referenceUrls.every(url=>window.__revoked.includes(url))`));
  faults.delete('prompts.references');
  await click(btn('重新读取参考图'));
  await ui(`!document.body.textContent.includes('重新读取参考图')`);
  check('references_recover_without_workspace_remount', await e(`Boolean(${refs}.querySelector('[aria-expanded]'))&&Boolean(document.querySelector('.ice-asset-tabs'))`));
  // Failure of jobs.get must not remove the data area; jobs.list keeps polling.
  faults.set('jobs.get', { fail: true }); faults.set('jobs.list', { fail: true });
  const jobFailureStart = requests.length;
  await e(`void(window.__warmTabs=document.querySelector('.ice-asset-tabs'))`);
  await click(btn('刷新配图')); await ui(`document.body.textContent.includes('图位读取失败')`);
  await until(() => requests.slice(jobFailureStart).some(r => r.method === 'jobs.list' && r.failed), 'failed task list poll');
  await ui(`document.body.textContent.includes('重新加载任务')`);
  check('workspace_retained_after_detail_and_list_read_failures', await e(`window.__warmTabs===document.querySelector('.ice-asset-tabs')&&window.__warmTabs.isConnected`));
  faults.delete('jobs.get'); faults.delete('jobs.list');
  await click(btn('刷新配图')); await ui(`!document.body.textContent.includes('图位读取失败')`);
  await click(btn('重新加载任务')); await ui(`!document.body.textContent.includes('重新加载任务')`);
  await stopD6('warm_failure');
  await click(btn('关闭配图工作台')); await ui(`!document.querySelector('.ice-asset-tabs')`);
  await click(btn('← 返回对话')); await ui(`!document.querySelector('.ice-editor')`);
  // Warm module/cache at 500px, normal motion, reset then Enter/edit/save/open.
  // The delayed detail response crosses the real 2.5s reset-note expiry.
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // Reset before narrowing so the production task control is keyboard reachable.
  await ui(`Boolean(document.querySelector('[aria-label="任务列表紧凑视图"]'))`);
  await e(`document.querySelector('[aria-label="任务列表紧凑视图"]').click()`);
  await startD6('warm-slow-reset');
  await click(btn('恢复默认视图'));
  await ui(`Boolean(${edit})`); await e(`(${edit}).focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await e(`document.querySelector('.ice-editor').focus()`); await call('Input.insertText', { text: '再次编辑正文 ' });
  const warmSaves = count('articles.save'); await click(btn('保存新版本'));
  await until(() => count('articles.save') > warmSaves, 'second saved revision');
  await ui(`Boolean(${btn('保存新版本')})`);
  faults.set('jobs.get', { delay: 2800 });
  const slowStart = requests.length;
  await click(btn('准备配图')); await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  await until(() => requests.slice(slowStart).some(r => r.method === 'jobs.get' && r.finished - r.started >= 2800), 'slow detail read');
  faults.delete('jobs.get');
  await ui(`!document.body.textContent.includes('已恢复默认视图')`);
  check('workspace_crosses_reset_expiry_and_slow_detail', await e(`Boolean(document.querySelector('.ice-asset-tabs'))`));
  await call('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(200);
  check('workspace_narrow_no_horizontal_overflow', await e(`[...document.querySelectorAll('[role="dialog"]')].every(n=>n.scrollWidth<=n.clientWidth+2)`));
  await stopD6('warm_slow_reset');
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, 'workspace-narrow.png'), Buffer.from(shot.data, 'base64'));
  // A separate document clears Query memory and module state. Distinguish an
  // initial read failure (tabs have never existed) from D6's transient removal.
  await click(btn('关闭配图工作台')); await ui(`!document.querySelector('.ice-asset-tabs')`);
  await call('Emulation.clearDeviceMetricsOverride');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const oldDocument = await e('performance.timeOrigin');
  await call('Page.reload'); await wait(200);
  await ui(`performance.timeOrigin!==${oldDocument}&&Boolean(document.querySelector('[aria-label="任务状态筛选"]'))`);
  await startD6('cold-failed-read');
  await e(`(()=>{const n=document.querySelector('[aria-label="任务状态筛选"]');n.value='mine';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(btn('恢复默认视图'));
  await ui(`Boolean(${edit})`); await e(`(${edit}).focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await ui(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
  await e(`document.querySelector('.ice-editor').focus()`); await call('Input.insertText', { text: '初次读败验收 ' });
  const coldSaves = count('articles.save'); await click(btn('保存新版本'));
  await until(() => count('articles.save') > coldSaves, 'third saved revision');
  await ui(`Boolean(${btn('保存新版本')})`);
  faults.set('jobs.get', { fail: true, delay: 500 });
  await click(btn('准备配图')); await ui(`document.body.textContent.includes('图位读取失败')`);
  check('initial_detail_failure_keeps_dialog_without_ever_showing_tabs', await e(`Boolean(document.querySelector('[role="dialog"]'))&&!document.querySelector('.ice-asset-tabs')&&!window.__d6.insertions.some(n=>n.kind==='tabs')`));
  faults.delete('jobs.get'); faults.set('prompts.references', { fail: true });
  await click(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b=>b.textContent==='重试')`);
  await ui(`Boolean(document.querySelector('.ice-asset-tabs'))`);
  await ui(`document.body.textContent.includes('重新读取参考图')`);
  check('initial_reference_failure_never_claims_empty_or_cached_success', await e(`!${refs}.textContent.includes('本图位暂无参考图')&&!${refs}.querySelector('[aria-expanded]')&&!document.body.textContent.includes('已保留上次读取的参考图')`));
  faults.delete('prompts.references');
  await click(btn('重新读取参考图')); await ui(`Boolean(${refs}.querySelector('[aria-expanded]'))`);
  check('initial_read_recovery_populates_same_dialog', await e(`document.querySelectorAll('[role="dialog"]').length===1&&window.__d6.insertions.filter(n=>n.kind==='dialog').length===1`));
  // This label has no reset-expiry assertion: it focuses on initial error vs removal.
  await wait(2800); await stopD6('cold_failure');
  for (const trace of report.d6) {
    check('d6_' + trace.label + '_real_job_identity', requests.some(r => r.method === 'jobs.get' && r.started >= trace.started && r.finished <= trace.finished && r.identity?.job === fixture.jobs.completed && r.identity?.account === fixture.account_a));
  }
  // Closing during a real delayed read must stay closed when that reply arrives.
  faults.set('jobs.get', { delay: 1500 });
  const lateStart = requests.length;
  await click(btn('刷新配图'));
  await until(() => requests.slice(lateStart).some(r => r.method === 'jobs.get'), 'pending detail request');
  await click(btn('关闭配图工作台')); await ui(`!document.querySelector('[role="dialog"]')`);
  await until(() => requests.slice(lateStart).some(r => r.method === 'jobs.get' && r.finished), 'late closed detail response');
  faults.delete('jobs.get'); await wait(200);
  check('late_detail_reply_does_not_reopen_closed_workspace', await e(`!document.querySelector('[role="dialog"]')&&!document.querySelector('.ice-asset-tabs')`));
  check('no_renderer_errors', report.errors.length === 0);
  check('source_unchanged_during_run', JSON.stringify(fingerprint()) === JSON.stringify(report.sources));
  check('three_explicit_article_saves_and_no_model_calls', requests.filter(r => r.method === 'articles.save').length === 3 && !requests.some(r => /^(prompts.generate|chat.send|jobs.resume)$/.test(r.method)));
  assert(Object.values(report.checks).every(Boolean), 'Lifecycle assertions failed');
}
(async () => {
  try { await run(); report.state = 'passed'; }
  catch (error) { report.state = 'failed'; report.error = error.stack; report.body = await evaluate?.('document.body.innerText').catch(() => null); process.exitCode = 1; }
  finally {
    failChat = false; faults.clear(); ws?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await Promise.race([new Promise(r => chrome.once('exit', r)), wait(3000)]); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
    if (server) await new Promise(r => server.close(r));
    if (engine) { engine.stdin.end(); await Promise.race([new Promise(r => engine.once('exit', r)), wait(3000)]); if (engine.exitCode === null) engine.kill(); }
    report.requests = requests;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ state: report.state, checks: report.checks, error: report.error, evidence }));
  }
})();
