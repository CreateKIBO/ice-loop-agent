const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/planning.js'), 'utf8');
const nodes = {};
const sandbox = {
  document: {addEventListener() {}, querySelector(sel) { return nodes[sel] || (nodes[sel] = {innerHTML: '', textContent: ''}); }},
  console,
};
vm.createContext(sandbox);
vm.runInContext(source + '\n;globalThis.__hist={historyState,historyFilteredRows,historyCountText,renderHistoryList};', sandbox);
const hist = sandbox.__hist;

sandbox.activeAccount = () => ({columns: [
  {code: 'PY', name: 'Python 从 0 到 1'},
  {code: 'JV', name: 'Java 打怪升级'},
  {code: 'WK', name: '工具周刊'},
]});
sandbox.esc = value => String(value);
sandbox.badge = () => '';

const rows = [
  {history_id: 'h1', content_hash: 'a', title: '循环入门', series: 'PY', episode: 5, status: 'published', published_at: '2026-09-28'},
  {history_id: 'h2', content_hash: 'b', title: 'JDK 避坑', series: 'JV', episode: 1, status: 'draft', published_at: ''},
  {history_id: 'h3', content_hash: 'c', title: '装备清单', series: 'WK', episode: 1, status: 'published', published_at: '2026-09-26'},
  {history_id: 'h4', content_hash: 'd', title: '未归类', series: null, episode: null, status: 'draft', published_at: ''},
];

function countRecords() { return (nodes['#history-list'].innerHTML.match(/class="publication-panel history-record"/g) || []).length; }

test('history filter helpers load with the module', () => {
  assert.equal(typeof hist.renderHistoryList, 'function');
  assert.equal(typeof hist.historyCountText, 'function');
});

test('no filter shows every record with a plain total', () => {
  hist.historyState.rows = rows; hist.historyState.filter = '';
  hist.renderHistoryList();
  assert.equal(hist.historyCountText(), '历史文章 · 4 篇');
  assert.equal(countRecords(), 4);
});

test('series filter narrows list and shows shown/total count', () => {
  hist.historyState.filter = 'PY';
  hist.renderHistoryList();
  assert.equal(hist.historyCountText(), '历史文章 · 1/4 篇');
  assert.equal(countRecords(), 1);
  assert.match(nodes['#history-list'].innerHTML, /循环入门/);
  assert.doesNotMatch(nodes['#history-list'].innerHTML, /装备清单/);
});

test('unsorted filter selects records without a series', () => {
  hist.historyState.filter = '__none__';
  hist.renderHistoryList();
  assert.equal(countRecords(), 1);
  assert.match(nodes['#history-list'].innerHTML, /未归类/);
});

test('empty filter result explains the series has no records yet', () => {
  hist.historyState.filter = 'JV';
  hist.historyState.rows = rows.slice(0, 1);   // 只有 PY
  hist.renderHistoryList();
  assert.equal(countRecords(), 0);
  assert.match(nodes['#history-list'].innerHTML, /该栏目还没有历史文章/);
  assert.equal(hist.historyCountText(), '历史文章 · 0/1 篇');
});

test('records keep editable fields after filtering', () => {
  hist.historyState.rows = rows; hist.historyState.filter = 'WK';
  hist.renderHistoryList();
  const html = nodes['#history-list'].innerHTML;
  assert.match(html, /name="series"/);
  assert.match(html, /name="episode"/);
  assert.match(html, /name="published_at"/);
  assert.match(html, /data-plan-action="preview-history"/);
});
