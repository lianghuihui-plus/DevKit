'use strict';

const { invokeDeviceOperation } = require('../platform/device-port');
const { safeActionTechnicalDetails, sanitizeAdapterActionResult } = require('../lib/action-result');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { resolveActionRequest } = require('./action-request');
const sceneService = require('./scene-service');
const store = require('./store');
const transactions = require('./transaction-manager');

function redactedAction(action) {
  return action?.type === 'inputText' ? { ...action, text: '[REDACTED]' } : action;
}

function actionErrorMessage(error, action) {
  if (action?.type === 'inputText') return 'inputText action failed; sensitive input redacted';
  return error?.message || String(error);
}

function redactedActionError(error, action) {
  if (action?.type !== 'inputText') return error;
  const sanitized = new Error(actionErrorMessage(error, action));
  if (error?.code) sanitized.code = error.code;
  return sanitized;
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

function classifyActionOutcome(adapterResult) {
  if (adapterResult?.command?.status === 'REJECTED'
    || adapterResult?.deviceExecution?.status === 'FAILED'
    || adapterResult?.failureCode === 'ACTION_EFFECT_MISMATCH') return 'FAILED';
  if (adapterResult?.command?.status === 'UNKNOWN') return 'UNKNOWN';
  return 'COMPLETED';
}

function completedAction(operationId, action, adapterResult, beforeScene, afterScene, spatialEvidence = null, duringObservation = null) {
  return {
    operationId,
    lifecycle: { status: classifyActionOutcome(adapterResult) },
    action: redactedAction(action),
    command: adapterResult.command,
    deviceExecution: adapterResult.deviceExecution,
    ...safeActionTechnicalDetails(adapterResult),
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

function completionMetadata(dispatched, transaction, metadata = {}) {
  return {
    decisionId: metadata.decisionId ?? dispatched.decisionId ?? transaction.decisionId ?? null,
    planId: dispatched.planId ?? transaction.planId ?? null,
    sequenceId: metadata.sequenceId ?? dispatched.sequenceId ?? transaction.sequenceId ?? null,
    stepId: metadata.stepId ?? dispatched.stepId ?? transaction.stepId ?? null,
    preSceneRef: metadata.preSceneRef ?? dispatched.beforeScene?.sceneId ?? transaction.sceneId ?? null,
  };
}

function completionTransaction(execDir, dispatched) {
  const operationId = dispatched.operationId || dispatched.transaction?.operationId;
  const transaction = transactions.readAction(execDir, operationId)
    || transactions.readCompletedAction(execDir, operationId);
  if (!transaction) throw new Error(`action transaction ${operationId} is missing`);
  return transaction;
}

function captureFailureTechnicalFact(execDir, operationId, options = {}) {
  const ref = options.captureFailureTechnicalFactRef || options.captureFailureTechnicalFact?.technicalFactRef;
  const fact = ref ? store.events(execDir).find((event) => event.technicalFactRef === ref) : null;
  if (fact?.type !== 'technicalIssue'
    || fact.operation !== 'act'
    || fact.operationId !== operationId
    || !['POST_ACTION_CAPTURE_FAILED', 'POST_ACTION_OBSERVE_FAILED'].includes(fact.code)) {
    throw new Error('afterScene may be null only with a persisted capture-failure technical fact for this action');
  }
  return ref;
}

function ensurePromotionOption(options = {}) {
  if (typeof options.promoteScene !== 'boolean') throw new Error('options.promoteScene is required');
}

function dispatchedActionPayload(dispatched, transaction) {
  return dispatched.action?.action || dispatched.action || transaction.action;
}

function completeDispatchedAction(execDir, dispatched, afterScene, metadata = {}, options = {}) {
  ensurePromotionOption(options);
  let transaction = completionTransaction(execDir, dispatched);
  if (transaction.status === 'COMPLETED') return transaction.actionResult;
  const details = completionMetadata(dispatched, transaction, metadata);
  const action = dispatchedActionPayload(dispatched, transaction);
  const adapterResult = sanitizeAdapterActionResult(dispatched.adapterResult || transaction.deviceResult || {});
  const actionResult = completedAction(
    transaction.operationId,
    action,
    adapterResult,
    dispatched.beforeScene || store.readCurrentScene(execDir),
    afterScene,
    dispatched.action?.spatialEvidence || null,
    dispatched.action?.duringActionObservation || transaction.duringActionObservation || null,
  );
  if (!afterScene) {
    const captureFailureTechnicalFactRef = captureFailureTechnicalFact(execDir, transaction.operationId, options);
    actionResult.observationStatus = 'FAILED';
    actionResult.captureFailureTechnicalFactRef = captureFailureTechnicalFactRef;
    transaction = transactions.transitionAction(execDir, transaction, 'RESULT_RECORDED', 'OBSERVED', {
      outcome: classifyActionOutcome(adapterResult),
      observationStatus: 'FAILED',
      sceneIdAfter: null,
      captureFailureTechnicalFactRef,
    });
    transactions.completeAction(execDir, transaction, { actionResult: persistedActionResult(actionResult) });
    return actionResult;
  }
  afterScene.previousAction = actionResult;
  store.writeScene(execDir, afterScene, { promote: options.promoteScene });
  if (!store.events(execDir).some((event) => event.type === 'actionCompleted' && event.operationId === transaction.operationId)) {
    store.appendEvent(execDir, 'actionCompleted', {
      operationId: transaction.operationId,
      sceneId: details.preSceneRef,
      sceneIdAfter: afterScene.sceneId,
      action,
      lifecycle: actionResult.lifecycle,
      command: actionResult.command,
      deviceExecution: actionResult.deviceExecution,
      ...safeActionTechnicalDetails(actionResult),
      evidence: actionResult.evidence,
      duringActionObservation: actionResult.duringActionObservation || null,
      spatialEvidenceRef: transaction.spatialEvidenceRef || null,
      decisionId: details.decisionId,
      planId: details.planId,
      sequenceId: details.sequenceId,
      stepId: details.stepId,
    }, options);
  }
  if (options.interruptAfter === 'action-completed') {
    const error = new Error('MAVT_CASE_ACTION_INTERRUPTED: action-completed');
    error.code = 'MAVT_CASE_ACTION_INTERRUPTED';
    error.interruptAfter = 'action-completed';
    throw error;
  }
  transaction = transactions.transitionAction(execDir, transaction, 'RESULT_RECORDED', 'OBSERVED', {
    outcome: classifyActionOutcome(adapterResult),
    observationStatus: 'CAPTURED',
    sceneIdAfter: afterScene.sceneId,
  });
  if (options.interruptAfter === 'observe') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: observe');
  transactions.completeAction(execDir, transaction, { actionResult: persistedActionResult(actionResult) });
  return actionResult;
}

function completeUnknownDispatchedAction(execDir, unknown, afterScene, metadata = {}, options = {}) {
  ensurePromotionOption(options);
  let transaction = completionTransaction(execDir, unknown);
  const details = completionMetadata(unknown, transaction, metadata);
  let technicalFact = store.events(execDir).find((event) => event.type === 'actionOutcomeUnknown'
    && event.operationId === transaction.operationId) || null;
  if (!technicalFact) {
    technicalFact = store.appendEvent(execDir, 'actionOutcomeUnknown', {
      operationId: transaction.operationId,
      sceneId: details.preSceneRef,
      action: transaction.action,
      code: unknown.code || 'ACTION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION',
      message: unknown.message || 'action dispatch completed without a recorded device result',
      decisionId: details.decisionId,
      planId: details.planId,
      sequenceId: details.sequenceId,
      stepId: details.stepId,
    }, options);
  }
  const actionResult = {
    operationId: transaction.operationId,
    status: 'UNKNOWN',
    outcomeKnown: false,
    technicalFactRef: technicalFact.technicalFactRef,
    lifecycle: { status: 'UNKNOWN' },
    action: transaction.action,
    command: { status: 'UNKNOWN' },
    deviceExecution: { status: 'UNVERIFIED' },
    evidence: actionEvidence(unknown.beforeScene || store.readCurrentScene(execDir), afterScene),
  };
  if (!afterScene) {
    const captureFailureTechnicalFactRef = captureFailureTechnicalFact(execDir, transaction.operationId, options);
    actionResult.observationStatus = 'FAILED';
    actionResult.captureFailureTechnicalFactRef = captureFailureTechnicalFactRef;
    transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'OBSERVED', {
      outcome: 'UNKNOWN', outcomeKnown: false, observationStatus: 'FAILED', sceneIdAfter: null,
      captureFailureTechnicalFactRef,
    });
  } else {
    afterScene.previousAction = actionResult;
    store.writeScene(execDir, afterScene, { promote: options.promoteScene });
    transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'OBSERVED', {
      outcome: 'UNKNOWN', outcomeKnown: false, observationStatus: 'CAPTURED', sceneIdAfter: afterScene.sceneId,
    });
  }
  transactions.completeAction(execDir, transaction, { actionResult: persistedActionResult(actionResult) });
  return actionResult;
}

function recordCaptureFailureTechnicalFact(execDir, operationId, metadata, action, error, options) {
  const code = 'POST_ACTION_CAPTURE_FAILED';
  const existing = store.events(execDir).find((event) => event.type === 'technicalIssue'
    && event.operationId === operationId && event.code === code);
  if (existing) return existing;
  return store.appendEvent(execDir, 'technicalIssue', {
    operationId,
    code,
    ...(error.code ? { internalCode: error.code } : {}),
    message: actionErrorMessage(error, action),
    operation: 'act',
    decisionId: metadata.decisionId || null,
  }, options);
}

function dispatchAction(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir);
  const scene = options.beforeScene || store.readCurrentScene(execDir);
  if (!scene) return sceneService.observe(execDir, options);
  const resolved = options.resolvedAction || resolveActionRequest(scene, request, execution.platform);
  if (resolved.stale) return { status: 'SCENE_CHANGED', scene: sceneService.projectSceneSummary(scene) };
  const operationId = options.operationId || store.nextId(execDir, 'action');
  let transaction = transactions.prepareAction(execDir, {
    operationId,
    sceneId: scene.sceneId,
    action: redactedAction(resolved.action),
    intent: request.decision?.purpose || null,
    decisionId: request.decisionId || null,
    planId: request.planId || null,
    sequenceId: request.sequenceId || null,
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
    sequenceId: request.sequenceId || null,
    stepId: request.stepId || null,
  }, options);
  if (options.interruptAfter === 'action-prepared') throw Object.assign(new Error('action-prepared'), { code: 'MAVT_SEQUENCE_INTERRUPTED' });
  let deviceResult;
  try {
    transaction = transactions.transitionAction(execDir, transaction, 'PREPARED', 'DISPATCHED', {
      dispatchedAt: options.now || new Date().toISOString(),
    });
    if (options.interruptAfter === 'action-dispatched') throw Object.assign(new Error('action-dispatched'), { code: 'MAVT_SEQUENCE_INTERRUPTED' });
    if (options.interruptAfter === 'dispatch') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: dispatch');
    deviceResult = (options.invokeDeviceOperation || invokeDeviceOperation)(execDir, {
      context: { execution },
      operationId,
      action: resolved.action,
      request: {
        basisObservationRef: scene.screenshot.ref,
        ...(request.observationPolicy ? { observationPolicy: request.observationPolicy } : {}),
      },
    }, 'ACTION', { now: options.now, runner: options.runner, onAdapterSpan: options.onAdapterSpan, timeoutMs: options.timeoutMs });
    transaction = transactions.transitionAction(execDir, transaction, 'DISPATCHED', 'RESULT_RECORDED', {
      deviceResult: sanitizeAdapterActionResult(deviceResult.adapterResult),
      spatialEvidenceRef: deviceResult.spatialEvidenceRef || null,
      duringActionObservation: duringActionObservation(request, deviceResult),
      recordedAt: options.now || new Date().toISOString(),
    });
    if (options.interruptAfter === 'action-result-recorded') throw Object.assign(new Error('action-result-recorded'), { code: 'MAVT_SEQUENCE_INTERRUPTED' });
    if (options.interruptAfter === 'device-result') throw new Error('MAVT_CASE_ACTION_INTERRUPTED: device-result');
  } catch (error) {
    if (error.code === 'MAVT_SEQUENCE_INTERRUPTED') throw error;
    if (transaction.status !== 'DISPATCHED') throw error;
    const sanitizedError = redactedActionError(error, resolved.action);
    const technicalFact = store.appendEvent(execDir, 'actionOutcomeUnknown', {
      operationId,
      sceneId: scene.sceneId,
      action: redactedAction(resolved.action),
      code: error.code || 'DEVICE_ACTION_FAILED',
      message: actionErrorMessage(error, resolved.action),
      decisionId: request.decisionId || null,
      planId: request.planId || null,
      sequenceId: request.sequenceId || null,
      stepId: request.stepId || null,
    }, options);
    throw Object.assign(sanitizedError, {
      actionOutcome: 'UNKNOWN',
      operationId,
      technicalFactRef: technicalFact.technicalFactRef,
      actionDispatch: {
        beforeScene: scene,
        action: redactedAction(resolved.action),
        decisionId: request.decisionId || null,
        planId: request.planId || null,
        sequenceId: request.sequenceId || null,
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
    ...safeActionTechnicalDetails(adapterResult),
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
    ...(request.sequenceId ? { sequenceId: request.sequenceId } : {}),
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
      const action = completeUnknownDispatchedAction(execDir, {
        ...dispatch,
        operationId: error.operationId,
        code: error.code,
        message: error.message,
      }, store.readCurrentScene(execDir), {
        decisionId: dispatch.decisionId,
        sequenceId: dispatch.sequenceId,
        stepId: dispatch.stepId,
        preSceneRef: dispatch.beforeScene.sceneId,
      }, { ...options, promoteScene: true });
      observed.scene = sceneService.projectSceneSummary(store.readCurrentScene(execDir));
      return { ...observed, action };
    } catch (observeError) {
      const fact = recordCaptureFailureTechnicalFact(execDir, error.operationId, dispatch, dispatch.action, observeError, options);
      completeUnknownDispatchedAction(execDir, {
        ...dispatch,
        operationId: error.operationId,
        code: error.code,
        message: error.message,
      }, null, {
        decisionId: dispatch.decisionId,
        sequenceId: dispatch.sequenceId,
        stepId: dispatch.stepId,
        preSceneRef: dispatch.beforeScene.sceneId,
      }, { ...options, promoteScene: true, captureFailureTechnicalFactRef: fact.technicalFactRef });
      throw Object.assign(redactedActionError(observeError, dispatch.action), {
        code: observeError.code || 'POST_ACTION_OBSERVE_FAILED',
        actionOutcome: 'UNKNOWN',
        operationId: error.operationId,
        technicalFactRef: error.technicalFactRef,
      });
    }
  }
  if (dispatched.status !== 'ACTION_DISPATCHED') return dispatched;
  const {
    operationId, beforeScene: scene, action: dispatchedAction,
  } = dispatched;
  try {
    const observed = sceneService.observe(execDir, {
      ...options,
      purpose: 'POST_ACTION',
      relatedOperationId: operationId,
      preAdapterDelayMs: dispatchedAction.action.type === 'wait' ? 0 : 500,
      previousAction: {
        operationId,
        lifecycle: { status: classifyActionOutcome(dispatched.adapterResult) },
        action: dispatchedAction.action,
        command: dispatchedAction.command,
        deviceExecution: dispatchedAction.deviceExecution,
        evidence: dispatchedAction.evidence,
        ...(dispatchedAction.spatialEvidence ? { spatialEvidence: dispatchedAction.spatialEvidence } : {}),
      },
      decisionId: request.decisionId || null,
    });
    const action = completeDispatchedAction(execDir, dispatched, store.readCurrentScene(execDir), {
      decisionId: request.decisionId || null,
      sequenceId: request.sequenceId || null,
      stepId: request.stepId || null,
      preSceneRef: scene.sceneId,
    }, { ...options, promoteScene: true });
    observed.scene = sceneService.projectSceneSummary(store.readCurrentScene(execDir));
    return { ...observed, action };
  } catch (error) {
    if (error.code === 'MAVT_CASE_ACTION_INTERRUPTED' && error.interruptAfter === 'action-completed') throw error;
    const transaction = transactions.readAction(execDir, operationId);
    if (transaction?.status !== 'RESULT_RECORDED') throw error;
    const fact = recordCaptureFailureTechnicalFact(execDir, operationId, {
      decisionId: request.decisionId || null,
    }, dispatchedAction.action, error, options);
    completeDispatchedAction(execDir, dispatched, null, {
      decisionId: request.decisionId || null,
      sequenceId: request.sequenceId || null,
      stepId: request.stepId || null,
      preSceneRef: scene.sceneId,
    }, { ...options, promoteScene: true, captureFailureTechnicalFactRef: fact.technicalFactRef });
    throw redactedActionError(error, dispatchedAction.action);
  }
}

module.exports = {
  act,
  classifyActionOutcome,
  completeDispatchedAction,
  completeUnknownDispatchedAction,
  dispatchAction,
  redactedAction,
};
