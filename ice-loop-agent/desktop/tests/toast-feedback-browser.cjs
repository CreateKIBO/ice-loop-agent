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
const sourcePaths = ['components/toast.tsx', 'components/toastLifetime.ts', 'components/toastHost.ts', 'components/ActivityRail.tsx', 'components/ui.tsx', 'components/errorText.ts', 'styles/feedback.css'];
const fingerprint = () => Object.fromEntries(sourcePaths.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ui, 'src', file))).digest('hex')]));
report.sources = fingerprint();
let browser, server;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MotionConfig} from 'motion/react';
    import {Toaster,toast} from './components/toast';
    import {Dialog} from './components/ui';
    import './styles/tokens.css'; import './styles/base.css'; import './styles/feedback.css';
    const root=createRoot(document.getElementById('root'));
    window.toast=toast; window.actions=[];
    window.pendingAction=()=>new Promise((resolve,reject)=>{window.actions.push({resolve,reject});window.finishAction=resolve;});
    function App({reducedMotion}) {
      const [open,setOpen]=React.useState(false);
      return <MotionConfig reducedMotion={reducedMotion}>
        <button id="open-dialog" onClick={()=>setOpen(true)}>打开弹窗</button>
        <Dialog open={open} onOpenChange={setOpen} title="通知回归弹窗" initialFocus="#dialog-focus"
          footer={<button id="close-dialog" onClick={()=>setOpen(false)}>关闭弹窗</button>}>
          <input id="dialog-focus" aria-label="弹窗输入"/>
        </Dialog><Toaster/>
      </MotionConfig>;
    }
    window.renderToast=(reducedMotion='never')=>root.render(<React.StrictMode><App reducedMotion={reducedMotion}/></React.StrictMode>);
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

  // Actual Radix Dialog registers/unregisters the production toast host. Moving
  // a portal remounts its cards; an in-flight action still belongs to its ID.
  let before = await page.evaluate(() => window.actions.length);
  id = await show('跨宿主动作只执行一次');
  await card('跨宿主动作只执行一次').locator('.ice-toast__action').evaluate(n => { n.click(); n.click(); });
  check('same_tick_action_runs_once', await page.evaluate(() => window.actions.length) === before + 1);
  await page.locator('#open-dialog').click();
  await page.locator('[role="dialog"] .ice-toaster').waitFor();
  check('modal_preserves_pending_action', await card('跨宿主动作只执行一次').locator('.ice-toast__action').evaluate(n => n.disabled && n.getAttribute('aria-busy') === 'true'));
  await card('跨宿主动作只执行一次').locator('.ice-toast__action').evaluate(n => n.click());
  check('portal_move_does_not_replay_action', await page.evaluate(() => window.actions.length) === before + 1);
  check('modal_initial_focus_preserved', await page.locator('#dialog-focus').evaluate(n => n === document.activeElement));
  await page.locator('#close-dialog').click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  check('modal_close_returns_opener_focus', await page.locator('#open-dialog').evaluate(n => n === document.activeElement));
  check('leaving_modal_preserves_pending_action', await card('跨宿主动作只执行一次').locator('.ice-toast__action').evaluate(n => n.disabled));
  await page.waitForTimeout(1500);
  check('remounted_pending_action_does_not_expire', await card('跨宿主动作只执行一次').count() === 1);
  await page.evaluate(() => window.actions.forEach(action => action.resolve()));
  await page.waitForTimeout(350); await clear(id);

  before = await page.evaluate(() => window.actions.length);
  id = await show('关闭后不再执行动作');
  await card('关闭后不再执行动作').evaluate(n => { const action = n.querySelector('.ice-toast__action'); n.querySelector('.ice-toast__close').click(); action.click(); });
  check('dismissed_action_cannot_start_during_exit', await page.evaluate(() => window.actions.length) === before);
  await clear(id);

  // Rejection values are unknown at the bridge boundary. Never serialize an
  // error object/headers, and never throw a second error while reporting one.
  for (const kind of ['null', 'string', 'object']) {
    const errorId = await page.evaluate(kind => window.toast.info({ title: '受控失败' + kind, duration: 5000,
      action: { label: '重试受控动作', run: () => { throw kind === 'null' ? null : kind === 'string'
        ? '本地模拟失败 sk-toast-secret-token'
        : { message: '[NETWORK] 受控网络失败', headers: { authorization: 'Bearer private-fixture-value' } }; } } }), kind);
    await card('受控失败' + kind).locator('.ice-toast__action').click();
    await page.waitForTimeout(300);
    const failure = page.locator('.ice-toast--danger');
    const text = await failure.allTextContents();
    check(kind + '_rejection_reports_failure', text.some(t => t.includes('重试受控动作失败')) && await card('受控失败' + kind).count() === 0);
    check(kind + '_error_detail_is_safe_and_useful', text.some(t => t.includes(kind === 'null' ? '操作未完成' : kind === 'string' ? '本地模拟失败' : '网络连接失败'))
      && text.every(t => !t.includes('sk-toast-secret-token') && !t.includes('private-fixture-value')));
    await failure.locator('.ice-toast__close').evaluateAll(nodes => nodes.forEach(n => n.click()));
    await clear(errorId);
  }

  // A plain toast must keep its consumed reading time and progress phase when
  // the production portal moves into/out of a real Radix dialog.
  await page.mouse.move(5, 5); await page.locator('#outside').focus();
  id = await page.evaluate(() => window.toast.info({ title: '跨宿主阅读时间', duration: 4000 }));
  await card('跨宿主阅读时间').waitFor();
  await card('跨宿主阅读时间').locator('.ice-toast__progress').evaluate(n => getComputedStyle(n).transform);
  await page.waitForTimeout(1700);
  check('plain_clock_is_unpaused_before_portal', await card('跨宿主阅读时间').evaluate(n => !n.matches(':hover') && !n.contains(document.activeElement) && document.visibilityState === 'visible'));
  const progressBefore = await card('跨宿主阅读时间').locator('.ice-toast__progress').evaluate(n => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  await page.locator('#open-dialog').click(); await page.locator('[role="dialog"] .ice-toaster').waitFor();
  await page.waitForTimeout(220);
  const progressAfter = await card('跨宿主阅读时间').locator('.ice-toast__progress').evaluate(n => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  report.portalProgress = { before: progressBefore, after: progressAfter };
  check('portal_progress_does_not_restart', progressAfter <= progressBefore + 0.1);
  await page.locator('#close-dialog').click(); await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  await page.waitForTimeout(2600);
  check('portal_move_preserves_reading_deadline', await card('跨宿主阅读时间').count() === 0);
  await clear(id);

  id = await page.evaluate(() => { window.__progressStart = performance.now(); return window.toast.info({ title: '恢复动态后的进度', duration: 5000 }); });
  await page.waitForTimeout(1200); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(1000); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(100);
  report.resumedProgress = await card('恢复动态后的进度').locator('.ice-toast__progress').evaluate(n => ({
    actual: new DOMMatrixReadOnly(getComputedStyle(n).transform).m11, expected: Math.max(0, 1 - (performance.now() - window.__progressStart) / 5000),
  }));
  check('motion_resume_progress_matches_remaining_time', Math.abs(report.resumedProgress.actual - report.resumedProgress.expected) < 0.12);
  await clear(id);

  await page.locator('#open-dialog').click(); await page.locator('[role="dialog"]').waitFor();
  id = await page.evaluate(() => window.toast.warning({ title: '长详情阅读', duration: 5000,
    detail: Array.from({ length: 80 }, (_, i) => '第' + i + '行：读取状态与下一步说明，保留原换行。').join('\n'), action: { label: '核对状态', run: () => {} } }));
  await card('长详情阅读').waitFor(); await page.waitForTimeout(250);
  await page.locator('.ice-dialog-notifications').evaluate(n => n.scrollTop = 0);
  const detail = card('长详情阅读').locator('.ice-toast__detail');
  check('long_detail_has_keyboard_scroll_target', await detail.evaluate(n => n.tabIndex === 0 && n.getAttribute('role') === 'region' && n.scrollHeight > n.clientHeight));
  check('long_detail_preserves_line_breaks', await detail.evaluate(n => getComputedStyle(n).whiteSpace === 'pre-wrap'));
  await detail.evaluate(n => n.focus()); await page.keyboard.press('PageDown'); await page.waitForTimeout(250);
  check('long_detail_keyboard_scrolls_own_region', await detail.evaluate(n => document.activeElement === n && n.scrollTop > 0));
  check('modal_long_detail_keeps_action_and_close_reachable', await card('长详情阅读').evaluate(n => ['.ice-toast__action', '.ice-toast__close'].every(selector => {
    const button = n.querySelector(selector), r = button.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(selector) === button;
  })));
  check('long_detail_has_no_horizontal_overflow', await detail.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  await page.screenshot({ path: path.join(evidence, 'modal-long-detail.png') });
  await card('长详情阅读').locator('.ice-toast__close').click(); await clear(id);
  id = await page.evaluate(() => window.toast.info({ title: '短详情', detail: '简短说明', duration: 5000 }));
  await card('短详情').waitFor();
  check('short_detail_does_not_add_a_tab_stop', await card('短详情').locator('.ice-toast__detail').evaluate(n => !n.hasAttribute('tabindex') && !n.hasAttribute('role')));
  await clear(id);
  await page.locator('#close-dialog').click(); await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

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
  await clear(id);
  await page.setViewportSize({ width: 320, height: 800 });
  id = await page.evaluate(() => window.toast.warning({ title: '待归档文件_' + 'x'.repeat(200), duration: 5000,
    action: { label: '重新读取并确认当前公众号的归档状态'.repeat(3), run: () => {} } }));
  await page.waitForTimeout(300);
  const longCard = page.locator('.ice-toast--warning');
  check('long_toast_content_does_not_overflow', await longCard.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  check('narrow_action_below_readable_body', await longCard.evaluate(n => {
    const body = n.querySelector('.ice-toast__body').getBoundingClientRect(), action = n.querySelector('.ice-toast__action').getBoundingClientRect();
    return action.top >= body.bottom && body.width > n.clientWidth / 2;
  }));
  check('long_toast_close_stays_reachable', await longCard.locator('.ice-toast__close').evaluate(n => {
    const r = n.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.ice-toast__close') === n;
  }));
  await page.screenshot({ path: path.join(evidence, 'narrow.png') });
  await clear(id);

  // Short viewports need a bounded notification stack, with a keyboard entry
  // only when the stack itself overflows. These are actual DOM scrolls.
  await page.setViewportSize({ width: 320, height: 420 });
  await page.mouse.move(5, 5); await page.locator('#outside').focus();
  const stackIds = await page.evaluate(() => Array.from({ length: 4 }, (_, i) => window.toast.warning({
    title: '短视口通知' + i, detail: '当前操作结果与下一步说明。'.repeat(12), duration: 10000, action: { label: '核对', run: () => {} },
  })));
  await page.locator('.ice-toast').last().waitFor(); await page.waitForTimeout(250);
  const stack = page.locator('.ice-toaster');
  check('short_viewport_stack_stays_within_viewport', await stack.evaluate(n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
  check('overflowing_stack_has_keyboard_entry', await stack.evaluate(n => n.tabIndex === 0 && n.scrollHeight > n.clientHeight));
  await page.locator('#open-dialog').focus(); await page.keyboard.press('Tab');
  check('tab_enters_overflowing_notification_region', await stack.evaluate(n => n === document.activeElement));
  await page.keyboard.press('PageDown'); await page.waitForTimeout(250);
  check('keyboard_scrolls_notification_stack', await stack.evaluate(n => n.scrollTop > 0));
  check('short_viewport_stack_has_no_horizontal_overflow', await stack.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
  await page.screenshot({ path: path.join(evidence, 'short-viewport-stack.png') });
  for (const stackId of stackIds) await clear(stackId);

  // A toast clipped below the modal notification viewport has not yet had its
  // reading opportunity. It must not expire before the user scrolls to it.
  await page.setViewportSize({ width: 500, height: 800 });
  await page.locator('#open-dialog').click(); await page.locator('[role="dialog"]').waitFor();
  await page.mouse.move(5, 5);
  const clippedIds = await page.evaluate(() => [
    ...[0, 1].map(i => window.toast.info({ title: '在前通知' + i, detail: '先核对这条说明。\n'.repeat(12), duration: 10000 })),
    window.toast.info({ title: '等待读取的通知', duration: 1800, action: { label: '查看', run: () => {} } }),
  ]);
  await card('等待读取的通知').waitFor(); await page.waitForTimeout(200);
  check('clipped_toast_is_below_modal_viewport', await card('等待读取的通知').evaluate(n => n.getBoundingClientRect().top >= document.querySelector('.ice-dialog-notifications').getBoundingClientRect().bottom));
  check('clipped_toast_progress_is_paused', await card('等待读取的通知').locator('.ice-toast__progress').evaluate(n => n.style.animationPlayState === 'paused'));
  await page.waitForTimeout(2100);
  const survived = await card('等待读取的通知').count() === 1;
  check('clipped_toast_keeps_reading_time', survived);
  if (survived) {
    await stack.focus(); await page.keyboard.press('End'); await page.waitForTimeout(400);
    check('scroll_reveals_clipped_toast_and_resumes_progress', await card('等待读取的通知').evaluate(n => {
      const r = n.getBoundingClientRect(), v = document.querySelector('.ice-dialog-notifications').getBoundingClientRect();
      return r.top >= v.top && r.bottom <= v.bottom && n.querySelector('.ice-toast__progress').style.animationPlayState === 'running';
    }));
    const beforeClip = await card('等待读取的通知').locator('.ice-toast__progress').evaluate(n => new DOMMatrix(getComputedStyle(n).transform).m11);
    await page.keyboard.press('Home'); await page.waitForTimeout(200);
    check('scrolling_away_pauses_reading_again', await card('等待读取的通知').locator('.ice-toast__progress').evaluate(n => n.style.animationPlayState === 'paused'));
    await page.waitForTimeout(2100);
    check('second_clip_preserves_remaining_reading_time', await card('等待读取的通知').count() === 1);
    await page.keyboard.press('End'); await page.waitForTimeout(200);
    const afterClip = await card('等待读取的通知').locator('.ice-toast__progress').evaluate(n => new DOMMatrix(getComputedStyle(n).transform).m11);
    report.clippedProgress = { before: beforeClip, after: afterClip };
    check('scroll_resume_progress_preserves_elapsed_reading', beforeClip < 0.95 && Math.abs(afterClip - (beforeClip - 200 / 1800)) < 0.1);
    await page.screenshot({ path: path.join(evidence, 'modal-stack-resumed.png') });
    await page.waitForTimeout(2100);
    check('revealed_toast_expires_after_visible_reading_time', await card('等待读取的通知').count() === 0);
  } else report.clippedBlocker = 'Toast expired while fully clipped; scroll/resume checks could not run';
  for (const clippedId of clippedIds) await clear(clippedId);
  await page.locator('#close-dialog').click(); await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  await page.evaluate(() => window.unmount());
  check('unmount_clears_animations', await page.evaluate(() => document.getAnimations().length === 0));
  check('no_renderer_errors', errors.length === 0); report.errors = errors;
  check('source_unchanged_during_run', JSON.stringify(report.sources) === JSON.stringify(fingerprint()));
  assert(Object.values(report.checks).every(Boolean), 'Failed: ' + Object.keys(report.checks).filter(k => !report.checks[k]).join(', '));
}
run().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }, null, 2));
});
