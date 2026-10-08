#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildExecutionTrace } = require('../report/execution-trace');
const { metrics } = require('../case-runtime/result-service');
const { assertSequenceIntegrity, readSequences, runSequence } = require('../case-runtime/sequence-service');
const store = require('../case-runtime/store');
const { readExecutionReport } = require('../lib/execution-reader');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-sequence-report-'));
createTestWorkspace(root);
const fixture = createCurrentFixture(root, { suffix: 'sequence-report' });
const executionPath = path.join(fixture.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, `${JSON.stringify({
  ...execution, endedAt: null, status: 'RUNNING', lifecycle: 'RUNNING', finalized: false, executionStatus: 'RUNNING',
}, null, 2)}\n`);
store.writeScene(fixture.execDir, JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'scenes', 'scene-0002.json'), 'utf8')));

const initial = store.readCurrentScene(fixture.execDir);
const sequence = runSequence(fixture.execDir, {
  operation: 'runSequence',
  basedOnSceneId: initial.sceneId,
  purpose: 'report must link each action to exact Scenes',
  steps: [
    { id: 'first', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } },
    { id: 'second', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } },
  ],
}, {
  remainingMs: 60000,
  clock: () => 0,
  invokeDeviceOperation: (_dir, payload, kind) => {
    if (kind === 'ACTION') {
      return { adapterResult: {
        schemaVersion: 2, type: 'actionResult', platform: 'harmony', action: payload.action,
        command: { status: 'ACCEPTED' }, deviceExecution: { status: 'UNVERIFIED' },
      } };
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
  invokeScreenshotCapture: (_dir, _payload) => ({
    adapterResult: { time: '2026-09-24T10:00:00.000Z', app: initial.app },
    evidence: {
      ref: initial.screenshot.ref, sha256: initial.screenshot.sha256,
      width: initial.screenshot.width, height: initial.screenshot.height, usable: true,
    },
  }),
});

assert.strictEqual(sequence.status, 'SEQUENCE_COMPLETED');
const record = readSequences(fixture.execDir)[0];
assert.deepStrictEqual(assertSequenceIntegrity(fixture.execDir, record), record);
const trace = buildExecutionTrace(readExecutionReport(fixture.execDir));
assert.strictEqual(trace.sequences.length, 1);
assert.ok(!Object.hasOwn(trace, 'plans'));
assert.strictEqual(trace.sequences[0].sequenceId, sequence.sequenceId);
assert.strictEqual(trace.sequences[0].sequenceRecordRef, sequence.sequenceRecordRef);
assert.strictEqual(trace.sequences[0].integrity.status, 'VALID');
assert.deepStrictEqual(trace.sequences[0].steps, record.steps);

for (const step of sequence.steps) {
  const action = trace.entries.find((entry) => entry.category === 'ACTION' && entry.operationId === step.operationId);
  assert.ok(action, `report action missing for ${step.operationId}`);
  assert.strictEqual(action.beforeObservationEntry?.sceneId, step.preSceneRef);
  assert.strictEqual(action.afterObservationEntry?.sceneId, step.postSceneRef);
  assert.deepStrictEqual(action.evidence.sceneRefs, { before: step.preSceneRef, after: step.postSceneRef });
}

const unknownError = Object.assign(new Error('delivery uncertain'), { code: 'DEVICE_ACTION_FAILED' });
const unknownBefore = store.readCurrentScene(fixture.execDir);
const unknownSequence = runSequence(fixture.execDir, {
  operation: 'runSequence',
  basedOnSceneId: unknownBefore.sceneId,
  purpose: 'unknown action must retain reportable after Scene evidence',
  steps: [{ id: 'unknown', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } }],
}, {
  remainingMs: 60000,
  clock: () => 0,
  invokeDeviceOperation: (_dir, _payload, kind) => {
    if (kind === 'ACTION') throw unknownError;
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
});
assert.strictEqual(unknownSequence.status, 'SEQUENCE_PARTIAL');
assert.strictEqual(unknownSequence.outcomeKnown, false);
const unknownRecord = readSequences(fixture.execDir).find((item) => item.sequenceId === unknownSequence.sequenceId);
assert.deepStrictEqual(assertSequenceIntegrity(fixture.execDir, unknownRecord), unknownRecord);
const unknownStep = unknownRecord.steps[0];
assert.ok(unknownStep.postSceneRef);
const unknownTrace = buildExecutionTrace(readExecutionReport(fixture.execDir));
const unknownAction = unknownTrace.entries.find((entry) => entry.category === 'ACTION'
  && entry.operationId === unknownStep.operationId);
assert.strictEqual(unknownAction.beforeObservationEntry?.sceneId, unknownStep.preSceneRef);
assert.strictEqual(unknownAction.afterObservationEntry?.sceneId, unknownStep.postSceneRef);
assert.deepStrictEqual(unknownAction.evidence.sceneRefs, {
  before: unknownStep.preSceneRef,
  after: unknownStep.postSceneRef,
});

const calculated = metrics(execution, { verdict: 'INCONCLUSIVE', checks: [] },
  store.events(fixture.execDir), '2026-09-24T10:01:00.000Z', fixture.execDir);
assert.strictEqual(calculated.sequenceMetrics.runCount, 2);
assert.strictEqual(calculated.sequenceMetrics.partialCount, 1);
assert.strictEqual(calculated.sequenceMetrics.actionStepCount, 3);
assert.strictEqual(calculated.sequenceMetrics.stepCount, 3);
console.log('sequence report passed');
