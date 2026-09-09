'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  appProvisioningSha,
  preparationPolicySha,
  validateAppProvisioning,
  validateInstalledAppIdentity,
  validatePreparationPolicy,
} = require('../lib/app-provisioning');
const { invokeAppPreparation, invokeAppRestart, resolveTargetBinding } = require('../platform/device-port');
const {
  commitPlatformSessionRefresh,
  commitPreparationReady,
  commitPreparationRotation,
  invalidateWarmSession,
} = require('../session/warm-session-store');
const sceneService = require('./scene-service');
const store = require('./store');

function unavailable(internalCode, message) {
  const error = contractError('APP_INITIAL_STATE_UNAVAILABLE', 'The requested App initial state cannot be established in this execution');
  error.internalCode = internalCode;
  error.internalMessage = message;
  return error;
}

function asUnavailable(error) {
  if (error?.code === 'APP_INITIAL_STATE_UNAVAILABLE') return error;
  return unavailable(error?.internalCode || error?.code || 'APP_STATE_RESET_FAILED', error?.internalMessage || error?.message || String(error));
}

function workspaceRoot(runtime) {
  return path.resolve(path.dirname(runtime.sessionRef.statePath), '../..');
}

function resolveStrategy(execution, runtime, targetState) {
  const policy = validatePreparationPolicy(execution.preparationPolicy);
  if (execution.preparationPolicySha !== preparationPolicySha(policy)) throw contractError('PREPARATION_POLICY_CHANGED', 'frozen preparation policy changed');
  const provisioning = validateAppProvisioning(execution.appProvisioning, {
    workspaceRoot: workspaceRoot(runtime),
    platform: execution.platform,
    appId: execution.targetBinding.appId,
    deviceType: execution.targetBinding.deviceType,
  });
  if (execution.appProvisioningSha !== appProvisioningSha(provisioning)) throw contractError('APP_PROVISIONING_CHANGED', 'frozen App provisioning changed');
  const strategy = targetState === 'FRESH_INSTALL' || execution.platform === 'ios' ? 'REINSTALL_APP' : 'CLEAR_APP_DATA';
  const requiredEffects = strategy === 'REINSTALL_APP'
    ? ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] : ['CLEAR_APP_DATA'];
  const missing = requiredEffects.filter((effect) => !policy.allowedEffects.includes(effect));
  if (missing.length) throw unavailable('APP_PREPARATION_NOT_AUTHORIZED', `missing authorization: ${missing.join(', ')}`);
  if (strategy === 'REINSTALL_APP' && provisioning.mode !== 'ARTIFACT_MANAGED') {
    throw unavailable('APP_INSTALL_ARTIFACT_UNAVAILABLE', 'reinstall requires a frozen installation artifact');
  }
  return { strategy, provisioning, requiredEffects };
}

function validatePhase(execDir) {
  const forbidden = new Set([
    'sceneObserved', 'actionRequested', 'knowledgeQueried', 'appRecovered', 'caseFinished',
    'appPreparationCompleted', 'appPreparationFailed', 'appPreparationOutcomeUnknown',
  ]);
  if (store.events(execDir).some((event) => forbidden.has(event.type))) {
    throw contractError('APP_PREPARATION_PHASE_INVALID', 'prepare must be the first business operation in an execution');
  }
}

function validatePlatformResult(value, draft) {
  if (!value || typeof value !== 'object' || value.ok !== true || value.status !== 'SUCCEEDED' || value.strategy !== draft.strategy) {
    throw unavailable(value?.failureCode || 'APP_STATE_RESET_FAILED', value?.reason || 'platform preparation did not succeed');
  }
  if (draft.strategy === 'REINSTALL_APP') validateInstalledAppIdentity(value, draft.provisioning);
  return value;
}

function saveDraft(file, draft, status, update = {}) {
  const next = { ...draft, ...update, status };
  writeJsonAtomic(file, next);
  return next;
}

