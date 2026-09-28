'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  FINAL_SCENE_RESERVE_MS,
  SEQUENCE_STATUSES,
  normalizeSequenceRequest,
  sequenceDurationMs,
  sequenceRequestKey,
} = require('./sequence-contract');
const { resolveActionRequest } = require('./action-request');
const {
  classifyActionOutcome,
  completeDispatchedAction,
  dispatchAction,
} = require('./action-service');
const sceneService = require('./scene-service');
const store = require('./store');

const SEQUENCE_ID_PATTERN = /^sequence-[0-9]+$/;

function sequenceDirectory(execDir) {
  return path.join(store.paths(execDir).operations, 'sequences');
}

function validSequenceId(sequenceId) {
  if (typeof sequenceId !== 'string' || !SEQUENCE_ID_PATTERN.test(sequenceId)) {
    throw contractError('SEQUENCE_RECORD_INCOMPLETE', 'sequence record has an invalid sequenceId');
  }
  return sequenceId;
}

function sequencePath(execDir, sequenceId) {
  return path.join(sequenceDirectory(execDir), `${validSequenceId(sequenceId)}.json`);
}

function unsignedRecord(record) {
  const { integrity, ...unsigned } = record;
  return unsigned;
}

function recordDigest(record) {
  return crypto.createHash('sha256').update(canonicalJson(unsignedRecord(record))).digest('hex');
}

function writeSequenceRecord(execDir, record) {
  validSequenceId(record?.sequenceId);
  fs.mkdirSync(sequenceDirectory(execDir), { recursive: true });
  const value = {
    ...unsignedRecord(record),
    integrity: { recordSha256: recordDigest(record) },
  };
  writeJsonAtomic(sequencePath(execDir, value.sequenceId), value);
  return value;
}

function readSequences(execDir) {
  const directory = sequenceDirectory(execDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(directory, name), null))
    .filter(Boolean);
}

function incomplete(message) {
  return contractError('SEQUENCE_RECORD_INCOMPLETE', message);
}

function assertSequenceIntegrity(execDir, record) {
  if (!record || record.schemaVersion !== 1) throw incomplete('sequence record schema is invalid');
  validSequenceId(record.sequenceId);
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  if (record.executionId !== execution.executionId) throw incomplete('sequence record execution binding is invalid');
  const expectedRef = path.relative(path.resolve(execDir), sequencePath(execDir, record.sequenceId));
  if (record.sequenceRecordRef !== expectedRef) throw incomplete('sequence record reference is invalid');
  if (typeof record.requestKey !== 'string' || !record.requestKey.startsWith('sequence-request-')) {
    throw incomplete('sequence record request key is invalid');
  }
  if (!record.integrity?.recordSha256 || record.integrity.recordSha256 !== recordDigest(record)) {
    throw incomplete(`sequence record integrity is invalid: ${record.sequenceId}`);
  }
  return record;
}

function findTerminalSequence(execDir, request) {
  const requestKey = sequenceRequestKey(request);
  const matches = readSequences(execDir).filter((record) => record.requestKey === requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) throw incomplete('multiple sequence records share the same request key');
  const record = assertSequenceIntegrity(execDir, matches[0]);
  if (record.terminal !== true || !SEQUENCE_STATUSES.includes(record.status)) {
    throw incomplete(`sequence record has no terminal result: ${record.sequenceId}`);
  }
  return record;
}

function responseFromSequenceRecord(record, options = {}) {
  return {
    status: record.status,
    outcomeKnown: record.outcomeKnown !== false,
    ...(record.failure?.code ? { code: record.failure.code } : {}),
    sequenceId: record.sequenceId,
    sequenceRecordRef: record.sequenceRecordRef,
    steps: record.steps || [],
    evidence: record.evidence || { sceneRefs: [], screenshotRefs: [] },
    finalSceneRef: record.finalSceneRef || null,
    remainingMs: Number(record.remainingMs) || 0,
    idempotent: options.idempotent === true,
  };
}

function sceneChanged(scene) {
  return {
    status: 'SCENE_CHANGED',
    outcomeKnown: true,
    scene: sceneService.projectSceneSummary(scene),
  };
}

function now(options) {
  return options.now || new Date().toISOString();
}

