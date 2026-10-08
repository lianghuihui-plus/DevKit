'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSequence, readSequences, assertSequenceIntegrity } = require('../case-runtime/sequence-service');
const { validateSequenceEvidenceGraph } = require('../case-runtime/result-integrity');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-sequence-'));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { suffix: 'sequence' });
  const executionFile = path.join(current.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionFile, 'utf8'));
  fs.writeFileSync(executionFile, `${JSON.stringify({ ...execution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING' }, null, 2)}\n`);
  store.writeScene(current.execDir, JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', 'scene-0002.json'), 'utf8')));
  return current.execDir;
}

const act = (id) => ({ id, type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } });
const capture = (id, mode) => ({ id, type: 'capture', mode, purpose: id });
function request(execDir, steps, basedOnSceneId = store.readCurrentScene(execDir).sceneId) {
  return { operation: 'runSequence', basedOnSceneId, purpose: 'sequence test', steps };
}

function harness(execDir, outcomes = [], behavior = {}) {
  const initial = store.readCurrentScene(execDir);
  const calls = [];
  let now = 0;
  return {
    calls,
    options: {
      remainingMs: 30000,
      clock: () => now,
      sleep: (ms) => { calls.push({ kind: 'WAIT', ms }); now += ms; },
      invokeDeviceOperation: (_dir, payload, kind, options) => {
        calls.push({ kind, operationId: payload.operationId, timeoutMs: options.timeoutMs });
        if (kind === 'ACTION') {
          const actionError = behavior.actionErrors?.shift();
          if (actionError) throw actionError;
          const outcome = outcomes.shift() || {};
          return { adapterResult: {
            command: { status: outcome.command || 'ACCEPTED' },
            deviceExecution: { status: outcome.device || 'UNVERIFIED' },
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          } };
        }
        if (kind === 'OBSERVE' && behavior.failObserve) {
          const error = new Error('final observation failed');
          error.code = 'OBSERVATION_SCREENSHOT_FAILED';
          throw error;
        }
        return { adapterResult: { schemaVersion: 1, type: 'observation', platform: 'harmony', app: initial.app,
          artifacts: { screenshot: initial.screenshot.ref, layout: null, logs: [] } },
        evidence: { ref: initial.screenshot.ref, sha256: initial.screenshot.sha256, width: initial.screenshot.width,
          height: initial.screenshot.height, usable: true } };
      },
      invokeScreenshotCapture: (_dir, payload, options) => {
        calls.push({ kind: 'CAPTURE', operationId: payload.operationId, timeoutMs: options.timeoutMs });
        if (behavior.failCapture) {
          const error = new Error('intermediate screenshot failed');
          error.code = 'OBSERVATION_SCREENSHOT_FAILED';
          throw error;
        }
        return { adapterResult: { time: '2026-09-24T10:00:00.000Z', app: initial.app },
          evidence: { ref: initial.screenshot.ref, sha256: initial.screenshot.sha256, width: initial.screenshot.width,
            height: initial.screenshot.height, usable: true } };
      },
    },
  };
}

for (const [name, steps, captureModes, origins] of [
  ['two actions', [act('a'), act('b')], ['SCREENSHOT_ONLY', 'FULL_SCENE'], [['ACTION_POST'], ['ACTION_POST', 'SEQUENCE_FINAL']]],
  ['explicit screenshot between actions', [act('a'), capture('shot', 'SCREENSHOT_ONLY'), act('b')], ['SCREENSHOT_ONLY', 'FULL_SCENE'], [['AGENT_REQUESTED', 'ACTION_POST'], ['ACTION_POST', 'SEQUENCE_FINAL']]],
  ['terminal full capture', [act('a'), capture('full', 'FULL_SCENE')], ['FULL_SCENE'], [['AGENT_REQUESTED', 'ACTION_POST', 'SEQUENCE_FINAL']]],
  ['terminal screenshot', [act('a'), capture('shot', 'SCREENSHOT_ONLY')], ['SCREENSHOT_ONLY', 'FULL_SCENE'], [['AGENT_REQUESTED', 'ACTION_POST'], ['SEQUENCE_FINAL']]],
  ['full then action', [capture('first', 'FULL_SCENE'), act('a')], ['FULL_SCENE', 'FULL_SCENE'], [['AGENT_REQUESTED'], ['ACTION_POST', 'SEQUENCE_FINAL']]],
  ['wait only', [{ id: 'wait', type: 'wait', ms: 0 }], ['FULL_SCENE'], [['SEQUENCE_FINAL']]],
  ['capture only', [capture('full', 'FULL_SCENE')], ['FULL_SCENE'], [['AGENT_REQUESTED', 'SEQUENCE_FINAL']]],
]) {
  const execDir = fixture();
  const before = store.readCurrentScene(execDir);
  const h = harness(execDir);
  const result = runSequence(execDir, request(execDir, steps), h.options);
  assert.strictEqual(result.status, 'SEQUENCE_COMPLETED', name);
  const scenes = store.events(execDir).filter((event) => event.type === 'sceneObserved' && event.sequenceId === result.sequenceId)
    .map((event) => JSON.parse(fs.readFileSync(path.join(execDir, 'scenes', `${event.sceneId}.json`), 'utf8')));
  assert.deepStrictEqual(scenes.map((scene) => scene.captureMode), captureModes, name);
  assert.deepStrictEqual(scenes.map((scene) => scene.captureOrigins), origins, name);
  assert.strictEqual(store.readCurrentScene(execDir).sceneId, result.finalSceneRef, name);
  assert.strictEqual(scenes.filter((scene) => scene.captureMode === 'SCREENSHOT_ONLY').every((scene) => scene.sceneId !== result.finalSceneRef), true, name);
  assert.strictEqual(store.events(execDir).filter((event) => event.type === 'actionRequested' && event.sequenceId === result.sequenceId).length,
    steps.filter((step) => step.type === 'act').length, name);
  const actionSteps = result.steps.filter((step) => step.type === 'act');
  if (actionSteps.length) {
    const firstActionIndex = result.steps.findIndex((step) => step.type === 'act');
    const expectedPreSceneRef = firstActionIndex > 0
      ? result.steps[firstActionIndex - 1].postSceneRef
      : before.sceneId;
    assert.strictEqual(actionSteps[0].preSceneRef, expectedPreSceneRef, name);
    assert.ok(actionSteps.every((step) => step.postSceneRef), name);
  }
  assertSequenceIntegrity(execDir, readSequences(execDir)[0]);
  const graph = validateSequenceEvidenceGraph(execDir);
  assert.deepStrictEqual(graph.sequenceIds, [result.sequenceId], name);
  assert.ok(graph.files.includes(result.sequenceRecordRef), name);
}

