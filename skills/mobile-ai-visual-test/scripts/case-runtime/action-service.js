'use strict';

const { invokeDeviceOperation } = require('../platform/device-port');
const { resolveAction } = require('./capability-catalog');
const sceneService = require('./scene-service');
const store = require('./store');
const transactions = require('./transaction-manager');

function redactedAction(action) {
  return action?.type === 'inputText' ? { ...action, text: '[REDACTED]' } : action;
}

function act(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir);
  const scene = store.readCurrentScene(execDir);
  if (!scene) return sceneService.observe(execDir, options);
  const resolved = resolveAction(scene, request, execution.platform);
  if (resolved.stale) return { status: 'SCENE_CHANGED', scene };
  const operationId = store.nextId(execDir, 'action');
  let transaction = transactions.prepareAction(execDir, {
    operationId,
    sceneId: scene.sceneId,
    action: redactedAction(resolved.action),
    intent: request.decision?.purpose || request.intent || null,
    decisionId: request.decisionId || null,
    createdAt: options.now || new Date().toISOString(),
  });
  store.appendEvent(execDir, 'actionRequested', {
    operationId,
    sceneId: scene.sceneId,
    action: redactedAction(resolved.action),
    intent: request.decision?.purpose || request.intent || null,
    expectedOutcome: request.decision?.expectedOutcome || null,
    decisionId: request.decisionId || null,
  }, options);
  let deviceResult;
  try {
    transaction = transactions.transitionAction(execDir, transaction, 'PREPARED', 'DISPATCHED', {
      dispatchedAt: options.now || new Date().toISOString(),
    });
    if (options.interruptAfter === 'dispatch') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: dispatch');
    deviceResult = (options.invokeDeviceOperation || invokeDeviceOperation)(execDir, {
      context: { execution },
      operationId,
      action: resolved.action,
      request: { basisObservationRef: scene.screenshot.ref },
    }, 'ACTION', { now: options.now, runner: options.runner, onAdapterSpan: options.onAdapterSpan });
    transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'RESULT_RECORDED', {
      deviceResult: redactedAction(deviceResult.adapterResult),
      coordinateAudit: deviceResult.coordinateAudit || null,
      recordedAt: options.now || new Date().toISOString(),
    });
    store.appendEvent(execDir, 'actionCompleted', {
      operationId,
      sceneId: scene.sceneId,
      action: redactedAction(resolved.action),
      ok: deviceResult.adapterResult.ok !== false,
      result: redactedAction(deviceResult.adapterResult),
      coordinateAudit: deviceResult.coordinateAudit || null,
      decisionId: request.decisionId || null,
    }, options);
    if (options.interruptAfter === 'device-result') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: device-result');
  } catch (error) {
    if (transaction.status !== 'DISPATCHED') throw error;
    const technicalFact = store.appendEvent(execDir, 'actionOutcomeUnknown', {
      operationId,
      sceneId: scene.sceneId,
      action: redactedAction(resolved.action),
      code: error.code || 'DEVICE_ACTION_FAILED',
      message: error.message || String(error),
      decisionId: request.decisionId || null,
    }, options);
    try {
      const observed = sceneService.observe(execDir, {
        ...options,
        purpose: 'AFTER_UNKNOWN_ACTION',
        relatedOperationId: operationId,
        previousAction: { operationId, status: 'UNKNOWN', action: redactedAction(resolved.action) },
        decisionId: request.decisionId || null,
      });
      transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'OBSERVED', {
        outcome: 'UNKNOWN',
        error: { code: error.code || 'DEVICE_ACTION_FAILED', message: error.message || String(error) },
        sceneIdAfter: observed.scene.sceneId,
      });
      transactions.completeAction(execDir, transaction);
      return { ...observed, action: { operationId, status: 'UNKNOWN', technicalFactRef: technicalFact.technicalFactRef } };
    } catch (observeError) {
      throw Object.assign(observeError, {
        code: observeError.code || 'POST_ACTION_OBSERVE_FAILED',
        actionOutcome: 'UNKNOWN',
        operationId,
      });
    }
  }
  const observed = sceneService.observe(execDir, {
    ...options,
    purpose: 'POST_ACTION',
    relatedOperationId: operationId,
    preAdapterDelayMs: resolved.action.type === 'wait' ? 0 : 500,
    previousAction: {
      operationId,
      status: deviceResult.adapterResult.ok === false ? 'FAILED' : 'SUCCEEDED',
      action: redactedAction(resolved.action),
      result: redactedAction(deviceResult.adapterResult),
    },
    decisionId: request.decisionId || null,
  });
  transaction = transactions.transitionAction(execDir, transaction, 'RESULT_RECORDED', 'OBSERVED', {
    sceneIdAfter: observed.scene.sceneId,
  });
  if (options.interruptAfter === 'observe') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: observe');
  transactions.completeAction(execDir, transaction);
  return { ...observed, action: { operationId, status: deviceResult.adapterResult.ok === false ? 'FAILED' : 'SUCCEEDED' } };
}

module.exports = { act, redactedAction };
