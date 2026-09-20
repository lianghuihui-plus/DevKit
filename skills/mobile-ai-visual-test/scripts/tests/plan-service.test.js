#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalJson } = require('../lib/contract-utils');
const { recoverInterruptedPlans, runPlan } = require('../case-runtime/plan-service');
const { validatePlanEvidenceGraph } = require('../case-runtime/result-integrity');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plan-service-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'plan-service' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({
  ...execution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING',
}, null, 2)}\n`);
const sourceScene = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
sourceScene.screenshot.width = 1000;
sourceScene.screenshot.height = 600;
store.writeScene(fixture.execDir, sourceScene);
const png = fs.readFileSync(path.join(fixture.execDir, sourceScene.screenshot.ref));

let timeMs = 1000;
let actionCalls = 0;
let captureCalls = 0;
const request = {
  operation: 'runPlan', submissionId: 'run-plan-033-attempt-01', basedOnSceneId: 'scene-0002',
  purpose: '唤起视频控制栏并解除童锁', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'reveal', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
    { id: 'settle', type: 'wait', ms: 300 },
    { id: 'controls', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
    { id: 'lock', type: 'locate', sourceRef: '$controls.sceneRef', locator: { kind: 'POINT', point: [0.098, 0.501] } },
    { id: 'unlock', type: 'act', actionRef: 'visual:tap', input: { pointRef: '$lock.point' } },
    { id: 'after', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
    { id: 'technical-check', type: 'check', sourceRef: '$after.sceneRef', predicate: { kind: 'CAPTURE_AVAILABLE' } },
  ],
};
const options = {
  clock: () => timeMs,
  sleep: (ms) => { timeMs += ms; },
  invokeDeviceOperation: (_execDir, payload, kind) => {
    assert.strictEqual(kind, 'ACTION');
    assert.strictEqual(payload.action.pointRef, undefined);
    actionCalls += 1;
    timeMs += 20;
    return { adapterResult: {
      schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: payload.action.type,
      command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 20 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
      device: { id: 'fixture-device' }, app: { appId: 'com.example.fixture' },
    } };
  },
  invokeScreenshotCapture: (execDir, payload) => {
    captureCalls += 1;
    timeMs += 100;
    const ref = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(execDir, ref), png);
    return {
      adapterResult: {
        schemaVersion: 1, type: 'capture', platform: 'harmony', time: '2026-09-20T10:00:00.000Z',
        artifacts: { screenshot: ref }, device: { id: 'fixture-device' }, app: { appId: 'com.example.fixture', inTargetApp: true },
        captureTiming: { order: ['screenshot'], spanMs: 100 },
      },
      evidence: { ref, sha256: sourceScene.screenshot.sha256, width: 1000, height: 600, usable: true },
    };
  },
};

const result = runPlan(fixture.execDir, request, options);
assert.strictEqual(result.status, 'PLAN_COMPLETED');
assert.strictEqual(result.steps.length, 7);
assert.strictEqual(result.steps.every((step) => step.status === 'COMPLETED'), true);
assert.deepStrictEqual(result.steps.find((step) => step.stepId === 'lock').inputRefs, ['$controls.sceneRef']);
assert.deepStrictEqual(result.steps.find((step) => step.stepId === 'unlock').inputRefs, ['$lock.point']);
assert.strictEqual(actionCalls, 2);
assert.strictEqual(captureCalls, 2);
assert.strictEqual(store.readCurrentScene(fixture.execDir).sceneId, 'scene-0002');
assert.strictEqual(result.evidence.sceneRefs.length, 2);
assert.strictEqual(result.evidence.locatorRefs.length, 1);
assert.strictEqual(result.evidence.checkRefs.length, 1);
assert.ok(fs.existsSync(path.join(fixture.execDir, result.planRecordRef)));
assert.match(JSON.parse(fs.readFileSync(path.join(fixture.execDir, result.planRecordRef), 'utf8')).integrity.recordSha256, /^[0-9a-f]{64}$/);
assert.strictEqual(JSON.stringify(result).includes('observedEffect'), false);
assert.strictEqual(JSON.stringify(result).includes('screenComparison'), false);
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'planStepCompleted').length, 7);

const replay = runPlan(fixture.execDir, request, options);
assert.strictEqual(replay.idempotent, true);
assert.strictEqual(actionCalls, 2);
assert.strictEqual(captureCalls, 2);
assert.throws(() => runPlan(fixture.execDir, { ...request, purpose: '不同计划' }, options),
  (error) => error.code === 'PLAN_SUBMISSION_CONFLICT');

const continueResult = runPlan(fixture.execDir, {
  operation: 'runPlan', submissionId: 'continue-technical-plan', basedOnSceneId: 'scene-0002',
  purpose: '保留失败前缀并继续独立技术步骤', maxDurationMs: 2500, onFailure: 'CONTINUE',
  steps: [
    { id: 'shot', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
    { id: 'missing', type: 'locate', sourceRef: '$shot.sceneRef', locator: { kind: 'ELEMENT_REF', elementRef: 'missing-control' } },
    { id: 'checkpoint', type: 'checkpoint', evidenceRefs: [] },
  ],
}, options);
assert.strictEqual(continueResult.status, 'PLAN_PARTIAL');
assert.deepStrictEqual(continueResult.steps.map((step) => step.status), ['COMPLETED', 'FAILED', 'COMPLETED']);

const failedCheck = runPlan(fixture.execDir, {
  operation: 'runPlan', submissionId: 'failed-technical-check', basedOnSceneId: 'scene-0002',
  purpose: '技术检查失败时停止', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'shot', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
    { id: 'check', type: 'check', sourceRef: '$shot.sceneRef', predicate: { kind: 'ELEMENT_VISIBLE', elementRef: 'missing-control' } },
    { id: 'not-run', type: 'checkpoint', evidenceRefs: [] },
  ],
}, options);
assert.strictEqual(failedCheck.status, 'PLAN_PARTIAL');
assert.deepStrictEqual(failedCheck.steps.map((step) => step.status), ['COMPLETED', 'FAILED']);
assert.strictEqual(failedCheck.steps[1].error.code, 'PLAN_CHECK_FAILED');
assert.ok(failedCheck.steps[1].technicalFactRef);

const interruptedPath = path.join(fixture.execDir, 'operations', 'plans', 'plan-9999.json');
const interruptedRecord = {
  schemaVersion: 1, planId: 'plan-9999', executionId: execution.executionId,
  submissionId: 'interrupted-by-restart', requestSha256: 'frozen-request',
  basedOnSceneRef: 'scene-0002', flowContext: null, purpose: '模拟进程中断',
  maxDurationMs: 2500, onFailure: 'STOP', planRecordRef: 'operations/plans/plan-9999.json',
  requestedAt: '2026-09-20T10:00:00.000Z', startedAt: '2026-09-20T10:00:00.000Z', endedAt: null,
  elapsedMs: 100, remainingMs: 2400, status: 'PLAN_RUNNING', steps: [],
  evidence: { sceneRefs: [], screenshotRefs: [], locatorRefs: [], checkRefs: [] },
  technicalFacts: [], failure: null,
};
interruptedRecord.integrity = {
  recordSha256: crypto.createHash('sha256').update(canonicalJson(interruptedRecord)).digest('hex'),
};
fs.writeFileSync(interruptedPath, `${JSON.stringify(interruptedRecord, null, 2)}\n`);
store.appendEvent(fixture.execDir, 'planRequested', {
  planId: interruptedRecord.planId,
  submissionId: interruptedRecord.submissionId,
  requestSha256: interruptedRecord.requestSha256,
  maxDurationMs: interruptedRecord.maxDurationMs,
  planRecordRef: interruptedRecord.planRecordRef,
});
const recoveredPlans = recoverInterruptedPlans(fixture.execDir, { now: '2026-09-20T10:00:01.000Z' });
assert.deepStrictEqual(recoveredPlans.map((item) => item.planId), ['plan-9999']);
const recoveredRecord = JSON.parse(fs.readFileSync(interruptedPath, 'utf8'));
assert.strictEqual(recoveredRecord.status, 'PLAN_INTERRUPTED');
assert.strictEqual(recoveredRecord.failure.code, 'PLAN_INTERRUPTED_AFTER_PROCESS_RESTART');
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'planInterrupted' && event.planId === 'plan-9999').length, 1);

let unknownActionCalls = 0;
const unknownResult = runPlan(fixture.execDir, {
  operation: 'runPlan', submissionId: 'unknown-action-plan', basedOnSceneId: 'scene-0002',
  purpose: '动作结果未知时停止', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'before', type: 'wait', ms: 1 },
    { id: 'unknown', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
  ],
}, {
  ...options,
  invokeDeviceOperation: () => {
    unknownActionCalls += 1;
    throw Object.assign(new Error('transport disconnected'), { code: 'DEVICE_ADAPTER_FAILED' });
  },
});
assert.strictEqual(unknownResult.status, 'PLAN_INTERRUPTED');
assert.strictEqual(unknownActionCalls, 1);
assert.strictEqual(runPlan(fixture.execDir, {
  operation: 'runPlan', submissionId: 'unknown-action-plan', basedOnSceneId: 'scene-0002',
  purpose: '动作结果未知时停止', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'before', type: 'wait', ms: 1 },
    { id: 'unknown', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
  ],
}, options).idempotent, true);
assert.strictEqual(unknownActionCalls, 1);

assert.throws(() => store.appendEvent(fixture.execDir, 'invalidEvent', { sequence: 999, type: 'override' }),
  (error) => error.code === 'CASE_RUNTIME_EVENT_INVALID');

const planGraph = validatePlanEvidenceGraph(fixture.execDir, store.events(fixture.execDir));
assert.ok(planGraph.files.includes(result.planRecordRef));
assert.ok(planGraph.files.some((ref) => ref.startsWith('operations/plan-evidence/')));
const originalPlan = fs.readFileSync(path.join(fixture.execDir, result.planRecordRef), 'utf8');
const damagedPlan = JSON.parse(originalPlan);
damagedPlan.remainingMs += 1;
fs.writeFileSync(path.join(fixture.execDir, result.planRecordRef), `${JSON.stringify(damagedPlan, null, 2)}\n`);
assert.throws(() => validatePlanEvidenceGraph(fixture.execDir, store.events(fixture.execDir)),
  (error) => error.code === 'PLAN_RECORD_INCOMPLETE');
fs.writeFileSync(path.join(fixture.execDir, result.planRecordRef), originalPlan);

console.log('plan service passed');