function updateExecutionSession(execDir, draft) {
  return store.updateExecution(execDir, (execution) => ({
    ...execution,
    warmSessionId: draft.nextSessionId,
    warmSessionEpoch: draft.nextEpoch,
    warmSessionGeneration: 1,
    appStateResetDuringPreparation: true,
    preparationTargetState: draft.targetState,
    preparationStrategy: draft.strategy,
  }));
}

function refreshPlatformSession(execDir, execution, draft) {
  if (!draft.deviceResult?.platformSession) return;
  const runtimePath = store.paths(execDir).runtime;
  const runtime = readJson(runtimePath, null);
  const resource = commitPlatformSessionRefresh({
    sessionRef: runtime.sessionRef,
    batchId: execution.batchId,
    previousSessionId: runtime.sessionRef.platformResource?.session?.sessionId,
    platformSession: draft.deviceResult.platformSession,
    operationId: draft.operationId,
    now: draft.resultRecordedAt || new Date().toISOString(),
  });
  runtime.sessionRef.platformResource = resource;
  writeJsonAtomic(runtimePath, runtime);
}

function markFailure(execDir, draft, error, options = {}) {
  const runtime = readJson(store.paths(execDir).runtime, null);
  const now = options.now || new Date().toISOString();
  try {
    invalidateWarmSession({
      sessionRef: runtime.sessionRef,
      batchId: draft.batchId,
      failureCode: error.internalCode || error.code || 'APP_STATE_RESET_FAILED',
      reason: error.internalMessage || error.message,
      now,
    });
  } catch {
    // Keep the original preparation failure.
  }
  if (!store.events(execDir).some((event) => event.type === 'appPreparationFailed' && event.operationId === draft.operationId)) {
    store.appendEvent(execDir, 'appPreparationFailed', {
      operationId: draft.operationId,
      targetState: draft.targetState,
      code: error.code || 'APP_STATE_RESET_FAILED',
      internalCode: error.internalCode || error.code || 'APP_STATE_RESET_FAILED',
      message: error.internalMessage || error.message,
    }, { now });
  }
  store.updateExecution(execDir, (execution) => ({
    ...execution,
    preparationFailed: true,
    preparationFailureCode: error.code || 'APP_STATE_RESET_FAILED',
  }));
}

function completeOperation(execDir, draft, now) {
  const operation = {
    schemaVersion: 1,
    operationId: draft.operationId,
    status: 'COMPLETED',
    targetState: draft.targetState,
    strategy: draft.strategy,
    requiredEffects: draft.requiredEffects,
    artifactRef: draft.provisioning.mode === 'ARTIFACT_MANAGED' ? draft.provisioning.artifactRef : null,
    previousSessionId: draft.previousSessionId,
    previousEpoch: draft.previousEpoch,
    sessionId: draft.nextSessionId,
    epoch: draft.nextEpoch,
    generation: 1,
    sceneId: draft.sceneId,
    platformResult: draft.deviceResult,
    startedAt: draft.createdAt,
    completedAt: now,
  };
  writeJsonAtomic(path.join(store.paths(execDir).operations, `${draft.operationId}.json`), operation);
  if (!store.events(execDir).some((event) => event.type === 'appPreparationCompleted' && event.operationId === draft.operationId)) {
    store.appendEvent(execDir, 'appPreparationCompleted', {
      operationId: draft.operationId,
      targetState: draft.targetState,
      strategy: draft.strategy,
      sceneId: draft.sceneId,
      previousSessionId: draft.previousSessionId,
      sessionId: draft.nextSessionId,
      epoch: draft.nextEpoch,
      generation: 1,
    }, { now });
  }
}

