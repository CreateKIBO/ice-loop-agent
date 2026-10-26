// 批次1-52 边界回归：display.ts / errorText.ts 真实行为（Node 直跑产物模块）。
// 用 esbuild 转译 TS 源码后 require，与 editor-markdown.test.cjs 同模式。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const UI = path.join(__dirname, '..', 'ui');
let moduleCounter = 0;
function loadModule(rel) {
  const src = fs.readFileSync(path.join(UI, rel), 'utf8');
  const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node20' });
  // 每个模块用唯一临时文件：require 按路径缓存，共用一个文件会返回上一个模块。
  const temp = path.join(UI, `.module-under-test-${++moduleCounter}.cjs`);
  fs.writeFileSync(temp, code, 'utf8');
  try { return require(temp); } finally { try { fs.unlinkSync(temp); } catch { /* 保留则下次覆盖 */ } }
}

const display = loadModule('src/components/display.ts');
const errorText = loadModule('src/components/errorText.ts');

// ---- display.formatDuration：未知值兜底 ----
test('formatDuration handles unknown and humanizes known values', () => {
  assert.equal(display.formatDuration(null), '—');
  assert.equal(display.formatDuration(undefined), '—');
  assert.equal(display.formatDuration(Number.NaN), '—');
  assert.equal(display.formatDuration(500), '500ms');
  assert.ok(display.formatDuration(1500).endsWith('s'));
  assert.ok(display.formatDuration(125_000).startsWith('2m'));
});

// ---- display.formatBytes：未知与 1024 进 ----
test('formatBytes handles unknown and 1024-based units', () => {
  assert.equal(display.formatBytes(null), '—');
  assert.equal(display.formatBytes(-1), '—');
  assert.equal(display.formatBytes(512), '512 B');
  assert.ok(display.formatBytes(2048).includes('KB'));
  assert.ok(display.formatBytes(5 * 1024 * 1024).includes('MB'));
});

// ---- display.taskStateLabel：未知状态原值直显（可见兜底，不当成功）----
test('taskStateLabel maps known states and falls back to raw value', () => {
  assert.equal(display.taskStateLabel('waiting_user'), '等待人工处理');
  assert.equal(display.taskStateLabel('totally-new-state'), 'totally-new-state');
  assert.equal(display.taskStateLabel(null), '未知状态');
  assert.equal(display.taskStateLabel(''), '未知状态');
});

// ---- display.formatTimestamp：无效 ISO 原串兜底 ----
test('formatTimestamp falls back to raw string for invalid ISO', () => {
  assert.equal(display.formatTimestamp('not-a-date'), 'not-a-date');
  assert.equal(display.formatTimestamp(null), '—');
  const hm = display.formatTimestamp(new Date().toISOString());
  assert.match(hm, /^\d{2}:\d{2}$/); // 当天只显示时分
});

// ---- errorText：已知码 → 可操作文案；未知码不吞 ----
test('errorCopy maps known codes with actionable next steps', () => {
  const copy = errorText.errorCopy({ code: 'MODEL_BUDGET_EXCEEDED', message: 'x' });
  assert.equal(copy.title, '模型调用已达上限');
  assert.ok(copy.nextStep.includes('预算'));
  assert.equal(copy.retry, 'manual');
});

test('errorCopy keeps unknown codes visible with fallback copy', () => {
  const copy = errorText.errorCopy({ code: 'SOME_FUTURE_CODE', message: 'boom' });
  assert.notEqual(copy.title, '');
  assert.equal(errorText.errorCode({ code: 'SOME_FUTURE_CODE' }), 'SOME_FUTURE_CODE');
  assert.equal(errorText.errorCode(new Error('no code')), 'UNKNOWN');
  assert.equal(errorText.errorCode(null), 'UNKNOWN');
});

// ---- errorText：中文消息级兜底（引擎无稳定码的常见形态）----
test('errorCopy recognizes Chinese message patterns for conflict and account switch', () => {
  const conflict = errorText.errorCopy(new Error('正文已变化，请先刷新'));
  assert.equal(conflict.title, '内容已被更新');
  const switched = errorText.errorCopy(new Error('公众号已切换，请刷新任务列表'));
  assert.equal(switched.title, '公众号已切换');
});

// ---- errorText.diagnosticText：脱敏 + 截断 + 保留错误码 ----
test('diagnosticText redacts secrets, clips length, and keeps the code', () => {
  const text = errorText.diagnosticText({
    code: 'AUTH_FAILED',
    message: 'key = sk-abcdef1234567890xyz Bearer abc.def.ghi ' + 'x'.repeat(500),
  });
  assert.ok(text.startsWith('[AUTH_FAILED]'));
  assert.ok(!text.includes('sk-abcdef1234567890xyz'));
  assert.ok(!/[Bb]earer\s+abc/.test(text));
  assert.ok(text.length < 400); // 300 截断 + 前缀
});

test('real RPC objects preserve their message and embedded engine error code', () => {
  const value={code:'INTERNAL_ERROR',message:'Error invoking remote method: [MODEL_TIMEOUT] 等待超时'};
  assert.equal(errorText.errorCode(value),'MODEL_TIMEOUT');
  assert.equal(errorText.errorCopy(value).title,'模型请求超时');
  assert.ok(errorText.diagnosticText(value).includes('等待超时'));
  assert.ok(!errorText.diagnosticText(value).includes('[object Object]'));
  assert.equal(errorText.errorCode('[CONTEXT_LENGTH] too long'),'CONTEXT_LENGTH');
});

test('diagnostics redact quoted fields, non-sk tokens and URL credentials before clipping', () => {
  for(const message of [
    '{"api_key":"vendor-credential-example", "password":"pwd-example"}',
    'access_token=vendor-credential-example&next=page',
    'https://user-example:pwd-example@localhost/path',
    'Authorization: Bearer vendor-credential-example',
  ]){
    const text=errorText.diagnosticText({code:'AUTH_FAILED',message});
    assert.ok(!text.includes('vendor-credential-example'),text);
    assert.ok(!text.includes('pwd-example'),text);
  }
});

test('unknown write outcomes do not recommend blind automatic retry', () => {
  assert.equal(errorText.errorCopy({code:'FUTURE_WRITE_ERROR',message:'unknown'}).retry,'manual');
  assert.equal(errorText.errorCopy({code:'CONTENT_REFUSED',message:'no'}).retry,'manual');
  assert.equal(errorText.errorCopy({code:'MODEL_TIMEOUT',message:'slow'}).retry,'manual');
});

test('task display keeps the existing awaiting_user contract and rejects negative duration', () => {
  assert.equal(display.taskStateLabel('awaiting_user'),'需要你的处理');
  assert.equal(display.taskStateLabel('toString'),'toString');
  assert.equal(display.saveStateLabel('constructor'),'constructor');
  assert.equal(display.formatDuration(-10),'—');
});


test('unknown inline titles and backend actions redact credentials before clipping', () => {
  for (const message of ['api_key=vendor-secret-123', 'https://user:pass-123@localhost/fail',
    'Authorization: Bearer vendor-secret-123', 'a'.repeat(195) + ' access_token=vendor-secret-123']) {
    const shown = errorText.errorDisplay({ message, action: message });
    for (const field of [shown.title, shown.action, shown.diagnostic]) {
      assert.ok(!field.includes('vendor-secret-123') && !field.includes('pass-123'), field);
    }
  }
  assert.equal(errorText.errorDisplay(Error('请输入标题')).title, '请输入标题');
});
