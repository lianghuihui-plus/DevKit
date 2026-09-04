#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const telemetry = require('../case-runtime/telemetry');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-metrics-'));
fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ finalized: false }));
let nowMs = 1000;
const clock = () => nowMs;
const invocation = telemetry.beginInvocation(execDir, 'act', {
  operation: 'act', input: { text: 'secret' }, result: { verdict: 'PASS', summary: 'private' },
}, { now: '2026-08-20T10:00:00.000Z', telemetryClock: clock });
telemetry.recordSpan(execDir, 'adapter', 400, { kind: 'ACTION', runtimeOperation: 'act', postActionSettleMs: 100 }, { now: '2026-08-20T10:00:00.100Z' });
nowMs = 1700;
telemetry.endInvocation(execDir, invocation, { status: 'SCENE' }, { now: '2026-08-20T10:00:00.700Z', telemetryClock: clock });
const invalid = telemetry.beginInvocation(execDir, 'act', {
  operation: 'act', input: { text: 'invalid secret' }, result: { verdict: 'FAIL', summary: 'invalid private' },
}, { now: '2026-08-20T10:00:00.800Z', telemetryClock: clock });
nowMs = 1800;
telemetry.endInvocation(execDir, invalid, { status: 'REQUEST_INVALID', code: 'CASE_RUNTIME_REQUEST_INVALID' }, {
  now: '2026-08-20T10:00:00.900Z', telemetryClock: clock,
});

const summary = telemetry.summarize(execDir, 1000);
assert.deepStrictEqual(summary, {
  totalElapsedMs: 1000,
  runtimeActiveMs: 800,
  adapterActiveMs: 400,
  actionDeviceMs: 300,
  observationCaptureMs: 0,
  postActionSettleMs: 100,
  explicitWaitMs: 0,
  knowledgeQueryMs: 0,
  recoveryControlMs: 0,
  runtimeOverheadMs: 400,
  recoveryMs: 0,
  agentAndSchedulingGapMs: 200,
  agentTiming: {
    firstPreparationMs: 0,
    stepDecisionMs: 100,
    conclusionPreparationMs: 0,
    unclassifiedGapMs: 100,
    stepDecisionIntervals: [{
      afterInvocationId: 'invocation-0001',
      beforeInvocationId: 'invocation-0002',
      durationMs: 100,
    }],
  },
  invocationCount: 2,
  invocationErrorCount: 1,
});
assert.strictEqual(summary.agentAndSchedulingGapMs,
  summary.agentTiming.firstPreparationMs + summary.agentTiming.stepDecisionMs
  + summary.agentTiming.conclusionPreparationMs + summary.agentTiming.unclassifiedGapMs);
const invocationText = fs.readFileSync(telemetry.invocationFile(execDir), 'utf8');
assert.strictEqual(invocationText.includes('secret'), false);
assert.strictEqual(invocationText.includes('private'), false);
assert.strictEqual(invocationText.includes('invalid secret'), false);
assert.strictEqual(invocationText.includes('invalid private'), false);
assert.strictEqual(invocationText.includes('"verdict":"PASS"'), true);
assert.strictEqual(invocationText.includes('CASE_RUNTIME_REQUEST_INVALID'), true);

fs.rmSync(execDir, { recursive: true, force: true });
console.log('execution-metrics passed');
