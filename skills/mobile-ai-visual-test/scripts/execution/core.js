'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, sha256 } = require('../lib/contract-utils');
const {
  appendJsonl,
  createExecution: createExecutionState,
  executionPaths,
  readExecution,
  readJson,
  recoverExecution,
  withFileLock,
  writeJsonAtomic,
} = require('../lib/execution-lifecycle');
const { collectEvidence, sha256File, validateEvidenceRecord } = require('../lib/execution-evidence');
const { assertOperationAllowed, buildMetrics, timeLimitState } = require('../lib/execution-time-limit');
const { validateExecutionEvent } = require('./contracts/execution-event-contract');
const { validateMetrics, validateResult, withResultSha } = require('./contracts/result-contract');
const { assertWorkspace } = require('../lib/workspace');
const { validateKnowledgeCandidateSnapshot, validateResultKnowledgeSnapshots } = require('../lib/knowledge-snapshot');
const { unresolvedEvidenceConflicts } = require('../lib/observation-consistency');
const { buildObservationView } = require('../lib/observation-model');

const PHASE_TRANSITIONS = Object.freeze({
  UNDERSTAND: new Set(['ESTABLISH_START', 'CONCLUDE']),
  ESTABLISH_START: new Set(['EXECUTE', 'INVESTIGATE', 'CONCLUDE']),
  EXECUTE: new Set(['ESTABLISH_START', 'INVESTIGATE', 'CONCLUDE']),
  INVESTIGATE: new Set(['ESTABLISH_START', 'EXECUTE', 'CONCLUDE']),
  CONCLUDE: new Set(['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']),
  FINALIZED: new Set(),
});
const STATE_CHANGING_ACTIONS = new Set(['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard']);

