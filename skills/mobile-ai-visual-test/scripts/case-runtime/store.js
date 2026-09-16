'use strict';

const fs = require('fs');
const path = require('path');
const { contractError, sha256 } = require('../lib/contract-utils');
const { appendJsonl, readJson, readJsonl, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { bindTechnicalFact, isTechnicalFact, technicalFactRef } = require('../lib/technical-facts');

function paths(execDir) {
  const root = path.resolve(execDir);
  return {
    root,
    execution: path.join(root, 'execution.json'),
    runtime: path.join(root, 'runtime.json'),
    events: path.join(root, 'events.jsonl'),
    scenes: path.join(root, 'scenes'),
    currentScene: path.join(root, 'current-scene.json'),
    result: path.join(root, 'result.json'),
    metrics: path.join(root, 'metrics.json'),
    finishDraft: path.join(root, 'transactions', 'finish.draft.json'),
    preparationDraft: path.join(root, 'transactions', 'preparation.draft.json'),
    transactions: path.join(root, 'transactions'),
    operations: path.join(root, 'operations'),
    lock: path.join(root, '.runtime.lock'),
  };
}

function loadExecution(execDir, options = {}) {
  const execution = readJson(paths(execDir).execution, null);
  if (!execution || execution.schemaVersion !== 12 || execution.runtime !== 'case-runtime') {
    throw contractError('FORMAT_UNSUPPORTED', 'This execution was created by an unsupported format and must be run again');
  }
  if (!options.allowFinalized && execution.finalized === true) {
    throw contractError('CASE_RUNTIME_FINALIZED', 'Case Runtime execution is finalized');
  }
  return execution;
}

function events(execDir) {
  return readJsonl(paths(execDir).events, { repairIncompleteTail: true });
}

function appendEvent(execDir, type, payload = {}, options = {}) {
  const execution = loadExecution(execDir, { allowFinalized: options.allowFinalized === true });
  const current = events(execDir);
  const time = options.now || new Date().toISOString();
  const sequence = current.length + 1;
  let event = {
    schemaVersion: 1,
    eventId: sha256(JSON.stringify({ executionId: execution.executionId, sequence, type, time }), 'event', 20),
    executionId: execution.executionId,
    sequence,
    time,
    type,
    ...payload,
  };
  if (type !== 'caseModelRevised' && !Object.prototype.hasOwnProperty.call(payload, 'caseModelRevision')) {
    event.caseModelRevision = current.filter((item) => item.type === 'caseModelRevised').at(-1)?.revision || null;
  }
  if (isTechnicalFact(event)) {
    event.technicalFactRef = technicalFactRef(sequence);
    event = bindTechnicalFact(event, { execution, events: current, currentScene: readCurrentScene(execDir) });
  }
  appendJsonl(paths(execDir).events, event);
  return event;
}

function nextId(execDir, prefix) {
  const idField = `${prefix}Id`;
  const numbers = events(execDir).flatMap((event) => [event[idField], event.operationId, event.queryId, event.sceneId])
    .map((value) => String(value || '').match(new RegExp(`^${prefix}-(\\d+)$`)))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

function readCurrentScene(execDir) {
  return readJson(paths(execDir).currentScene, null);
}

function writeScene(execDir, scene) {
  const target = paths(execDir);
  fs.mkdirSync(target.scenes, { recursive: true });
  writeJsonAtomic(path.join(target.scenes, `${scene.sceneId}.json`), scene);
  writeJsonAtomic(target.currentScene, scene);
  return scene;
}

function updateExecution(execDir, update) {
  const target = paths(execDir);
  const execution = loadExecution(execDir, { allowFinalized: true });
  const next = typeof update === 'function' ? update(execution) : { ...execution, ...update };
  writeJsonAtomic(target.execution, next);
  return next;
}

function withRuntimeLock(execDir, callback, options = {}) {
  return withFileLock(paths(execDir).lock, callback, options);
}

function technicalResponse(execDir, error, options = {}) {
  const code = error?.code || 'CASE_RUNTIME_ERROR';
  const message = error?.internalMessage || error?.message || String(error);
  const diagnostic = error?.diagnostic || {
    code: error?.internalCode || code,
    ...(options.operation ? { stage: String(options.operation).toUpperCase() } : {}),
    summary: message,
    retryable: error?.retryable === true,
    ...(error?.actionOutcomeUnknown ? { recovery: { kind: 'OBSERVE_FIRST', nextCall: { capability: 'observe' } } } : {}),
  };
  const value = {
    status: 'TECHNICAL',
    code,
    message,
    diagnostic,
    scene: readCurrentScene(execDir),
  };
  try {
    const fact = appendEvent(execDir, 'technicalIssue', {
      code: value.code,
      ...(error?.internalCode ? { internalCode: error.internalCode } : {}),
      message: value.message,
      operation: options.operation || null,
      decisionId: options.decisionId || null,
      expectationRefs: options.expectationRefs || [],
    }, {
      ...options,
      allowFinalized: options.allowFinalized === true && !fs.existsSync(path.join(execDir, 'completion.json')),
    });
    value.technicalFactRef = fact.technicalFactRef;
  } catch {
    // Preserve the original runtime failure when the event store is unavailable.
  }
  return value;
}

module.exports = {
  appendEvent,
  events,
  loadExecution,
  nextId,
  paths,
  readCurrentScene,
  technicalResponse,
  updateExecution,
  withRuntimeLock,
  writeScene,
};
