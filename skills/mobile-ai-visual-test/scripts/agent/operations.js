'use strict';

const path = require('path');
const fs = require('fs');
const { validateActionExecution, normalizeActionProposal } = require('../lib/action-contract');
const { canonicalJson, contractError, ensureId, ensureObject, ensureString } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validatePlanAuthorization, withAuthorizationSha } = require('../lib/plan-authorization');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { resolveArtifact } = require('../lib/execution-evidence');
const { inspectPng } = require('../lib/image-evidence');
const { assertActionBudget, assertOperationAllowed } = require('../lib/execution-time-limit');
const {
  STATE_CHANGING_ACTIONS,
  beginOperation,
  changePhase,
  failOperation,
  assertNoTurnRecovery,
  knowledgeQueryDraftIds,
  hasCurrentStartObservation,
  latestStateChangeIndex,
  operationDraftIds,
  pendingPostActionObservation,
  rejectOperation,
  timelineEvents,
} = require('../execution/core');
const { invokeDeviceOperation, resolveTargetBinding } = require('./device-gateway');
const { factFromResult } = require('./operation-facts');

function operationContext(execDir) {
  return {
    execution: readJson(path.join(execDir, 'execution.json'), null),
    runtime: readJson(path.join(execDir, 'agent', 'runtime.json'), null),
    understanding: readJson(path.join(execDir, 'understanding.json'), null),
    plan: readJson(path.join(execDir, 'plan.json'), null),
  };
}

function freezeOperationRequest(request) {
  if (!request?.authorization || request.authorization.authorizationSha !== undefined) return request;
  return { ...request, authorization: withAuthorizationSha(request.authorization) };
}

function alignOperationPhase(execDir, request, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const requestedScope = request?.authorization?.phase;
  const targetPhase = requestedScope === 'case-prepare'
    ? 'ESTABLISH_START'
    : requestedScope === 'case-business' && ['ESTABLISH_START', 'CONCLUDE'].includes(execution?.phase)
      ? 'EXECUTE'
      : null;
  if (!execution || !targetPhase || execution.phase === targetPhase) return;
  changePhase(execDir, targetPhase, requestedScope === 'case-prepare'
    ? '根据 Agent 操作上下文建立或恢复用例起点'
    : '根据 Agent 操作上下文继续执行检查点', {
    implementationSha: execution.implementationSha,
    now: options.now,
  });
}