function timelineEvents(execDir) {
  const file = path.join(execDir, 'timeline.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function operationDraftIds(execDir) {
  const agentDir = path.join(execDir, 'agent');
  if (!fs.existsSync(agentDir)) return [];
  return fs.readdirSync(agentDir)
    .filter((name) => /^operation-.+\.draft\.json$/.test(name))
    .sort()
    .map((name) => {
      const draft = readJson(path.join(agentDir, name), null);
      return draft?.request?.operationId || name.slice('operation-'.length, -'.draft.json'.length);
    });
}

function knowledgeQueryDraftIds(execDir) {
  const agentDir = path.join(execDir, 'agent');
  if (!fs.existsSync(agentDir)) return [];
  return fs.readdirSync(agentDir)
    .filter((name) => /^knowledge-query-.+\.draft\.json$/.test(name))
    .sort()
    .map((name) => {
      const draft = readJson(path.join(agentDir, name), null);
      return draft?.queryId || name.slice('knowledge-query-'.length, -'.draft.json'.length);
    });
}

function turnDraftIds(execDir) {
  const turnsDir = path.join(execDir, 'agent', 'turns');
  if (!fs.existsSync(turnsDir)) return [];
  return fs.readdirSync(turnsDir)
    .filter((name) => /^.+\.draft\.json$/.test(name))
    .sort()
    .map((name) => {
      const draft = readJson(path.join(turnsDir, name), null);
      return draft?.turn?.turnId || name.slice(0, -'.draft.json'.length);
    });
}

function stepDraftIds(execDir) {
  const stepsDir = path.join(execDir, 'agent', 'steps');
  if (!fs.existsSync(stepsDir)) return [];
  return fs.readdirSync(stepsDir)
    .filter((name) => /^step-.+\.draft\.json$/.test(name))
    .sort()
    .map((name) => readJson(path.join(stepsDir, name), null)?.stepId || name.slice(0, -'.draft.json'.length));
}

function assertNoKnowledgeQueryRecovery(execDir) {
  const queryIds = knowledgeQueryDraftIds(execDir);
  if (queryIds.length) {
    throw contractError('KNOWLEDGE_QUERY_RECOVERY_REQUIRED', `recover knowledge query before continuing: ${queryIds.join(', ')}`);
  }
}

function assertNoOperationRecovery(execDir) {
  const operationIds = operationDraftIds(execDir);
  if (operationIds.length) {
    throw contractError('EXECUTION_OPERATION_RECOVERY_REQUIRED', `recover operation before continuing: ${operationIds.join(', ')}`);
  }
}

function assertNoTurnRecovery(execDir, allowedTurnId = null) {
  const turnIds = turnDraftIds(execDir).filter((turnId) => turnId !== allowedTurnId);
  if (turnIds.length) {
    throw contractError('AGENT_TURN_RECOVERY_REQUIRED', `recover Agent turn before continuing: ${turnIds.join(', ')}`);
  }
}

function assertAgentWriteReady(execDir, options = {}) {
  assertNoOperationRecovery(execDir);
  assertNoKnowledgeQueryRecovery(execDir);
  assertNoTurnRecovery(execDir, options.allowedTurnId || null);
}

function assertExecutionWorkspace(workspaceRoot) {
  try {
    return assertWorkspace(workspaceRoot, { allowTest: true });
  } catch (error) {
    throw contractError(error.code || 'WORKSPACE_INVALID', error.message);
  }
}

function workspaceRootFromExecutionDir(execDir) {
  let root = path.resolve(execDir);
  for (let index = 0; index < 6; index += 1) root = path.dirname(root);
  return root;
}

function createExecution(options) {
  assertExecutionWorkspace(options.workspaceRoot);
  if (typeof options.implementationSha !== 'string' || !options.implementationSha.trim()) {
    throw contractError('EXECUTION_IMPLEMENTATION_INVALID', 'implementationSha is required');
  }
  return createExecutionState(options);
}

function requireWritable(execDir, options = {}) {
  assertExecutionWorkspace(workspaceRootFromExecutionDir(execDir));
  const loaded = readExecution(execDir);
  if (options.implementationSha && loaded.execution.implementationSha !== options.implementationSha) {
    throw contractError('EXECUTION_IMPLEMENTATION_MISMATCH', 'execution was created by a different implementation');
  }
  if (loaded.execution.finalized || loaded.execution.phase === 'FINALIZED') {
    throw contractError('EXECUTION_FINALIZED', 'finalized execution is read-only');
  }
  return loaded;
}

function requireBoundRuntime(execDir, executionId) {
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  if (!runtime || runtime.status !== 'BOUND' || runtime.executionId !== executionId) {
    throw contractError('AGENT_RUNTIME_NOT_BOUND', 'Agent Runtime must be BOUND to the current execution');
  }
  return runtime;
}

function bindAgentRuntime(execDir, options = {}) {
  const { execution } = requireWritable(execDir, options);
  const runtime = {
    schemaVersion: 1,
    executionId: execution.executionId,
    status: 'BOUND',
    provider: options.provider || 'codex',
    batchId: options.batchId || execution.batchId,
    warmSessionGeneration: options.warmSessionGeneration || execution.warmSessionGeneration,
    sessionId: options.sessionId || `session-${execution.executionId}`,
    boundAt: options.now || new Date().toISOString(),
  };
  writeJsonAtomic(path.join(execDir, 'agent', 'runtime.json'), runtime);
  return runtime;
}

function appendEvent(execDir, event, options = {}) {
  const { execution } = requireWritable(execDir, options);
  const normalized = {
    schemaVersion: 1,
    executionId: execution.executionId,
    time: options.now || event.time || new Date().toISOString(),
    ...event,
  };
  validateExecutionEvent(normalized, { executionId: execution.executionId, phase: options.allowDifferentPhase ? undefined : execution.phase });
  appendJsonl(path.join(execDir, 'timeline.jsonl'), normalized);
  return normalized;
}

function changePhase(execDir, to, reason, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    assertAgentWriteReady(execDir);
    let draft = readJson(paths.phaseDraft, null);
    if (draft) {
      if (draft.executionId !== execution.executionId || draft.to !== to || draft.reason !== reason) {
        throw contractError('EXECUTION_PHASE_IN_PROGRESS', `phase transition ${draft.from} -> ${draft.to} is still active`);
      }
      if (![draft.from, draft.to].includes(execution.phase)) {
        throw contractError('EXECUTION_CORRUPTED', `phase draft does not match current phase ${execution.phase}`);
      }
    } else if (!PHASE_TRANSITIONS[execution.phase]?.has(to)) {
      throw contractError('EXECUTION_PHASE_TRANSITION_INVALID', `${execution.phase} cannot transition to ${to}`);
    }
    const from = draft?.from || execution.phase;
    const understanding = readJson(path.join(execDir, 'understanding.json'), null);
    const plan = readJson(path.join(execDir, 'plan.json'), null);
    if (to === 'ESTABLISH_START') {
      if (!understanding || !plan) throw contractError('EXECUTION_ARTIFACT_INCOMPLETE', 'understanding and plan are required before establishing the start');
      if (!plan.checkpoints.length) throw contractError('CHECKPOINT_REQUIRED', 'establishing the start requires at least one checkpoint');
    }
    if (to === 'EXECUTE') {
      if (!understanding || !plan || !plan.checkpoints.length) throw contractError('CHECKPOINT_REQUIRED', 'business execution requires a current non-empty checkpoint plan');
      const startEstablished = hasCurrentStartObservation(
        timelineEvents(execDir), understanding.revision, execution.warmSessionGeneration,
      );
      if (!startEstablished) throw contractError('START_OBSERVATION_REQUIRED', 'business execution requires a usable start observation for the current understanding revision');
    }
    const pending = pendingPostActionObservation(timelineEvents(execDir));
    if (to === 'CONCLUDE' && pending) {
      throw contractError('POST_ACTION_OBSERVATION_REQUIRED', `observe the current state after ${pending.operationId} before concluding`);
    }
    if (!draft) {
      const time = options.now || new Date().toISOString();
      const eventId = sha256(canonicalJson({ executionId: execution.executionId, from, to, reason, time }), 'phase', 24);
      draft = {
        schemaVersion: 1,
        executionId: execution.executionId,
        from,
        to,
        reason,
        status: 'STARTED',
        event: {
          schemaVersion: 1,
          eventId,
          executionId: execution.executionId,
          time,
          type: 'phaseChanged',
          writer: 'runtime-core',
          phase: to,
          from,
          to,
          reason,
        },
      };
      validateExecutionEvent(draft.event, { executionId: execution.executionId });
      writeJsonAtomic(paths.phaseDraft, draft);
    }
    if (execution.phase === from) {
      writeJsonAtomic(paths.execution, { ...execution, phase: to });
    }
    if (options.interruptAfter === 'state') throw new Error('MAVT_PHASE_CHANGE_INTERRUPTED: state');
    const exists = timelineEvents(execDir).some((event) => event.eventId === draft.event.eventId);
    if (!exists) appendEvent(execDir, draft.event, { allowDifferentPhase: true });
    fs.unlinkSync(paths.phaseDraft);
    return { ...draft.event, idempotent: execution.phase === to };
  }, { now: options.now });
}

