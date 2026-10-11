'use strict';
// C1：事件流纯函数——去重合并、游标分页、步骤折叠。不依赖 React 与桥接。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// esbuild 0.25 的 transformSync 不再输出 module.exports 赋值，改用 bundle 产物。
const bundled = path.resolve(__dirname, '../.test-tmp/event-stream.cjs');
fs.mkdirSync(path.dirname(bundled), { recursive: true });
esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../ui/src/data/eventStream.ts')],
  bundle: true, format: 'cjs', platform: 'node', outfile: bundled, logLevel: 'silent',
});
// esbuild 的导出标注是 `0 && (module.exports = {...})`，作为表达式语句不会执行；补一行真实赋值。
const sandbox = { exports: {}, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(bundled, 'utf8') + '\nmodule.exports = { MAX_STREAM_EVENTS, PHASE_LABEL, TOOL_LABEL, advanceCursor, formatElapsed, mergeEvents, needsBackfill, phaseFromMetadata, toolSignal, turnSteps };\n', sandbox);
// vm 上下文里的对象与主上下文不是同一引用，先 JSON 往返再比较。
const into = value => JSON.parse(JSON.stringify(value));
const api = sandbox.module.exports;
const mergeEvents = (...args) => into(api.mergeEvents(...args));
const advanceCursor = api.advanceCursor;
const needsBackfill = api.needsBackfill;
const turnSteps = (...args) => into(api.turnSteps(...args));
const phaseFromMetadata = value => into(api.phaseFromMetadata(value));
const toolSignal = api.toolSignal;
const formatElapsed = api.formatElapsed;

const ev = (sequence, type, payload, created_at) => ({ sequence, type, payload, created_at });

test('merge dedupes by sequence, keeps order and caps the tail', () => {
  const first = [ev(1, 'turn.started', { turn_id: 'm1' }), ev(2, 'turn.phase', { turn_id: 'm1', phase: 'waiting_model' })];
  const merged = mergeEvents(first, [first[1], ev(3, 'turn.finished', { turn_id: 'm1', status: 'completed' })]);
  assert.deepEqual(merged.map(row => row.sequence), [1, 2, 3]);
  // 重复页返回同一引用，便于 React 跳过渲染。
  assert.equal(api.mergeEvents(merged, [merged[2]]), merged);
  const many = Array.from({ length: 450 }, (_, index) => ev(index + 1, 'turn.phase', { phase: 'receiving' }));
  const capped = mergeEvents([], many);
  assert.equal(capped.length, 400);
  assert.equal(capped[0].sequence, 51);
});

test('cursor advances only by received events so a page limit never skips the gap', () => {
  const page = [ev(6, 'turn.phase', { phase: 'receiving' })];
  assert.equal(advanceCursor(5, page), 6);
  assert.equal(needsBackfill(6, 20), true);
  assert.equal(needsBackfill(20, 20), false);
  assert.equal(needsBackfill(6, Number.NaN), false);
});

test('turn steps fold real events in order and collapse repeated phases', () => {
  const events = [
    ev(1, 'turn.started', { turn_id: 'm1', started_at: '2026-10-11T12:00:00+08:00', citations: 2 }, '2026-10-11T12:00:00+08:00'),
    ev(2, 'turn.phase', { turn_id: 'm1', phase: 'waiting_model', model_id: 'glm-5.3' }, '2026-10-11T12:00:01+08:00'),
    ev(3, 'turn.phase', { turn_id: 'm1', phase: 'receiving' }, '2026-10-11T12:00:02+08:00'),
    ev(4, 'turn.phase', { turn_id: 'm1', phase: 'receiving' }, '2026-10-11T12:00:03+08:00'),
    ev(5, 'turn.phase', { turn_id: 'm9', phase: 'validating' }, '2026-10-11T12:00:04+08:00'),
  ];
  const progress = turnSteps(events, 'm1');
  assert.equal(progress.startedAt, '2026-10-11T12:00:00+08:00');
  assert.deepEqual(progress.steps.map(step => [step.label, step.status]), [
    ['读取历史与资料', 'done'], ['等待模型响应', 'done'], ['模型生成中', 'active'],
  ]);
  assert.equal(progress.steps[0].detail, '引文 2');
  assert.equal(progress.steps[1].detail, 'glm-5.3');
  assert.equal(progress.current.label, '模型生成中');
  assert.equal(progress.finished, null);
});

test('finished turns settle steps and a failed tool marks only that step', () => {
  const completed = turnSteps([
    ev(1, 'turn.phase', { turn_id: 'm1', phase: 'tools' }),
    ev(2, 'tool.started', { turn_id: 'm1', tool: 'search_articles' }),
    ev(3, 'tool.finished', { turn_id: 'm1', tool: 'search_articles', status: 'succeeded' }),
    ev(4, 'turn.finished', { turn_id: 'm1', status: 'completed', phase: 'ready', candidate_id: 'cand-1' }),
  ], 'm1');
  assert.deepEqual(completed.steps.map(step => step.status), ['done', 'done', 'done']);
  assert.equal(completed.steps[0].label, '执行工具');
  assert.equal(completed.steps[1].label, '执行工具 · 检索旧文');
  assert.equal(completed.finished.candidateId, 'cand-1');
  assert.equal(completed.current, null);

  const failed = turnSteps([
    ev(1, 'tool.started', { turn_id: 'm2', tool: 'unknown_tool' }),
    ev(2, 'tool.finished', { turn_id: 'm2', tool: 'unknown_tool', status: 'failed' }),
    ev(3, 'turn.finished', { turn_id: 'm2', status: 'failed', error_message: '网络暂时不可用' }),
  ], 'm2');
  assert.deepEqual(failed.steps.map(step => step.status), ['failed', 'failed']);
  assert.equal(failed.finished.errorMessage, '网络暂时不可用');
});

test('metadata fallback reads the object progress and never treats it as text', () => {
  const fromObject = phaseFromMetadata({ progress: { phase: 'waiting_model', started_at: '2026-10-11T12:00:00+08:00' } });
  assert.deepEqual(fromObject, { phase: 'waiting_model', label: '等待模型响应', startedAt: '2026-10-11T12:00:00+08:00' });
  assert.equal(phaseFromMetadata({ progress: { phase: '' } }), null);
  assert.equal(phaseFromMetadata(null), null);
  assert.deepEqual(phaseFromMetadata({ progress: 'receiving' }), { phase: 'receiving', label: '模型生成中' });
});

test('tool signal tracks the latest tool or finish event and elapsed time is real', () => {
  const events = [
    ev(1, 'turn.started', { turn_id: 'm1' }),
    ev(2, 'tool.started', { turn_id: 'm1', tool: 'search_articles' }),
    ev(3, 'turn.finished', { turn_id: 'm1', status: 'completed' }),
  ];
  assert.equal(toolSignal(events), 3);
  assert.equal(toolSignal([events[0]]), 0);
  assert.equal(formatElapsed(1500), '1 秒');
  assert.equal(formatElapsed(75_000), '1 分 15 秒');
});