function runSequence(execDir, request, options = {}) {
  const existing = findTerminalSequence(execDir, request);
  if (existing) return responseFromSequenceRecord(existing, { idempotent: true });

  const normalized = normalizeSequenceRequest(request);
  if (normalized.steps.length !== 1 || normalized.steps[0].type !== 'act') {
    throw contractError('SEQUENCE_NOT_IMPLEMENTED', 'this runtime revision supports exactly one act step');
  }

  const execution = store.loadExecution(execDir);
  const beforeScene = store.readCurrentScene(execDir);
  if (!beforeScene || beforeScene.sceneId !== normalized.basedOnSceneId) return sceneChanged(beforeScene);

  const step = normalized.steps[0];
  const actionRequest = {
    basedOnSceneId: beforeScene.sceneId,
    ...(step.capabilityId ? { capabilityId: step.capabilityId } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
    ...(step.visual ? { visual: step.visual } : {}),
    decision: { purpose: normalized.purpose, expectationRefs: [] },
    decisionId: options.decisionId || null,
  };
  const resolvedAction = resolveActionRequest(beforeScene, actionRequest, execution.platform);
  if (resolvedAction.stale) return sceneChanged(beforeScene);

  const clock = options.clock || Date.now;
  const startedMs = clock();
  const durationMs = sequenceDurationMs(options.remainingMs);
  const deadline = startedMs + durationMs;
  const actionTimeoutMs = deadline - clock() - FINAL_SCENE_RESERVE_MS;
  if (actionTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence has no usable action budget before final Scene reserve');

  const sequenceId = store.nextId(execDir, 'sequence');
  const operationId = store.nextId(execDir, 'action');
  const recordRef = path.relative(path.resolve(execDir), sequencePath(execDir, sequenceId));
  let record = writeSequenceRecord(execDir, {
    schemaVersion: 1,
    sequenceId,
    executionId: execution.executionId,
    requestKey: sequenceRequestKey(request),
    basedOnSceneRef: beforeScene.sceneId,
    purpose: normalized.purpose,
    flowContext: normalized.flowContext || null,
    decisionId: options.decisionId || null,
    sequenceRecordRef: recordRef,
    requestedAt: now(options),
    startedAt: now(options),
    endedAt: null,
    terminal: false,
    status: 'SEQUENCE_RUNNING',
    outcomeKnown: true,
    steps: [],
    evidence: { sceneRefs: [], screenshotRefs: [] },
    finalSceneRef: null,
    remainingMs: durationMs,
    technicalFacts: [],
    failure: null,
  });
  store.appendEvent(execDir, 'sequenceRequested', {
    sequenceId,
    requestKey: record.requestKey,
    basedOnSceneRef: beforeScene.sceneId,
    sequenceRecordRef: recordRef,
    decisionId: options.decisionId || null,
  }, options);

  const dispatched = dispatchAction(execDir, {
    ...actionRequest,
    sequenceId,
    stepId: step.id,
  }, {
    ...options,
    beforeScene,
    resolvedAction,
    operationId,
    timeoutMs: actionTimeoutMs,
  });
  if (dispatched.status !== 'ACTION_DISPATCHED') {
    throw contractError('SEQUENCE_NOT_IMPLEMENTED', 'prevalidated action did not dispatch');
  }
  if (classifyActionOutcome(dispatched.adapterResult) !== 'COMPLETED') {
    throw contractError('SEQUENCE_NOT_IMPLEMENTED', 'action failure completion is not implemented in this runtime revision');
  }

  const finalTimeoutMs = deadline - clock();
  if (finalTimeoutMs <= 0) throw contractError('SEQUENCE_TIMEOUT', 'sequence deadline reached before final Scene capture');
  sceneService.observe(execDir, {
    ...options,
    purpose: 'SEQUENCE_FINAL',
    captureOrigins: ['ACTION_POST', 'SEQUENCE_FINAL'],
    relatedOperationId: operationId,
    sequenceId,
    stepId: step.id,
    previousAction: {
      ...dispatched.action,
      lifecycle: { status: 'COMPLETED' },
    },
    promote: true,
    preAdapterDelayMs: dispatched.action.action.type === 'wait' ? 0 : 500,
    timeoutMs: finalTimeoutMs,
  });
  const finalScene = store.readCurrentScene(execDir);
  const action = completeDispatchedAction(execDir, dispatched, finalScene, {
    decisionId: options.decisionId || null,
    sequenceId,
    stepId: step.id,
    preSceneRef: beforeScene.sceneId,
  }, { ...options, promoteScene: true });
  const stepRecord = {
    stepId: step.id,
    stepIndex: 0,
    type: 'act',
    status: 'COMPLETED',
    operationId,
    preSceneRef: beforeScene.sceneId,
    postSceneRef: finalScene.sceneId,
    action: action.action,
  };
  const screenshotRefs = [...new Set([beforeScene.screenshot.ref, finalScene.screenshot.ref])];
  record = writeSequenceRecord(execDir, {
    ...record,
    terminal: true,
    status: 'SEQUENCE_COMPLETED',
    endedAt: now(options),
    steps: [stepRecord],
    evidence: {
      sceneRefs: [beforeScene.sceneId, finalScene.sceneId],
      screenshotRefs,
    },
    finalSceneRef: finalScene.sceneId,
    remainingMs: Math.max(0, deadline - clock()),
  });
  store.appendEvent(execDir, 'sequenceCompleted', {
    sequenceId,
    status: record.status,
    finalSceneRef: finalScene.sceneId,
    sequenceRecordRef: recordRef,
    decisionId: options.decisionId || null,
  }, options);
  return responseFromSequenceRecord(record);
}

module.exports = {
  assertSequenceIntegrity,
  findTerminalSequence,
  readSequences,
  responseFromSequenceRecord,
  runSequence,
  sequencePath,
  writeSequenceRecord,
};
