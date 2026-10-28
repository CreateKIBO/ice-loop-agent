'use strict';
// Real React/Motion in isolated Chrome; synthetic visibility only, no Electron/OS claim.
// Uses existing esbuild/playwright via NODE_PATH. Never installs or calls a service.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/toast-feedback');
fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Chrome; real React StrictMode/Motion; synthetic document visibility; no IPC', checks: {} };
let browser, server;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MotionConfig} from 'motion/react';
    import {Toaster,toast} from './components/toast';
    import './styles/tokens.css'; import './styles/base.css'; import './styles/feedback.css';
    const root=createRoot(document.getElementById('root'));
    window.toast=toast; window.pendingAction=()=>new Promise(resolve=>window.finishAction=resolve);
    window.renderToast=(reducedMotion='never')=>root.render(<React.StrictMode><MotionConfig reducedMotion={reducedMotion}><Toaster/></MotionConfig></React.StrictMode>);
    window.unmount=()=>root.unmount(); window.renderToast();
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(evidence, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(fs.readFileSync(path.join(evidence, req.url.slice(1))));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><button id="outside">外部焦点</button><div id="root"></div><script src="/app.js"></script>');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 500, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => Boolean(window.toast));
  const check = (name, ok) => { report.checks[name] = Boolean(ok); };
  const show = title => page.evaluate(title => window.toast.info({ title, duration: 1200, action: { label: '执行', run: () => window.pendingAction() } }), title);
  const card = title => page.locator('.ice-toast').filter({ hasText: title });
  const clear = async id => { await page.evaluate(id => window.toast.dismiss(id), id); await page.waitForTimeout(300); };
  const visibility = state => page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

  let id = await show('焦点与悬停独立');
  await card('焦点与悬停独立').hover();
  await card('焦点与悬停独立').locator('.ice-toast__action').focus();
  await page.mouse.move(5, 5); await page.waitForTimeout(1500);
  check('mouse_leave_preserves_keyboard_pause', await card('焦点与悬停独立').count() === 1);
  await page.locator('#outside').focus();
  await page.waitForTimeout(1600);
  check('expires_after_focus_and_hover_leave', await card('焦点与悬停独立').count() === 0);
  await clear(id);

  id = await show('后台保留阅读时间');
  await page.waitForTimeout(150); await visibility('hidden');
  check('hidden_progress_paused', await card('后台保留阅读时间').locator('.ice-toast__progress').evaluate(n => getComputedStyle(n).animationPlayState === 'paused'));
  await page.waitForTimeout(1500);
  check('hidden_does_not_expire', await card('后台保留阅读时间').count() === 1);
  await visibility('visible'); await page.waitForTimeout(1600);
  check('visible_resumes_expiry', await card('后台保留阅读时间').count() === 0);
  await clear(id);

  id = await show('异步动作反馈');
  await card('异步动作反馈').locator('.ice-toast__action').click();
  await page.locator('#outside').focus(); await page.mouse.move(5, 5);
  check('action_disabled_and_busy', await card('异步动作反馈').locator('.ice-toast__action').evaluate(n => n.disabled && n.getAttribute('aria-busy') === 'true'));
  check('running_progress_paused', await card('异步动作反馈').locator('.ice-toast__progress').evaluate(n => getComputedStyle(n).animationPlayState === 'paused'));
  await page.waitForTimeout(1500);
  check('pending_action_does_not_expire', await card('异步动作反馈').count() === 1);
  await page.evaluate(() => window.finishAction()); await page.waitForTimeout(350);
  check('success_dismisses', await card('异步动作反馈').count() === 0);

  // Preference changes affect an already mounted host, then new cards too.
  for (const policy of ['system', 'manual', 'parent']) {
    id = await show('实时偏好' + policy);
    await card('实时偏好' + policy).hover();
    if (policy === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (policy === 'manual') await page.evaluate(() => document.documentElement.dataset.reduceMotion = 'true');
    if (policy === 'parent') await page.evaluate(() => window.renderToast('always'));
    await page.waitForTimeout(80);
    check(policy + '_existing_progress_stops', await card('实时偏好' + policy).locator('.ice-toast__progress').evaluate(n => getComputedStyle(n).animationName === 'none'));
    await clear(id); await page.mouse.move(5, 5);
    id = await show('静态通知' + policy);
    await page.waitForTimeout(40);
    check(policy + '_no_transform_animation', await card('静态通知' + policy).evaluate(n => {
      const t = getComputedStyle(n).transform;
      return (t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)') && n.getAnimations().every(a => a.playState !== 'running');
    }));
    await clear(id);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { delete document.documentElement.dataset.reduceMotion; window.renderToast('never'); });
  }
  id = await show('窄屏通知');
  await page.waitForTimeout(350);
  check('narrow_toast_within_viewport', await card('窄屏通知').evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path: path.join(evidence, 'narrow.png') });
  await page.evaluate(() => window.unmount());
  check('unmount_clears_animations', await page.evaluate(() => document.getAnimations().length === 0));
  check('no_renderer_errors', errors.length === 0); report.errors = errors;
  assert(Object.values(report.checks).every(Boolean), 'Failed: ' + Object.keys(report.checks).filter(k => !report.checks[k]).join(', '));
}
run().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }, null, 2));
});
