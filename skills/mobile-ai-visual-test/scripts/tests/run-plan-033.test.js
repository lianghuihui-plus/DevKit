#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { act } = require('../case-runtime/action-service');
const { runPlan } = require('../case-runtime/plan-service');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const timing = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'run-plan-transient-controls.json'), 'utf8'));

function activeFixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-033-${suffix}-`));
  createTestWorkspace(root);
  const fixture = createCurrentFixture(root, { suffix });
  const executionPath = path.join(fixture.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  fs.writeFileSync(executionPath, `${JSON.stringify({
    ...execution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING',
  }, null, 2)}\n`);
  const scene = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
  scene.screenshot.width = 1000;
  scene.screenshot.height = 600;
  store.writeScene(fixture.execDir, scene);
  return { ...fixture, root, scene, png: fs.readFileSync(path.join(fixture.execDir, scene.screenshot.ref)) };
}

const ordinary = activeFixture('ordinary');
let ordinaryClock = 0;
let ordinaryVisibleUntil = null;
const ordinaryResult = act(ordinary.execDir, {
  basedOnSceneId: ordinary.scene.sceneId,
  visual: { gesture: 'tap', point: timing.revealPoint },
  decision: { purpose: '唤起视频控制栏', expectationRefs: [] },
}, {
  invokeDeviceOperation(execDir, payload, kind) {
    if (kind === 'ACTION') {
      ordinaryClock += 20;
      ordinaryVisibleUntil = ordinaryClock + timing.visibleWindowMs;
      return { adapterResult: {
        schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: payload.action.type,
        command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 20 },
        deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
      } };
    }
    ordinaryClock += timing.fullSceneCaptureMs;
    const ref = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(execDir, ref), ordinary.png);
    return {
      adapterResult: {
        schemaVersion: 1, type: 'observation', platform: 'harmony', time: '2026-09-20T10:00:05.000Z',
        artifacts: { screenshot: ref, layout: null, logs: [] }, app: { appId: 'com.example.fixture', inTargetApp: true },
      },
      evidence: { ref, sha256: ordinary.scene.screenshot.sha256, width: 1000, height: 600, usable: true },
    };
  },
});
assert.strictEqual(ordinaryResult.status, 'SCENE');
assert.ok(ordinaryClock > ordinaryVisibleUntil, 'ordinary full Scene returns after the transient control has hidden');
assert.strictEqual(ordinaryResult.action.observedEffect, undefined);

const planned = activeFixture('planned');
let planClock = 0;
let planVisibleUntil = null;
let unlockAt = null;
let actionCount = 0;
const planRequest = {
  operation: 'runPlan', submissionId: '033-attempt-01', basedOnSceneId: planned.scene.sceneId,
  purpose: '唤起视频控制栏并解除童锁', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'reveal', type: 'act', actionRef: 'visual:tap', input: { point: timing.revealPoint } },
    { id: 'settle', type: 'wait', ms: timing.settleMs },
    { id: 'controls', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
    { id: 'lock', type: 'locate', sourceRef: '$controls.sceneRef', locator: { kind: 'POINT', point: timing.lockPoint } },
    { id: 'unlock', type: 'act', actionRef: 'visual:tap', input: { pointRef: '$lock.point' } },
    { id: 'after', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
  ],
};
const planResult = runPlan(planned.execDir, planRequest, {
  clock: () => planClock,
  sleep: (ms) => { planClock += ms; },
  invokeDeviceOperation(_execDir, payload) {
    actionCount += 1;
    planClock += 20;
    if (actionCount === 1) planVisibleUntil = planClock + timing.visibleWindowMs;
    else unlockAt = planClock;
    return { adapterResult: {
      schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: payload.action.type,
      command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 20 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    } };
  },
  invokeScreenshotCapture(execDir, payload) {
    planClock += timing.screenshotCaptureMs;
    const ref = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(execDir, ref), planned.png);
    return {
      adapterResult: {
        schemaVersion: 1, type: 'capture', platform: 'harmony', time: '2026-09-20T10:00:00.000Z',
        artifacts: { screenshot: ref }, app: { appId: 'com.example.fixture', inTargetApp: true },
        captureTiming: { order: ['screenshot'], spanMs: timing.screenshotCaptureMs },
      },
      evidence: { ref, sha256: planned.scene.screenshot.sha256, width: 1000, height: 600, usable: true },
    };
  },
});
assert.strictEqual(planResult.status, 'PLAN_COMPLETED');
assert.ok(unlockAt < planVisibleUntil, 'the second plan action must execute while the transient control is visible');
assert.strictEqual(store.readCurrentScene(planned.execDir).sceneId, planned.scene.sceneId);
assert.strictEqual(actionCount, 2);
assert.strictEqual(JSON.stringify(planResult).includes('observedEffect'), false);
assert.strictEqual(JSON.stringify(planResult).includes('screenComparison'), false);
assert.strictEqual(fs.existsSync(path.join(planned.execDir, 'result.json')), true, 'runPlan must not replace the existing CaseResult fixture');
const resourceStore = require('../case-runtime/agent-resource-store');
const publicPlan = require('../case-runtime/agent-facing-translator').projectAgentFacingResponse(planned.execDir, planResult,
  { operation: 'runPlan', input: {} }, { resourceProvider: resourceStore.provideOperationResources });
assert.strictEqual(publicPlan.data.type, 'planResult');
assert.strictEqual(publicPlan.data.content.steps.length, planRequest.steps.length);
assert.ok(!publicPlan.resources.some((item) => item.ref === publicPlan.data.ref));
assert.deepStrictEqual(resourceStore.readPublishedResource(planned.execDir, publicPlan.data.ref).data, publicPlan.data);
for (const associated of publicPlan.resources) assert.strictEqual(resourceStore.readPublishedResource(planned.execDir, associated.ref).data.type, associated.type);

const retried = runPlan(planned.execDir, planRequest, {
  clock: () => planClock,
  sleep: () => { throw new Error('idempotent retry must not execute'); },
});
assert.strictEqual(retried.idempotent, true);
assert.strictEqual(actionCount, 2);

console.log('run-plan-033 passed');
