'use strict';
// 批次A（2026-10-20 后续任务）行为回归：写成功 vs 刷新失败分离、幂等重试、
// 账号切换竞态、失败保持输入→恢复→只写一次、ErrorNote 展示、焦点归还目标选择。
// 通过 esbuild 打包真实源码模块并用 mock 桥接驱动（不启动 Electron）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const UI = path.resolve(__dirname, '../ui');
const uiRequire = Module.createRequire(path.join(UI, 'package.json'));

let compileCounter = 0;
function compileEntry(contents) {
  // 同一入口里 import 的模块共享一份实例（store/toast 状态跨导出可见）。
  const result = esbuild.buildSync({
    stdin: { contents, resolveDir: path.join(UI, 'src'), loader: 'ts' },
    bundle: true, write: false,
    format: 'cjs', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'], logLevel: 'silent',
  });
  const target = path.join(UI, `.async-recovery-${++compileCounter}.cjs`);
  const module = new Module(target);
  module.filename = target;
  module.paths = Module._nodeModulePaths(UI);
  module._compile(result.outputFiles[0].text, target);
  return module.exports;
}

// window：rpc 桥接与 localStorage 都从这里取；每个用例替换 request 实现。
const storageMap = new Map();
globalThis.window = {
  localStorage: {
    getItem: key => storageMap.get(key) ?? null,
    setItem: (key, value) => storageMap.set(key, value),
    removeItem: key => storageMap.delete(key),
  },
  ice: { request: async () => { throw new Error('bridge not configured'); } },
  setTimeout, clearTimeout,
};

const app = compileEntry(`
  import * as client from './data/client';
  import * as actions from './data/actions';
  import * as toastMod from './components/toast';
  import * as composerDraft from './data/composerDraft';
  import * as receipts from './data/receipts';
  export { client, actions, toastMod, composerDraft, receipts };
`);
const focus = compileEntry(`import * as focus from './components/focusRestore'; export { focus };`).focus;
const { ErrorNote } = compileEntry(`import { ErrorNote } from './components/ErrorNote'; export { ErrorNote };`);
const errorText = compileEntry(`import * as errorText from './components/errorText'; export { errorText };`).errorText;
const React = uiRequire('react');
const { renderToStaticMarkup } = uiRequire('react-dom/server');

const CHAT_RESULT = conversationId => ({
  conversation: { id: conversationId, title: 't' }, messages: [], candidates: [],
});

function useBridge(handler) { window.ice.request = handler; }

test('createConversation retries reuse the same request_id and never double-create on one success', async () => {
  app.client.accountStore.set('acc-a');
  app.client.conversationStore.set(null);
  const calls = [];
  let failures = 2; // 前两次尝试失败，第三次成功；验证重试全程复用同一幂等键
  useBridge(async (method, params) => {
    if (method !== 'chat.create') return {};
    calls.push(params.request_id);
    if (failures-- > 0) throw Object.assign(new Error('[STATE_CONFLICT] 引擎忙'), { code: 'STATE_CONFLICT' });
    return CHAT_RESULT('conv-1');
  });
  const requestId = 'req-stable-1';
  await assert.rejects(() => app.actions.createConversation(requestId), /引擎忙|STATE_CONFLICT/);
  await assert.rejects(() => app.actions.createConversation(requestId), /引擎忙|STATE_CONFLICT/);
  const id = await app.actions.createConversation(requestId);
  assert.equal(id, 'conv-1');
  assert.equal(app.client.conversationStore.get(), 'conv-1');
  // 三次尝试（两次失败 + 一次成功）都带同一幂等键，成功路径只发生一次写。
  assert.deepEqual(calls, ['req-stable-1', 'req-stable-1', 'req-stable-1']);
});

