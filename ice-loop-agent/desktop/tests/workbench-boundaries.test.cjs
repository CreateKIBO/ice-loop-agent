'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const desktop = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(desktop, 'ui/src/data/workbenchResponses.ts'), 'utf8');
const sandbox = { exports: {}, module: { exports: {} } };
vm.runInNewContext(esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code, sandbox);
const { chatResult, jobRows } = sandbox.module.exports;

test('real chat response envelope is accepted; legacy array and malformed messages fail at boundary', () => {
  const result = { conversation: { id: 'conversation-1', title: '讨论' },
    messages: [{ id: 'message-1', role: 'assistant', content: '正文', status: 'completed' }],
    candidates: [], current: {} };
  assert.equal(chatResult(result), result);
  assert.throws(() => chatResult(result.messages), /响应格式/);
  assert.throws(() => chatResult({ ...result, messages: [{}] }), /响应格式/);
});

test('jobs.list is an array; object-shaped response is rejected', () => {
  const rows = [{ job_id: 'job-1', topic: '题目' }];
  assert.equal(jobRows(rows)[0].job_id, 'job-1');
  assert.throws(() => jobRows({ jobs: rows }), /响应格式/);
});

test('new workbench calls are explicitly allowed while internal and unfinished writes stay private', () => {
  const publicMethods = require('../workbench-methods.cjs');
  const methods = new Set(publicMethods);
  assert.equal(methods.size, publicMethods.length);
  assert.ok(methods.has('articles.document'));
  assert.ok(methods.has('articles.editor_draft_save'));
  assert.ok(methods.has('workflow.graph'));
  // 批次一（R05/R06/R13）完成可信导出链后 export_bundle 经 allowlist 开放：
  // 目录只能来自 ice:choose-export-dir 用户选择，Python 端再次校验。
  assert.ok(methods.has('articles.export_bundle'));
  assert.ok(methods.has('articles.delivery_snapshot') && methods.has('articles.delivery_confirm'));
  for (const method of ['downloads.stage', 'downloads.bind', 'downloads.list', 'assets.capture_status']) {
    assert.ok(methods.has(method), method);
  }
  for (const privateMethod of ['agent.run_turn', 'models.probe_capabilities', 'unknown.method']) {
    assert.ok(!methods.has(privateMethod));
  }
  const config = JSON.parse(fs.readFileSync(path.join(desktop, 'electron-builder.json'), 'utf8'));
  assert.ok(config.files.includes('workbench-methods.cjs'), 'new IPC module must ship with main');
});

test('v3: document methods are public, main-only document calls and retired execution calls are not', () => {
  const methods = new Set(require('../workbench-methods.cjs'));
  for (const method of ['documents.list', 'documents.save_working', 'documents.import_paste', 'documents.render_delivery',
    'documents.export_bundle', 'bookmarks.list', 'publications.register']) assert.ok(methods.has(method), method);
  // 剪贴板载荷、交付登记与按路径导入图片只能由主进程发起。
  for (const method of ['documents.copy_payload', 'documents.delivery_record', 'documents.image_import']) assert.ok(!methods.has(method), method);
  const main = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
  const allow = main.slice(main.indexOf('const methods = new Set(['), main.indexOf("methods.add('tools.execution_settings')"));
  for (const retired of ["'execution.approve'", "'execution.inputs'", "'supplements.execute'", "'supplements.prepare'"]) {
    assert.ok(!allow.includes(retired), retired + ' must stay off the renderer allowlist (C-03)');
  }
  assert.ok(!main.includes("methods.add('execution.code_save')") && !main.includes("methods.add('execution.policy_save')"));
});