function validateOperationRequest(execDir, request, kind) {
  ensureObject(request, 'operation request', 'AGENT_OPERATION_INVALID');
  ensureId(request.operationId, 'operationId', 'AGENT_OPERATION_INVALID');
  const context = operationContext(execDir);
  validateLiveAgentBinding(execDir);
  if (!context.execution || !context.runtime || context.runtime.status !== 'BOUND'
    || context.runtime.executionId !== context.execution.executionId
    || context.runtime.batchId !== context.execution.batchId
    || context.runtime.warmSessionGeneration !== context.execution.warmSessionGeneration) {
    throw contractError('AGENT_OPERATION_BINDING_MISMATCH', 'Agent Runtime does not match the current execution generation');
  }
  validatePlanAuthorization(request.authorization, context);
  if (request.authorization.phase === 'case-business') {
    const startEstablished = Boolean(context.understanding && hasCurrentStartObservation(
      timelineEvents(execDir), context.understanding.revision, context.execution.warmSessionGeneration,
    ));
    if (!startEstablished) {
      throw contractError('START_OBSERVATION_REQUIRED', 'case-business operations require a usable start observation for the current understanding revision');
    }
  }
  if (request.intent !== undefined) ensureString(request.intent, 'intent', 'AGENT_OPERATION_INVALID');
  if (request.expectedOutcome !== undefined) ensureString(request.expectedOutcome, 'expectedOutcome', 'AGENT_OPERATION_INVALID');
  if (request.purpose !== undefined) ensureString(request.purpose, 'purpose', 'AGENT_OPERATION_INVALID');
  if (request.relatedOperationId !== undefined) ensureId(request.relatedOperationId, 'relatedOperationId', 'AGENT_OPERATION_INVALID');
  if (kind === 'ACTION') {
    const normalized = normalizeActionProposal(request.action, { context: 'Agent action' });
    validateActionExecution(normalized.action, {
      platform: context.execution.platform,
      scope: request.authorization.phase,
      context: 'Agent action',
    });
    if (STATE_CHANGING_ACTIONS.has(normalized.action.type)) {
      ensureString(request.basisObservationRef, 'basisObservationRef', 'AGENT_OPERATION_INVALID');
      const events = timelineEvents(execDir);
      const observations = events.filter((entry) => entry.type === 'observation' && entry.usable === true);
      const basisIndex = observations.findIndex((entry) => entry.ref === request.basisObservationRef);
      if (basisIndex < 0) throw contractError('ACTION_BASIS_INVALID', 'basisObservationRef must reference a usable current execution observation');
      const basis = observations[basisIndex];
      const basisTimelineIndex = events.indexOf(basis);
      if (basisTimelineIndex <= latestStateChangeIndex(events)
        || basis.warmSessionGeneration !== context.execution.warmSessionGeneration) {
        throw contractError('ACTION_BASIS_STALE', 'basisObservationRef predates the current device state or warm session generation');
      }
      if (normalized.action.coordinateArtifactRef) {
        const expectedArtifact = ['visual', 'pixel'].includes(normalized.action.coordinateSource)
          ? basis.artifacts?.screenshot : basis.artifacts?.layout;
        if (!expectedArtifact || normalized.action.coordinateArtifactRef !== expectedArtifact) {
          throw contractError('ACTION_COORDINATE_ARTIFACT_INVALID', 'coordinateArtifactRef must match the basis observation artifact for coordinateSource');
        }
        const artifactFile = resolveArtifact(execDir, expectedArtifact);
        if (!fs.existsSync(artifactFile)) throw contractError('ACTION_COORDINATE_ARTIFACT_INVALID', 'coordinate artifact is missing');
        if (['visual', 'pixel'].includes(normalized.action.coordinateSource)) {
          const image = inspectPng(artifactFile);
          if (image.decodeStatus !== 'VALID') throw contractError('ACTION_COORDINATE_ARTIFACT_INVALID', 'coordinate screenshot is not a valid PNG');
          const points = normalized.action.type === 'swipe'
            ? [[Number(normalized.action.fromX), Number(normalized.action.fromY)], [Number(normalized.action.toX), Number(normalized.action.toY)]]
            : [[Number(normalized.action.x), Number(normalized.action.y)]];
          const bounds = normalized.action.targetBounds?.map(Number);
          const pointOutsideImage = points.some(([x, y]) => x < 0 || y < 0 || x >= image.width || y >= image.height);
          const pointOutsideBounds = bounds && points.some(([x, y]) => x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]);
          if (image.width > 1 && image.height > 1 && (pointOutsideImage
            || bounds?.[0] < 0 || bounds?.[1] < 0 || bounds?.[2] > image.width || bounds?.[3] > image.height
            || pointOutsideBounds)) {
            throw contractError('ACTION_COORDINATE_OUT_OF_RANGE', 'coordinates or targetBounds are outside the referenced screenshot');
          }
        }
      }
    }
    return { ...request, action: normalized.action, actionNormalizations: normalized.normalizations, context };
  }
  if (request.action !== undefined) throw contractError('AGENT_OPERATION_INVALID', 'observation request cannot contain action');
  return { ...request, context };
}

function existingOperation(execDir, operationId) {
  const events = timelineEvents(execDir);
  const fact = events.find((entry) => ['observation', 'actionResult'].includes(entry.type) && entry.operationId === operationId);
  const completed = events.find((entry) => entry.type === 'operationCompleted' && entry.operationId === operationId);
  return fact && completed ? fact : null;
}

function operationPaths(execDir, operationId) {
  return {
    draft: path.join(execDir, 'agent', `operation-${operationId}.draft.json`),
    completed: path.join(execDir, 'agent', `operation-${operationId}.json`),
  };
}

function assertPostActionObservation(execDir, validated, kind, options = {}) {
  if (kind !== 'ACTION' || !STATE_CHANGING_ACTIONS.has(validated.action.type)) return;
  const pending = pendingPostActionObservation(timelineEvents(execDir));
  if (!pending) return;
  rejectOperation(execDir, {
    operationId: validated.request.operationId,
    kind,
    actionType: validated.action.type,
    relatedOperationId: pending.operationId,
    failureCode: 'POST_ACTION_OBSERVATION_REQUIRED',
    reason: `observe the current state after ${pending.operationId} before another state-changing action`,
  }, { now: options.now });
  throw contractError('POST_ACTION_OBSERVATION_REQUIRED', `observe the current state after ${pending.operationId} before another state-changing action`);
}

function completeRecord(paths, value) {
  writeJsonAtomic(paths.completed, value);
  if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);
}

function frozenOperationError(record) {
  if (!record?.error) return null;
  return contractError(record.error.code, record.error.message);
}