function recordKnowledgeQuery(execDir, event, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    if (!Array.isArray(event.candidates)) throw contractError('KNOWLEDGE_QUERY_INVALID', 'knowledge query candidates must be an array');
    event.candidates.forEach((candidate) => validateKnowledgeCandidateSnapshot(execDir, candidate));
    const existing = timelineEvents(execDir).find((item) => item.type === 'knowledgeQuery' && item.queryId === event.queryId);
    if (existing) {
      const comparable = ({ schemaVersion, executionId, time, writer, phase, type, ...value }) => value;
      if (canonicalJson(comparable(existing)) !== canonicalJson(event)) throw contractError('KNOWLEDGE_QUERY_BINDING_MISMATCH', 'queryId is already bound to another query result');
      return { ...existing, idempotent: true };
    }
    return appendEvent(execDir, { ...event, type: 'knowledgeQuery', writer: 'knowledge-query', phase: execution.phase }, { now: options.now });
  }, { now: options.now });
}

function recordRuntimeEvent(execDir, event, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    if (!['runtimeIncident', 'recoveryStarted', 'recoveryCompleted', 'controlRequestClosed'].includes(event.type)) {
      throw contractError('EXECUTION_EVENT_WRITER_INVALID', `unsupported runtime event: ${event.type}`);
    }
    const idField = event.type === 'runtimeIncident' ? 'incidentId' : 'recoveryId';
    const existing = timelineEvents(execDir).find((entry) => entry.type === event.type && entry[idField] === event[idField]);
    if (existing) {
      const comparable = ({ schemaVersion, executionId, time, writer, phase, ...value }) => value;
      if (canonicalJson(comparable(existing)) !== canonicalJson(event)) throw contractError('EXECUTION_EVENT_BINDING_MISMATCH', `${event.type} id is already bound to different content`);
      return { ...existing, idempotent: true };
    }
    if (event.type === 'runtimeIncident') {
      const events = timelineEvents(execDir);
      const evidence = new Set(collectEvidence(events, { execDir, executionId: execution.executionId }).map((item) => item.ref));
      const observationEvidenceValid = event.evidenceRefs.length > 0 && event.evidenceRefs.every((ref) => evidence.has(ref));
      const recoveryBoundary = latestRecoveryIndex(events);
      const failedOperationValid = event.failedOperationId !== null && events.slice(recoveryBoundary + 1).some((entry) => entry.type === 'operationCompleted'
        && entry.operationId === event.failedOperationId && entry.outcome === 'FAILED' && entry.failureCode);
      if (!observationEvidenceValid && !failedOperationValid) {
        throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'runtime incident must reference current observations or a failed operation');
      }
    } else if (['recoveryStarted', 'recoveryCompleted'].includes(event.type) && event.incidentId !== null
      && !timelineEvents(execDir).some((entry) => entry.type === 'runtimeIncident' && entry.incidentId === event.incidentId)) {
      throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'recovery event references an unknown incident');
    }
    return appendEvent(execDir, { ...event, writer: 'runtime-core', phase: execution.phase }, { now: options.now });
  }, { now: options.now });
}

