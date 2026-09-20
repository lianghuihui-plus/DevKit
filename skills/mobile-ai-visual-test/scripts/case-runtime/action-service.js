'use strict';

const { invokeDeviceOperation } = require('../platform/device-port');
const { sanitizeAdapterActionResult } = require('../lib/action-result');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { resolveAction } = require('./capability-catalog');
const { validateLongPressTiming } = require('./contract');
const sceneService = require('./scene-service');
const store = require('./store');
const transactions = require('./transaction-manager');

function redactedAction(action) {
  return action?.type === 'inputText' ? { ...action, text: '[REDACTED]' } : action;
}

function duringActionObservation(request, deviceResult) {
  if (!deviceResult?.duringActionEvidence) return null;
  return {
    status: 'CAPTURED',
    requestedAtMs: Number(request.observationPolicy.duringActionAtMs),
    capturedAtMs: Number(deviceResult.adapterResult.duringActionCapture?.capturedAtMs),
    screenshotRef: deviceResult.duringActionEvidence.ref,
    screenshotSha256: deviceResult.duringActionEvidence.sha256,
  };
}

function actionEvidence(beforeScene, afterScene = null) {
  const sceneRefs = { before: beforeScene.sceneId };
  const screenshotRefs = [beforeScene.screenshot.ref];
  if (afterScene) {
    sceneRefs.after = afterScene.sceneId;
    screenshotRefs.push(afterScene.screenshot.ref);
  }
  return { sceneRefs, screenshotRefs: [...new Set(screenshotRefs)] };
}

function completedAction(operationId, action, adapterResult, beforeScene, afterScene, spatialEvidence = null, duringObservation = null) {
  return {
    operationId,
    lifecycle: { status: 'COMPLETED' },
    action: redactedAction(action),
    command: adapterResult.command,
    deviceExecution: adapterResult.deviceExecution,
    evidence: actionEvidence(beforeScene, afterScene),
    ...(spatialEvidence ? { spatialEvidence } : {}),
    ...(duringObservation ? { duringActionObservation: duringObservation } : {}),
  };
}

function persistedActionResult(actionResult) {
  const { spatialEvidence, ...stored } = actionResult;
  return {
    ...stored,
    ...(spatialEvidence?.ref ? { spatialEvidenceRef: spatialEvidence.ref } : {}),
  };
}

function dispatchAction(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir);
  const scene = store.readCurrentScene(execDir);
  if (!scene) return sceneService.observe(execDir, options);
  const resolved = resolveAction(scene, request, execution.platform);
  if (resolved.stale) return { status: 'SCENE_CHANGED', scene: sceneService.projectSceneSummary(scene) };
  if (request.observationPolicy && resolved.action.type !== 'longPress') {
    const error = new Error('observationPolicy.duringActionAtMs is only supported for longPress');
    error.code = 'CASE_RUNTIME_REQUEST_INVALID';
    throw error;
  }
  if (resolved.action.type === 'longPress') validateLongPressTiming(resolved.action.durationMs, request.observationPolicy);
  const operationId = store.nextId(execDir, 'action');
  let transaction = transactions.prepareAction(execDir, {
    operationId,
    sceneId: scene.sceneId,
    action: redactedAction(resolved.action),
    intent: request.decision?.purpose || null,
    decisionId: request.decisionId || null,
    planId: request.planId || null,
    stepId: request.stepId || null,
    createdAt: options.now || new Date().toISOString(),
  });
  store.appendEvent(execDir, 'actionRequested', {
    operationId,
    sceneId: scene.sceneId,
    action: redactedAction(resolved.action),
    intent: request.decision?.purpose || null,
    expectedOutcome: request.decision?.expectedOutcome || null,
    decisionId: request.decisionId || null,
    planId: request.planId || null,
    stepId: request.stepId || null,
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
      request: {
        basisObservationRef: scene.screenshot.ref,
        ...(request.observationPolicy ? { observationPolicy: request.observationPolicy } : {}),
      },
    }, 'ACTION', { now: options.now, runner: options.runner, onAdapterSpan: options.onAdapterSpan });
    transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'RESULT_RECORDED', {
      deviceResult: sanitizeAdapterActionResult(deviceResult.adapterResult),
      spatialEvidenceRef: deviceResult.spatialEvidenceRef || null,
      duringActionObservation: duringActionObservation(request, deviceResult),
      recordedAt: options.now || new Date().toISOString(),
    });
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
      planId: request.planId || null,
      stepId: request.stepId || null,
    }, options);
    throw Object.assign(error, {
      actionOutcome: 'UNKNOWN',
      operationId,
      technicalFactRef: technicalFact.technicalFactRef,
      actionDispatch: {
        beforeScene: scene,
        action: redactedAction(resolved.action),
        decisionId: request.decisionId || null,
        planId: request.planId || null,
        stepId: request.stepId || null,
      },
    });
  }
  const spatialEvidence = deviceResult.spatialEvidenceRef
    ? projectActionSpatialEvidence(execDir, deviceResult.spatialEvidenceRef, {
      operationId,
      actionType: resolved.action.type,
    })
    : null;
  const adapterResult = sanitizeAdapterActionResult(deviceResult.adapterResult);
  const action = {
    operationId,
    lifecycle: { status: 'RESULT_RECORDED' },
    action: redactedAction(resolved.action),
    command: adapterResult.command,
    deviceExecution: adapterResult.deviceExecution,
    evidence: actionEvidence(scene),
    ...(spatialEvidence ? { spatialEvidence } : {}),
    ...(duringActionObservation(request, deviceResult) ? { duringActionObservation: duringActionObservation(request, deviceResult) } : {}),
  };
  return {
    status: 'ACTION_DISPATCHED',
    operationId,
    beforeScene: scene,
    action,
    adapterResult,
    transaction,
    ...(request.planId ? { planId: request.planId } : {}),
    ...(request.stepId ? { stepId: request.stepId } : {}),
  };
}

