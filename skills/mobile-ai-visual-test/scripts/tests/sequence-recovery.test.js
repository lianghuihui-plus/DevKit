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
