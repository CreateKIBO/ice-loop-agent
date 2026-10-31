'use strict';
// Real source components in existing Chrome/Playwright; memory clipboard adapter,
// never OS clipboard/Electron IPC. Every credential below is a fixture value.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { chromium } = require('playwright'), esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/error-feedback'); fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Chrome real React StrictMode; ErrorPanel/CopyButton/write-refresh receipts/Toaster; memory adapters; no IPC or OS clipboard', checks: {}, errors: [] };
const sourcePaths = ['components/ui.tsx', 'components/CopyButton.tsx', 'data/clipboard.ts', 'data/receipts.ts', 'components/errorText.ts', 'components/toast.tsx', 'components/toastLifetime.ts', 'styles/feedback.css'];
const fingerprint = () => Object.fromEntries(sourcePaths.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ui, 'src', file))).digest('hex')]));
report.sources = fingerprint();
let browser, server;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {CopyButton} from './components/CopyButton'; import {ErrorPanel} from './components/ui';
    import {Toaster} from './components/toast';
    import {refreshAfterWrite} from './data/receipts';
    window.copyCalls=[]; window.copyPlan=[]; window.panelRetries=0; window.panelDismissals=0;
    window.writeCount=0; window.refreshCount=0; window.refreshPlan=[];
    const refresh=async()=>{
      window.refreshCount++; const step=window.refreshPlan.shift()||{};
      if(step.delay) await new Promise(resolve=>setTimeout(resolve,step.delay));
      if(step.reject) throw step.value;
    };
    window.ice={copyText:async text=>{
      window.copyCalls.push(text); const step=window.copyPlan.shift()||{};
      if(step.delay) await new Promise(resolve=>setTimeout(resolve,step.delay));
      if(step.reject) throw step.value;
      return step.result||{ok:true};
    }};
    function App(){
      const [text,setText]=React.useState('第一段完整内容'),[mounted,setMounted]=React.useState(true),[panel,setPanel]=React.useState(null),[receipt,setReceipt]=React.useState('');
      window.setCopyText=setText; window.setCopyMounted=setMounted; window.setErrorPanel=setPanel;
      return <><main style={{padding:16}}>
        <input id="text-source" value={text} onChange={e=>setText(e.target.value)} aria-label="待复制文本"/>
        <div id="copy-host">{mounted&&<CopyButton text={text} label="复制内容"/>}</div>
        <div id="error-panel">{panel&&<ErrorPanel {...panel} onRetry={()=>window.panelRetries++} onDismiss={()=>window.panelDismissals++}/>}</div>
        <button id="write-refresh" onClick={async()=>{
          window.writeCount++; setReceipt('写入已确认');
          try { await refreshAfterWrite('提示词保存',refresh); setReceipt('写入已确认'); }
          catch { setReceipt('保存失败'); }
        }}>模拟已确认写入后刷新</button><p id="write-status" role="status">{receipt}</p>
      </main><Toaster/></>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(evidence, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(fs.readFileSync(path.join(evidence, req.url.slice(1))));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => Boolean(window.setErrorPanel));
  const check = (name, value) => { report.checks[name] = Boolean(value); fs.writeFileSync(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2)); };
  const copy = page.locator('#copy-host button'), panel = page.locator('#error-panel [role="alert"]');
  const clearToasts = async () => { await page.locator('.ice-toast__close').evaluateAll(nodes => nodes.forEach(n => n.click())); await page.waitForTimeout(80); };

  const rawTitle = '资源读取失败 api_key=fixture-title-value';
  const rawDetail = '读取失败 Authorization: Basic dXNlcjpwYXNz\n地址 https://example.invalid/' + 'x'.repeat(700);
  await page.evaluate(({ title, detail }) => window.setErrorPanel({ title, detail }), { title: rawTitle, detail: rawDetail });
  await panel.waitFor();
  check('panel_title_redacts_credential', !(await panel.locator('strong').innerText()).includes('fixture-title-value'));
  check('panel_detail_redacts_credential', !(await panel.innerText()).includes('dXNlcjpwYXNz'));
  check('panel_keeps_useful_error_context', (await panel.innerText()).includes('资源读取失败') && (await panel.innerText()).includes('读取失败'));
  check('narrow_panel_long_detail_has_no_overflow', await panel.evaluate(n => n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= innerWidth));
  check('narrow_page_has_no_horizontal_scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await panel.getByRole('button', { name: '知道了', exact: true }).click();
  check('panel_actions_preserve_callbacks', await page.evaluate(() => window.panelRetries === 1 && window.panelDismissals === 1));
  await page.screenshot({ path: path.join(evidence, 'error-panel-narrow.png'), fullPage: true });
  await page.evaluate(() => window.setErrorPanel(null));

  for (const [kind, value, expected] of [
    ['null', null, '操作未完成'],
    ['string', '列表刷新拒绝 api_key=fixture-receipt-value', '列表刷新拒绝'],
    ['object', { message: '[NETWORK] 受控读取失败', headers: { authorization: 'Basic dXNlcjpwYXNz' } }, '网络连接失败'],
  ]) {
    await page.evaluate(value => { window.refreshPlan = [{ reject: true, value }]; }, value);
    await page.locator('#write-refresh').click(); await page.waitForTimeout(100);
    const warnings = page.locator('.ice-toast--warning'), text = (await warnings.allTextContents()).join('\n');
    check('receipt_' + kind + '_keeps_write_success', await page.locator('#write-status').innerText() === '写入已确认');
    check('receipt_' + kind + '_explains_refresh_failure', text.includes('提示词保存已完成，列表刷新失败') && text.includes(expected));
    check('receipt_' + kind + '_is_redacted', !/fixture-receipt-value|dXNlcjpwYXNz/.test(text));
    await clearToasts();
  }
  await page.evaluate(() => { window.refreshPlan = [{ reject: true, value: Error('列表暂不可读') }, { delay: 600, reject: true, value: Error('再次读取失败') }, {}]; });
  await page.locator('#write-refresh').click(); await page.waitForTimeout(100);
  const retry = page.locator('.ice-toast--warning .ice-toast__action');
  const counts = await page.evaluate(() => ({ writes: window.writeCount, reads: window.refreshCount }));
  await retry.evaluate(n => { n.click(); n.click(); }); await page.waitForTimeout(80);
  check('receipt_retry_has_busy_feedback', await retry.evaluate(n => n.disabled && n.getAttribute('aria-busy') === 'true'));
  check('receipt_same_tick_retry_reads_once', await page.evaluate(counts => window.refreshCount === counts.reads + 1, counts));
  await page.waitForTimeout(700);
  check('receipt_failed_retry_keeps_a_new_warning', await page.locator('.ice-toast--warning').count() === 1 && (await page.locator('.ice-toast--warning').innerText()).includes('再次读取失败'));
  await retry.click(); await page.waitForTimeout(100);
  check('receipt_successful_retry_dismisses_warning', await page.locator('.ice-toast--warning').count() === 0);
  check('receipt_retries_never_replay_the_write', await page.evaluate(counts => window.writeCount === counts.writes && window.refreshCount === counts.reads + 2, counts));

  for (const [kind, value, expected] of [
    ['null', null, '操作未完成'],
    ['string', '复制桥接拒绝 api_key=fixture-copy-value', '复制桥接拒绝'],
    ['object', { message: '[NETWORK] 受控桥接失败', headers: { authorization: 'Basic dXNlcjpwYXNz' } }, '网络连接失败'],
  ]) {
    await page.evaluate(value => { window.copyPlan = [{ reject: true, value }]; }, value);
    await copy.click(); await page.waitForTimeout(150);
    const text = (await page.locator('.ice-toast--danger').allTextContents()).join('\n');
    check('copy_' + kind + '_failure_is_useful', text.includes('复制失败') && text.includes(expected));
    check('copy_' + kind + '_does_not_leak_secrets', !/fixture-copy-value|dXNlcjpwYXNz/.test(text));
    check('copy_' + kind + '_clears_busy_without_success', await copy.evaluate(n => !n.disabled && n.getAttribute('aria-busy') !== 'true' && !n.textContent.includes('已复制')));
    await clearToasts();
  }
  await page.evaluate(() => { window.copyPlan = [{ result: { ok: true } }]; });
  await copy.click(); await page.waitForTimeout(100);
  check('copy_recovers_after_failure', (await copy.innerText()).includes('已复制'));
  check('copy_keeps_accessible_action_label', await copy.getAttribute('aria-label') === '复制内容');
  await page.evaluate(() => { window.copyPlan = [{ result: { ok: false, message: '受控剪贴板拒绝' } }]; });
  await copy.click(); await page.waitForTimeout(100);
  check('copy_readback_denial_clears_previous_success', !(await copy.innerText()).includes('已复制')
    && (await page.locator('.ice-toast--danger').innerText()).includes('受控剪贴板拒绝'));
  await clearToasts();

  const before = await page.evaluate(() => window.copyCalls.length);
  await page.evaluate(() => { window.copyPlan = [{ delay: 600, result: { ok: true } }]; });
  await copy.evaluate(n => { n.click(); n.click(); n.click(); }); await page.waitForTimeout(80);
  check('copy_pending_has_busy_feedback', await copy.evaluate(n => n.disabled && n.getAttribute('aria-busy') === 'true'));
  check('copy_same_tick_dispatches_once', await page.evaluate(before => window.copyCalls.length === before + 1, before));
  await page.evaluate(() => window.setCopyText('第二段新的内容')); await page.waitForTimeout(750);
  check('copy_stale_success_does_not_mark_new_text', !(await copy.innerText()).includes('已复制'));

  await page.evaluate(() => { window.copyPlan = [{ delay: 600, result: { ok: true } }]; });
  await copy.click(); await page.waitForTimeout(80);
  await page.evaluate(() => window.setCopyText('临时版本')); await page.waitForTimeout(60);
  await page.evaluate(() => window.setCopyText('第二段新的内容')); await page.waitForTimeout(750);
  check('copy_text_roundtrip_invalidates_old_receipt', !(await copy.innerText()).includes('已复制'));

  await page.evaluate(() => { window.copyPlan = [{ delay: 600, reject: true, value: '过期复制失败' }]; });
  await copy.click(); await page.waitForTimeout(80);
  await page.evaluate(() => window.setCopyText('第三段内容')); await page.waitForTimeout(750);
  check('copy_changed_text_ignores_old_failure', await page.locator('.ice-toast').count() === 0 && await copy.evaluate(n => !n.disabled));

  await page.evaluate(() => { window.copyPlan = [{ delay: 600, reject: true, value: null }]; });
  await copy.click(); await page.waitForTimeout(80); await page.evaluate(() => window.setCopyMounted(false));
  await page.waitForTimeout(750);
  check('copy_unmounted_failure_is_quiet', await page.locator('.ice-toast').count() === 0);
  check('copy_unmount_removes_control', await copy.count() === 0);
  check('no_renderer_errors', report.errors.length === 0);
  check('source_unchanged_during_run', JSON.stringify(fingerprint()) === JSON.stringify(report.sources));
  assert(Object.values(report.checks).every(Boolean), 'Failed: ' + Object.keys(report.checks).filter(key => !report.checks[key]).join(', '));
}
run().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }, null, 2));
});