function continuePreparation(execDir, initialDraft, options = {}) {
  const file = store.paths(execDir).preparationDraft;
  let draft = initialDraft;
  let execution = store.loadExecution(execDir);
  const runtime = readJson(store.paths(execDir).runtime, null);
  const now = options.now || new Date().toISOString();
  try {
    if (draft.status === 'PREPARED') {
      draft = saveDraft(file, draft, 'STRATEGY_DISPATCHED', { dispatchedAt: now });
      const result = (options.invokeAppPreparation || invokeAppPreparation)(execDir, {
        execution,
        operationId: draft.operationId,
        targetState: draft.targetState,
        strategy: draft.strategy,
        provisioning: draft.provisioning,
      }, options);
      if (options.interruptAfter === 'preparation-dispatched') throw new Error('MAVT_PREPARATION_INTERRUPTED: dispatched');
      draft = saveDraft(file, draft, 'STRATEGY_RESULT_RECORDED', {
        deviceResult: result,
        resultRecordedAt: now,
      });
      validatePlatformResult(result, draft);
    }
    if (draft.status === 'STRATEGY_DISPATCHED') {
      const error = contractError('APP_PREPARATION_OUTCOME_UNKNOWN', 'preparation dispatch completed without a recorded platform result');
      error.internalCode = 'APP_PREPARATION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION';
      if (!store.events(execDir).some((event) => event.type === 'appPreparationOutcomeUnknown' && event.operationId === draft.operationId)) {
        store.appendEvent(execDir, 'appPreparationOutcomeUnknown', {
          operationId: draft.operationId,
          targetState: draft.targetState,
          code: error.code,
          message: error.message,
        }, { now });
      }
      commitPreparationRotation({
        sessionRef: runtime.sessionRef,
        batchId: execution.batchId,
        operationId: draft.operationId,
        strategy: draft.strategy,
        previousSessionId: draft.previousSessionId,
        previousEpoch: draft.previousEpoch,
        nextSessionId: draft.nextSessionId,
        nextEpoch: draft.nextEpoch,
        now,
      });
      execution = updateExecutionSession(execDir, draft);
      throw asUnavailable(error);
    }
    if (draft.status === 'STRATEGY_RESULT_RECORDED') {
      validatePlatformResult(draft.deviceResult, draft);
      refreshPlatformSession(execDir, execution, draft);
      commitPreparationRotation({
        sessionRef: runtime.sessionRef,
        batchId: execution.batchId,
        operationId: draft.operationId,
        strategy: draft.strategy,
        previousSessionId: draft.previousSessionId,
        previousEpoch: draft.previousEpoch,
        nextSessionId: draft.nextSessionId,
        nextEpoch: draft.nextEpoch,
        now,
      });
      execution = updateExecutionSession(execDir, draft);
      draft = saveDraft(file, draft, 'SESSION_ROTATED', { sessionRotatedAt: now });
    }
    if (draft.status === 'SESSION_ROTATED') {
      const binding = resolveTargetBinding(execDir, execution);
      const started = (options.restartApp || invokeAppRestart)(binding, options);
      if (!started?.coldStartVerified || !started?.startupDisplayVerified) {
        throw unavailable(started?.failureCode || 'APP_PREPARATION_START_FAILED', started?.reason || 'App start after preparation was not verified');
      }
      commitPreparationReady({
        sessionRef: runtime.sessionRef,
        batchId: execution.batchId,
        operationId: draft.operationId,
        sessionId: draft.nextSessionId,
        epoch: draft.nextEpoch,
        now,
      });
      draft = saveDraft(file, draft, 'APP_STARTED', { launchResult: started, appStartedAt: now });
    }
    if (draft.status === 'APP_STARTED') {
      const observed = sceneService.observe(execDir, {
        ...options,
        purpose: 'APP_PREPARATION_INITIAL_SCENE',
        relatedOperationId: draft.operationId,
      });
      draft = saveDraft(file, draft, 'OBSERVED', { sceneId: observed.scene.sceneId, observedAt: now });
    }
    if (draft.status === 'OBSERVED') {
      completeOperation(execDir, draft, now);
      fs.unlinkSync(file);
      return {
        status: 'SCENE',
        preparation: {
          operationId: draft.operationId,
          targetState: draft.targetState,
          status: 'SATISFIED',
          previousSessionId: draft.previousSessionId,
          sessionId: draft.nextSessionId,
          epoch: draft.nextEpoch,
          generation: 1,
        },
        scene: store.readCurrentScene(execDir),
      };
    }
    throw contractError('APP_PREPARATION_TRANSACTION_INVALID', `unsupported preparation status: ${draft.status}`);
  } catch (error) {
    if (draft.status !== 'PREPARED' && !String(error.message || '').startsWith('MAVT_PREPARATION_INTERRUPTED')) {
      const publicError = asUnavailable(error);
      markFailure(execDir, draft, publicError, options);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      throw publicError;
    }
    throw error;
  }
}

