#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sequenceRequestKey } = require('../case-runtime/sequence-contract');
const {
  assertSequenceIntegrity,
  findTerminalSequence,
  readSequences,
  responseFromSequenceRecord,
  sequencePath,
  writeSequenceRecord,
} = require('../case-runtime/sequence-service');
const store = require('../case-runtime/store');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

function fixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-sequence-record-${suffix}-`));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { suffix });
  const scene = JSON.parse(fs.readFileSync(path.join(current.execDir, 'scenes', 'scene-0002.json'), 'utf8'));
  store.writeScene(current.execDir, scene);
  return current;
}

function request(basedOnSceneId, stepId = 'tap') {
  return {
    operation: 'runSequence',
    basedOnSceneId,
    purpose: 'record replay test',
    steps: [{ id: stepId, type: 'act', visual: { gesture: 'tap', point: [0.5, 0.5] } }],
  };
}

function promoteFinalScene(execDir, sequenceId = 'sequence-0001') {
  const basis = store.readCurrentScene(execDir);
  const finalScene = {
    ...basis,
    sceneId: 'scene-0003',
    captureOrigins: ['SEQUENCE_FINAL'],
    sequenceId,
    stepId: null,
  };
  store.writeScene(execDir, finalScene);
  store.appendEvent(execDir, 'sceneObserved', {
    sceneId: finalScene.sceneId,
    screenshotRef: finalScene.screenshot.ref,
    screenshotSha256: finalScene.screenshot.sha256,
    promoted: true,
    captureOrigins: finalScene.captureOrigins,
    sequenceId,
    stepId: null,
  }, { allowFinalized: true });
  return finalScene;
}

function terminalRecord(execDir, value) {
  const sequenceId = value.sequenceId || 'sequence-0001';
  return {
    schemaVersion: 1,
    sequenceId,
    executionId: store.loadExecution(execDir, { allowFinalized: true }).executionId,
    requestKey: value.requestKey,
    basedOnSceneRef: value.basedOnSceneRef,
    sequenceRecordRef: path.relative(path.resolve(execDir), sequencePath(execDir, sequenceId)),
    terminal: value.terminal ?? true,
    status: value.status || 'SEQUENCE_COMPLETED',
    outcomeKnown: value.outcomeKnown ?? true,
    steps: value.steps || [],
    evidence: value.evidence || { sceneRefs: ['scene-0003'], screenshotRefs: [] },
    finalSceneRef: value.finalSceneRef === undefined ? 'scene-0003' : value.finalSceneRef,
    deadlineMs: value.deadlineMs ?? 30000,
    remainingMs: value.remainingMs ?? 4321,
    elapsedMs: value.elapsedMs ?? 0,
    technicalFacts: value.technicalFacts || [],
    failure: value.failure || null,
  };
}

{
  const current = fixture('terminal');
  const original = request(store.readCurrentScene(current.execDir).sceneId);
  promoteFinalScene(current.execDir);
  const unsigned = terminalRecord(current.execDir, {
    requestKey: sequenceRequestKey(original),
    basedOnSceneRef: original.basedOnSceneId,
  });
  const first = writeSequenceRecord(current.execDir, unsigned);
  const second = writeSequenceRecord(current.execDir, unsigned);

  assert.strictEqual(first.integrity.recordSha256, second.integrity.recordSha256);
  assert.deepStrictEqual(readSequences(current.execDir), [second]);
  assert.deepStrictEqual(assertSequenceIntegrity(current.execDir, second), second);

  store.writeScene(current.execDir, { ...store.readCurrentScene(current.execDir), sceneId: 'scene-9999' });
  const replay = findTerminalSequence(current.execDir, original, {
    remainingMs: 1,
    decisionId: 'different-runtime-metadata',
  });
  assert.strictEqual(replay.sequenceId, first.sequenceId);

  const response = responseFromSequenceRecord(replay, {
    idempotent: true,
    remainingMs: 1,
    decisionId: 'different-runtime-metadata',
  });
  assert.deepStrictEqual(response, {
    status: 'SEQUENCE_COMPLETED',
    outcomeKnown: true,
    sequenceId: 'sequence-0001',
    sequenceRecordRef: 'operations/sequences/sequence-0001.json',
    steps: [],
    evidence: { sceneRefs: ['scene-0003'], screenshotRefs: [] },
    finalSceneRef: 'scene-0003',
    remainingMs: 4321,
    elapsedMs: 0,
    idempotent: true,
  });
  assert.strictEqual(findTerminalSequence(current.execDir, request(original.basedOnSceneId, 'changed')), null);
}

{
  const current = fixture('missing-elapsed');
  const original = request(store.readCurrentScene(current.execDir).sceneId);
  promoteFinalScene(current.execDir);
  const { elapsedMs, ...missingElapsed } = terminalRecord(current.execDir, {
    requestKey: sequenceRequestKey(original),
    basedOnSceneRef: original.basedOnSceneId,
  });
  const saved = writeSequenceRecord(current.execDir, missingElapsed);
  assert.throws(
    () => assertSequenceIntegrity(current.execDir, saved),
    (error) => error.code === 'SEQUENCE_RECORD_INCOMPLETE' && /elapsed/.test(error.message),
  );
}

{
  const current = fixture('nonterminal');
  const original = request(store.readCurrentScene(current.execDir).sceneId);
  writeSequenceRecord(current.execDir, terminalRecord(current.execDir, {
    requestKey: sequenceRequestKey(original),
    basedOnSceneRef: original.basedOnSceneId,
    terminal: false,
    status: 'SEQUENCE_RUNNING',
    finalSceneRef: null,
  }));
  assert.throws(
    () => findTerminalSequence(current.execDir, original),
    (error) => error.code === 'SEQUENCE_RECORD_INCOMPLETE',
  );
}

{
  const current = fixture('tampered');
  const original = request(store.readCurrentScene(current.execDir).sceneId);
  promoteFinalScene(current.execDir);
  const saved = writeSequenceRecord(current.execDir, terminalRecord(current.execDir, {
    requestKey: sequenceRequestKey(original),
    basedOnSceneRef: original.basedOnSceneId,
  }));
  fs.writeFileSync(sequencePath(current.execDir, saved.sequenceId), `${JSON.stringify({
    ...saved,
    remainingMs: saved.remainingMs + 1,
  }, null, 2)}\n`);
  assert.throws(
    () => findTerminalSequence(current.execDir, original),
    (error) => error.code === 'SEQUENCE_RECORD_INCOMPLETE',
  );
}

console.log('sequence record replay passed');
