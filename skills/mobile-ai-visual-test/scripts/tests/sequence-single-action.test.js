#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertSequenceIntegrity,
  readSequences,
  runSequence,
} = require('../case-runtime/sequence-service');
const store = require('../case-runtime/store');
const transactions = require('../case-runtime/transaction-manager');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-sequence-single-${suffix}-`));
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
  return current.execDir;
}

const act = (id = 'tap') => ({
  id,
  type: 'act',
  visual: { gesture: 'tap', point: [0.5, 0.5] },
});

function request(execDir, step = act()) {
  return {
    operation: 'runSequence',
    basedOnSceneId: store.readCurrentScene(execDir).sceneId,
    purpose: 'single action sequence',
    steps: [step],
  };
}

function harness(execDir) {
  const initial = store.readCurrentScene(execDir);
  const calls = [];
  return {
    calls,
    options: {
      remainingMs: 60000,
      decisionId: 'decision-original',
      clock: () => 0,
      invokeDeviceOperation: (_dir, payload, kind, options) => {
        calls.push({
          kind,
          operationId: payload.operationId,
          timeoutMs: options.timeoutMs,
          preAdapterDelayMs: options.preAdapterDelayMs || 0,
          currentSceneId: store.readCurrentScene(execDir).sceneId,
          sequences: readSequences(execDir),
        });
        if (kind === 'ACTION') {
          return {
            adapterResult: {
              schemaVersion: 2,
              type: 'actionResult',
              platform: 'harmony',
              action: payload.action,
              command: { status: 'ACCEPTED' },
              deviceExecution: { status: 'UNVERIFIED' },
            },
          };
        }
        return {
          adapterResult: {
            schemaVersion: 1,
            type: 'observation',
            platform: 'harmony',
            time: '2026-09-24T10:00:00.000Z',
            app: initial.app,
            artifacts: { screenshot: initial.screenshot.ref, layout: null, logs: [] },
          },
          evidence: {
            ref: initial.screenshot.ref,
            sha256: initial.screenshot.sha256,
            width: initial.screenshot.width,
            height: initial.screenshot.height,
            usable: true,
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
  assert.strictEqual(result.outcomeKnown, true);
  assert.strictEqual(result.idempotent, false);
  assert.deepStrictEqual(h.calls.map((call) => call.kind), ['ACTION', 'OBSERVE']);
  assert.strictEqual(h.calls[0].timeoutMs, 26000);
  assert.strictEqual(h.calls[1].timeoutMs, 30000);
  assert.strictEqual(h.calls[1].preAdapterDelayMs, 500);
  assert.ok(h.calls.every((call) => call.currentSceneId === before.sceneId));
  assert.strictEqual(h.calls[0].sequences.length, 1);
  assert.strictEqual(h.calls[0].sequences[0].terminal, false);

  const step = result.steps[0];
  assert.strictEqual(step.stepId, 'tap');
  assert.strictEqual(step.type, 'act');
  assert.strictEqual(step.status, 'COMPLETED');
  assert.strictEqual(step.preSceneRef, before.sceneId);
  assert.strictEqual(step.postSceneRef, result.finalSceneRef);

  const finalScene = store.readCurrentScene(execDir);
  assert.strictEqual(finalScene.sceneId, result.finalSceneRef);
  assert.strictEqual(finalScene.captureMode, 'FULL_SCENE');
  assert.deepStrictEqual(finalScene.captureOrigins, ['ACTION_POST', 'SEQUENCE_FINAL']);
  assert.strictEqual(finalScene.relatedOperationId, step.operationId);
  assert.strictEqual(finalScene.sequenceId, result.sequenceId);
  assert.strictEqual(finalScene.stepId, 'tap');
  assert.deepStrictEqual(finalScene.previousAction.evidence.sceneRefs, {
    before: before.sceneId,
    after: finalScene.sceneId,
  });

  assert.strictEqual(transactions.readAction(execDir, step.operationId), null);
  assert.strictEqual(transactions.readCompletedAction(execDir, step.operationId).status, 'COMPLETED');
  const completedEvents = store.events(execDir).filter((event) => (
    event.type === 'actionCompleted' && event.operationId === step.operationId
  ));
  assert.strictEqual(completedEvents.length, 1);
  assert.strictEqual(completedEvents[0].sequenceId, result.sequenceId);
  assert.strictEqual(completedEvents[0].sceneId, before.sceneId);
  assert.strictEqual(completedEvents[0].sceneIdAfter, finalScene.sceneId);

  const record = readSequences(execDir)[0];
  assert.strictEqual(record.terminal, true);
  assert.deepStrictEqual(assertSequenceIntegrity(execDir, record), record);
  assert.deepStrictEqual(record.evidence.sceneRefs, [before.sceneId, finalScene.sceneId]);

  const callCount = h.calls.length;
  const replay = runSequence(execDir, input, {
    ...h.options,
    remainingMs: 1000,
    decisionId: 'decision-retry',
  });
  assert.strictEqual(replay.sequenceId, result.sequenceId);
  assert.strictEqual(replay.idempotent, true);
  assert.strictEqual(h.calls.length, callCount);

  const changed = { ...input, steps: [act('different')] };
  const stale = runSequence(execDir, changed, h.options);
  assert.strictEqual(stale.status, 'SCENE_CHANGED');
  assert.strictEqual(h.calls.length, callCount);
}

{
  const execDir = fixture('prevalidation');
  const h = harness(execDir);
  const unavailable = request(execDir, {
    id: 'missing',
    type: 'act',
    capabilityId: `${store.readCurrentScene(execDir).sceneId}:tap:missing`,
  });
  assert.strictEqual(runSequence(execDir, unavailable, h.options).status, 'SCENE_CHANGED');
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(readSequences(execDir).length, 0);
}

{
  const execDir = fixture('unsupported');
  const h = harness(execDir);
  assert.throws(() => runSequence(execDir, request(execDir, {
    id: 'wait', type: 'wait', ms: 0,
  }), h.options), (error) => error.code === 'SEQUENCE_NOT_IMPLEMENTED');
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(readSequences(execDir).length, 0);
}

console.log('single terminal sequence action passed');