function beginOperation(execDir, kind, operationId, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    assertOperationAllowed(execution, kind.toLowerCase(), options.now || new Date());
    const events = timelineEvents(execDir);
    if (events.some((event) => event.type === 'operationStarted' && event.operationId === operationId)) {
      throw contractError('EXECUTION_OPERATION_DUPLICATE', `operation already exists: ${operationId}`);
    }
    return appendEvent(execDir, { type: 'operationStarted', writer: 'runtime-core', phase: execution.phase, operationId, kind }, { now: options.now });
  }, { now: options.now });
}

function rejectOperation(execDir, event, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    return appendEvent(execDir, {
      type: 'operationRejected',
      writer: 'runtime-core',
      phase: execution.phase,
      ...event,
    }, { now: options.now });
  }, { now: options.now });
}

function completeOperation(execDir, event, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    const events = timelineEvents(execDir);
    const started = events.find((item) => item.type === 'operationStarted' && item.operationId === event.operationId);
    if (!started) throw contractError('EXECUTION_OPERATION_INVALID', 'operation is missing');
    const completed = events.find((item) => item.type === 'operationCompleted' && item.operationId === event.operationId);
    const expectedType = started.kind === 'OBSERVE' ? 'observation' : 'actionResult';
    if (event.type !== expectedType) throw contractError('EXECUTION_OPERATION_INVALID', `${started.kind} operation requires ${expectedType}`);
    if (event.type === 'observation') {
      validateEvidenceRecord({
        ref: event.ref,
        executionId: execution.executionId,
        phase: event.scope,
        writer: 'observe.sh',
        sha256: event.sha256,
        usable: event.usable,
      }, { execDir, executionId: execution.executionId });
    }
    if (event.scope === 'case-prepare' && !['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE'].includes(execution.phase)) {
      throw contractError('EXECUTION_EVENT_PHASE_INVALID', 'case-prepare facts require an active execution phase');
    }
    if (event.scope === 'case-prepare') {
      const understanding = readJson(path.join(execDir, 'understanding.json'), null);
      const startCondition = event.startConditionId === undefined
        ? null
        : understanding?.startConditions?.find((item) => item.id === event.startConditionId);
      if ((event.startConditionId !== undefined && !startCondition) || event.understandingRevision !== understanding.revision) {
        throw contractError('START_CONDITION_REFERENCE_INVALID', 'case-prepare facts must bind a current start condition');
      }
    }
    if (event.scope === 'case-business' && !['EXECUTE', 'INVESTIGATE'].includes(execution.phase)) {
      throw contractError('EXECUTION_EVENT_PHASE_INVALID', 'case-business facts require EXECUTE or INVESTIGATE phase');
    }
    const writer = event.type === 'observation' ? 'observe.sh' : event.type === 'actionResult' ? 'action.sh' : null;
    if (!writer) throw contractError('EXECUTION_OPERATION_INVALID', 'operation result must be observation or actionResult');
    const existingFact = events.find((item) => item.type === event.type && item.operationId === event.operationId);
    let fact;
    if (existingFact) {
      const comparable = ({ schemaVersion, executionId, time, writer: eventWriter, phase, ...value }) => value;
      if (existingFact.writer !== writer || existingFact.phase !== execution.phase
        || canonicalJson(comparable(existingFact)) !== canonicalJson(event)) {
        throw contractError('EXECUTION_OPERATION_INVALID', 'open operation already contains a different result fact');
      }
      fact = existingFact;
    } else {
      if (completed) throw contractError('EXECUTION_OPERATION_CORRUPTED', 'completed operation is missing its result fact');
      fact = appendEvent(execDir, { ...event, writer, phase: execution.phase }, { now: options.now });
    }
    const expectedOutcome = event.type === 'observation' ? (event.usable ? 'SUCCEEDED' : 'FAILED') : (event.ok ? 'SUCCEEDED' : 'FAILED');
    if (completed) {
      if (completed.outcome !== expectedOutcome) throw contractError('EXECUTION_OPERATION_CORRUPTED', 'operation completion does not match its result fact');
      return fact;
    }
    if (options.interruptAfter === 'fact') throw new Error('MAVT_OPERATION_INTERRUPTED: fact');
    appendEvent(execDir, {
      type: 'operationCompleted',
      writer: 'runtime-core',
      phase: execution.phase,
      operationId: event.operationId,
      outcome: expectedOutcome,
    }, { now: options.now });
    return fact;
  }, { now: options.now });
}

