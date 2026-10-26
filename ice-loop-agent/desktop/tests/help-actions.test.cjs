'use strict';
// 批次D-17/18/20（2026-10-20 后续任务）：帮助跳转白名单与文案边界。
// 1) 帮助跳转只能是既有界面开关（uiState store），禁止 RPC 字符串；
// 2) 预算/历史范围文案与后端语义一致（1–100 / 会话0不限默认24 / 最近五期正文+全部标题）；
// 3) 没有界面入口的条目写清操作路径，不制造不可点击的假链接（无 markdown 链接）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const UI = path.resolve(__dirname, '..', 'ui');
const SRC = path.join(UI, 'src');
const uiRequire = Module.createRequire(path.join(UI, 'package.json'));

const result = esbuild.buildSync({
  stdin: {
    contents: "import { TROUBLESHOOTING, SHORTCUTS } from './components/ShortcutHelp'; export { TROUBLESHOOTING, SHORTCUTS };",
    resolveDir: SRC, loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'empty' }, external: ['react', 'react/*'], logLevel: 'silent',
});
const target = path.join(UI, '.help-actions-under-test.cjs');
const host = new Module(target);
host.filename = target;
host.paths = Module._nodeModulePaths(UI);
host._compile(result.outputFiles[0].text, target);
const { TROUBLESHOOTING } = host.exports;

const helpSource = fs.readFileSync(path.join(SRC, 'components/ShortcutHelp.tsx'), 'utf8');

test('help jumps only open existing UI stores; no RPC strings or model calls in help', () => {
  // 白名单目标在 JUMP 表中逐一声明；帮助源码不得出现 rpc/bridge 调用。
  assert.ok(/const JUMP: Record<HelpTarget/.test(helpSource), '应有 JUMP 白名单表');
  for (const forbidden of ['rpc(', 'window.ice', '.request(', 'fetch(']) {
    assert.ok(!helpSource.includes(forbidden), `帮助组件不应包含 ${forbidden}`);
  }
  for (const entry of TROUBLESHOOTING) {
    if (!entry.go) continue;
    assert.ok(['model-settings', 'editorial', 'publication-history', 'publication-identity'].includes(entry.go.target),
      `${entry.symptom} 的跳转目标不在白名单内`);
    assert.equal(typeof entry.go.label, 'string');
  }
});

test('budget and history wording matches backend semantics', () => {
  const budgetEntry = TROUBLESHOOTING.find(entry => entry.keywords.includes('model_budget_exceeded'));
  assert.ok(budgetEntry, '预算排障条目应存在');
  // 与 ice_agent/model_budgets.py 一致：任务 1–100；会话 0–1000，0=不限，默认24。
  assert.ok(budgetEntry.cause.includes('1–100'), '任务预算范围应为1–100');
  assert.ok(budgetEntry.cause.includes('0表示不限制'), '仅会话预算允许0不限');
  assert.ok(budgetEntry.cause.includes('默认24'), '未配置会话预算默认24');
  const guides = helpSource;
  assert.ok(guides.includes('最近五期正文与全部历史标题'), '历史范围表述应保留');
});

test('entries without a jump button describe the concrete path; no fake links anywhere', () => {
  for (const entry of TROUBLESHOOTING) {
    // 无跳转的条目必须给出可跟随的操作位置（路径：/左栏/编辑器/经典界面/切回…）。
    if (!entry.go) {
      assert.ok(/路径：|左栏|编辑器|经典界面|切回|观察任务/.test(entry.next),
        `「${entry.symptom}」没有跳转按钮，下一步必须写清操作位置`);
    }
    // 帮助文本不允许 markdown 链接（不可点击的假链接）。
    for (const text of [entry.symptom, entry.cause, entry.next]) {
      assert.ok(!/\[[^\]]+\]\([^)]+\)/.test(text), `帮助文本不得包含假链接：${text}`);
    }
  }
});
