#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyActionOutcome,
  completeDispatchedAction,
  dispatchAction,
} = require('../case-runtime/action-service');
const { buildCapabilities } = require('../case-runtime/capability-catalog');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function makeFixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-action-completion-${suffix}-`));
  createTestWorkspace(root);
  const fixture = createCurrentFixture(root, { suffix });
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
  return fixture;
}

function acceptedResult(action) {
  return {
    adapterResult: {
      schemaVersion: 2,
      type: 'actionResult',
      platform: 'harmony',
      action,
      command: { status: 'ACCEPTED', transport: 'HDC_UITEST', elapsedMs: 10 },
      deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
    },
  };
}

function postScene(beforeScene, sceneId) {
  return { ...beforeScene, sceneId, previousAction: null };
}

const fixture = makeFixture('known');
const beforeScene = store.readCurrentScene(fixture.execDir);

assert.strictEqual(classifyActionOutcome({ command: { status: 'REJECTED' } }), 'FAILED');
assert.strictEqual(classifyActionOutcome({ deviceExecution: { status: 'FAILED' } }), 'FAILED');
assert.strictEqual(classifyActionOutcome({ failureCode: 'ACTION_EFFECT_MISMATCH' }), 'FAILED');

const dispatched = dispatchAction(fixture.execDir, {
  basedOnSceneId: beforeScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '完成共享动作' },
  sequenceId: 'sequence-0001',
  stepId: 'tap',
}, {
  now: '2026-09-24T10:00:00.000Z',
  invokeDeviceOperation: () => acceptedResult('tap'),
});
const completed = completeDispatchedAction(fixture.execDir, dispatched, postScene(beforeScene, 'scene-0099'), {
  sequenceId: 'sequence-0001', stepId: 'tap', preSceneRef: beforeScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:00.100Z' });

assert.strictEqual(completed.lifecycle.status, 'COMPLETED');
assert.strictEqual(completed.evidence.sceneRefs.after, 'scene-0099');
assert.strictEqual(store.readCurrentScene(fixture.execDir).sceneId, beforeScene.sceneId);
assert.strictEqual(transactions.readAction(fixture.execDir, dispatched.operationId), null);
const storedCompleted = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${dispatched.operationId}.json`), 'utf8'));
assert.strictEqual(storedCompleted.sequenceId, 'sequence-0001');
assert.strictEqual(storedCompleted.stepId, 'tap');
assert.strictEqual(storedCompleted.actionResult.evidence.sceneRefs.after, 'scene-0099');
const requested = store.events(fixture.execDir).find((event) => event.type === 'actionRequested' && event.operationId === dispatched.operationId);
const completion = store.events(fixture.execDir).find((event) => event.type === 'actionCompleted' && event.operationId === dispatched.operationId);
assert.strictEqual(requested.sequenceId, 'sequence-0001');
assert.strictEqual(requested.stepId, 'tap');
assert.strictEqual(completion.sequenceId, 'sequence-0001');
assert.strictEqual(completion.stepId, 'tap');

const inputScene = store.readCurrentScene(fixture.execDir);
inputScene.elements = [{
  id: 'account-field', text: '账号', role: 'TextField', bounds: [80, 210, 360, 270],
  clickable: false, checkable: false, editable: true, enabled: true, visible: true, focused: false,
}];
inputScene.capabilities = buildCapabilities(inputScene, 'harmony');
store.writeScene(fixture.execDir, inputScene);
const inputText = '13223222360';
const inputDispatched = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  capabilityId: `${inputScene.sceneId}:inputText:account-field`,
  input: { text: inputText, mode: 'replace' },
  decision: { purpose: '输入账号' },
  sequenceId: 'sequence-0001',
  stepId: 'input',
}, {
  now: '2026-09-24T10:00:01.000Z',
  invokeDeviceOperation: () => acceptedResult('inputText'),
});
const inputCompleted = completeDispatchedAction(fixture.execDir, inputDispatched, postScene(inputScene, 'scene-0100'), {
  sequenceId: 'sequence-0001', stepId: 'input', preSceneRef: inputScene.sceneId,
}, { promoteScene: false, now: '2026-09-24T10:00:01.100Z' });
const inputOperation = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${inputDispatched.operationId}.json`), 'utf8'));
const inputEvents = store.events(fixture.execDir).filter((event) => event.operationId === inputDispatched.operationId);
for (const persisted of [inputCompleted, inputOperation, ...inputEvents]) {
  assert.strictEqual(JSON.stringify(persisted).includes(inputText), false);
  assert.strictEqual(JSON.stringify(persisted).includes('[REDACTED]'), true);
}

const captureFailure = store.appendEvent(fixture.execDir, 'technicalIssue', {
  code: 'POST_ACTION_CAPTURE_FAILED', message: 'post-action capture failed', operation: 'act',
}, { now: '2026-09-24T10:00:02.000Z' });
const failedCapture = dispatchAction(fixture.execDir, {
  basedOnSceneId: inputScene.sceneId,
  visual: { gesture: 'tap', point: [0.5, 0.5] },
  decision: { purpose: '验证采集失败收口' },
}, {
  now: '2026-09-24T10:00:02.010Z',
  invokeDeviceOperation: () => acceptedResult('tap'),
});
completeDispatchedAction(fixture.execDir, failedCapture, null, {
  preSceneRef: inputScene.sceneId,
}, {
  promoteScene: false,
  captureFailureTechnicalFactRef: captureFailure.technicalFactRef,
  now: '2026-09-24T10:00:02.020Z',
});
const captureFailureOperation = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'operations', `${failedCapture.operationId}.json`), 'utf8'));
assert.strictEqual(captureFailureOperation.observationStatus, 'FAILED');
assert.strictEqual(captureFailureOperation.sceneIdAfter, null);
assert.strictEqual(captureFailureOperation.captureFailureTechnicalFactRef, captureFailure.technicalFactRef);
assert.strictEqual(store.events(fixture.execDir).some((event) => event.type === 'actionCompleted' && event.operationId === failedCapture.operationId), false);

console.log('action-completion.test.js: all assertions passed');
