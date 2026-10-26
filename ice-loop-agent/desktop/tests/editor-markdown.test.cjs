// M3-02/03：markdownBridge（TS 源码）经 esbuild 转译后对共享 fixture 做
// 字节级 round-trip 与未知结构保留测试。与 Python 侧 test_v2_editor 共用
// tests/fixtures/editorial-sample.md（前后端 AST 一致性）。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const UI = path.join(__dirname, '..', 'ui');
const bridgeSrc = fs.readFileSync(path.join(UI, 'src', 'features', 'editor', 'markdownBridge.ts'), 'utf8');
const fixturePath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'editorial-sample.md');
const fixture = fs.readFileSync(fixturePath, 'utf8');

// 转译为 CJS 并落在 ui/ 内，使 require('unified') 从 ui/node_modules 解析。
const { code } = esbuild.transformSync(bridgeSrc, { loader: 'ts', format: 'cjs', target: 'node20' });
const tempModule = path.join(UI, '.bridge-under-test.cjs');
fs.writeFileSync(tempModule, code, 'utf8');
process.on('exit', () => { try { fs.unlinkSync(tempModule); } catch { /* 清理失败不遮蔽结果 */ } });
const bridge = require(tempModule);

test('fixture parses to expected block types', () => {
  const doc = bridge.markdownToDoc(fixture);
  const types = doc.content.map(n => n.type);
  assert.deepStrictEqual(types, [
    'heading', 'paragraph', 'heading', 'codeBlock', 'imageSlot', 'blockquote',
    'bulletList', 'orderedList', 'horizontalRule', 'runOutput', 'rawBlock',
  ]);
});

test('byte round-trip on shared fixture', () => {
  const doc = bridge.markdownToDoc(fixture);
  const out = bridge.docToMarkdown(doc);
  // 文档模型表示块结构，不含文件尾换行；其余字节必须一致。
  assert.strictEqual(out, fixture.replace(/\n+$/, ''), '受支持结构与 raw 块应语义往返且字节不变');
  assert.strictEqual(bridge.docToMarkdown(bridge.markdownToDoc(out)), out, '输出自身幂等');
});

test('round-trip is idempotent after edit', () => {
  const doc = bridge.markdownToDoc(fixture);
  // 模拟编辑：改第一段文本
  doc.content[1].content[0].text = '编辑后的段落，含**新加粗**。';
  const once = bridge.docToMarkdown(doc);
  const twice = bridge.docToMarkdown(bridge.markdownToDoc(once));
  assert.strictEqual(twice, once, '编辑后的 Markdown 再次往返应稳定');
  assert.ok(once.includes('编辑后的段落'));
  assert.ok(once.includes('待配图'), '图位占位符保留');
});

test('unknown html block preserved verbatim', () => {
  const md = fixture + '\n<div class="embed">自定义 HTML</div>\n';
  const doc = bridge.markdownToDoc(md);
  const raw = doc.content.find(n => n.type === 'rawBlock' && String(n.attrs.source).includes('<div'));
  assert.ok(raw, 'HTML 块应成为 rawBlock');
  assert.ok(bridge.docToMarkdown(doc).includes('<div class="embed">自定义 HTML</div>'), 'raw 原文保留');
});

test('run output ref survives and placeholder fields intact', () => {
  const doc = bridge.markdownToDoc(fixture);
  const slot = doc.content.find(n => n.type === 'imageSlot');
  assert.strictEqual(slot.attrs.figureNo, 2);
  assert.strictEqual(slot.attrs.kind, '终端截图');
  assert.strictEqual(slot.attrs.obtain, '真实运行后截图');
  const run = doc.content.find(n => n.type === 'runOutput');
  assert.strictEqual(run.attrs.runRef, 'run-abc123');
});


test('outline shares Markdown syntax: fenced/quoted examples excluded, duplicate and setext headings retained', () => {
  const md = '# **Main** `code`\r\n\r\n```python\r\n# fake\r\n```\r\n\r\n> ## quoted\r\n\r\n## Same\r\n\r\nSame\r\n----\r\n';
  const headings = bridge.markdownHeadings(md);
  assert.deepStrictEqual(headings, [
    {index:0, level:1, text:'Main code', line:1},
    {index:1, level:2, text:'Same', line:9},
    {index:2, level:2, text:'Same', line:11},
  ]);
  assert.strictEqual(bridge.markdownToDoc(md).content.filter(n=>n.type==='heading').length,headings.length);
  assert.deepStrictEqual(bridge.markdownHeadings('plain text\n\n    # indented code\n'),[]);
});
