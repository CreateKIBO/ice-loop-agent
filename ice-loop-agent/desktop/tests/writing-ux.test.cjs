'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createInputStore, submittedInput, articleMetrics, contextMatches, keyFor, STORAGE_KEY, INPUT_LIMIT, DRAFT_LIMIT, DRAFT_TTL} = require('../renderer/writing-ux.js');
const memoryStorage = () => { const rows = new Map(); return {getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value)}; };

test('unsent inputs survive reload and remain isolated by account and conversation', () => {
  const storage = memoryStorage(), store = createInputStore(storage, () => 1000);
  store.set('ice', 'a', '第一篇文章的想法'); store.set('ice', 'b', '第二篇文章'); store.set('other', 'a', '另一个公众号');
  const reloaded = createInputStore(storage, () => 1001);
  assert.equal(reloaded.get('ice', 'a'), '第一篇文章的想法');
  assert.equal(reloaded.get('ice', 'b'), '第二篇文章');
  assert.equal(reloaded.get('other', 'a'), '另一个公众号');
  assert.equal(reloaded.get('third', 'a'), '');
  assert.notEqual(keyFor('a:b', 'c'), keyFor('a', 'b:c'));
});
test('a successful send clears only the exact submitted input', () => {
  const store = createInputStore(memoryStorage(), () => 1000);
  store.set('ice', 'a', '  写一篇文章\n');
  assert.equal(store.clearSubmitted('ice', 'a', '写一篇文章'), true);
  assert.equal(store.get('ice', 'a'), '');
  store.set('ice', 'a', '正在输入的下一条消息');
  assert.equal(store.clearSubmitted('ice', 'a', '写一篇文章'), false);
  assert.equal(store.get('ice', 'a'), '正在输入的下一条消息');
  assert.equal(submittedInput(' 新的输入 ', '上一条'), ' 新的输入 ');
  assert.equal(submittedInput('  原始请求\n', '原始请求'), '');
});
test('an acknowledgement for a previous account cannot erase the current account input', () => {
  const store = createInputStore(memoryStorage(), () => 1000);
  store.set('ice', 'a', '请求'); store.set('other', 'a', '请求');
  store.clearSubmitted('ice', 'a', '请求');
  assert.equal(store.get('other', 'a'), '请求');
});
test('mounted input actions require both the current account and conversation', () => {
  const mounted = {accountId: 'ice', conversationId: 'a'};
  assert.equal(contextMatches(mounted, 'ice', 'a'), true);
  assert.equal(contextMatches(mounted, 'other', 'a'), false);
  assert.equal(contextMatches(mounted, 'ice', 'b'), false);
  assert.equal(contextMatches(mounted, 'ice', null), false);
  assert.equal(contextMatches(null, 'ice', 'a'), false);
  assert.equal(contextMatches({accountId: '', conversationId: '__new__'}, '', null), false);
  assert.equal(contextMatches({accountId: 'ice', conversationId: '__new__'}, 'ice', null), true);
});
test('history is bounded, drops expired entries, and truncates only at the input limit', () => {
  const storage = memoryStorage(); let now = 1000; const store = createInputStore(storage, () => now);
  for (let i = 0; i < DRAFT_LIMIT + 5; i++) { now++; store.set('ice', String(i), '想法'); }
  assert.equal(store.count(), DRAFT_LIMIT); assert.equal(store.get('ice', '0'), '');
  store.set('ice', 'long', '字'.repeat(INPUT_LIMIT + 100));
  assert.equal(store.get('ice', 'long').length, INPUT_LIMIT);
  now += DRAFT_TTL + 1;
  assert.equal(store.count(), 0);
});
test('invalid or hostile persisted rows cannot inject fields into the ledger', () => {
  const storage = memoryStorage(); storage.setItem(STORAGE_KEY, JSON.stringify({version: 1, drafts: [
    {accountId: 'ice', conversationId: 'a', text: '可以恢复', updatedAt: 1000, api_key: 'must-not-persist'},
    {accountId: 'ice', conversationId: 'future', text: 'wrong', updatedAt: 10000000},
    {accountId: {}, conversationId: 'bad', text: 'wrong', updatedAt: 1000},
    {accountId: 'ice', conversationId: 'bad', text: {}, updatedAt: 1000}
  ]}));
  const store = createInputStore(storage, () => 1000); store.set('ice', 'b', '新输入');
  assert.equal(store.count(), 2);
  assert.equal(storage.getItem(STORAGE_KEY).includes('must-not-persist'), false);
});
test('storage failures preserve current-window inputs without throwing or claiming persistence', () => {
  const storage = {getItem() { throw Error('access denied'); }, setItem() { throw Error('quota'); }};
  const store = createInputStore(storage, () => 1000);
  assert.equal(store.set('ice', 'a', '没有丢失'), false);
  assert.equal(store.persistent(), false); assert.equal(store.get('ice', 'a'), '没有丢失');
  assert.equal(store.clearSubmitted('ice', 'a', '没有丢失'), true);
});
test('explicitly clearing the input removes its recovery record', () => {
  const store = createInputStore(memoryStorage(), () => 1000);
  store.set('ice', 'a', '旧想法'); store.set('ice', 'a', '');
  assert.equal(store.get('ice', 'a'), ''); assert.equal(store.count(), 0);
});
test('article metrics count Unicode characters and blank-line paragraphs without mutating text', () => {
  assert.deepEqual(articleMetrics('你好 👋\n\nHello'), {characters: 8, paragraphs: 2});
  assert.deepEqual(articleMetrics(' \n\t'), {characters: 0, paragraphs: 0});
});
