'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, gate } = require('./benchmark-mcp');

test('benchmark percentile uses observed samples and flags warm p95 regressions', () => {
  assert.deepEqual(summarize([5, 1, 4, 3, 2]), { count: 5, p50Ms: 3, p95Ms: 5 });
  assert.equal(gate({ p50Ms: 50, p95Ms: 90 }, { p50Ms: 49, p95Ms: 95 }).pass, false);
  assert.equal(gate({ p50Ms: 50, p95Ms: 90 }, { p50Ms: 49, p95Ms: 89 }).pass, true);
});