function failOperation(execDir, operationId, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    const events = timelineEvents(execDir);
    const started = events.find((item) => item.type === 'operationStarted' && item.operationId === operationId);
    const completed = events.find((item) => item.type === 'operationCompleted' && item.operationId === operationId);
    if (!started) throw contractError('EXECUTION_OPERATION_INVALID', 'operation is missing');
    if (completed) return completed;
    return appendEvent(execDir, {
      type: 'operationCompleted',
      writer: 'runtime-core',
      phase: execution.phase,
      operationId,
      outcome: 'FAILED',
      failureCode: options.failureCode || 'DEVICE_OPERATION_FAILED',
      reason: options.reason || 'device operation did not produce a usable result',
      ...(options.actionType ? { actionType: options.actionType, stateChanging: options.stateChanging === true } : {}),
    }, { now: options.now });
  }, { now: options.now });
}

function openOperations(events) {
  const completed = new Set(events.filter((event) => event.type === 'operationCompleted').map((event) => event.operationId));
  return events.filter((event) => event.type === 'operationStarted' && !completed.has(event.operationId));
}

function pendingPostActionObservation(events) {
  let pending = null;
  for (const event of events) {
    if (event.type === 'actionResult' && STATE_CHANGING_ACTIONS.has(event.requestedAction?.type)) pending = event;
    if (event.type === 'operationCompleted' && event.failureCode === 'DEVICE_ACTION_OUTCOME_UNCERTAIN' && event.stateChanging === true) pending = event;
    if (event.type === 'observation' && pending && event.usable === true && event.relatedOperationId === pending.operationId) pending = null;
    if (event.type === 'timeLimitReached' && pending && event.pendingOperationId === pending.operationId) pending = null;
  }
  return pending;
}

function timeLimitEvent(events) {
  return events.find((event) => event.type === 'timeLimitReached') || null;
}

function sealTimeLimit(execDir, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  const event = withFileLock(paths.lock, () => {
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    const limit = timeLimitState(execution, options.now || new Date());
    if (!limit.reached) throw contractError('CASE_TIME_LIMIT_NOT_REACHED', 'execution time limit has not been reached');
    assertNoOperationRecovery(execDir);
    assertNoKnowledgeQueryRecovery(execDir);
    assertNoTurnRecovery(execDir);
    const pendingSteps = stepDraftIds(execDir);
    if (pendingSteps.length) {
      throw contractError('AGENT_STEP_RECOVERY_REQUIRED', `recover semantic step before stopping at the time limit: ${pendingSteps.join(', ')}`);
    }
    const events = timelineEvents(execDir);
    const existing = timeLimitEvent(events);
    if (existing) return existing;
    const open = openOperations(events);
    if (open.length) throw contractError('EXECUTION_OPERATION_RECOVERY_REQUIRED', `recover operation before stopping at the time limit: ${open.map((item) => item.operationId).join(', ')}`);
    const pending = pendingPostActionObservation(events);
    const observationUnavailable = !currentObservation(events, execution.warmSessionGeneration);
    return appendEvent(execDir, {
      type: 'timeLimitReached',
      writer: 'runtime-core',
      phase: execution.phase,
      deadlineAt: new Date(Date.parse(execution.startedAt) + limit.limitMs).toISOString(),
      reason: 'case time limit reached; no further device operations are allowed',
      observationUnavailable,
      ...(pending ? { pendingOperationId: pending.operationId } : {}),
    }, { now: options.now });
  }, { now: options.now });
  const execution = readJson(paths.execution);
  if (execution.phase !== 'CONCLUDE') changePhase(execDir, 'CONCLUDE', 'case time limit reached', options);
  return event;
}

function latestStateChangeIndex(events) {
  let boundary = -1;
  events.forEach((event, index) => {
    if (event.type === 'actionResult' && STATE_CHANGING_ACTIONS.has(event.requestedAction?.type)) boundary = index;
    if (event.type === 'operationCompleted' && event.failureCode === 'DEVICE_ACTION_OUTCOME_UNCERTAIN' && event.stateChanging === true) boundary = index;
    if (event.type === 'recoveryCompleted') boundary = index;
  });
  return boundary;
}

function latestRecoveryIndex(events) {
  return events.map((event) => event.type).lastIndexOf('recoveryCompleted');
}

function hasCurrentStartObservation(events, understandingRevision, warmSessionGeneration) {
  const recoveryBoundary = latestRecoveryIndex(events);
  const observations = events.map((event, index) => ({ event, index })).filter(({ event, index }) => event.type === 'observation'
    && event.scope === 'case-prepare'
    && event.usable === true
    && event.understandingRevision === understandingRevision
    && index > recoveryBoundary
    && (warmSessionGeneration === undefined || event.warmSessionGeneration === warmSessionGeneration));
  return events.some((event, index) => event.type === 'startEstablished'
    && event.understandingRevision === understandingRevision
    && index > recoveryBoundary
    && (warmSessionGeneration === undefined || event.warmSessionGeneration === warmSessionGeneration)
    && observations.some((entry) => entry.index < index && entry.event.ref === event.observationRef));
}

