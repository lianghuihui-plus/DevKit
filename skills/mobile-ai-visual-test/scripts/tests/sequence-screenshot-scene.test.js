#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { persistSequenceScreenshotScene } = require('../case-runtime/sequence-service');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const legacyPlanKey = ['plan', 'Id'].join('');

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-sequence-screenshot-${suffix}-`));
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

function captured(beforeScene, suffix) {
  return {
    adapterResult: {
      time: `2026-09-24T10:00:0${suffix}.000Z`,
      app: beforeScene.app,
      captureTiming: { captureMs: 120 },
    },
    evidence: {
      ref: `screenshots/sequence-${suffix}.png`,
      sha256: `sequence-shot-${suffix}`,
      width: beforeScene.screenshot.width,
      height: beforeScene.screenshot.height,
      usable: true,
    },
  };
}

function previousAction(beforeScene) {
  return {
    operationId: 'action-0042',
    lifecycle: { status: 'COMPLETED' },
    action: { type: 'tap', x: 50, y: 80 },
    command: { status: 'ACCEPTED' },
    deviceExecution: { status: 'UNVERIFIED' },
    evidence: {
      sceneRefs: { before: beforeScene.sceneId },
      screenshotRefs: [beforeScene.screenshot.ref],
    },
  };
}

{
  const current = fixture('unpromoted');
  const beforeScene = store.readCurrentScene(current.execDir);
  const execution = store.loadExecution(current.execDir);
  const scene = persistSequenceScreenshotScene(current.execDir, captured(beforeScene, '1'), execution, {
    operationId: 'capture-0001',
    purpose: 'SEQUENCE_ACTION_POST',
    captureOrigins: ['ACTION_POST', 'AGENT_REQUESTED', 'ACTION_POST'],
    relatedOperationId: 'action-0042',
    sequenceId: 'sequence-0001',
    stepId: 'tap',
    previousAction: previousAction(beforeScene),
    beforeScene,
    decisionId: 'decision-0001',
  }, { promote: false });

  assert.strictEqual(scene.captureMode, 'SCREENSHOT_ONLY');
  assert.deepStrictEqual(scene.captureOrigins, ['AGENT_REQUESTED', 'ACTION_POST']);
  assert.strictEqual(scene.relatedOperationId, 'action-0042');
  assert.strictEqual(scene.sequenceId, 'sequence-0001');
  assert.strictEqual(scene.stepId, 'tap');
  assert.strictEqual(scene.source.operation, 'runSequence');
  assert.strictEqual(Object.hasOwn(scene.source, legacyPlanKey), false);
  assert.deepStrictEqual(scene.previousAction.evidence.sceneRefs, {
    before: beforeScene.sceneId,
    after: scene.sceneId,
  });
  assert.deepStrictEqual(scene.previousAction.evidence.screenshotRefs, [
    beforeScene.screenshot.ref,
    'screenshots/sequence-1.png',
  ]);
  assert.strictEqual(store.readCurrentScene(current.execDir).sceneId, beforeScene.sceneId);

  const persisted = JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', `${scene.sceneId}.json`), 'utf8'));
  assert.deepStrictEqual(persisted, scene);
  const event = store.events(current.execDir).at(-1);
  assert.strictEqual(event.type, 'sceneObserved');
  assert.strictEqual(event.sceneId, scene.sceneId);
  assert.strictEqual(event.operationId, 'capture-0001');
  assert.strictEqual(event.captureMode, 'SCREENSHOT_ONLY');
  assert.deepStrictEqual(event.captureOrigins, scene.captureOrigins);
  assert.strictEqual(event.relatedOperationId, 'action-0042');
  assert.strictEqual(event.sequenceId, 'sequence-0001');
  assert.strictEqual(event.stepId, 'tap');
  assert.strictEqual(event.promoted, false);
  assert.strictEqual(Object.hasOwn(event, legacyPlanKey), false);
}

{
  const current = fixture('promoted');
  const beforeScene = store.readCurrentScene(current.execDir);
  const scene = persistSequenceScreenshotScene(
    current.execDir,
    captured(beforeScene, '2'),
    store.loadExecution(current.execDir),
    {
      operationId: 'capture-0002',
      captureOrigins: ['AGENT_REQUESTED'],
      sequenceId: 'sequence-0002',
      stepId: 'shot',
      beforeScene,
    },
    { promote: true },
  );
  assert.strictEqual(store.readCurrentScene(current.execDir).sceneId, scene.sceneId);
  assert.strictEqual(store.events(current.execDir).at(-1).promoted, true);
}

{
  const current = fixture('invalid');
  const beforeScene = store.readCurrentScene(current.execDir);
  const execution = store.loadExecution(current.execDir);
  const result = captured(beforeScene, '3');
  assert.throws(() => persistSequenceScreenshotScene(current.execDir, result, execution, {
    operationId: 'capture-invalid-origin',
    captureOrigins: ['UNKNOWN_ORIGIN'],
    sequenceId: 'sequence-0003',
    stepId: 'shot',
  }, { promote: false }), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');
  assert.throws(() => persistSequenceScreenshotScene(current.execDir, result, execution, {
    operationId: 'capture-invalid-association',
    captureOrigins: ['AGENT_REQUESTED'],
    relatedOperationId: 'action-0042',
    sequenceId: 'sequence-0003',
    stepId: 'shot',
  }, { promote: false }), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');
  assert.throws(() => persistSequenceScreenshotScene(current.execDir, result, execution, {
    operationId: 'capture-missing-promotion',
    captureOrigins: ['AGENT_REQUESTED'],
    sequenceId: 'sequence-0003',
    stepId: 'shot',
  }), (error) => error.code === 'CASE_RUNTIME_REQUEST_INVALID');
}

console.log('sequence screenshot Scene persistence passed');
