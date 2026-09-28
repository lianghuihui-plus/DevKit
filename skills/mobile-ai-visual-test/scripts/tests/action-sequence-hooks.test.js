#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  completeUnknownDispatchedAction,
  dispatchAction,
} = require('../case-runtime/action-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-action-sequence-hooks-${suffix}-`));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { suffix });
  const executionPath = path.join(current.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  fs.writeFileSync(executionPath, `${JSON.stringify({
    ...execution,
    endedAt: null,
    status: 'RUNNING',
    lifecycle: 'RUNNING',
    finalized: false,
    executionStatus: 'RUNNING',
  }, null, 2)}\n`);
  const scene = JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
  store.writeScene(current.execDir, scene);
  return current;
}

function resolvedTap() {
  return {
    stale: false,
    action: {
      type: 'tap', x: 41, y: 73,
      coordinateSource: 'visual',
      targetBounds: [0, 0, 100, 100],
      coordinateEvidence: 'prevalidated Sequence action',
      coordinateArtifactRef: 'screenshots/prevalidated.png',
    },
  };
}

function accepted(action) {
  return {
    adapterResult: {
      schemaVersion: 2,
      type: 'actionResult',
      platform: 'harmony',
      action,
      command: { status: 'ACCEPTED' },
      deviceExecution: { status: 'UNVERIFIED' },
    },
  };
}

{
  const current = fixture('injected');
  const persistedCurrent = store.readCurrentScene(current.execDir);
  const beforeScene = { ...persistedCurrent, sceneId: 'scene-sequence-basis' };
  const resolvedAction = resolvedTap();
  const calls = [];
  const dispatched = dispatchAction(current.execDir, {
    basedOnSceneId: beforeScene.sceneId,
    visual: { gesture: 'tap', point: [0, 0] },
    sequenceId: 'sequence-0001',
    stepId: 'tap',
  }, {
    beforeScene,
    resolvedAction,
    operationId: 'action-0099',
    timeoutMs: 1234,
    invokeDeviceOperation: (_execDir, payload, kind, options) => {
      calls.push({ payload, kind, options });
      return accepted(payload.action);
    },
  });

  assert.strictEqual(dispatched.operationId, 'action-0099');
  assert.strictEqual(dispatched.beforeScene.sceneId, 'scene-sequence-basis');
  assert.deepStrictEqual(dispatched.action.action, resolvedAction.action);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].kind, 'ACTION');
  assert.deepStrictEqual(calls[0].payload.action, resolvedAction.action);
  assert.strictEqual(calls[0].options.timeoutMs, 1234);
  assert.strictEqual(transactions.readAction(current.execDir, 'action-0099').status, 'RESULT_RECORDED');
  assert.strictEqual(store.readCurrentScene(current.execDir).sceneId, persistedCurrent.sceneId);
}

for (const [interruptAfter, expectedState, expectedDispatches] of [
  ['action-prepared', 'PREPARED', 0],
  ['action-dispatched', 'DISPATCHED', 0],
  ['action-result-recorded', 'RESULT_RECORDED', 1],
]) {
  const current = fixture(interruptAfter);
  const operationId = `action-${interruptAfter.replace(/[^a-z]/g, '')}`;
  let dispatches = 0;
  assert.throws(() => dispatchAction(current.execDir, {
    basedOnSceneId: store.readCurrentScene(current.execDir).sceneId,
    visual: { gesture: 'tap', point: [0.5, 0.5] },
    sequenceId: 'sequence-0001',
    stepId: 'tap',
  }, {
    resolvedAction: resolvedTap(),
    operationId,
    interruptAfter,
    invokeDeviceOperation: (_execDir, payload) => {
      dispatches += 1;
      return accepted(payload.action);
    },
  }), (error) => error.code === 'MAVT_SEQUENCE_INTERRUPTED');

  assert.strictEqual(transactions.readAction(current.execDir, operationId).status, expectedState);
  assert.strictEqual(dispatches, expectedDispatches);
  assert.strictEqual(store.events(current.execDir).some((event) => (
    event.type === 'actionOutcomeUnknown' && event.operationId === operationId
  )), false);
}

{
  const current = fixture('unknown-evidence');
  const beforeScene = store.readCurrentScene(current.execDir);
  const operationId = 'action-unknown-sequence';
  let draft = transactions.prepareAction(current.execDir, {
    operationId,
    sceneId: beforeScene.sceneId,
    action: resolvedTap().action,
    sequenceId: 'sequence-0001',
    stepId: 'tap',
  });
  draft = transactions.transitionAction(current.execDir, draft, 'PREPARED', 'DISPATCHED');
  const afterScene = {
    ...beforeScene,
    sceneId: 'scene-unknown-after',
    screenshot: {
      ...beforeScene.screenshot,
      ref: 'screenshots/scene-unknown-after.png',
      path: path.join(current.execDir, 'screenshots', 'scene-unknown-after.png'),
      sha256: 'after-scene-sha',
    },
  };

  const completed = completeUnknownDispatchedAction(current.execDir, {
    operationId,
    beforeScene,
    action: resolvedTap().action,
    code: 'DEVICE_CONNECTION_LOST',
    message: 'device result unavailable',
  }, afterScene, {
    sequenceId: 'sequence-0001',
    stepId: 'tap',
    preSceneRef: beforeScene.sceneId,
  }, { promoteScene: false });

  assert.deepStrictEqual(completed.evidence.sceneRefs, {
    before: beforeScene.sceneId,
    after: afterScene.sceneId,
  });
  assert.deepStrictEqual(completed.evidence.screenshotRefs, [
    beforeScene.screenshot.ref,
    afterScene.screenshot.ref,
  ]);
  assert.strictEqual(transactions.readAction(current.execDir, operationId), null);
  assert.strictEqual(transactions.readCompletedAction(current.execDir, operationId).status, 'COMPLETED');
  assert.strictEqual(store.readCurrentScene(current.execDir).sceneId, beforeScene.sceneId);
}

console.log('sequence action lifecycle hooks passed');