function confirmStartObservation(execDir, observationRef, reason, options = {}) {
  const { execution } = requireWritable(execDir, options);
  requireBoundRuntime(execDir, execution.executionId);
  const understanding = readJson(path.join(execDir, 'understanding.json'), null);
  const events = timelineEvents(execDir);
  const recoveryBoundary = latestRecoveryIndex(events);
  const observationIndex = events.findIndex((event, index) => event.type === 'observation'
    && index > recoveryBoundary
    && event.ref === observationRef
    && event.scope === 'case-prepare'
    && event.usable === true
    && event.understandingRevision === understanding?.revision
    && event.warmSessionGeneration === execution.warmSessionGeneration);
  if (observationIndex < 0) {
    throw contractError('START_OBSERVATION_REQUIRED', 'start confirmation requires a current usable PREPARE observation');
  }
  const existing = events.find((event, index) => event.type === 'startEstablished'
    && index > recoveryBoundary
    && event.understandingRevision === understanding.revision
    && event.warmSessionGeneration === execution.warmSessionGeneration);
  if (existing) {
    if (existing.observationRef !== observationRef) {
      throw contractError('START_OBSERVATION_STALE', 'the current start is already bound to another observation');
    }
    return { ...existing, idempotent: true };
  }
  return appendEvent(execDir, {
    type: 'startEstablished', writer: 'agent', phase: execution.phase,
    understandingRevision: understanding.revision,
    warmSessionGeneration: execution.warmSessionGeneration,
    observationRef,
    reason,
  }, { now: options.now });
}

function currentObservation(events, warmSessionGeneration) {
  const boundary = latestStateChangeIndex(events);
  return events.map((event, index) => ({ event, index }))
    .filter(({ event, index }) => event.type === 'observation'
      && event.usable === true
      && index > boundary
      && (warmSessionGeneration === undefined || event.warmSessionGeneration === warmSessionGeneration))
    .at(-1)?.event || null;
}

function assertCurrentObservationRefs(events, refs, options = {}) {
  const requested = Array.isArray(refs) ? refs : [];
  const boundary = latestStateChangeIndex(events);
  const observations = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'observation' && event.usable === true);
  const latest = observations[observations.length - 1];
  if (!latest || requested.length === 0) {
    throw contractError('CURRENT_OBSERVATION_REQUIRED', 'verdict review requires a usable current observation');
  }
  const byRef = new Map(observations.map((entry) => [entry.event.ref, entry]));
  const selected = requested.map((ref) => byRef.get(ref));
  if (selected.some((entry) => !entry || entry.index <= boundary)) {
    throw contractError('CURRENT_OBSERVATION_STALE', 'verdict review observations must be captured after the latest state change');
  }
  if (options.warmSessionGeneration !== undefined
    && selected.some((entry) => entry.event.warmSessionGeneration !== options.warmSessionGeneration)) {
    throw contractError('CURRENT_OBSERVATION_STALE', 'verdict review observations must belong to the current warm session generation');
  }
  if (!selected.some((entry) => entry.index === latest.index)) {
    throw contractError('CURRENT_OBSERVATION_STALE', 'verdict review must include the latest usable business observation');
  }
  return { boundary, latest: latest.event, observations: selected.map((entry) => entry.event) };
}

function assertConclusionObservationRefs(events, refs, options = {}) {
  const stopped = timeLimitEvent(events);
  if (stopped?.observationUnavailable !== true) return assertCurrentObservationRefs(events, refs, options);
  const requested = Array.isArray(refs) ? refs : [];
  if (requested.length > 0) {
    throw contractError('CURRENT_OBSERVATION_STALE', 'time-limit observation gaps must not cite observations from before the latest state change');
  }
  return { boundary: latestStateChangeIndex(events), latest: null, observations: [], observationGap: true };
}

function assertCurrentPlan(events) {
  const lastUnderstanding = events.map((event) => event.type).lastIndexOf('caseUnderstood');
  const lastPlan = events.map((event) => event.type).lastIndexOf('planRevised');
  if (lastPlan < lastUnderstanding) {
    throw contractError('PLAN_REVISION_STALE', 'plan must be revised after the latest understanding revision');
  }
}