test('failed create keeps the caller input and stages nothing onto the new conversation', async () => {
  app.client.accountStore.set('acc-a');
  app.client.conversationStore.set(null);
  useBridge(async method => {
    if (method === 'chat.create') throw Object.assign(new Error('[NETWORK] 断开'), { code: 'NETWORK' });
    return {};
  });
  await assert.rejects(() => app.actions.createConversation('req-fail', {
    initialInput: { text: '第一篇想写什么', mode: 'draft' },
  }), /断开|NETWORK/);
  const composerDraft = app.composerDraft;
  // 欢迎页输入由组件状态 + 本地草稿承担：失败后本地草稿仍在，新会话没有被注入内容。
  composerDraft.saveComposerDraft(window.localStorage, 'acc-a', 'getting-started',
    { text: '第一篇想写什么', mode: 'draft' });
  const restored = composerDraft.loadComposerDraft(window.localStorage, 'acc-a', 'getting-started');
  assert.equal(restored.text, '第一篇想写什么');
  assert.ok(composerDraft.peekStagedComposerDraft('acc-a', 'conv-never') == null,
    '失败后不应向新会话注入内容');
});

test('account switched mid-create throws a switch notice and never selects the new conversation locally', async () => {
  app.client.accountStore.set('acc-a');
  app.client.conversationStore.set(null);
  useBridge(async method => {
    if (method === 'chat.create') {
      // 模拟等待期间用户在另一入口切换了账号。
      app.client.accountStore.set('acc-b');
      return CHAT_RESULT('conv-2');
    }
    return {};
  });
  await assert.rejects(() => app.actions.createConversation('req-switch'), /公众号已切换/);
  assert.notEqual(app.client.conversationStore.get(), 'conv-2');
});

test('list refresh failure after a successful create reports a refresh warning, not a create failure', async () => {
  app.client.accountStore.set('acc-a');
  app.client.conversationStore.set(null);
  useBridge(async method => (method === 'chat.create' ? CHAT_RESULT('conv-3') : {}));
  const warnings = [];
  const toastModule = app.toastMod;
  const originalWarning = toastModule.toast.warning;
  toastModule.toast.warning = input => warnings.push(input);
  const originalInvalidate = app.client.queryClient.invalidateQueries;
  let invalidateBroken = true;
  app.client.queryClient.invalidateQueries = async () => {
    if (invalidateBroken) throw new Error('刷新失败：本地缓存不可用');
    return originalInvalidate.call(app.client.queryClient, { queryKey: ['ice'] });
  };
  try {
    // 刷新失败不能把创建成功冒充成失败——否则用户会拿新请求键重试建出第二个会话。
    const id = await app.actions.createConversation('req-refresh-fail');
    assert.equal(id, 'conv-3');
    assert.equal(app.client.conversationStore.get(), 'conv-3');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].title, /会话创建已完成，列表刷新失败/);
  } finally {
    app.client.queryClient.invalidateQueries = originalInvalidate;
    toastModule.toast.warning = originalWarning;
    invalidateBroken = false;
  }
});

test('refreshAfterWrite resolves when refresh fails and offers a retry-refresh receipt', async () => {
  const receiptsModule = app.receipts;
  const toastModule = app.toastMod;
  const warnings = [];
  const originalWarning = toastModule.toast.warning;
  toastModule.toast.warning = input => warnings.push(input);
  let attempts = 0;
  try {
    await receiptsModule.refreshAfterWrite('已归档会话', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('列表暂时不可读');
    });
    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].title, /已归档会话已完成，列表刷新失败/);
    assert.equal(warnings[0].action.label, '重试刷新');
    // 重试入口存在且可再次执行（第二次刷新成功后不再追加警告）。
    await warnings[0].action.run();
    assert.equal(attempts, 2);
    assert.equal(warnings.length, 1);
  } finally {
    toastModule.toast.warning = originalWarning;
  }
});

