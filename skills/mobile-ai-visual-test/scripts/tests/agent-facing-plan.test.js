#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectPreviousAction } = require('../case-runtime/agent-facing-contract');
const { run } = require('../case-runtime/agent-facing-client');
const { projectAgentFacingResponse, translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const { readPlans } = require('../case-runtime/plan-service');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-broker');
const store = require('../case-runtime/store');
const resources = require('../case-runtime/agent-resource-store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-plan-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'agent-plan' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({ ...execution, finalized: false, status: 'RUNNING', lifecycle: 'RUNNING' }, null, 2)}\n`);
fs.writeFileSync(path.join(fixture.execDir, 'runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  executionId: execution.executionId,
  status: 'READY',
  entry: path.join(fixture.execDir, 'agent-facing-client.js'),
  broker: { allowedOperations: AGENT_OPERATIONS },
}, null, 2)}\n`);
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
const sceneRef = resources.publishScene(fixture.execDir, 'scene-0002').data.ref;

const publicRequest = {
  operation: 'runPlan', input: { submissionId: 'run-plan-033-attempt-01', sceneRef,
  purpose: '唤起视频控制栏并解除童锁', maxDurationMs: 2500, onFailure: 'STOP',
  steps: [
    { id: 'reveal', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
    { id: 'after', type: 'capture', mode: 'SCREENSHOT_ONLY' },
  ] },
};
const translated = translateAgentFacingRequest(fixture.execDir, publicRequest);
assert.deepStrictEqual(translated, {
  operation: 'runPlan', submissionId: publicRequest.input.submissionId, basedOnSceneId: 'scene-0002',
  purpose: publicRequest.input.purpose, maxDurationMs: 2500, onFailure: 'STOP', steps: publicRequest.input.steps,
  decision: { purpose: publicRequest.input.purpose, expectationRefs: [] },
});

const basisScene = store.readCurrentScene(fixture.execDir);
const basisScreenshot = fs.readFileSync(path.join(fixture.execDir, basisScene.screenshot.ref));
let actionCalls = 0;
let captureCalls = 0;
const executionOptions = {
  now: '2026-08-13T10:00:06.000+08:00',
  invokeDeviceOperation() {
    actionCalls += 1;
    return { adapterResult: {
      schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: 'tap',
      command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 20 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    } };
  },
  invokeScreenshotCapture(execDir, payload) {
    captureCalls += 1;
    const ref = `screenshots/${payload.operationId}.png`;
    fs.writeFileSync(path.join(execDir, ref), basisScreenshot);
    return {
      adapterResult: {
        schemaVersion: 1, type: 'capture', platform: 'harmony', time: '2026-09-23T01:00:00.000Z',
        artifacts: { screenshot: ref }, app: basisScene.app,
        captureTiming: { order: ['screenshot'], spanMs: 100 },
      },
      evidence: {
        ref, sha256: basisScene.screenshot.sha256,
        width: basisScene.screenshot.width, height: basisScene.screenshot.height, usable: true,
      },
    };
  },
};
const executed = run(fixture.execDir, publicRequest, executionOptions);
assert.strictEqual(executed.status, 'SUCCEEDED',
  `public runPlan must execute through the complete Runtime path: ${JSON.stringify(executed)}`);
assert.strictEqual(executed.result.outcome, 'PLAN_COMPLETED');
assert.strictEqual(actionCalls, 1);
assert.strictEqual(captureCalls, 1);
const [planRecord] = readPlans(fixture.execDir);
assert.ok(planRecord.decisionId, 'the plan record must retain its originating Agent decision');
const planEvents = store.events(fixture.execDir).filter((event) => event.planId === planRecord.planId);
assert.ok(planEvents.length > 0);
assert.ok(planEvents.every((event) => event.decisionId === planRecord.decisionId),
  'plan events and child evidence must retain the originating Agent decision');

const replayed = run(fixture.execDir, publicRequest, executionOptions);
assert.strictEqual(replayed.status, 'SUCCEEDED');
assert.strictEqual(replayed.result.outcome, 'PLAN_COMPLETED');
assert.strictEqual(replayed.result.idempotent, true,
  'a new Runtime decisionId must not alter the plan request hash for the same submission');
assert.strictEqual(actionCalls, 1);
assert.strictEqual(captureCalls, 1);

const projected = projectAgentFacingResponse(fixture.execDir, {
  status: 'PLAN_COMPLETED', planId: 'plan-0001', planRecordRef: 'operations/plans/plan-0001.json',
  steps: [{ stepId: 'reveal', type: 'act', status: 'COMPLETED', durationMs: 20, outputRefs: ['action-0002'] }],
  evidence: { sceneRefs: ['scene-0003'], screenshotRefs: ['screenshots/capture-0001.png'], locatorRefs: [], checkRefs: [] },
  technicalFacts: [], remainingMs: 2100,
}, publicRequest);
assert.strictEqual(projected.status, 'SUCCEEDED');
assert.strictEqual(projected.result.outcome, 'PLAN_COMPLETED');
assert.strictEqual(projected.result.planId, 'plan-0001');
assert.strictEqual(projected.verdict, undefined);
assert.strictEqual(projected.screenComparison, undefined);
assert.strictEqual(JSON.stringify(projected).includes('observedEffect'), false);

const previous = projectPreviousAction({
  operationId: 'action-0001', action: { type: 'tap' }, command: { status: 'ACCEPTED' },
  evidence: { sceneRefs: { before: 'scene-0001', after: 'scene-0002' }, screenshotRefs: ['a.png', 'b.png'] },
  observedEffect: { status: 'CHANGED' },
});
assert.strictEqual(previous.screenComparison, undefined);
assert.deepStrictEqual(previous.evidence.sceneRefs, { before: 'scene-0001', after: 'scene-0002' });

console.log('agent-facing plan passed');
