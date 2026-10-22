'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const benchmark = require('./benchmark-mcp');
const { summarize, gate } = benchmark;

test('benchmark percentile uses observed samples and flags warm p95 regressions', () => {
  assert.deepEqual(summarize([5, 1, 4, 3, 2]), { count: 5, p50Ms: 3, p95Ms: 5 });
  assert.equal(gate({ p50Ms: 50, p95Ms: 90 }, { p50Ms: 49, p95Ms: 95 }).pass, false);
  assert.equal(gate({ p50Ms: 50, p95Ms: 90 }, { p50Ms: 49, p95Ms: 89 }).pass, true);
});

test('benchmark acceptance fails when warm calls pass but cold MCP parity fails', () => {
  assert.equal(typeof benchmark.acceptancePass, 'function');
  assert.equal(benchmark.acceptancePass({ warmPreviewPass: true, defaultCliPass: true, mcpDefaultSwitchApproved: false }), false);
  assert.equal(benchmark.acceptancePass({ warmPreviewPass: true, defaultCliPass: true, mcpDefaultSwitchApproved: true }), true);
});
