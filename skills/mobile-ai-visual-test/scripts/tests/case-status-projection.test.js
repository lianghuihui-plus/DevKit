#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { projectCaseStatus } = require('../lib/case-status-projection');

assert.strictEqual(projectCaseStatus({}), 'PENDING');
assert.strictEqual(projectCaseStatus({ execution: {}, readability: 'FORMAT_UNSUPPORTED' }), 'NEEDS_RERUN');
assert.strictEqual(projectCaseStatus({ execution: {}, sourceCurrent: false }), 'NEEDS_RERUN');
assert.strictEqual(projectCaseStatus({ execution: { status: 'CANCELLED' }, result: { verdict: 'PASS' } }), 'CANCELLED');
assert.strictEqual(projectCaseStatus({ execution: {}, result: { verdict: 'NOT_RUN' }, closure: {} }), 'NOT_RUN');
assert.strictEqual(projectCaseStatus({ execution: {}, closure: null }), 'RUNNING');
assert.strictEqual(projectCaseStatus({ execution: {}, closure: {} }), 'NOT_RUN');
assert.strictEqual(projectCaseStatus({ execution: { handoffConsumedAt: '2026-09-17T00:00:00Z' }, closure: {} }), 'BLOCKED');

console.log('case status projection passed');
