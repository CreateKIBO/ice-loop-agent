'use strict';
// Real Radix Dialog/ImageViewer source in existing Chrome; fixture PNG via a
// memory read bridge. No Electron IPC, original capability or OS claim.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { chromium } = require('playwright'), esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/dialog-layout'); fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Chrome real StrictMode/Radix Dialog and ImageViewer; fixture PNG/memory read bridge; no IPC', checks: {}, errors: [] };
const files = ['components/ui.tsx', 'components/toast.tsx', 'components/toastHost.ts', 'features/assets/ImageViewer.tsx', 'features/assets/imageLease.ts', 'styles/feedback.css'];
const fingerprint = () => Object.fromEntries(files.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ui, 'src', file))).digest('hex')]));
report.sources = fingerprint(); let browser, server;
async function run() {
  const png = 'data:image/png;base64,' + fs.readFileSync(path.join(repo, '.demo-assets/f1.png')).toString('base64');
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MotionConfig} from 'motion/react';
    import {Dialog} from './components/ui'; import {ImageViewer} from './features/assets/ImageViewer';
    import {accountStore} from './data/client'; import {toast,Toaster} from './components/toast';
    accountStore.set('fixture-account'); window.reads=[]; window.urls=new Set();
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);window.urls.add(url);return url};
    URL.revokeObjectURL=url=>{window.urls.delete(url);revoke(url)};
    window.ice={request:async(method,params)=>{window.reads.push({method,params});if(method!=='resources.preview')throw Error('Unexpected method');return ${JSON.stringify(png)}}};
    window.toast=toast;
    function App(){
      const [kind,setKind]=React.useState(null),[nested,setNested]=React.useState(false),[options,setOptions]=React.useState({title:'核对内容',description:'简短说明',caption:'示例图片'});
      const [policy,setPolicy]=React.useState('user');window.setDialogMotionPolicy=setPolicy;
      window.setDialogOptions=setOptions;
      return <MotionConfig reducedMotion={policy}><button id="open-generic" onClick={()=>setKind('generic')}>打开核对</button><button id="open-image" onClick={()=>setKind('image')}>查看图片</button>
        <Dialog open={kind==='generic'} onOpenChange={open=>{if(!open)setKind(null)}} title={options.title} description={options.description} initialFocus="#dialog-field"
          footer={<><button id="open-nested" onClick={()=>setNested(true)}>打开子层</button><button id="close-generic" onClick={()=>setKind(null)}>确认并关闭</button></>}>
          <input id="dialog-field" aria-label="核对输入"/><p>需要核对的正文内容。</p>
        </Dialog>
        <Dialog open={nested} onOpenChange={setNested} title="嵌套核对" description="子层说明" footer={<button id="close-nested" onClick={()=>setNested(false)}>返回父层</button>}>子层内容</Dialog>
        {kind==='image'&&<ImageViewer target={{kind:'resource',resourceId:'fixture-resource',accountId:'fixture-account',caption:options.caption}} onClose={()=>setKind(null)}/>}
        <Toaster/>
      </MotionConfig>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(evidence, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(evidence, req.url.slice(1))));
    } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 420 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => Boolean(window.setDialogOptions));
  const check = (name, value) => { report.checks[name] = Boolean(value); };
  const dialog = page.locator('[role="dialog"]');
  const reachable = locator => locator.evaluate(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === n; });
  const close = async (opener, stage = opener) => {
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    (report.closeFocus ??= {})[stage] = await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName }));
    check(stage + '_close_returns_focus', await page.locator('#' + opener).evaluate(n => n === document.activeElement));
  };
  const title = '核对文件_' + 'x'.repeat(160), description = 'reference_' + 'y'.repeat(180) + '.png';
  await page.evaluate(({ title, description }) => window.setDialogOptions({ title, description, caption: '示例图片' }), { title, description });
  await page.locator('#open-generic').click(); await dialog.waitFor();
  check('long_header_initial_focus_preserves_explicit_field', await page.locator('#dialog-field').evaluate(n => n === document.activeElement));
  check('long_title_does_not_overflow', await dialog.locator('h2').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  check('long_description_does_not_overflow', await dialog.evaluate(n => {
    const d = document.getElementById(n.getAttribute('aria-describedby')); return d && d.scrollWidth <= d.clientWidth + 1;
  }));
  check('long_header_dialog_has_no_horizontal_overflow', await dialog.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  const header = dialog.locator('.ice-dialog-header');
  const headerReady = await header.count() === 1;
  check('overflow_header_has_keyboard_region', headerReady && await header.evaluate(n => n.tabIndex === 0 && n.getAttribute('role') === 'region' && n.scrollHeight > n.clientHeight));
  if (headerReady) {
    await page.keyboard.press('Shift+Tab');
    check('tab_reaches_overflow_header', await header.evaluate(n => n === document.activeElement));
    report.headerBefore = await header.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, total: n.scrollHeight, focused: n === document.activeElement }));
    await page.keyboard.press('End'); await page.waitForTimeout(350);
    report.headerAfter = await header.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, total: n.scrollHeight, focused: n === document.activeElement }));
    check('header_keyboard_reaches_description_end', await header.evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 2));
    check('header_keeps_exact_title_and_description', await dialog.locator('h2').textContent() === title && await dialog.evaluate(n => document.getElementById(n.getAttribute('aria-describedby'))?.textContent) === description);
    await page.keyboard.press('Home'); await page.waitForTimeout(350);
    check('header_keyboard_returns_to_title_start', await header.evaluate(n => n.scrollTop === 0));
    await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(250);
    check('expanded_header_removes_unneeded_tab_stop', await header.evaluate(n => n.scrollHeight <= n.clientHeight + 1 && !n.hasAttribute('tabindex') && !n.hasAttribute('role')));
    await page.setViewportSize({ width: 320, height: 420 }); await page.waitForTimeout(250);
    check('shrinking_header_restores_keyboard_region', await header.evaluate(n => n.scrollHeight > n.clientHeight && n.tabIndex === 0 && n.getAttribute('role') === 'region'));
  } else report.headerBlocker = 'No bounded header region; keyboard description reading unavailable';
  check('short_dialog_footer_reachable_with_long_header', await reachable(page.locator('#close-generic')));
  await page.screenshot({ path: path.join(evidence, 'long-header-short.png') });
  await close('open-generic', 'long_header');

  await page.evaluate(() => window.setDialogOptions({ title: '核对内容', description: '简短说明', caption: '示例图片' }));
  await page.setViewportSize({ width: 500, height: 800 }); await page.locator('#open-generic').click(); await dialog.waitFor();
  check('short_header_does_not_add_tab_stop', await dialog.locator('.ice-dialog-header').count() === 0 || await dialog.locator('.ice-dialog-header').evaluate(n => !n.hasAttribute('tabindex') && !n.hasAttribute('role')));
  await page.locator('#open-nested').click(); await page.locator('#close-nested').waitFor();
  await page.evaluate(() => window.toast.warning({ title: '嵌套内通知', duration: 10000 }));
  check('nested_toast_host_stays_in_top_dialog', await page.locator('#close-nested').evaluate(n => n.closest('[role="dialog"]').contains(document.querySelector('.ice-toast'))));
  await page.locator('#close-nested').click();
  check('nested_close_returns_parent_opener', await page.locator('#open-nested').evaluate(n => n === document.activeElement));
  check('toast_host_returns_to_parent_dialog', await dialog.evaluate(n => n.contains(document.querySelector('.ice-toast'))));
  await page.locator('.ice-toast__close').click(); await close('open-generic', 'parent');

  await page.setViewportSize({ width: 320, height: 420 });
  const caption = 'reference_' + 'z'.repeat(180) + '.png。' + '核对图片来源与位置。'.repeat(40);
  await page.evaluate(caption => window.setDialogOptions({ title: '核对内容', description: '简短说明', caption }), caption);
  await page.locator('#open-image').click(); await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('.ice-image-viewport img')?.naturalWidth > 0);
  check('image_reads_only_fixture_preview', await page.evaluate(() => window.reads.length > 0 && window.reads.every(r => r.method === 'resources.preview' && r.params.account_id === 'fixture-account')));
  check('long_caption_does_not_overflow_viewer', await dialog.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  check('long_caption_keeps_image_viewport_space', await page.locator('.ice-image-viewport').evaluate(n => { const r = n.getBoundingClientRect(), body = n.closest('.ice-dialog-body').getBoundingClientRect(); return body.height > 24 && r.top < body.bottom; }));
  check('long_caption_image_close_is_reachable', await reachable(dialog.getByRole('button', { name: '关闭原图', exact: true })));
  await page.evaluate(() => window.toast.warning({ title: '图片内操作结果', detail: '操作状态保留，可关闭后继续核对。', duration: 10000 }));
  await page.locator('.ice-toast').waitFor();
  check('short_image_toast_and_close_stay_reachable', await reachable(page.locator('.ice-toast__close')) && await reachable(dialog.getByRole('button', { name: '关闭原图', exact: true })));
  check('short_image_with_toast_keeps_viewport_space', await page.locator('.ice-image-viewport').evaluate(n => n.closest('.ice-dialog-body').clientHeight > 24));
  await page.locator('.ice-toast__close').click();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Tab');
  check('image_tab_focus_stays_in_dialog', await dialog.evaluate(n => n.contains(document.activeElement)));
  await page.screenshot({ path: path.join(evidence, 'long-caption-image-short.png') });
  await close('open-image');
  check('closing_image_releases_blob_lease', await page.evaluate(() => window.urls.size === 0));

  // Preference changes on an already open dialog must not play its entrance
  // again. Inspect the real CSS animation and preserve the exact input node.
  await page.setViewportSize({ width: 500, height: 800 });
  await page.evaluate(() => { delete document.documentElement.dataset.reduceMotion; window.setDialogOptions({title:'动效生命周期',description:'当前输入需要保留',caption:'示例图片'}); });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const motionSample = () => dialog.evaluate(n => ({
    scale: new DOMMatrix(getComputedStyle(n).transform).m22,
    running: n.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName),
    overlayRunning: document.querySelector('.ice-dialog-overlay').getAnimations().filter(a => a.playState === 'running').map(a => a.animationName),
  }));
  const twoFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('#open-generic').click(); await dialog.waitFor();
  report.motion = { normalEntry: await motionSample() };
  check('normal_open_keeps_real_entrance', report.motion.normalEntry.running.includes('ice-dialog-in'));
  await page.waitForTimeout(300);
  await page.locator('#dialog-field').fill('重播入场不能重置这份输入');
  await page.evaluate(() => { window.__motionField=document.getElementById('dialog-field'); window.__motionDialog=window.__motionField.closest('[role="dialog"]'); });
  for (const policy of ['manual', 'system', 'parent']) {
    if (policy === 'manual') await page.evaluate(() => document.documentElement.dataset.reduceMotion = 'true');
    if (policy === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (policy === 'parent') await page.evaluate(() => window.setDialogMotionPolicy('always'));
    await twoFrames();
    const reduced = await motionSample();
    check(policy + '_live_dialog_is_static', reduced.running.length === 0 && reduced.overlayRunning.length === 0 && Math.abs(reduced.scale - 1) < 0.001);
    if (policy === 'manual') await page.evaluate(() => delete document.documentElement.dataset.reduceMotion);
    if (policy === 'system') await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (policy === 'parent') await page.evaluate(() => window.setDialogMotionPolicy('user'));
    await twoFrames();
    const restored = await motionSample(); (report.motion.preferences ??= []).push({ policy, reduced, restored });
    check(policy + '_restore_does_not_replay_open_entrance', restored.running.length === 0 && restored.overlayRunning.length === 0 && Math.abs(restored.scale - 1) < 0.001);
    check(policy + '_preference_keeps_nodes_input_and_focus', await page.evaluate(() =>
      window.__motionDialog===document.querySelector('[role="dialog"]') && window.__motionField===document.getElementById('dialog-field')
      && window.__motionField.value==='重播入场不能重置这份输入' && document.activeElement===window.__motionField));
    await page.waitForTimeout(300);
  }
  await close('open-generic', 'motion_normal');
  await page.evaluate(() => window.setDialogMotionPolicy('always'));
  await page.locator('#open-generic').click(); await dialog.waitFor(); await twoFrames();
  report.motion.parentOpen = await motionSample();
  check('parent_reduced_open_disables_css_dialog_and_overlay_motion', report.motion.parentOpen.running.length === 0 && report.motion.parentOpen.overlayRunning.length === 0 && Math.abs(report.motion.parentOpen.scale - 1) < 0.001);
  await close('open-generic', 'motion_parent');
  await page.evaluate(() => window.setDialogMotionPolicy('user'));
  await page.locator('#open-generic').click(); await dialog.waitFor();
  report.motion.reopened = await motionSample();
  check('explicit_reopen_restores_normal_entrance', report.motion.reopened.running.includes('ice-dialog-in'));
  await page.waitForTimeout(300); await close('open-generic', 'motion_reopened');
  for (const policy of ['manual', 'system', 'parent']) {
    await page.locator('#open-generic').click(); await dialog.waitFor();
    const before = await motionSample();
    check(policy + '_interrupt_probe_starts_during_real_entrance', before.running.includes('ice-dialog-in'));
    if (policy === 'manual') await page.evaluate(() => document.documentElement.dataset.reduceMotion = 'true');
    if (policy === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (policy === 'parent') await page.evaluate(() => window.setDialogMotionPolicy('always'));
    await twoFrames(); const stopped = await motionSample();
    check(policy + '_interrupt_stops_dialog_and_overlay', stopped.running.length === 0 && stopped.overlayRunning.length === 0 && Math.abs(stopped.scale - 1) < 0.001);
    if (policy === 'manual') await page.evaluate(() => delete document.documentElement.dataset.reduceMotion);
    if (policy === 'system') await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (policy === 'parent') await page.evaluate(() => window.setDialogMotionPolicy('user'));
    await twoFrames(); const restored = await motionSample();
    check(policy + '_interrupted_entrance_does_not_restart', restored.running.length === 0 && restored.overlayRunning.length === 0 && Math.abs(restored.scale - 1) < 0.001);
    (report.motion.interruptions ??= []).push({ policy, before, stopped, restored });
    await close('open-generic', 'interrupt_' + policy);
  }
  check('no_renderer_errors', report.errors.length === 0);
  check('source_unchanged_during_run', JSON.stringify(fingerprint()) === JSON.stringify(report.sources));
  assert(Object.values(report.checks).every(Boolean), 'Failed: ' + Object.keys(report.checks).filter(key => !report.checks[key]).join(', '));
}
run().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ evidence, ...report }, null, 2));
});
