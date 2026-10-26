'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditRemovals } = require('./lifecycle-trace.cjs');
const node = { id: 3, kind: 'dialog', title: '最终交付审阅' };
const trace = removals => ({ actions: [{ name: 'prepare-image', at: 100, finished: 200, nodes: [node] }], removals });
test('expected close matches captured node exactly once within user action', () => {
  assert.deepEqual(auditRemovals(trace([{ ...node, at: 150 }])), { unexpected: [], missingOrRepeated: [] });
  for (const event of [{ ...node, id: 4, at: 150 }, { ...node, at: 99 }, { ...node, at: 201 }]) {
    const audit = auditRemovals(trace([event]));
    assert.equal(audit.unexpected.length, 1); assert.equal(audit.missingOrRepeated.length, 1);
  }
  assert.equal(auditRemovals(trace([])).missingOrRepeated.length, 1);
  assert.equal(auditRemovals(trace([{ ...node, at: 150 }, { ...node, at: 160 }])).missingOrRepeated.length, 1);
});
test('closing review does not allow workspace tabs or another same-title dialog to vanish', () => {
  const audit = auditRemovals(trace([{ ...node, at: 150 }, { ...node, id: 4, at: 160 }, { id: 5, kind: 'tabs', at: 170 }]));
  assert.deepEqual(audit.unexpected.map(n => n.id), [4, 5]);
});
