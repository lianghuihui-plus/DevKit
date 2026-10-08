'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertSequenceIntegrity,
  readSequences,
  recoverInterruptedSequences,
  runSequence,
  writeSequenceRecord,
} = require('../case-runtime/sequence-service');
const { validateSequenceEvidenceGraph } = require('../case-runtime/result-integrity');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

assert.strictEqual(typeof recoverInterruptedSequences, 'function');

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-sequence-recovery-${suffix}-`));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { suffix });
  const executionFile = path.join(current.execDir, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionFile, 'utf8'));
  fs.writeFileSync(executionFile, `${JSON.stringify({
    ...execution,
    endedAt: null,
    status: 'RUNNING',
    lifecycle: 'RUNNING',
    finalized: false,
    executionStatus: 'RUNNING',
  }, null, 2)}\n`);
  const initial = JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
  store.writeScene(current.execDir, initial);
  return current.execDir;
}

function sequenceRequest(execDir) {
  return {
    operation: 'runSequence',
    basedOnSceneId: store.readCurrentScene(execDir).sceneId,
    purpose: 'recover one deterministic action',
    steps: [{ id: 'tap', type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } }],
  };
}

function harness(execDir, interruptAfter, behavior = {}) {
  const initial = store.readCurrentScene(execDir);
  const calls = [];
  return {
    calls,
    options: {
      remainingMs: 30000,
      clock: () => 0,
      now: '2026-09-24T12:00:00.000Z',
      interruptAfter,
      invokeDeviceOperation: (_dir, payload, kind, options) => {
        calls.push({ kind, operationId: payload.operationId, timeoutMs: options.timeoutMs });
        if (kind === 'ACTION') return {
          adapterResult: {
            command: { status: 'ACCEPTED' },
            deviceExecution: { status: 'UNVERIFIED' },
          },
        };
        if (kind === 'CAPTURE' && behavior.failCapture) {
          const error = new Error('explicit screenshot failed');
          error.code = 'OBSERVATION_SCREENSHOT_FAILED';
          throw error;
        }
        if (behavior.failRecoveryCapture) {
          const error = new Error('recovery observation failed');
          error.code = 'OBSERVATION_SCREENSHOT_FAILED';
          throw error;
        }
        return {
          adapterResult: {
            schemaVersion: 1,
            type: 'observation',
            platform: 'harmony',
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

function sequenceDrafts(execDir) {
  const directory = store.paths(execDir).transactions;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.draft.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    .filter((draft) => draft.sequenceId);
}

for (const scenario of [
  { name: 'record-before-request-event', interruptAfter: 'sequence-record-persisted', expectedRecoveryCaptures: 1 },
  { name: 'record-created', interruptAfter: 'sequence-created', expectedRecoveryCaptures: 1 },
  { name: 'prepared', interruptAfter: 'action-prepared', expectedRecoveryCaptures: 1 },
  { name: 'dispatched', interruptAfter: 'action-dispatched', expectedRecoveryCaptures: 1 },
  { name: 'result-recorded', interruptAfter: 'action-result-recorded', expectedRecoveryCaptures: 1 },
  { name: 'post-scene', interruptAfter: 'post-scene-persisted', expectedRecoveryCaptures: 0 },
  { name: 'observed', interruptAfter: 'observe', expectedRecoveryCaptures: 0 },
  { name: 'final-scene', interruptAfter: 'sequence-final-scene-persisted', expectedRecoveryCaptures: 0 },
  {
    name: 'terminal-record-before-event', interruptAfter: 'sequence-terminal-record-persisted',
    expectedRecoveryCaptures: 0, expectedRecoveries: 0,
  },
]) {
  const execDir = fixture(scenario.name);
  const h = harness(execDir, scenario.interruptAfter);
  assert.throws(() => runSequence(execDir, sequenceRequest(execDir), h.options), undefined, scenario.name);
  const beforeRecoveryCalls = h.calls.length;
  const beforeActionDispatches = h.calls.filter((call) => call.kind === 'ACTION').length;

  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, scenario.expectedRecoveries ?? 1, scenario.name);
  assert.strictEqual(sequenceDrafts(execDir).length, 0, scenario.name);
  assert.strictEqual(h.calls.slice(beforeRecoveryCalls).filter((call) => call.kind === 'ACTION').length, 0, scenario.name);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, beforeActionDispatches, scenario.name);
  assert.strictEqual(
    h.calls.slice(beforeRecoveryCalls).filter((call) => ['CAPTURE', 'OBSERVE'].includes(call.kind)).length,
    scenario.expectedRecoveryCaptures,
    scenario.name,
  );

  const records = readSequences(execDir);
  assert.strictEqual(records.length, 1, scenario.name);
  assert.strictEqual(records[0].terminal, true, scenario.name);
  assert.ok(records[0].integrity?.recordSha256, scenario.name);
  assertSequenceIntegrity(execDir, records[0]);
  assert.deepStrictEqual(validateSequenceEvidenceGraph(execDir).sequenceIds, [records[0].sequenceId]);
  const actionCompleted = store.events(execDir).filter((event) => (
    event.type === 'actionCompleted' && event.sequenceId === records[0].sequenceId
  ));
  assert.ok(actionCompleted.length <= 1, scenario.name);
  const terminalEvents = store.events(execDir).filter((event) => (
    ['sequenceCompleted', 'sequenceInterrupted'].includes(event.type)
      && event.sequenceId === records[0].sequenceId
  ));
  assert.strictEqual(terminalEvents.length, 1, scenario.name);

  const signature = records[0].integrity.recordSha256;
  const callsAfterFirstRecovery = h.calls.length;
  assert.deepStrictEqual(recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined }), [], scenario.name);
  assert.strictEqual(h.calls.length, callsAfterFirstRecovery, scenario.name);
  assert.strictEqual(readSequences(execDir)[0].integrity.recordSha256, signature, scenario.name);
}

{
  const execDir = fixture('terminal-event-repair');
  const h = harness(execDir, 'sequence-terminal-record-persisted');
  const originalRequest = sequenceRequest(execDir);
  assert.throws(() => runSequence(execDir, originalRequest, h.options));
  const original = readSequences(execDir)[0];
  assert.strictEqual(original.terminal, true);
  const calls = h.calls.length;
  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, 0);
  assert.strictEqual(h.calls.length, calls);
  assert.strictEqual(readSequences(execDir)[0].integrity.recordSha256, original.integrity.recordSha256);
  assert.deepStrictEqual(validateSequenceEvidenceGraph(execDir).sequenceIds, [original.sequenceId]);
  const replay = runSequence(execDir, originalRequest, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(replay.idempotent, true);
  assert.strictEqual(replay.sequenceId, original.sequenceId);
  assert.strictEqual(h.calls.length, calls);
  assert.deepStrictEqual(recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined }), []);
  assert.strictEqual(store.events(execDir).filter((event) => event.sequenceId === original.sequenceId
    && ['sequenceCompleted', 'sequenceInterrupted'].includes(event.type)).length, 1);
}

{
  const execDir = fixture('completed-action-before-step-record');
  const h = harness(execDir, 'action-transaction-completed');
  assert.throws(() => runSequence(execDir, sequenceRequest(execDir), h.options));
  assert.strictEqual(sequenceDrafts(execDir).length, 0);
  const dispatchesBeforeRecovery = h.calls.filter((call) => call.kind === 'ACTION').length;

  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, dispatchesBeforeRecovery);
  const record = readSequences(execDir)[0];
  assert.deepStrictEqual(record.steps.map((step) => step.stepId), ['tap']);
  assert.strictEqual(record.steps[0].status, 'COMPLETED');
  assert.ok(record.steps[0].operationId);
  assert.ok(record.steps[0].postSceneRef);
  assertSequenceIntegrity(execDir, record);
  const missingAction = writeSequenceRecord(execDir, { ...record, steps: [] });
  assert.throws(() => assertSequenceIntegrity(execDir, missingAction), (error) => (
    error.code === 'SEQUENCE_RECORD_INCOMPLETE'
      && /action is missing from the step record/.test(error.message)
  ));
}

for (const mode of ['FULL_SCENE', 'SCREENSHOT_ONLY']) {
  const execDir = fixture(`completed-action-with-${mode.toLowerCase()}`);
  const h = harness(execDir, 'action-transaction-completed');
  const request = sequenceRequest(execDir);
  request.steps.push({ id: 'evidence', type: 'capture', mode, purpose: 'retain business evidence' });
  assert.throws(() => runSequence(execDir, request, h.options));
  const actionDispatches = h.calls.filter((call) => call.kind === 'ACTION').length;

  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, 1, mode);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, actionDispatches, mode);
  const record = readSequences(execDir)[0];
  assert.deepStrictEqual(record.steps.map((step) => step.stepId), ['tap', 'evidence'], mode);
  assert.strictEqual(record.steps[1].status, 'COMPLETED', mode);
  assert.strictEqual(record.steps[1].mode, mode, mode);
  assert.strictEqual(record.steps[1].postSceneRef, record.steps[0].postSceneRef, mode);
  assertSequenceIntegrity(execDir, record);
  if (mode === 'FULL_SCENE') {
    const missingCapture = writeSequenceRecord(execDir, { ...record, steps: record.steps.slice(0, 1) });
    assert.throws(() => assertSequenceIntegrity(execDir, missingCapture), (error) => (
      error.code === 'SEQUENCE_RECORD_INCOMPLETE'
        && /capture is missing from the step record/.test(error.message)
    ));
  }
}

{
  const execDir = fixture('ambiguous-failed-adjacent-capture');
  const h = harness(execDir, 'action-transaction-completed', { failCapture: true });
  const request = sequenceRequest(execDir);
  request.steps.push({
    id: 'evidence', type: 'capture', mode: 'SCREENSHOT_ONLY', purpose: 'retain business evidence',
  });
  assert.throws(() => runSequence(execDir, request, h.options));
  const actionDispatches = h.calls.filter((call) => call.kind === 'ACTION').length;
  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(h.calls.filter((call) => call.kind === 'ACTION').length, actionDispatches);
  const record = readSequences(execDir)[0];
  assert.strictEqual(record.status, 'SEQUENCE_INTERRUPTED');
  assert.strictEqual(record.failure.code, 'SEQUENCE_CAPTURE_FAILED');
  assert.deepStrictEqual(record.steps.map((step) => [step.stepId, step.status]), [
    ['tap', 'COMPLETED'],
    ['evidence', 'FAILED'],
  ]);
  assert.strictEqual(record.steps[1].postSceneRef, null);
  assert.strictEqual(record.finalSceneRef, record.steps[0].postSceneRef);
  assertSequenceIntegrity(execDir, record);
}

{
  const execDir = fixture('expired-deadline');
  let currentTime = 1000;
  const h = harness(execDir, 'sequence-created');
  h.options.clock = () => currentTime;
  assert.throws(() => runSequence(execDir, sequenceRequest(execDir), h.options));
  assert.strictEqual(readSequences(execDir)[0].deadlineMs, 31000);

  currentTime = 31001;
  const callsBeforeRecovery = h.calls.length;
  const recovered = recoverInterruptedSequences(execDir, { ...h.options, interruptAfter: undefined });
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(h.calls.length, callsBeforeRecovery);
  const record = readSequences(execDir)[0];
  assert.strictEqual(record.finalSceneRef, null);
  assert.strictEqual(record.remainingMs, 0);
  assert.ok(store.events(execDir).some((event) => event.sequenceId === record.sequenceId
    && event.code === 'SEQUENCE_FINAL_CAPTURE_FAILED'));
}

{
  const execDir = fixture('unknown-capture-failure');
  const h = harness(execDir, 'action-dispatched');
  assert.throws(() => runSequence(execDir, sequenceRequest(execDir), h.options));
  const recovery = harness(execDir, null, { failRecoveryCapture: true });
  const recovered = recoverInterruptedSequences(execDir, recovery.options);
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(sequenceDrafts(execDir).length, 0);
  assert.strictEqual(readSequences(execDir)[0].finalSceneRef, null);
  assert.strictEqual(readSequences(execDir)[0].outcomeKnown, false);
  assert.strictEqual(recovery.calls.filter((call) => call.kind === 'ACTION').length, 0);
  assert.strictEqual(recovery.calls.filter((call) => call.kind === 'OBSERVE').length, 1);
}

console.log('sequence-recovery.test.js: all assertions passed');
