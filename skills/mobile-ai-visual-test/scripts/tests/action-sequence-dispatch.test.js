#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dispatchAction } = require('../case-runtime/action-service');
const { buildCapabilities } = require('../case-runtime/capability-catalog');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const legacyPlanKey = ['plan', 'Id'].join('');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-action-sequence-dispatch-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'sequence-dispatch' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({ ...execution,
  endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING',
}, null, 2)}\n`);
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));

const beforeSceneEvents = store.events(fixture.execDir).filter((event) => event.type === 'sceneObserved').length;
const dispatched = dispatchAction(fixture.execDir, {
  basedOnSceneId: 'scene-0002', visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '唤起瞬时控件' }, sequenceId: 'sequence-0001', stepId: 'reveal',
  [legacyPlanKey]: 'retired-plan',
}, {
  now: '2026-09-20T10:00:00.000Z',
  invokeDeviceOperation: (_dir, payload, kind) => {
    assert.strictEqual(kind, 'ACTION');
    assert.strictEqual(payload.action.type, 'tap');
    return { adapterResult: {
      schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: 'tap',
      command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 10 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    } };
  },
});
assert.strictEqual(dispatched.status, 'ACTION_DISPATCHED');
assert.strictEqual(dispatched.sequenceId, 'sequence-0001');
assert.strictEqual(dispatched.stepId, 'reveal');
assert.strictEqual(Object.hasOwn(dispatched, legacyPlanKey), false);
assert.deepStrictEqual(dispatched.action.evidence.sceneRefs, { before: 'scene-0002' });
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'sceneObserved').length, beforeSceneEvents);
const transaction = transactions.readAction(fixture.execDir, dispatched.operationId);
assert.strictEqual(transaction.sequenceId, 'sequence-0001');
assert.strictEqual(transaction.stepId, 'reveal');
assert.strictEqual(Object.hasOwn(transaction, legacyPlanKey), false);
const requested = store.events(fixture.execDir).find((event) =>
  event.type === 'actionRequested' && event.operationId === dispatched.operationId);
assert.strictEqual(requested.sequenceId, 'sequence-0001');
assert.strictEqual(requested.stepId, 'reveal');
assert.strictEqual(Object.hasOwn(requested, legacyPlanKey), false);

let failedDispatch;
try {
  dispatchAction(fixture.execDir, {
    basedOnSceneId: 'scene-0002', visual: { gesture: 'tap', point: [0.5, 0.5] },
    sequenceId: 'sequence-0001', stepId: 'failed', [legacyPlanKey]: 'retired-plan',
  }, { invokeDeviceOperation: () => { throw new Error('adapter unavailable'); } });
} catch (error) {
  failedDispatch = error;
}
assert.strictEqual(failedDispatch.actionOutcome, 'UNKNOWN');
assert.strictEqual(failedDispatch.actionDispatch.sequenceId, 'sequence-0001');
assert.strictEqual(failedDispatch.actionDispatch.stepId, 'failed');
assert.strictEqual(Object.hasOwn(failedDispatch.actionDispatch, legacyPlanKey), false);
const failedEvent = store.events(fixture.execDir).find((event) =>
  event.type === 'actionOutcomeUnknown' && event.operationId === failedDispatch.operationId);
assert.strictEqual(failedEvent.sequenceId, 'sequence-0001');
assert.strictEqual(failedEvent.stepId, 'failed');
assert.strictEqual(Object.hasOwn(failedEvent, legacyPlanKey), false);

const inputScene = store.readCurrentScene(fixture.execDir);
inputScene.elements = [{ id: 'account-field', text: '账号', role: 'TextField', bounds: [80, 210, 360, 270],
  clickable: false, checkable: false, editable: true, enabled: true, visible: true, focused: false }];
inputScene.capabilities = buildCapabilities(inputScene, 'harmony');
store.writeScene(fixture.execDir, inputScene);
const inputResult = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId, capabilityId: `${inputScene.sceneId}:inputText:account-field`,
  input: { text: '13223222360', mode: 'replace' }, decision: { purpose: '输入账号' },
}, { invokeDeviceOperation: () => ({ adapterResult: {
  schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: 'inputText',
  command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 50 },
  deviceExecution: { status: 'FAILED', verification: 'INPUT_EFFECT', failureCode: 'ACTION_EFFECT_MISMATCH' },
  failureCode: 'ACTION_EFFECT_MISMATCH', inputEffect: {
    status: 'MISMATCH', attempts: 7, settledMs: 7652, expectedLength: 11, observedLength: 5,
    expectedText: '13223222360', actualText: '13223',
  },
} }) });
assert.strictEqual(inputResult.action.failureCode, 'ACTION_EFFECT_MISMATCH');
assert.strictEqual(JSON.stringify(inputResult.action).includes('13223222360'), false);
assert.strictEqual(JSON.stringify(inputResult.action).includes('13223'), false);
console.log('action sequence dispatch passed');