function act(execDir, request, options = {}) {
  let dispatched;
  try {
    dispatched = dispatchAction(execDir, request, options);
  } catch (error) {
    if (error.actionOutcome !== 'UNKNOWN' || !error.actionDispatch) throw error;
    const dispatch = error.actionDispatch;
    try {
      const observed = sceneService.observe(execDir, {
        ...options,
        purpose: 'AFTER_UNKNOWN_ACTION',
        relatedOperationId: error.operationId,
        previousAction: {
          operationId: error.operationId,
          lifecycle: { status: 'UNKNOWN' },
          action: dispatch.action,
          command: { status: 'UNKNOWN' },
          deviceExecution: { status: 'UNVERIFIED' },
          evidence: actionEvidence(dispatch.beforeScene),
        },
        decisionId: dispatch.decisionId,
      });
      let transaction = transactions.readAction(execDir, error.operationId);
      transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'OBSERVED', {
        outcome: 'UNKNOWN',
        error: { code: error.code || 'DEVICE_ACTION_FAILED', message: error.message || String(error) },
        sceneIdAfter: observed.scene.sceneId,
      });
      transactions.completeAction(execDir, transaction);
      return { ...observed, action: { operationId: error.operationId, status: 'UNKNOWN', technicalFactRef: error.technicalFactRef } };
    } catch (observeError) {
      throw Object.assign(observeError, {
        code: observeError.code || 'POST_ACTION_OBSERVE_FAILED',
        actionOutcome: 'UNKNOWN',
        operationId: error.operationId,
      });
    }
  }
  if (dispatched.status !== 'ACTION_DISPATCHED') return dispatched;
  const {
    operationId, beforeScene: scene, action: dispatchedAction,
    adapterResult, transaction: recordedTransaction,
  } = dispatched;
  let transaction = recordedTransaction;
  const observed = sceneService.observe(execDir, {
    ...options,
    purpose: 'POST_ACTION',
    relatedOperationId: operationId,
    preAdapterDelayMs: dispatchedAction.action.type === 'wait' ? 0 : 500,
    previousAction: {
      operationId,
      lifecycle: { status: 'COMPLETED' },
      action: dispatchedAction.action,
      command: dispatchedAction.command,
      deviceExecution: dispatchedAction.deviceExecution,
      evidence: dispatchedAction.evidence,
      ...(dispatchedAction.spatialEvidence ? { spatialEvidence: dispatchedAction.spatialEvidence } : {}),
    },
    decisionId: request.decisionId || null,
  });
  const observedScene = store.readCurrentScene(execDir);
  const actionResult = completedAction(
    operationId,
    dispatchedAction.action,
    adapterResult,
    scene,
    observedScene,
    dispatchedAction.spatialEvidence,
    dispatchedAction.duringActionObservation,
  );
  observedScene.previousAction = actionResult;
  store.writeScene(execDir, observedScene);
  observed.scene = sceneService.projectSceneSummary(observedScene);
  store.appendEvent(execDir, 'actionCompleted', {
    operationId,
    sceneId: scene.sceneId,
    sceneIdAfter: observed.scene.sceneId,
    action: dispatchedAction.action,
    lifecycle: actionResult.lifecycle,
    command: actionResult.command,
    deviceExecution: actionResult.deviceExecution,
    evidence: actionResult.evidence,
    duringActionObservation: actionResult.duringActionObservation || null,
    spatialEvidenceRef: transaction.spatialEvidenceRef || null,
    decisionId: request.decisionId || null,
    planId: request.planId || null,
    stepId: request.stepId || null,
  }, options);
  transaction = transactions.transitionAction(execDir, transaction, 'RESULT_RECORDED', 'OBSERVED', {
    sceneIdAfter: observed.scene.sceneId,
  });
  if (options.interruptAfter === 'observe') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: observe');
  transactions.completeAction(execDir, transaction, { actionResult: persistedActionResult(actionResult) });
  return { ...observed, action: actionResult };
}

module.exports = { act, dispatchAction, redactedAction };
