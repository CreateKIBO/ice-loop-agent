const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, escapeHTML } = require('../renderer/markdown.js');
test('raw HTML and script inside code are escaped', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n```html\n<script>bad()</script>\n```');
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
});
test('untrusted links do not become navigable URLs', () => {
  assert.ok(!renderMarkdown('[hello](javascript:alert(1))').includes('href='));
  assert.ok(!renderMarkdown('![图1：图](https://remote.invalid/image.png)').includes('<img'));
});
test('only managed image data can appear in preview', () => {
  assert.ok(renderMarkdown('![图1：截图](images/test.png)', {1:'data:image/png;base64,AAAA'}).includes('<img'));
  assert.ok(!renderMarkdown('![图1：截图](images/test.png)', {1:'data:image/svg+xml;base64,AAAA'}).includes('<img'));
});
test('article headings and literal console output are preserved', () => {
  const html = renderMarkdown('# 标题\n\n## 一、示例\n\n```text\n<hello>\n```');
  assert.ok(html.includes('<h1>标题</h1>') && html.includes('&lt;hello&gt;'));
  assert.equal(escapeHTML('"<&'), '&quot;&lt;&amp;');
});
