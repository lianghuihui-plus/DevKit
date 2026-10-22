#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sceneService = require('../case-runtime/scene-service');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const legacyPlanKey = ['plan', 'Id'].join('');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-scene-capture-origin-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'scene-capture-origin' });
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

const initialScene = store.readCurrentScene(fixture.execDir);
function fakeObservation() {
  return {
    adapterResult: {
      schemaVersion: 1,
      type: 'observation',
      platform: 'harmony',
      time: '2026-09-24T10:00:00.000Z',
      app: initialScene.app,
      artifacts: { screenshot: initialScene.screenshot.ref, layout: null, logs: [] },
    },
    evidence: {
      ref: initialScene.screenshot.ref,
      sha256: initialScene.screenshot.sha256,
      width: initialScene.screenshot.width,
      height: initialScene.screenshot.height,
      usable: true,
    },
  };
}

const observed = sceneService.observe(fixture.execDir, {
  purpose: 'SEQUENCE_FINAL',
  captureOrigins: ['SEQUENCE_FINAL', 'ACTION_POST', 'ACTION_POST'],
  relatedOperationId: 'action-0001',
  sequenceId: 'sequence-0001',
  stepId: 'tap',
  [legacyPlanKey]: 'retired-plan',
  promote: false,
  invokeDeviceOperation: fakeObservation,
});

assert.deepStrictEqual(observed.scene.captureOrigins, ['ACTION_POST', 'SEQUENCE_FINAL']);
assert.strictEqual(store.readCurrentScene(fixture.execDir).sceneId, initialScene.sceneId);
const persisted = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', `${observed.scene.sceneId}.json`), 'utf8'));
assert.deepStrictEqual(persisted.captureOrigins, ['ACTION_POST', 'SEQUENCE_FINAL']);
assert.strictEqual(persisted.relatedOperationId, 'action-0001');
assert.strictEqual(persisted.sequenceId, 'sequence-0001');
assert.strictEqual(persisted.stepId, 'tap');
assert.strictEqual(Object.hasOwn(persisted.source, legacyPlanKey), false);
const observedEvent = store.events(fixture.execDir).at(-1);
assert.strictEqual(observedEvent.type, 'sceneObserved');
assert.deepStrictEqual(observedEvent.captureOrigins, ['ACTION_POST', 'SEQUENCE_FINAL']);
assert.strictEqual(observedEvent.relatedOperationId, 'action-0001');
assert.strictEqual(observedEvent.sequenceId, 'sequence-0001');
assert.strictEqual(observedEvent.stepId, 'tap');
assert.strictEqual(Object.hasOwn(observedEvent, legacyPlanKey), false);
assert.strictEqual(observedEvent.promoted, false);

assert.throws(() => sceneService.observe(fixture.execDir, {
  purpose: 'SEQUENCE_FINAL',
  captureOrigins: ['UNKNOWN_ORIGIN'],
  sequenceId: 'sequence-0001',
  invokeDeviceOperation: fakeObservation,
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');

assert.throws(() => sceneService.observe(fixture.execDir, {
  purpose: 'SEQUENCE_FINAL',
  captureOrigins: ['SEQUENCE_FINAL'],
  relatedOperationId: 'action-0001',
  sequenceId: 'sequence-0001',
  invokeDeviceOperation: fakeObservation,
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');

assert.throws(() => sceneService.observe(fixture.execDir, {
  purpose: 'SEQUENCE_FINAL',
  captureOrigins: ['AGENT_REQUESTED'],
  relatedOperationId: 'action-0001',
  invokeDeviceOperation: fakeObservation,
}), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');

const recovery = sceneService.observe(fixture.execDir, {
  purpose: 'AFTER_UNKNOWN_ACTION',
  relatedOperationId: 'action-recovery-0001',
  promote: false,
  invokeDeviceOperation: fakeObservation,
});
assert.strictEqual(recovery.scene.relatedOperationId, 'action-recovery-0001');
assert.deepStrictEqual(recovery.scene.captureOrigins, []);

console.log('scene capture origin passed');
