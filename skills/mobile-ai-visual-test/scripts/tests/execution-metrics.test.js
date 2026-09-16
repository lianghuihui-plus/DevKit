#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const telemetry = require('../case-runtime/telemetry');
const { metrics } = require('../case-runtime/result-service');
const { deriveExecutionTiming } = require('../lib/execution-timing');

const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-metrics-'));
fs.writeFileSync(path.join(execDir, 'execution.json'), JSON.stringify({ schemaVersion: 12, finalized: false }));
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
telemetry.endInvocation(execDir, invalid, {
  status: 'REQUEST_INVALID',
  code: 'CASE_RUNTIME_REQUEST_INVALID',
  issues: [
    { fieldPath: 'input.text', expected: 'non-empty string', code: 'TYPE_MISMATCH', received: 'invalid secret' },
    { fieldPath: 'input.text', expected: 'non-empty string', code: 'TYPE_MISMATCH', received: 'invalid secret' },
    { fieldPath: 'decision', expected: 'object', code: 'REQUIRED' },
  ],
}, {
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
  agentFacing: {
    requestCount: 0,
    recordResultCount: 0,
    unresolvedFinishAttemptCount: 0,
    requestBytes: 0,
    responseBytes: 0,
    sceneProjectionBytes: 0,
    ledgerProjectionMs: 0,
    documentationRefCount: 0,
    hostTransportCounts: {},
    durationMs: 0,
  },
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
const invocationEntries = invocationText.trim().split(/\r?\n/).map(JSON.parse);
const invalidEnd = invocationEntries.find((entry) => entry.invocationId === invalid.invocationId && entry.phase === 'END');
assert.deepStrictEqual(invalidEnd.issueCodes, ['TYPE_MISMATCH', 'REQUIRED']);
assert.deepStrictEqual(invalidEnd.fieldPaths, ['input.text', 'decision']);
assert.strictEqual(invocationText.includes('received'), false);

const rejectedResponse = {
  status: 'INPUT_INVALID', code: 'ACTION_NOT_AVAILABLE',
  documentationRef: 'references/case-runtime/errors.md#error-action-not-available',
  scene: { sceneRef: 'scene-0001', screenshot: { ref: 'screenshots/scene-0001.png' } },
};
telemetry.recordAgentFacing(execDir, {
  capability: 'act', actionRef: 'secret-control:tap',
}, rejectedResponse, 25, {
  now: '2026-08-20T10:00:00.950Z', hostTransport: 'stdin',
  agentFacingMetrics: { ledgerProjectionMs: 0 },
});
const finishRequest = {
  capability: 'finish', summary: 'private summary',
};
const finishResponse = {
  status: 'RESULT_INCOMPLETE', code: 'CASE_RESULT_INCOMPLETE',
  documentationRef: 'references/case-runtime/errors.md#error-case-result-incomplete',
  readiness: { unresolved: [{ expectationRef: 'E2', reasons: ['RESULT_MISSING'] }] },
};
telemetry.recordAgentFacing(execDir, finishRequest, finishResponse, 15, {
  now: '2026-08-20T10:00:00.975Z', hostTransport: 'mcp',
  agentFacingMetrics: { ledgerProjectionMs: 9 },
});
const protocolSummary = telemetry.summarize(execDir, 1000).agentFacing;
assert.deepStrictEqual(protocolSummary, {
  requestCount: 2,
  recordResultCount: 0,
  unresolvedFinishAttemptCount: 1,
  requestBytes: Buffer.byteLength(JSON.stringify({
    capability: 'act', actionRef: 'secret-control:tap',
  })) + Buffer.byteLength(JSON.stringify(finishRequest)),
  responseBytes: Buffer.byteLength(JSON.stringify(rejectedResponse)) + Buffer.byteLength(JSON.stringify(finishResponse)),
  sceneProjectionBytes: Buffer.byteLength(JSON.stringify(rejectedResponse.scene)),
  ledgerProjectionMs: 9,
  documentationRefCount: 2,
  hostTransportCounts: { stdin: 1, mcp: 1 },
  durationMs: 40,
});
const agentFacingText = fs.readFileSync(telemetry.agentFacingFile(execDir), 'utf8');
for (const secret of ['secret-control', 'private observation', 'private result', 'private summary']) {
  assert.strictEqual(agentFacingText.includes(secret), false);
}

const resultMetrics = metrics({
  executionId: 'execution-investigation-metrics',
  startedAt: '2026-08-20T10:00:00.000Z',
  warmSessionGenerationStart: 1,
  warmSessionGeneration: 1,
  warmSessionIdStart: 'warm-0001',
  warmSessionId: 'warm-0001',
  warmSessionEpochStart: 1,
  warmSessionEpoch: 1,
}, {
  verdict: 'FAIL',
  checks: [{ expectationRef: 'E1', status: 'FAIL' }],
}, [], '2026-08-20T10:00:01.000Z', null, {
  knowledgeCoverage: {
    investigation: {
      requiredExpectationRefs: ['E1'],
      completedExpectationRefs: ['E1'],
      missingExpectationRefs: [],
      byExpectation: {
        E1: { required: true, status: 'NO_MATCH', queryIds: ['knowledge-0001'], reviewedQueryIds: ['knowledge-0001'] },
      },
    },
  },
});
assert.deepStrictEqual(resultMetrics.knowledgeInvestigation, {
  requiredExpectationRefs: ['E1'],
  completedExpectationRefs: ['E1'],
  missingExpectationRefs: [],
  byExpectation: {
    E1: { required: true, status: 'NO_MATCH', queryIds: ['knowledge-0001'], reviewedQueryIds: ['knowledge-0001'] },
  },
});
assert.deepStrictEqual(Object.fromEntries([
  'caseTotalElapsedMs', 'coordinatorPreparationMs', 'initialStatePreparationMs',
  'handoffPreparationMs', 'handoffSchedulingMs', 'caseAgentPhaseMs',
].map((field) => [field, resultMetrics[field]])), {
  caseTotalElapsedMs: null,
  coordinatorPreparationMs: null,
  initialStatePreparationMs: null,
  handoffPreparationMs: null,
  handoffSchedulingMs: null,
  caseAgentPhaseMs: null,
});
const anchoredMetrics = metrics({
  executionId: 'execution-timing-metrics',
  startedAt: '2026-08-20T10:00:01.000Z',
  caseProcessingStartedAt: '2026-08-20T10:00:00.000Z',
  initialStateCompletedAt: '2026-08-20T10:00:03.000Z',
  handoffReadyAt: '2026-08-20T10:00:04.000Z',
  handoffConsumedAt: '2026-08-20T10:00:06.000Z',
}, { verdict: 'PASS', checks: [] }, [], '2026-08-20T10:00:10.000Z');
assert.deepStrictEqual(Object.fromEntries([
  'elapsedMs', 'caseTotalElapsedMs', 'coordinatorPreparationMs', 'initialStatePreparationMs',
  'handoffPreparationMs', 'handoffSchedulingMs', 'caseAgentPhaseMs',
].map((field) => [field, anchoredMetrics[field]])), {
  elapsedMs: 9000,
  caseTotalElapsedMs: 10000,
  coordinatorPreparationMs: 1000,
  initialStatePreparationMs: 2000,
  handoffPreparationMs: 1000,
  handoffSchedulingMs: 2000,
  caseAgentPhaseMs: 4000,
});

const anchoredTiming = deriveExecutionTiming({
  startedAt: '2026-08-20T10:00:01.000Z',
  endedAt: '2026-08-20T10:00:10.000Z',
  caseProcessingStartedAt: '2026-08-20T10:00:00.000Z',
  initialStateCompletedAt: '2026-08-20T10:00:03.000Z',
  handoffReadyAt: '2026-08-20T10:00:04.000Z',
  handoffConsumedAt: '2026-08-20T10:00:06.000Z',
}, {}, { caseReportPublishedAt: '2026-08-20T10:00:12.000Z' });
assert.deepStrictEqual(anchoredTiming, {
  durationBasis: 'CASE_TOTAL',
  startedAt: '2026-08-20T10:00:00.000Z',
  durationMs: 10000,
  phases: {
    coordinatorPreparationMs: 1000,
    initialStatePreparationMs: 2000,
    handoffPreparationMs: 1000,
    handoffSchedulingMs: 2000,
    caseAgentPhaseMs: 4000,
    reportPublicationDelayMs: 2000,
  },
});
assert.deepStrictEqual(deriveExecutionTiming({
  startedAt: '2026-08-20T10:00:07.000Z', endedAt: '2026-08-20T10:00:10.000Z',
  caseProcessingStartedAt: '2026-08-20T10:00:06.000Z',
  initialStateCompletedAt: '2026-08-20T10:00:08.000Z',
  autoInitialStateBlocked: true,
}, {}), {
  durationBasis: 'CASE_TOTAL',
  startedAt: '2026-08-20T10:00:06.000Z',
  durationMs: 4000,
  phases: {
    coordinatorPreparationMs: 1000,
    initialStatePreparationMs: 1000,
    handoffPreparationMs: null,
    handoffSchedulingMs: null,
    caseAgentPhaseMs: null,
    reportPublicationDelayMs: null,
  },
});
assert.deepStrictEqual(deriveExecutionTiming({ startedAt: '2026-08-20T10:00:01.000Z' }, { elapsedMs: 321 }), {
  durationBasis: 'EXECUTION_TOTAL',
  startedAt: '2026-08-20T10:00:01.000Z',
  durationMs: 321,
  phases: {
    coordinatorPreparationMs: null,
    initialStatePreparationMs: null,
    handoffPreparationMs: null,
    handoffSchedulingMs: null,
    caseAgentPhaseMs: null,
    reportPublicationDelayMs: null,
  },
});

const invalidExplicitPublication = deriveExecutionTiming({
  startedAt: '2026-08-20T10:00:00.000Z',
  endedAt: '2026-08-20T10:00:02.000Z',
}, { elapsedMs: 2000 }, {
  caseReportPublishedAt: '2026-08-20T10:00:01.000Z',
  reportPublicationDelayMs: 999,
});
assert.strictEqual(invalidExplicitPublication.phases.reportPublicationDelayMs, null);
assert.strictEqual(deriveExecutionTiming({ endedAt: '2026-08-20T10:00:02.000Z' }, { elapsedMs: 2000 }, {
  reportPublicationDelayMs: 999,
}).phases.reportPublicationDelayMs, null);
assert.strictEqual(deriveExecutionTiming({ startedAt: '2026-08-20T10:00:00.000Z' }, { elapsedMs: 2000 }, {
  caseReportPublishedAt: '2026-08-20T10:00:03.000Z',
  reportPublicationDelayMs: 999,
}).phases.reportPublicationDelayMs, null);
assert.deepStrictEqual(deriveExecutionTiming({ startedAt: '2026-08-20T10:00:01.000Z' }, {
  elapsedMs: 321,
  caseTotalElapsedMs: 654,
  coordinatorPreparationMs: 10,
  initialStatePreparationMs: null,
  handoffPreparationMs: 20,
  handoffSchedulingMs: null,
  caseAgentPhaseMs: 30,
}), {
  durationBasis: 'CASE_TOTAL',
  startedAt: '2026-08-20T10:00:01.000Z',
  durationMs: 654,
  phases: {
    coordinatorPreparationMs: 10,
    initialStatePreparationMs: null,
    handoffPreparationMs: 20,
    handoffSchedulingMs: null,
    caseAgentPhaseMs: 30,
    reportPublicationDelayMs: null,
  },
});

fs.rmSync(execDir, { recursive: true, force: true });
console.log('execution-metrics passed');
