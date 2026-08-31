'use strict';

const path = require('path');
const { contractError, ensureId, ensureObject } = require('../lib/contract-utils');
const { readJson } = require('../lib/execution-lifecycle');
const { collectEvidence } = require('../lib/execution-evidence');
const { currentObservation, latestStateChangeIndex, timelineEvents } = require('../execution/core');
const { RECOVERY_TRIGGERS, incidentCategory, isIncidentRecovery } = require('../lib/recovery-contract');

function validateRecoveryRequest(request, state, item, execDir) {
  ensureObject(request, 'recovery request', 'RECOVERY_INVALID');
  ensureId(request.recoveryId, 'recoveryId', 'RECOVERY_INVALID');
  if (!RECOVERY_TRIGGERS.has(request.triggerType)) throw contractError('RECOVERY_TRIGGER_INVALID', `unsupported recovery trigger: ${request.triggerType || 'missing'}`);
  if (!item || item.status !== 'RUNNING' || request.executionId !== item.executionId) throw contractError('RECOVERY_BINDING_MISMATCH', 'recovery must bind the current running execution');
  const sourceRefs = Array.isArray(request.sourceRefs) ? request.sourceRefs : [];
  const evidenceRefs = Array.isArray(request.evidenceRefs) ? request.evidenceRefs : [];
  const events = timelineEvents(execDir);
  const liveExecution = readJson(path.join(execDir, 'execution.json'), null);
  const observations = new Map(events.map((event, index) => [event.ref, { event, index }])
    .filter(([ref, entry]) => ref && entry.event.type === 'observation'));
  const evidenceObservations = evidenceRefs.map((ref) => observations.get(ref));
  if (evidenceObservations.some((entry) => !entry
    || entry.event.executionId !== request.executionId
    || entry.event.warmSessionGeneration !== liveExecution?.warmSessionGeneration)) {
    throw contractError('RECOVERY_REFERENCE_INVALID', 'recovery evidence must be an observation from the current execution generation');
  }
  if (request.triggerType === 'AGENT_DECIDED_RESTART' && evidenceRefs.length) {
    const current = currentObservation(events, liveExecution.warmSessionGeneration);
    if (!current || evidenceRefs.length !== 1 || evidenceRefs[0] !== current.ref) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'agent-decided restart requires the current usable observation');
    }
  }
  if (isIncidentRecovery(request.triggerType) && evidenceObservations.length) {
    const boundary = latestStateChangeIndex(events);
    if (evidenceObservations.some((entry) => entry.index <= boundary)) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'incident recovery evidence must follow the latest state change');
    }
  }
  const recoveryBoundary = events.map((event) => event.type).lastIndexOf('recoveryCompleted');
  const failedOperation = request.generatedBy === 'agent-facade' && request.failedOperationId
    ? events.slice(recoveryBoundary + 1).find((event) => event.type === 'operationCompleted'
      && event.operationId === request.failedOperationId && event.outcome === 'FAILED' && event.failureCode)
    : null;
  if (request.triggerType === 'SOURCE_REQUIRED_COLD_START' && !sourceRefs.length) throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'source-required cold start needs sourceRefs');
  if (request.triggerType !== 'SOURCE_REQUIRED_COLD_START' && !evidenceRefs.length && !failedOperation) {
    throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'recovery needs current execution evidenceRefs or a frozen failed operation');
  }
  if (request.triggerType === 'AGENT_DECIDED_RESTART' && (typeof request.decisionReason !== 'string' || !request.decisionReason.trim())) {
    throw contractError('RECOVERY_INVALID', 'agent-decided restart requires decisionReason');
  }
  if (isIncidentRecovery(request.triggerType)) {
    ensureId(request.incidentId, 'incidentId', 'RECOVERY_INVALID');
    incidentCategory(request.incidentCategory);
    if (typeof request.incidentReason !== 'string' || !request.incidentReason.trim()) throw contractError('RECOVERY_INVALID', 'incidentReason is required');
  }
  if (!request.checkpointId) throw contractError('RECOVERY_INVALID', 'checkpointId is required');
  if (state.status !== 'RUNNING' || state.warmSession.status !== 'READY') {
    throw contractError('RECOVERY_STATE_INVALID', 'recovery requires a running batch and ready warm session');
  }
  const plan = readJson(path.join(execDir, 'plan.json'), null);
  if (!plan?.checkpoints?.some((entry) => entry.id === request.checkpointId)) {
    throw contractError('RECOVERY_REFERENCE_INVALID', 'checkpointId must belong to the current plan');
  }
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  if (!execution || !runtime || runtime.status !== 'BOUND' || runtime.executionId !== execution.executionId) {
    throw contractError('AGENT_RUNTIME_NOT_BOUND', 'App recovery requires the current bound Agent Runtime');
  }
  if (request.triggerType === 'SOURCE_REQUIRED_COLD_START') {
    const knownRefs = new Set((readJson(path.join(execDir, 'understanding.json'), null)?.sourceRefs || []).map((entry) => entry.id));
    if (!sourceRefs.every((ref) => knownRefs.has(ref))) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'sourceRefs must belong to the current understanding');
    }
  } else if (evidenceRefs.length) {
    const knownRefs = new Set(collectEvidence(events, {
      execDir,
      executionId: execution.executionId,
    }).filter((entry) => entry.warmSessionGeneration === execution.warmSessionGeneration)
      .map((entry) => entry.ref));
    if (!evidenceRefs.every((ref) => knownRefs.has(ref))) {
      throw contractError('RECOVERY_REFERENCE_INVALID', 'evidenceRefs must be current execution observations');
    }
  }
}

module.exports = { validateRecoveryRequest };