function completeFinalization(execDir, draft, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'));
  const eventsBeforeCommit = timelineEvents(execDir);
  collectEvidence(eventsBeforeCommit, { execDir, executionId: execution.executionId });
  validateResultKnowledgeSnapshots(execDir, draft.result, eventsBeforeCommit);
  writeJsonAtomic(path.join(execDir, 'result.json'), draft.result);
  if (options.interruptAfter === 'result') throw new Error('MAVT_FINALIZE_INTERRUPTED: result');
  writeJsonAtomic(path.join(execDir, 'metrics.json'), draft.metrics);
  const events = timelineEvents(execDir);
  if (!events.some((event) => event.type === 'result')) {
    appendJsonl(path.join(execDir, 'timeline.jsonl'), draft.resultEvent);
  }
  writeJsonAtomic(path.join(execDir, 'execution.json'), {
    ...execution,
    endedAt: draft.result.endedAt,
    phase: 'FINALIZED',
    lifecycle: 'FINALIZED',
    finalized: true,
  });
  const draftPath = path.join(execDir, 'finalization.draft.json');
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  return { executionId: execution.executionId, result: draft.result, metrics: draft.metrics, finalized: true };
}

function buildFinalizationDraft(execDir, proposedResult, execution, options = {}) {
  const validationPhase = options.phaseOverride || execution.phase;
  if (validationPhase !== 'CONCLUDE') throw contractError('EXECUTION_PHASE_INVALID', 'finalize requires CONCLUDE phase');
  const events = timelineEvents(execDir);
  if (openOperations(events).length) throw contractError('EXECUTION_OPERATION_OPEN', 'all device operations must be closed before finalize');
  const pendingObservation = pendingPostActionObservation(events);
  if (pendingObservation) {
    throw contractError('POST_ACTION_OBSERVATION_REQUIRED', `observe the current state after ${pendingObservation.operationId} before finalizing`);
  }
  const understanding = readJson(path.join(execDir, 'understanding.json'), null);
  const plan = readJson(path.join(execDir, 'plan.json'), null);
  if (!understanding || !plan) throw contractError('EXECUTION_ARTIFACT_INCOMPLETE', 'understanding and plan are required before finalize');
  if (['PASS', 'FAIL'].includes(proposedResult.verdict)
    && !hasCurrentStartObservation(events, understanding.revision, execution.warmSessionGeneration)) {
    throw contractError('START_NOT_ESTABLISHED', `${proposedResult.verdict} requires current startEstablished evidence`);
  }
  assertCurrentPlan(events);
  const requirementIds = new Set(understanding.requirements.map((item) => item.id));
  if (plan.checkpoints.some((checkpoint) => checkpoint.requirementRefs.some((ref) => !requirementIds.has(ref)))) {
    throw contractError('PLAN_REVISION_STALE', 'plan references requirements from an older understanding');
  }
  const evidence = collectEvidence(events, { execDir, executionId: execution.executionId })
    .filter((item) => item.warmSessionGeneration === execution.warmSessionGeneration);
  const knowledgeQueries = events.filter((event) => event.type === 'knowledgeQuery').map((event) => ({ ...event, ref: event.queryId }));
  const knowledgeAssessments = events.filter((event) => event.type === 'knowledgeAssessment').map((event) => ({ ...event, ref: event.knowledgeRef }));
  const knowledgeReviews = events.filter((event) => event.type === 'knowledgeReview');
  const incidents = events.filter((event) => event.type === 'runtimeIncident').map((event) => ({ ...event, ref: event.incidentId }));
  const verdictReviews = [
    ...events.filter((event) => event.type === 'verdictReview'),
    ...(options.additionalVerdictReviews || []),
  ];
  const endedAt = options.now || proposedResult.endedAt || new Date().toISOString();
  const result = withResultSha({
    ...proposedResult,
    schemaVersion: 2,
    executionId: execution.executionId,
    platform: proposedResult.platform || execution.platform,
    startedAt: execution.startedAt,
    endedAt,
  });
  const stoppedAtLimit = timeLimitEvent(events);
  if (stoppedAtLimit?.observationUnavailable === true
    && (result.verdict !== 'INCONCLUSIVE' || result.executionStatus !== 'STOPPED_BY_BUDGET' || result.verdictBasis !== 'INSUFFICIENT_EVIDENCE')) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'an unobserved state change at the time limit requires an inconclusive insufficient-evidence result');
  }
  verdictReviews.filter((review) => review.requestedVerdict === result.verdict)
    .forEach((review) => assertConclusionObservationRefs(events, review.currentObservationRefs, {
      warmSessionGeneration: execution.warmSessionGeneration,
    }));
  const latestObservation = currentObservation(events, execution.warmSessionGeneration);
  const evidenceConflicts = unresolvedEvidenceConflicts(execDir, events, buildObservationView, {
    warmSessionGeneration: execution.warmSessionGeneration,
  });
  if (['PASS', 'FAIL'].includes(result.verdict) && evidenceConflicts.length > 0) {
    throw contractError('EVIDENCE_CONFLICT_UNRESOLVED', `${result.verdict} 不能建立在尚未解决的关键现场证据冲突上`, {
      conflicts: evidenceConflicts,
      suggestion: '恢复可靠现场并重新观察，或使用 INCONCLUSIVE/技术 BLOCKED 收口',
    });
  }
  validateResult(result, {
    executionId: execution.executionId,
    understanding,
    plan,
    evidence,
    knowledgeQueries,
    knowledgeAssessments,
    knowledgeReviews,
    verdictReviews,
    incidents,
    currentObservationRef: latestObservation?.ref || null,
  });
  validateResultKnowledgeSnapshots(execDir, result, events);
  if (result.verdict === 'PASS') {
    const resultEvidence = new Set(result.requirementFindings.flatMap((finding) => finding.evidenceRefs || []));
    if (!latestObservation || !resultEvidence.has(latestObservation.ref)) {
      throw contractError('CURRENT_OBSERVATION_REQUIRED', 'PASS must cite the latest usable observation after the latest state change');
    }
  }
  const metrics = buildMetrics(execution, result, events, endedAt, { execDir });
  validateMetrics(metrics, { executionId: execution.executionId });
  const resultEvent = {
    schemaVersion: 1,
    executionId: execution.executionId,
    time: endedAt,
    type: 'result',
    writer: 'runtime-core',
    phase: 'FINALIZED',
    resultSha: result.resultSha,
    verdict: result.verdict,
  };
  validateExecutionEvent(resultEvent, { executionId: execution.executionId, phase: 'FINALIZED' });
  return { schemaVersion: 1, result, metrics, resultEvent };
}

