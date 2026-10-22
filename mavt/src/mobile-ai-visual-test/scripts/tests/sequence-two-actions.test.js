#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSequences, runSequence } = require('../case-runtime/sequence-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-sequence-two-actions-${suffix}-`));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { suffix });
  const executionPath = path.join(current.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  fs.writeFileSync(executionPath, `${JSON.stringify({
    ...execution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING',
  }, null, 2)}\n`);
  store.writeScene(current.execDir, JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
  return current.execDir;
}

function act(id) {
  return { id, type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } };
}

function request(execDir, steps = [act('first'), act('second')]) {
  return {
    operation: 'runSequence',
    basedOnSceneId: store.readCurrentScene(execDir).sceneId,
    purpose: 'two action sequence',
    steps,
  };
}

function harness(execDir) {
  const initial = store.readCurrentScene(execDir);
  const calls = [];
  return {
    calls,
    options: {
      remainingMs: 60000,
      decisionId: 'decision-two-actions',
      clock: () => 0,
      invokeDeviceOperation: (_dir, payload, kind, options) => {
        calls.push({
          kind, operationId: payload.operationId, timeoutMs: options.timeoutMs,
          currentSceneId: store.readCurrentScene(execDir).sceneId,
        });
        if (kind === 'ACTION') {
          return {
            adapterResult: {
              schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: payload.action,
              command: { status: 'ACCEPTED' }, deviceExecution: { status: 'UNVERIFIED' },
            },
          };
        }
        return {
          adapterResult: {
            schemaVersion: 1, type: 'observation', platform: 'harmony', time: '2026-09-24T10:00:00.000Z',
            app: initial.app, artifacts: { screenshot: initial.screenshot.ref, layout: null, logs: [] },
          },
          evidence: {
            ref: initial.screenshot.ref, sha256: initial.screenshot.sha256,
            width: initial.screenshot.width, height: initial.screenshot.height, usable: true,
          },
        };
      },
    },
  };
}

{
  const execDir = fixture('happy');
  const before = store.readCurrentScene(execDir);
  const input = request(execDir);
  const h = harness(execDir);
  const result = runSequence(execDir, input, h.options);

  assert.strictEqual(result.status, 'SEQUENCE_COMPLETED');
  assert.deepStrictEqual(h.calls.map(({ kind }) => kind), ['ACTION', 'CAPTURE', 'ACTION', 'OBSERVE']);
  assert.strictEqual(h.calls.filter(({ kind }) => kind === 'ACTION').length, 2);
  assert.strictEqual(h.calls.filter(({ kind }) => kind === 'CAPTURE').length, 1);
  assert.strictEqual(h.calls.filter(({ kind }) => kind === 'OBSERVE').length, 1);

  const [first, second] = result.steps;
  const screenshotScene = JSON.parse(fs.readFileSync(path.join(execDir, 'scenes', `${first.postSceneRef}.json`), 'utf8'));
  const finalScene = store.readCurrentScene(execDir);
  assert.strictEqual(first.preSceneRef, before.sceneId);
  assert.strictEqual(first.postSceneRef, screenshotScene.sceneId);
  assert.strictEqual(second.preSceneRef, screenshotScene.sceneId);
  assert.strictEqual(second.postSceneRef, finalScene.sceneId);
  assert.strictEqual(screenshotScene.captureMode, 'SCREENSHOT_ONLY');
  assert.deepStrictEqual(screenshotScene.captureOrigins, ['ACTION_POST']);
  assert.strictEqual(screenshotScene.relatedOperationId, first.operationId);
  assert.notStrictEqual(screenshotScene.sceneId, finalScene.sceneId);
  assert.strictEqual(finalScene.captureMode, 'FULL_SCENE');
  assert.deepStrictEqual(finalScene.captureOrigins, ['ACTION_POST', 'SEQUENCE_FINAL']);
  assert.strictEqual(finalScene.relatedOperationId, second.operationId);
  assert.strictEqual(finalScene.sequenceId, result.sequenceId);
  assert.strictEqual(finalScene.stepId, 'second');
  assert.deepStrictEqual(finalScene.previousAction.evidence.sceneRefs, {
    before: screenshotScene.sceneId,
    after: finalScene.sceneId,
  });
  assert.strictEqual(h.calls[2].currentSceneId, before.sceneId);

  for (const step of result.steps) {
    assert.strictEqual(transactions.readAction(execDir, step.operationId), null);
    assert.strictEqual(transactions.readCompletedAction(execDir, step.operationId).status, 'COMPLETED');
    assert.strictEqual(store.events(execDir).filter((event) => (
      event.type === 'actionCompleted' && event.operationId === step.operationId
    )).length, 1);
  }
  const callsBeforeReplay = h.calls.length;
  const replay = runSequence(execDir, input, { ...h.options, remainingMs: 1, decisionId: 'decision-replay' });
  assert.strictEqual(replay.sequenceId, result.sequenceId);
  assert.strictEqual(replay.idempotent, true);
  assert.strictEqual(h.calls.length, callsBeforeReplay);
}

{
  const execDir = fixture('prevalidation');
  const h = harness(execDir);
  const invalidSecond = {
    id: 'missing', type: 'act', capabilityId: `${store.readCurrentScene(execDir).sceneId}:tap:missing`,
  };
  assert.strictEqual(runSequence(execDir, request(execDir, [act('first'), invalidSecond]), h.options).status, 'SCENE_CHANGED');
  assert.deepStrictEqual(h.calls, []);
  assert.deepStrictEqual(readSequences(execDir), []);
}

console.log('two action sequence passed');
