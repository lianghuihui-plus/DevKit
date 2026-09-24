#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { completeUnknownDispatchedAction } = require('../case-runtime/action-service');
const { recoverPendingTransactions } = require('../case-runtime/recovery-service');
const sceneService = require('../case-runtime/scene-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-action-recovery-ownership-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'recovery-ownership' });
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

const beforeScene = store.readCurrentScene(fixture.execDir);
function draft(operationId, status, sequenceId = null) {
  let value = transactions.prepareAction(fixture.execDir, {
    operationId,
    sceneId: beforeScene.sceneId,
    action: { type: 'wait', ms: 10 },
    decisionId: 'decision-0001',
    sequenceId,
    stepId: `${operationId}-step`,
  });
  if (status === 'PREPARED') return value;
  value = transactions.transitionAction(fixture.execDir, value, 'PREPARED', 'DISPATCHED', {
    dispatchedAt: '2026-09-24T10:00:00.000Z',
  });
  if (status === 'DISPATCHED') return value;
  value = transactions.transitionAction(fixture.execDir, value, 'DISPATCHED', 'RESULT_RECORDED', {
    deviceResult: {
      command: { status: 'ACCEPTED' },
      deviceExecution: { status: 'UNVERIFIED' },
    },
  });
  if (status === 'RESULT_RECORDED') return value;
  return transactions.transitionAction(fixture.execDir, value, 'RESULT_RECORDED', 'OBSERVED', {
    sceneIdAfter: beforeScene.sceneId,
  });
}

for (const status of ['PREPARED', 'DISPATCHED', 'RESULT_RECORDED', 'OBSERVED']) {
  draft(`action-independent-${status.toLowerCase()}`, status);
  draft(`action-sequence-${status.toLowerCase()}`, status, 'sequence-0001');
}

let observeCalls = 0;
const recovered = recoverPendingTransactions(fixture.execDir, {
  now: '2026-09-24T10:00:01.000Z',
  invokeDeviceOperation: (execDir, _payload, kind) => {
    assert.strictEqual(kind, 'OBSERVE');
    observeCalls += 1;
    return {
      adapterResult: {
        schemaVersion: 1,
        type: 'observation',
        platform: 'harmony',
        time: '2026-09-24T10:00:01.000Z',
        app: beforeScene.app,
        artifacts: { screenshot: beforeScene.screenshot.ref, layout: null, logs: [] },
      },
      evidence: {
        ref: beforeScene.screenshot.ref,
        sha256: beforeScene.screenshot.sha256,
        width: beforeScene.screenshot.width,
        height: beforeScene.screenshot.height,
        usable: true,
      },
    };
  },
});
assert.strictEqual(recovered.filter((item) => item.kind === 'action').length, 4);
assert.strictEqual(observeCalls, 2);
for (const status of ['PREPARED', 'DISPATCHED', 'RESULT_RECORDED', 'OBSERVED']) {
  assert.strictEqual(transactions.readAction(fixture.execDir, `action-independent-${status.toLowerCase()}`), null);
  assert.strictEqual(transactions.readAction(fixture.execDir, `action-sequence-${status.toLowerCase()}`).status, status);
}

const unknownDraft = transactions.readAction(fixture.execDir, 'action-sequence-dispatched');
const currentBeforeUnknown = store.readCurrentScene(fixture.execDir);
let actionAdapterCalls = 0;
const unknownCompleted = completeUnknownDispatchedAction(fixture.execDir, unknownDraft, {
  ...currentBeforeUnknown,
  sceneId: 'scene-0999',
  previousAction: null,
}, {
  sequenceId: 'sequence-0001',
  stepId: unknownDraft.stepId,
  preSceneRef: unknownDraft.sceneId,
}, {
  promoteScene: false,
  now: '2026-09-24T10:00:02.000Z',
  invokeDeviceOperation: () => { actionAdapterCalls += 1; },
});
assert.strictEqual(unknownCompleted.outcomeKnown, false);
assert.strictEqual(actionAdapterCalls, 0);
assert.strictEqual(store.readCurrentScene(fixture.execDir).sceneId, currentBeforeUnknown.sceneId);
assert.strictEqual(transactions.readAction(fixture.execDir, unknownDraft.operationId), null);
assert.strictEqual(store.events(fixture.execDir).filter((event) => event.type === 'actionOutcomeUnknown' && event.operationId === unknownDraft.operationId).length <= 1, true);
assert.strictEqual(store.events(fixture.execDir).some((event) => event.type === 'actionCompleted' && event.operationId === unknownDraft.operationId), false);

console.log('action-recovery-ownership.test.js: all assertions passed');