function operationError(error, fallbackCode) {
  return {
    code: error.code || fallbackCode,
    message: error.message,
    ...(error.adapterDiagnostics ? { adapterDiagnostics: error.adapterDiagnostics } : {}),
    ...(Number.isFinite(error.remainingMs) ? { remainingMs: error.remainingMs } : {}),
    ...(Number.isFinite(error.requiredMs) ? { requiredMs: error.requiredMs } : {}),
  };
}

function executeDeviceOperation(execDir, request, options = {}) {
  request = freezeOperationRequest(request);
  ensureObject(request, 'operation request', 'AGENT_OPERATION_INVALID');
  ensureId(request.operationId, 'operationId', 'AGENT_OPERATION_INVALID');
  assertNoTurnRecovery(execDir);
  const pendingQueries = knowledgeQueryDraftIds(execDir);
  if (pendingQueries.length) {
    throw contractError('KNOWLEDGE_QUERY_RECOVERY_REQUIRED', `recover knowledge query before operating the device: ${pendingQueries.join(', ')}`);
  }
  const otherDrafts = operationDraftIds(execDir).filter((operationId) => operationId !== request.operationId);
  if (otherDrafts.length) {
    throw contractError('EXECUTION_OPERATION_RECOVERY_REQUIRED', `recover operation before starting another: ${otherDrafts.join(', ')}`);
  }
  const paths = operationPaths(execDir, request.operationId);
  const completedRecord = readJson(paths.completed, null);
  if (completedRecord) {
    if (canonicalJson(completedRecord.request) !== canonicalJson(request)) {
      throw contractError('AGENT_OPERATION_BINDING_MISMATCH', 'operationId is already bound to another request');
    }
    const error = frozenOperationError(completedRecord);
    if (error) throw error;
    return { accepted: true, idempotent: true, fact: completedRecord.fact, deviceResult: completedRecord.deviceResult };
  }
  const kind = request.action ? 'ACTION' : 'OBSERVE';
  let draft = readJson(paths.draft, null);
  const recovered = Boolean(draft);
  if (draft && (draft.schemaVersion !== 2 || draft.kind !== kind || canonicalJson(draft.request) !== canonicalJson(request))) {
    throw contractError('AGENT_OPERATION_BINDING_MISMATCH', 'operationId is already bound to another request');
  }
  if (!draft) alignOperationPhase(execDir, request, options);
  if (kind === 'ACTION' && STATE_CHANGING_ACTIONS.has(request.action?.type)) {
    const pending = pendingPostActionObservation(timelineEvents(execDir));
    if (pending && pending.operationId !== request.operationId) {
      rejectOperation(execDir, { operationId: request.operationId, kind, actionType: request.action.type, relatedOperationId: pending.operationId, failureCode: 'POST_ACTION_OBSERVATION_REQUIRED', reason: `observe the current state after ${pending.operationId} before another state-changing action` }, { now: options.now });
      throw contractError('POST_ACTION_OBSERVATION_REQUIRED', `observe the current state after ${pending.operationId} before another state-changing action`);
    }
  }
  const validated = validateOperationRequest(execDir, request, kind);
  validated.request = request;
  resolveTargetBinding(execDir, validated.context.execution);
  assertPostActionObservation(execDir, validated, kind, options);
  const frozenRequest = { schemaVersion: 2, kind, request };
  if (!draft) {
    if (kind === 'ACTION') {
      assertActionBudget(validated.context.execution, validated.action, options.postActionSettleMs || 0, options.now || new Date());
    } else {
      assertOperationAllowed(validated.context.execution, kind.toLowerCase(), options.now || new Date());
    }
    draft = { ...frozenRequest, status: 'REQUEST_FROZEN' };
    writeJsonAtomic(paths.draft, draft);
  }
  if (recovered && draft.status === 'REQUEST_FROZEN') {
    try {
      assertOperationAllowed(validated.context.execution, kind.toLowerCase(), options.now || new Date());
    } catch (error) {
      if (error.code !== 'CASE_TIME_LIMIT_REACHED') throw error;
      const frozenError = { code: 'CASE_TIME_LIMIT_REACHED', message: 'the frozen request was not sent before the case time limit' };
      completeRecord(paths, { schemaVersion: 2, kind, request, error: frozenError });
      throw contractError(frozenError.code, frozenError.message);
    }
  }
  const started = timelineEvents(execDir).some((entry) => entry.type === 'operationStarted' && entry.operationId === request.operationId);
  if (!started) beginOperation(execDir, kind, request.operationId, { implementationSha: validated.context.execution.implementationSha, now: options.now });
  if (options.interruptAfter === 'begin') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: begin');

  if (draft.status === 'ADAPTER_CALLING' && kind === 'ACTION') {
    const stateChanging = STATE_CHANGING_ACTIONS.has(validated.action.type);
    const error = stateChanging
      ? { code: 'DEVICE_ACTION_OUTCOME_UNCERTAIN', message: 'action may have reached the device; observe current state before deciding the next action' }
      : { code: 'DEVICE_ACTION_FAILED', message: 'non-state-changing action was interrupted before returning a result' };
    failOperation(execDir, request.operationId, { failureCode: error.code, reason: error.message, actionType: validated.action.type, stateChanging, now: options.now });
    completeRecord(paths, { schemaVersion: 2, kind, request, error });
    throw contractError(error.code, error.message);
  }
  if (draft.status === 'ADAPTER_CALLING' && kind === 'OBSERVE') {
    const limitReached = (() => {
      try {
        assertOperationAllowed(validated.context.execution, 'observe', options.now || new Date());
        return false;
      } catch (error) {
        if (error.code !== 'CASE_TIME_LIMIT_REACHED') throw error;
        return true;
      }
    })();
    if (limitReached) {
      failOperation(execDir, request.operationId, { failureCode: 'DEVICE_OBSERVATION_OUTCOME_UNAVAILABLE', reason: 'observation was in flight when the case time limit was reached', now: options.now });
      const error = { code: 'DEVICE_OBSERVATION_OUTCOME_UNAVAILABLE', message: 'observation could not be recovered without a new device call after the case time limit' };
      completeRecord(paths, { schemaVersion: 2, kind, request, error });
      throw contractError(error.code, error.message);
    }
  }
  if (draft.status === 'OUTCOME_UNCERTAIN' || draft.status === 'FAILED') {
    throw contractError(draft.failureCode, draft.reason);
  }
  if (!draft.result) {
    assertOperationAllowed(validated.context.execution, kind.toLowerCase(), options.now || new Date());
    draft = { ...draft, status: 'ADAPTER_CALLING', adapterStartedAt: options.now || new Date().toISOString() };
    writeJsonAtomic(paths.draft, draft);
    let gatewayResult;
    try {
      gatewayResult = invokeDeviceOperation(execDir, validated, kind, options);
    } catch (error) {
      const stateChanging = kind === 'ACTION' && STATE_CHANGING_ACTIONS.has(validated.action.type);
      if (stateChanging) {
        const frozenError = operationError(error, 'DEVICE_ADAPTER_FAILED');
        frozenError.code = 'DEVICE_ACTION_OUTCOME_UNCERTAIN';
        frozenError.message = `action may have reached the device: ${error.message}`;
        failOperation(execDir, request.operationId, { failureCode: frozenError.code, reason: frozenError.message, actionType: validated.action.type, stateChanging: true, now: options.now });
        completeRecord(paths, { schemaVersion: 2, kind, request, error: frozenError });
        throw contractError(frozenError.code, frozenError.message);
      }
      const frozenError = operationError(error, kind === 'ACTION' ? 'DEVICE_ACTION_FAILED' : 'DEVICE_ADAPTER_FAILED');
      failOperation(execDir, request.operationId, {
        failureCode: frozenError.code,
        reason: frozenError.message,
        ...(kind === 'ACTION' ? { actionType: validated.action.type, stateChanging: false } : {}),
        now: options.now,
      });
      completeRecord(paths, { schemaVersion: 2, kind, request, error: frozenError });
      throw contractError(frozenError.code, frozenError.message);
    }
    if (options.interruptAfter === 'adapter') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: adapter');
    draft = { ...draft, status: 'RESULT_FROZEN', result: gatewayResult, adapterCompletedAt: options.now || new Date().toISOString() };
    writeJsonAtomic(paths.draft, draft);
  }
  if (options.interruptAfter === 'result') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: result');
  const fact = factFromResult(execDir, validated, kind, draft.result, options);
  if (options.interruptAfter === 'timeline') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: timeline');
  completeRecord(paths, {
    schemaVersion: 2,
    kind,
    request,
    fact,
    deviceResult: draft.result.adapterResult,
    timing: {
      adapterStartedAt: draft.adapterStartedAt || null,
      adapterCompletedAt: draft.adapterCompletedAt || null,
      postActionSettleMs: draft.result.postActionSettleMs || 0,
    },
  });
  return { accepted: true, recovered, fact, deviceResult: draft.result.adapterResult };
}

module.exports = {
  existingOperation,
  executeDeviceOperation,
  freezeOperationRequest,
  alignOperationPhase,
  operationPaths,
  operationContext,
  validateOperationRequest,
};
