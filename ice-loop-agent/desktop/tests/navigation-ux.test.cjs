const {test} = require('node:test');
const assert = require('node:assert/strict');
const {records, search, pages, LocalSearch, NavigationGate} = require('../renderer/navigation-ux.js');

test('identical titles keep distinct conversations while duplicate identities collapse', () => {
  const rows = records({conversations: [{id: 'c1', title: '同一标题'}, {id: 'c2', title: '同一标题'}, {id: 'c1', title: '同一标题'}], drafts: [{draft_id: 'c1', title: '同一标题'}]}, 'account');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => `${row.kind}:${row.id}`), ['conversation:c1', 'conversation:c2', 'draft:c1']);
});

test('archived, deleted, and foreign-publication records never enter local search', () => {
  const conversations = [{id: 'active'}, {id: 'archived', archived: 1}, {id: 'removed', deleted: true}, {id: 'legacy', deleted_at: '2026-10-04'}, {id: 'foreign', account_id: 'other'}];
  const jobs = [{job_id: 'active-job', visibility: 'active'}, {job_id: 'hidden', visibility: 'archived'}];
  const rows = records({conversations, jobs}, 'account');
  assert.deepEqual(rows.map(row => row.id), ['active', 'active-job']);
});

test('search matches multiple title, series, and kind tokens with normalized case', () => {
  const rows = records({jobs: [{job_id: 'loop', topic: 'for 与 while 循环', series: 'PY', episode: 17, state: 'paused'}, {job_id: 'java', topic: '循环进阶', series: 'JV'}]}, 'account');
  const result = search(rows, 'ＰＹ   循环 任务');
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 'loop');
  assert.match(result.items[0].meta, /017/);
});

test('specific title matches rank above page metadata matches', () => {
  const rows = records({conversations: [{id: 'draft-chat', title: '草稿：下一期怎么写'}]}, 'account');
  const result = search(rows, '草稿');
  assert.equal(result.items[0].id, 'draft-chat');
  assert.ok(result.items.some(row => row.id === 'drafts'));
});

test('blank search retains newest records first and page shortcuts remain available', () => {
  const rows = records({conversations: [{id: 'older', updated_at: '2026-09-01'}, {id: 'latest', updated_at: '2026-10-04'}]}, 'account');
  const result = search(rows, '');
  assert.equal(result.items[0].id, 'latest');
  assert.equal(result.total, rows.length + pages.length);
  assert.ok(result.items.some(row => row.id === 'models'));
});

test('result limit keeps total count so users can refine broad matches', () => {
  const rows = records({drafts: Array.from({length: 110}, (_unused, index) => ({draft_id: String(index), title: `稿件 ${index}`}))}, 'account');
  const result = search(rows, '稿件');
  assert.equal(result.items.length, 60);
  assert.equal(result.total, 110);
});

test('loading only uses local read methods with explicit frozen account identity', async () => {
  const calls = [];
  const model = new LocalSearch(async (method, params) => { calls.push({method, params}); return []; }, () => ({id: 'account-a'}));
  const result = await model.load();
  assert.equal(result.stale, false);
  assert.deepEqual(calls.map(call => call.method), ['chat.list', 'chat.drafts', 'jobs.list']);
  assert.ok(calls.every(call => call.params.account_id === 'account-a'));
  assert.deepEqual(calls[0].params, {account_id: 'account-a', archived: false, deleted: false});
  assert.deepEqual(calls[2].params, {account_id: 'account-a', visibility: 'active'});
});

test('one failed source does not block other local records or page actions', async () => {
  const model = new LocalSearch(async method => {
    if (method === 'chat.list') throw Error('engine temporarily unavailable');
    if (method === 'chat.drafts') return [{draft_id: 'saved', title: '已保存的稿件'}];
    return [];
  }, () => ({id: 'a'}));
  const result = await model.load();
  assert.deepEqual(result.errors, ['会话']);
  assert.equal(result.rows[0].id, 'saved');
  assert.ok(search(model.rows, 'TapNow').items.some(row => row.id === 'browser'));
});

test('an invalid source response is isolated instead of breaking the search dialog', async () => {
  const model = new LocalSearch(async method => method === 'chat.list' ? {error: 'not a list'} : [], () => ({id: 'a'}));
  const result = await model.load();
  assert.deepEqual(result.errors, ['会话']);
  assert.deepEqual(result.rows, []);
  assert.ok(search(model.rows, '模型').items.some(row => row.id === 'models'));
});

test('account switch during pending reads rejects all previous publication results', async () => {
  let current = 'a', release;
  const barrier = new Promise(resolve => { release = resolve; });
  const model = new LocalSearch(async method => { await barrier; return method === 'chat.list' ? [{id: 'private-a', title: 'A 公众号内容'}] : []; }, () => ({id: current}));
  const pending = model.load(); current = 'b'; release();
  assert.equal((await pending).stale, true);
  assert.deepEqual(model.rows, []);
});

test('closed and reopened palette ignores delayed older load even within same account', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let first = true;
  const model = new LocalSearch(async method => {
    const delayed = first;
    if (method === 'jobs.list') first = false;
    if (delayed) await barrier;
    return method === 'chat.list' ? [{id: delayed ? 'old' : 'new'}] : [];
  }, () => ({id: 'a'}));
  const old = model.load(); model.invalidate(); const latest = await model.load(); release();
  assert.equal(latest.stale, false);
  assert.equal((await old).stale, true);
  assert.deepEqual(model.rows.map(row => row.id), ['new']);
});

test('invalidate immediately drops previous publication results before next read', async () => {
  const model = new LocalSearch(async method => method === 'chat.list' ? [{id: 'local'}] : [], () => ({id: 'a'}));
  await model.load(); assert.equal(model.rows.length, 1); model.invalidate();
  assert.deepEqual(model.rows, []);
  assert.equal(model.accountId, '');
});

test('a second palette request during target navigation opens when that navigation finishes', () => {
  const gate = new NavigationGate();
  assert.equal(gate.requestOpen('a'), true);
  gate.begin(); assert.equal(gate.requestOpen('a'), false);
  assert.equal(gate.busy, true);
  assert.equal(gate.finish('a'), true);
  assert.equal(gate.busy, false);
  assert.equal(gate.pendingAccount, '');
});

test('a queued open request is discarded when publication changes before navigation finishes', () => {
  const gate = new NavigationGate(); gate.begin(); gate.requestOpen('a');
  assert.equal(gate.finish('b'), false);
  assert.equal(gate.busy, false);
  assert.equal(gate.pendingAccount, '');
});

test('cancelling a queued open prevents an unexpected palette appearing after navigation', () => {
  const gate = new NavigationGate(); gate.begin(); gate.requestOpen('a'); gate.cancelOpen();
  assert.equal(gate.finish('a'), false);
  assert.equal(gate.requestOpen('a'), true);
});