function validateFinalizationProposal(execDir, proposedResult, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    assertAgentWriteReady(execDir);
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    return buildFinalizationDraft(execDir, proposedResult, execution, options);
  }, { now: options.now });
}

function finalizeExecution(execDir, proposedResult, options = {}) {
  const paths = executionPaths(path.dirname(path.dirname(execDir)), path.basename(execDir));
  return withFileLock(paths.lock, () => {
    const recovery = recoverExecution(execDir);
    if (options.implementationSha && recovery.execution?.implementationSha !== options.implementationSha) {
      throw contractError('EXECUTION_IMPLEMENTATION_MISMATCH', 'execution was created by a different implementation');
    }
    if (recovery.status === 'FINALIZED') {
      return { executionId: recovery.execution.executionId, result: readJson(paths.result), metrics: readJson(paths.metrics), alreadyFinalized: true };
    }
    if (recovery.status === 'RESUME_FINALIZE') return completeFinalization(execDir, readJson(paths.finalizationDraft), options);
    assertAgentWriteReady(execDir);
    const { execution } = requireWritable(execDir, options);
    requireBoundRuntime(execDir, execution.executionId);
    const draft = buildFinalizationDraft(execDir, proposedResult, execution, options);
    writeJsonAtomic(paths.finalizationDraft, draft);
    writeJsonAtomic(paths.execution, { ...execution, lifecycle: 'FINALIZING' });
    if (options.interruptAfter === 'draft') throw new Error('MAVT_FINALIZE_INTERRUPTED: draft');
    return completeFinalization(execDir, draft, options);
  }, { now: options.now });
}

module.exports = {
  PHASE_TRANSITIONS,
  assertCurrentObservationRefs,
  assertConclusionObservationRefs,
  currentObservation,
  assertAgentWriteReady,
  assertNoTurnRecovery,
  assertExecutionWorkspace,
  assertCurrentPlan,
  assertNoKnowledgeQueryRecovery,
  appendEvent,
  assertNoOperationRecovery,
  beginOperation,
  bindAgentRuntime,
  changePhase,
  completeOperation,
  confirmStartObservation,
  createExecution,
  finalizeExecution,
  hasCurrentStartObservation,
  validateFinalizationProposal,
  failOperation,
  knowledgeQueryDraftIds,
  latestRecoveryIndex,
  latestStateChangeIndex,
  openOperations,
  operationDraftIds,
  pendingPostActionObservation,
  sealTimeLimit,
  timeLimitEvent,
  rejectOperation,
  STATE_CHANGING_ACTIONS,
  stepDraftIds,
  recordKnowledgeQuery,
  recordRuntimeEvent,
  requireBoundRuntime,
  timelineEvents,
  turnDraftIds,
  workspaceRootFromExecutionDir,
};
