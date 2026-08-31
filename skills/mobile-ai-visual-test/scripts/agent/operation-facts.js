'use strict';

const { completeOperation, pendingPostActionObservation, timelineEvents } = require('../execution/core');

function factFromResult(execDir, validated, kind, result, options = {}) {
  const { request } = validated;
  if (kind === 'OBSERVE') {
    const evidence = result.evidence || result;
    const adapterResult = result.adapterResult || result;
    const pending = pendingPostActionObservation(timelineEvents(execDir));
    const relatedOperationId = request.relatedOperationId || pending?.operationId;
    const observationPurpose = request.purpose || (relatedOperationId ? 'POST_ACTION' : request.authorization.phase === 'case-prepare' ? 'ESTABLISH_START' : 'AGENT_DECIDED');
    return completeOperation(execDir, {
      type: 'observation',
      operationId: request.operationId,
      scope: request.authorization.phase,
      ref: evidence.ref,
      sha256: evidence.sha256,
      usable: evidence.usable === true,
      observationPurpose,
      ...(relatedOperationId ? { relatedOperationId } : {}),
      ...(request.intent ? { intent: request.intent } : {}),
      ...(request.expectedOutcome ? { expectedOutcome: request.expectedOutcome } : {}),
      artifacts: {
        screenshot: adapterResult.artifacts?.screenshot || evidence.ref,
        layout: adapterResult.artifacts?.layout || null,
        logs: adapterResult.artifacts?.logs || [],
      },
      warmSessionGeneration: validated.context.execution.warmSessionGeneration,
      ...(adapterResult.app ? { app: adapterResult.app } : {}),
      ...(adapterResult.device ? { device: adapterResult.device } : {}),
      ...(adapterResult.technicalSignals ? { technicalSignals: adapterResult.technicalSignals } : {}),
      authorization: request.authorization,
      ...(request.authorization.phase === 'case-prepare' ? {
        ...(request.authorization.startConditionId ? { startConditionId: request.authorization.startConditionId } : {}),
        understandingRevision: request.authorization.understandingRevision,
      } : {}),
    }, { implementationSha: validated.context.execution.implementationSha, now: options.now, interruptAfter: options.interruptAfter });
  }
  const adapterResult = result.adapterResult || result;
  return completeOperation(execDir, {
    type: 'actionResult',
    operationId: request.operationId,
    scope: request.authorization.phase,
    ok: adapterResult.ok === true,
    requestedAction: validated.action,
    ...(request.basisObservationRef ? { basisObservationRef: request.basisObservationRef } : {}),
    actionNormalizations: validated.actionNormalizations,
    authorization: request.authorization,
    deviceResult: adapterResult,
    ...(result.coordinateAudit ? { coordinateAudit: result.coordinateAudit } : {}),
    warmSessionGeneration: validated.context.execution.warmSessionGeneration,
    ...(request.intent ? { intent: request.intent } : {}),
    ...(request.expectedOutcome ? { expectedOutcome: request.expectedOutcome } : {}),
    ...(request.authorization.phase === 'case-prepare' ? {
      ...(request.authorization.startConditionId ? { startConditionId: request.authorization.startConditionId } : {}),
      understandingRevision: request.authorization.understandingRevision,
    } : {}),
  }, { implementationSha: validated.context.execution.implementationSha, now: options.now, interruptAfter: options.interruptAfter });
}

module.exports = { factFromResult };