function prepare(execDir, request, options = {}) {
  validatePhase(execDir);
  const execution = store.loadExecution(execDir);
  const runtime = readJson(store.paths(execDir).runtime, null);
  const file = store.paths(execDir).preparationDraft;
  if (fs.existsSync(file)) throw contractError('APP_PREPARATION_TRANSACTION_INVALID', 'preparation transaction already exists');
  const operationId = store.nextId(execDir, 'preparation');
  const requestedAt = options.now || new Date().toISOString();
  store.appendEvent(execDir, 'appPreparationRequested', {
    operationId,
    targetState: request.preparation.targetState,
  }, { now: requestedAt });
  let resolved;
  try {
    resolved = resolveStrategy(execution, runtime, request.preparation.targetState);
  } catch (error) {
    const publicError = asUnavailable(error);
    store.appendEvent(execDir, 'appPreparationFailed', {
      operationId,
      targetState: request.preparation.targetState,
      code: publicError.code,
      internalCode: publicError.internalCode,
      message: publicError.internalMessage,
    }, { now: requestedAt });
    store.updateExecution(execDir, {
      ...execution,
      preparationFailed: true,
      preparationFailureCode: publicError.code,
    });
    throw publicError;
  }
  const draft = {
    schemaVersion: 1,
    operationId,
    batchId: execution.batchId,
    targetState: request.preparation.targetState,
    strategy: resolved.strategy,
    requiredEffects: resolved.requiredEffects,
    provisioning: resolved.provisioning,
    status: 'PREPARED',
    previousSessionId: execution.warmSessionId,
    previousEpoch: execution.warmSessionEpoch,
    nextSessionId: `warm-${String(execution.warmSessionEpoch + 1).padStart(4, '0')}`,
    nextEpoch: execution.warmSessionEpoch + 1,
    authorizationSha: execution.preparationPolicySha,
    createdAt: requestedAt,
  };
  writeJsonAtomic(file, draft);
  return continuePreparation(execDir, draft, options);
}

function recoverPendingPreparation(execDir, options = {}) {
  const file = store.paths(execDir).preparationDraft;
  if (!fs.existsSync(file)) return [];
  const draft = readJson(file, null);
  if (!draft || draft.schemaVersion !== 1 || !draft.operationId?.startsWith('preparation-')) {
    throw contractError('APP_PREPARATION_TRANSACTION_INVALID', 'pending preparation transaction is invalid');
  }
  if (draft.status === 'PREPARED') {
    fs.unlinkSync(file);
    return [{ kind: 'preparation', operationId: draft.operationId, status: 'NOT_SENT' }];
  }
  try {
    const response = continuePreparation(execDir, draft, { ...options, interruptAfter: undefined });
    return [{ kind: 'preparation', operationId: draft.operationId, status: 'RECOVERED', response }];
  } catch (error) {
    return [{
      kind: 'preparation',
      operationId: draft.operationId,
      status: error.internalCode === 'APP_PREPARATION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION' ? 'UNKNOWN' : 'FAILED',
      response: store.technicalResponse(execDir, error, { ...options, operation: 'prepare' }),
    }];
  }
}

module.exports = { prepare, recoverPendingPreparation, resolveStrategy, validatePhase };