{
  const execDir = fixture();
  const h = harness(execDir);
  const original = request(execDir, [act('a')]);
  const first = runSequence(execDir, original, h.options);
  const retry = runSequence(execDir, original, { ...h.options, remainingMs: 1000, decisionId: 'different' });
  assert.strictEqual(retry.sequenceId, first.sequenceId);
  assert.strictEqual(retry.idempotent, true);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, 1);
  const changed = { ...original, steps: [act('different')] };
  assert.strictEqual(runSequence(execDir, changed, h.options).status, 'SCENE_CHANGED');
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, 1);
}

for (const [duration, waits] of [[7000, [2000]], [5000, []]]) {
  const execDir = fixture();
  const h = harness(execDir);
  const result = runSequence(execDir, request(execDir, [{ id: 'wait', type: 'wait', ms: 2000 }]), { ...h.options, remainingMs: duration });
  assert.deepStrictEqual(h.calls.filter((call) => call.kind === 'WAIT').map((call) => call.ms), waits);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'OBSERVE').length, 1);
  assert.ok(result.finalSceneRef);
  assert.strictEqual(result.status, waits.length ? 'SEQUENCE_COMPLETED' : 'SEQUENCE_PARTIAL');
}

{
  const execDir = fixture();
  const h = harness(execDir, [], { failCapture: true });
  const result = runSequence(execDir, request(execDir, [act('a'), act('b')]), h.options);
  assert.strictEqual(result.status, 'SEQUENCE_PARTIAL');
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, 1);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'CAPTURE').length, 1);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'OBSERVE').length, 1);
  assert.strictEqual(result.steps[0].postSceneRef, result.finalSceneRef);
  assert.strictEqual(result.steps.some((step) => step.stepId === 'b'), false);
}

{
  const execDir = fixture();
  const h = harness(execDir, [], { failObserve: true });
  const result = runSequence(execDir, request(execDir, [act('a')]), h.options);
  assert.strictEqual(result.status, 'SEQUENCE_PARTIAL');
  assert.strictEqual(result.finalSceneRef, null);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'OBSERVE').length, 1);
  const completed = JSON.parse(fs.readFileSync(path.join(execDir, 'operations', `${result.steps[0].operationId}.json`), 'utf8'));
  assert.strictEqual(completed.sceneIdAfter, null);
  assert.ok(completed.captureFailureTechnicalFactRef);
  const record = readSequences(execDir)[0];
  assert.deepStrictEqual(record.technicalFacts, [completed.captureFailureTechnicalFactRef]);
  assertSequenceIntegrity(execDir, record);
}

{
  const execDir = fixture();
  const unknown = new Error('delivery uncertain');
  unknown.code = 'DEVICE_ACTION_FAILED';
  const h = harness(execDir, [], { actionErrors: [unknown] });
  const result = runSequence(execDir, request(execDir, [act('a'), act('b')]), h.options);
  assert.strictEqual(result.status, 'SEQUENCE_PARTIAL');
  assert.strictEqual(result.outcomeKnown, false);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, 1);
  assert.strictEqual(result.steps[0].status, 'UNKNOWN');
  assert.strictEqual(result.steps.some((step) => step.stepId === 'b'), false);
}

{
  const execDir = fixture();
  const h = harness(execDir);
  runSequence(execDir, request(execDir, [act('a'), act('b')]), { ...h.options, remainingMs: 7000 });
  assert.deepStrictEqual(h.calls.map(({ kind, timeoutMs }) => [kind, timeoutMs]), [
    ['ACTION', 3000], ['CAPTURE', 3000], ['ACTION', 3000], ['OBSERVE', 7000],
  ]);
}

for (const outcome of [{ command: 'REJECTED' }, { device: 'FAILED' }, { failureCode: 'ACTION_EFFECT_MISMATCH' }]) {
  const execDir = fixture();
  const h = harness(execDir, [outcome]);
  const result = runSequence(execDir, request(execDir, [act('a'), act('b')]), h.options);
  assert.strictEqual(result.outcomeKnown, true);
  assert.notStrictEqual(result.status, 'SEQUENCE_COMPLETED');
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, 1);
  assert.ok(result.finalSceneRef);
}

console.log('sequence-service.test.js: all assertions passed');
