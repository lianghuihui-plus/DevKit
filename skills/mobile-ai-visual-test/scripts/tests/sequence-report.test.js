#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildExecutionTrace } = require('../report/execution-trace');
const { metrics } = require('../case-runtime/result-service');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-sequence-report-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'sequence-report' });
const trace = buildExecutionTrace({ latest: fixture.execDir });
assert.ok(Array.isArray(trace.sequences));
assert.ok(!Object.hasOwn(trace, 'plans'));
writeJsonAtomic(path.join(fixture.execDir, 'operations/sequences/sequence-0001.json'), {
  sequenceId: 'sequence-0001', status: 'SEQUENCE_PARTIAL',
  steps: [{ stepId: 'tap', type: 'act', status: 'COMPLETED' },
    { stepId: 'wait', type: 'wait', status: 'FAILED' }],
  finalSceneRef: 'scene-0003', integrity: { recordSha256: 'digest' },
});
const execution = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'execution.json'), 'utf8'));
const calculated = metrics(execution, { verdict: 'INCONCLUSIVE', checks: [] }, [
  { type: 'sequenceRequested', sequenceId: 'sequence-0001' },
  { type: 'sequenceCompleted', sequenceId: 'sequence-0001', status: 'SEQUENCE_PARTIAL' },
], '2026-09-24T10:01:00.000Z', fixture.execDir);
assert.strictEqual(calculated.sequenceMetrics.runCount, 1);
assert.strictEqual(calculated.sequenceMetrics.partialCount, 1);
assert.strictEqual(calculated.sequenceMetrics.actionStepCount, 1);
assert.strictEqual(calculated.sequenceMetrics.stepCount, 2);
console.log('sequence report passed');
