#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dispatchAction } = require('../case-runtime/action-service');
const { sceneFromObservation } = require('../case-runtime/scene-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-action-plan-dispatch-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'plan-dispatch' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({
  ...execution,
  endedAt: null,
  status: 'RUNNING',
  lifecycle: 'RUNNING',
  finalized: false,
  executionStatus: 'RUNNING',
}, null, 2)}\n`);
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));

const beforeSceneEvents = store.events(fixture.execDir).filter((event) => event.type === 'sceneObserved').length;
const result = dispatchAction(fixture.execDir, {
  basedOnSceneId: 'scene-0002',
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '唤起瞬时控件' },
  planId: 'plan-0001',
  stepId: 'reveal',
}, {
  now: '2026-09-20T10:00:00.000Z',
  invokeDeviceOperation: (_execDir, payload, kind) => {
    assert.strictEqual(kind, 'ACTION');
    assert.strictEqual(payload.action.type, 'tap');
    return {
      adapterResult: {
        schemaVersion: 2,
        type: 'actionResult',
        platform: 'harmony',
        action: 'tap',
        time: '2026-09-20T10:00:00.010Z',
        command: { status: 'ACCEPTED', transport: 'HDC_UITEST', elapsedMs: 10 },
        deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
        device: { id: 'fixture-device' },
        app: { appId: 'com.example.fixture' },
      },
    };
  },
});

assert.strictEqual(result.status, 'ACTION_DISPATCHED');
assert.strictEqual(result.planId, 'plan-0001');
assert.strictEqual(result.stepId, 'reveal');
assert.strictEqual(result.beforeScene.sceneId, 'scene-0002');
assert.strictEqual(result.action.lifecycle.status, 'RESULT_RECORDED');
assert.strictEqual(result.action.command.status, 'ACCEPTED');
assert.strictEqual(result.action.observedEffect, undefined);
assert.deepStrictEqual(result.action.evidence.sceneRefs, { before: 'scene-0002' });
assert.deepStrictEqual(result.action.evidence.screenshotRefs, ['screenshots/scene-0002.png']);
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'sceneObserved').length, beforeSceneEvents);

const transaction = transactions.readAction(fixture.execDir, result.operationId);
assert.strictEqual(transaction.status, 'RESULT_RECORDED');
assert.strictEqual(transaction.planId, 'plan-0001');
assert.strictEqual(transaction.stepId, 'reveal');

const previousScene = store.readCurrentScene(fixture.execDir);
const nextScene = sceneFromObservation(fixture.execDir, {
  operationId: 'observation-plan-test',
  ref: previousScene.screenshot.ref,
  sha256: previousScene.screenshot.sha256,
  usable: true,
  scope: 'case',
  observationPurpose: 'POST_ACTION',
  artifacts: { screenshot: previousScene.screenshot.ref, layout: null, logs: [] },
  app: previousScene.app,
  time: '2026-09-20T10:00:00.020Z',
}, store.loadExecution(fixture.execDir), {
  ...result.action,
  lifecycle: { status: 'COMPLETED' },
}, previousScene);
assert.strictEqual(nextScene.previousAction.observedEffect, undefined);
assert.deepStrictEqual(nextScene.previousAction.evidence.sceneRefs, {
  before: previousScene.sceneId,
  after: nextScene.sceneId,
});
assert.deepStrictEqual(nextScene.previousAction.evidence.screenshotRefs, [previousScene.screenshot.ref]);

console.log('action-plan-dispatch.test.js: all assertions passed');
