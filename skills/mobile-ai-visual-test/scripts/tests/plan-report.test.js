#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { metrics } = require('../case-runtime/result-service');
const { canonicalJson } = require('../lib/contract-utils');
const { renderCurrentContextHtml } = require('../report/current-report-html');
const { buildExecutionTrace } = require('../report/execution-trace');

function signed(record) {
  return {
    ...record,
    integrity: {
      recordSha256: crypto.createHash('sha256').update(canonicalJson(record)).digest('hex'),
    },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plan-report-'));
fs.mkdirSync(path.join(root, 'operations', 'plans'), { recursive: true });
fs.mkdirSync(path.join(root, 'operations', 'plan-evidence'), { recursive: true });
fs.mkdirSync(path.join(root, 'scenes'), { recursive: true });

const completed = signed({
  schemaVersion: 1,
  planId: 'plan-0001',
  executionId: 'execution-plan-report',
  submissionId: 'submission-0001',
  requestSha256: 'request-sha-1',
  basedOnSceneRef: 'scene-0001',
  purpose: '在瞬时窗口内完成操作',
  maxDurationMs: 2500,
  onFailure: 'STOP',
  planRecordRef: 'operations/plans/plan-0001.json',
  requestedAt: '2026-09-20T01:00:00.000Z',
  startedAt: '2026-09-20T01:00:00.000Z',
  endedAt: '2026-09-20T01:00:00.420Z',
  elapsedMs: 420,
  remainingMs: 2080,
  status: 'PLAN_COMPLETED',
  steps: [
    { stepId: 'capture', stepIndex: 0, type: 'capture', status: 'COMPLETED', durationMs: 100, basisSceneRef: 'scene-0001', inputRefs: [], outputRefs: ['scene-0002', 'screenshots/scene-0002.png'], technicalFactRef: null },
    { stepId: 'check', stepIndex: 1, type: 'check', status: 'COMPLETED', durationMs: 5, basisSceneRef: 'scene-0001', inputRefs: [], outputRefs: ['operations/plan-evidence/check-plan-0001-check.json'], technicalFactRef: 'operations/plan-evidence/check-plan-0001-check.json' },
  ],
  evidence: { sceneRefs: ['scene-0002'], screenshotRefs: ['screenshots/scene-0002.png'], locatorRefs: [], checkRefs: ['operations/plan-evidence/check-plan-0001-check.json'] },
  technicalFacts: ['operations/plan-evidence/check-plan-0001-check.json'],
  failure: null,
});
const { integrity: completedIntegrity, ...completedRecord } = completed;
const partial = signed({
  ...completedRecord,
  planId: 'plan-0002',
  submissionId: 'submission-0002',
  requestSha256: 'request-sha-2',
  planRecordRef: 'operations/plans/plan-0002.json',
  purpose: '定位短暂显示的控件',
  status: 'PLAN_PARTIAL',
  elapsedMs: 180,
  remainingMs: 2320,
  steps: [
    { stepId: 'capture', stepIndex: 0, type: 'capture', status: 'COMPLETED', durationMs: 100, basisSceneRef: 'scene-0001', inputRefs: [], outputRefs: ['scene-0002'], technicalFactRef: null },
    { stepId: 'locate', stepIndex: 1, type: 'locate', status: 'FAILED', durationMs: 80, basisSceneRef: 'scene-0001', inputRefs: [], outputRefs: [], technicalFactRef: null, error: { code: 'TARGET_NOT_FOUND', message: '控件已隐藏' } },
  ],
  failure: { code: 'TARGET_NOT_FOUND', message: '控件已隐藏' },
});
fs.writeFileSync(path.join(root, completed.planRecordRef), `${JSON.stringify(completed, null, 2)}\n`);
fs.writeFileSync(path.join(root, partial.planRecordRef), `${JSON.stringify(partial, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'operations', 'plan-evidence', 'check-plan-0001-check.json'), `${JSON.stringify({
  schemaVersion: 1,
  type: 'checkEvidence',
  planId: 'plan-0001',
  stepId: 'check',
  result: { predicate: { kind: 'ELEMENT_VISIBLE', elementRef: 'child-lock' }, sourceRefs: ['scene-0002'], status: 'UNAVAILABLE', value: null },
}, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'scenes', 'scene-0002.json'), `${JSON.stringify({
  schemaVersion: 2,
  sceneId: 'scene-0002',
  captureMode: 'SCREENSHOT_ONLY',
  screenshot: { ref: 'screenshots/scene-0002.png', sha256: 'shot-2', width: 1080, height: 1920 },
  source: { operation: 'runPlan', planId: 'plan-0001', stepId: 'capture' },
}, null, 2)}\n`);

const events = [
  { sequence: 1, time: '2026-09-20T01:00:00.000Z', type: 'planRequested', planId: 'plan-0001', planRecordRef: completed.planRecordRef },
  { sequence: 2, time: '2026-09-20T01:00:00.100Z', type: 'sceneObserved', sceneId: 'scene-0002', screenshotRef: 'screenshots/scene-0002.png', screenshotSha256: 'shot-2', captureMode: 'SCREENSHOT_ONLY', promoted: false, planId: 'plan-0001', stepId: 'capture' },
  { sequence: 3, time: '2026-09-20T01:00:00.100Z', type: 'planStepCompleted', planId: 'plan-0001', stepId: 'capture', stepType: 'capture', durationMs: 100, status: 'COMPLETED' },
  { sequence: 4, time: '2026-09-20T01:00:00.105Z', type: 'planStepCompleted', planId: 'plan-0001', stepId: 'check', stepType: 'check', durationMs: 5, status: 'COMPLETED' },
  { sequence: 5, time: '2026-09-20T01:00:00.420Z', type: 'planCompleted', planId: 'plan-0001', status: 'PLAN_COMPLETED', planRecordRef: completed.planRecordRef, elapsedMs: 420 },
  { sequence: 6, time: '2026-09-20T01:00:01.000Z', type: 'planRequested', planId: 'plan-0002', planRecordRef: partial.planRecordRef },
  { sequence: 7, time: '2026-09-20T01:00:01.100Z', type: 'planStepCompleted', planId: 'plan-0002', stepId: 'capture', stepType: 'capture', durationMs: 100, status: 'COMPLETED' },
  { sequence: 8, time: '2026-09-20T01:00:01.180Z', type: 'planStepFailed', planId: 'plan-0002', stepId: 'locate', stepType: 'locate', durationMs: 80, status: 'FAILED', error: partial.failure },
  { sequence: 9, time: '2026-09-20T01:00:01.180Z', type: 'planInterrupted', planId: 'plan-0002', status: 'PLAN_PARTIAL', planRecordRef: partial.planRecordRef, elapsedMs: 180, failure: partial.failure },
];
const report = {
  latest: root,
  execution: { executionId: 'execution-plan-report', startedAt: '2026-09-20T01:00:00.000Z' },
  events,
  result: { verdict: 'PASS', summary: '业务结论由 Agent 给出', checks: [] },
  metrics: null,
  display: { verdict: 'PASS', durationMs: 2000 },
};

const trace = buildExecutionTrace(report);
assert.strictEqual(trace.plans.length, 2);
assert.strictEqual(trace.plans[0].integrity.status, 'VALID');
assert.strictEqual(trace.plans[0].steps[1].technicalFact.result.status, 'UNAVAILABLE');
assert.strictEqual(trace.plans[1].status, 'PLAN_PARTIAL');
assert.strictEqual(trace.plans[1].steps[1].error.code, 'TARGET_NOT_FOUND');
assert.strictEqual(trace.entries.filter((entry) => entry.category === 'PLAN').length, 8);
const transientScene = trace.entries.find((entry) => entry.sceneId === 'scene-0002');
assert.strictEqual(transientScene.captureMode, 'SCREENSHOT_ONLY');
assert.strictEqual(transientScene.promoted, false);
assert.strictEqual(trace.screenshots[0].captureMode, 'SCREENSHOT_ONLY');
assert.strictEqual(JSON.stringify(trace).includes('screenComparison'), false);

const projectedMetrics = metrics({
  executionId: 'execution-plan-report',
  startedAt: '2026-09-20T01:00:00.000Z',
}, report.result, events, '2026-09-20T01:00:02.000Z', root);
assert.strictEqual(projectedMetrics.schemaVersion, 3);
assert.deepStrictEqual(projectedMetrics.planMetrics, {
  schemaVersion: 1,
  runCount: 2,
  planCount: 2,
  completedCount: 1,
  partialCount: 1,
  interruptedCount: 0,
  failedCount: 1,
  screenshotOnlyCaptureCount: 1,
  transientCaptureCount: 1,
  actionStepCount: 0,
  waitMs: 0,
  captureMs: 200,
  locateMs: 80,
  checkMs: 5,
  stepCount: 4,
  totalDurationMs: 600,
  runs: [
    {
      planId: 'plan-0001', status: 'PLAN_COMPLETED', elapsedMs: 420,
      completedStepCount: 2, failedStepId: null, screenshotOnlyCaptureCount: 1,
      actionStepCount: 0, waitMs: 0, captureMs: 100, locateMs: 0, checkMs: 5,
      startedAt: '2026-09-20T01:00:00.000Z', endedAt: '2026-09-20T01:00:00.420Z',
      recordSha256: completed.integrity.recordSha256,
    },
    {
      planId: 'plan-0002', status: 'PLAN_PARTIAL', elapsedMs: 180,
      completedStepCount: 1, failedStepId: 'locate', screenshotOnlyCaptureCount: 0,
      actionStepCount: 0, waitMs: 0, captureMs: 100, locateMs: 80, checkMs: 0,
      startedAt: '2026-09-20T01:00:00.000Z', endedAt: '2026-09-20T01:00:00.420Z',
      recordSha256: partial.integrity.recordSha256,
    },
  ],
});
assert.strictEqual(projectedMetrics.verdict, 'PASS');

const html = renderCurrentContextHtml({ identity: { title: '计划报告用例' } }, { ...report, metrics: projectedMetrics });
for (const text of ['Runtime 命令计划', 'PLAN_COMPLETED', 'PLAN_PARTIAL', 'SCREENSHOT_ONLY', 'UNAVAILABLE', 'TARGET_NOT_FOUND']) {
  assert.ok(html.includes(text), text);
}
assert.strictEqual(html.includes('DIFFERENT'), false);
assert.strictEqual(html.includes('IDENTICAL'), false);
assert.ok(html.includes('.runtime-plan>dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(12ch,1fr))'));

fs.rmSync(root, { recursive: true, force: true });
console.log('plan-report passed');