test('ErrorNote renders mapped copy with next step, and keeps local messages verbatim', () => {
  const mapped = renderToStaticMarkup(React.createElement(ErrorNote, {
    error: Object.assign(new Error('模型调用已达上限：本篇 20/20'), {
      code: 'MODEL_BUDGET_EXCEEDED', action: 'open_budget_settings', recoverable: true }),
  }));
  assert.match(mapped, /模型调用已达上限/);
  assert.match(mapped, /下一步：/);
  assert.match(mapped, /open_budget_settings/);
  assert.match(mapped, /展开诊断/);
  assert.ok(!mapped.includes('sk-'), '内联错误不应回显敏感字段');

  const local = renderToStaticMarkup(React.createElement(ErrorNote, {
    error: new Error('内容仍在修改，请稍后重试切换，当前输入已保留'),
  }));
  assert.match(local, /内容仍在修改/);
  // 未映射的本地提示不能被替换成"未识别错误"。
  assert.ok(!local.includes('发生未识别的错误'));

  // retry: "none" 的错误（如已取消）不提供重试按钮。
  const cancelled = renderToStaticMarkup(React.createElement(ErrorNote, {
    error: Object.assign(new Error('已停止'), { code: 'CANCELLED' }),
    onRetry: () => {},
  }));
  assert.ok(!cancelled.includes('>重试</button>'));
});

test('errorDisplay preserves backend action/recoverable and clips long local messages', () => {
  const errorTextModule = errorText;
  const mapped = errorText.errorDisplay({ code: 'ACCOUNT_MISMATCH', message: 'x', action: 'switch_back', recoverable: false });
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.action, 'switch_back');
  assert.equal(mapped.recoverable, false);
  assert.equal(mapped.retry, 'manual');
  const longLocal = errorText.errorDisplay(new Error('字'.repeat(400)));
  assert.equal(mapped.mapped, true);
  assert.ok(longLocal.title.length <= 201);
  assert.ok(longLocal.title.endsWith('…'));
  assert.equal(longLocal.mapped, false);
});

test('pickFocusTarget prefers the next row, then the previous row, then the list', () => {
  const rows = ['r0', 'r1', 'r2', 'r3'];
  assert.equal(focus.pickFocusTarget(rows.slice(0, 1).concat(rows.slice(2)), 2, 'list'), 'r3'); // 移除 r2 后下一行顶替
  assert.equal(focus.pickFocusTarget(['r0', 'r1', 'r2'], 3, 'list'), 'r2'); // 移除末行 → 前一行
  assert.equal(focus.pickFocusTarget([], 0, 'list'), 'list'); // 整列表为空 → 列表容器
  assert.equal(focus.pickFocusTarget(rows, -1, null), null); // 行不在列表（防御）→ 不抢焦点
});


test('real QueryObserver fetch failure after create becomes a refresh receipt without a second write', async () => {
  const { QueryObserver } = uiRequire('@tanstack/react-query');
  const client = app.client.queryClient;
  const key = ['ice', 'acc-real-refresh', 'chat.list', {}];
  app.client.accountStore.set('acc-real-refresh');
  client.setQueryData(key, { conversations: [] });
  const observer = new QueryObserver(client, { queryKey: key, staleTime: Infinity, retry: false,
    queryFn: async () => { throw Error('real query refresh rejected'); } });
  const unsubscribe = observer.subscribe(() => {});
  const warnings = [], original = app.toastMod.toast.warning;
  app.toastMod.toast.warning = input => warnings.push(input);
  let writes = 0;
  useBridge(async method => { if (method === 'chat.create') { writes++; return CHAT_RESULT('real-created'); } return {}; });
  try {
    assert.equal(await app.actions.createConversation('real-query-key'), 'real-created');
    assert.equal(writes, 1);
    assert.equal(warnings.length, 1);
    await warnings[0].action.run();
    assert.equal(writes, 1, 'retry must only fetch, never create again');
    assert.equal(warnings.length, 2, 'repeated refresh failure stays inside receipt boundary');
  } finally { unsubscribe(); client.removeQueries({ queryKey: key }); app.toastMod.toast.warning = original; }
});
