'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureObject, ensureString, sha256 } = require('../lib/contract-utils');
const { currentObservation, timelineEvents } = require('../execution/core');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');

const CONTROL_REQUEST_FILE = 'control-request.json';
const RECOVERY_TRIGGERS = new Set([
  'SOURCE_REQUIRED_COLD_START',
  'AGENT_DECIDED_RESTART',
  'APP_CRASH',
  'SYSTEM_KILLED',
  'UNKNOWN_EXIT',
  'APP_UNRESPONSIVE',
  'AUTOMATION_SESSION_LOST',
]);

function controlRequestPath(execDir) {
  return path.join(execDir, 'agent', CONTROL_REQUEST_FILE);
}

function activeCheckpoint(plan, events, warmSessionGeneration) {
  const ids = new Set((plan?.checkpoints || []).map((entry) => entry.id));
  const recent = [...events].reverse().find((event) => ids.has(event.authorization?.checkpointId)
    && (warmSessionGeneration === undefined || event.warmSessionGeneration === warmSessionGeneration));
  return recent?.authorization?.checkpointId || plan?.checkpoints?.[0]?.id || null;
}

function recoveryBinding(value) {
  return {
    recoveryId: value.recoveryId,
    executionId: value.executionId,
    checkpointId: value.checkpointId,
    triggerType: value.triggerType,
    evidenceRefs: value.evidenceRefs,
    failedOperationId: value.failedOperationId || null,
    incidentId: value.incidentId || null,
    incidentCategory: value.incidentCategory || null,
    incidentReason: value.incidentReason || null,
    decisionReason: value.decisionReason || null,
    sourceRefs: value.sourceRefs || [],
  };
}

function requestRecovery(execDir, input = {}, options = {}) {
  ensureObject(input, 'recovery request', 'AGENT_CONTROL_REQUEST_INVALID');
  ensureString(input.reason, 'reason', 'AGENT_CONTROL_REQUEST_INVALID');
  const triggerType = String(input.triggerType || 'AGENT_DECIDED_RESTART').trim().toUpperCase();
  if (!RECOVERY_TRIGGERS.has(triggerType)) {
    throw contractError('AGENT_CONTROL_REQUEST_INVALID', `unsupported recovery trigger: ${triggerType}`, {
      fieldPath: 'triggerType', allowed: [...RECOVERY_TRIGGERS],
    });
  }
  const binding = validateLiveAgentBinding(execDir);
  const plan = readJson(path.join(execDir, 'plan.json'), null);
  if (!plan?.checkpoints?.length) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'recovery requires the current plan');
  const understanding = readJson(path.join(execDir, 'understanding.json'), null);
  const events = timelineEvents(execDir);
  const observation = currentObservation(events, binding.execution.warmSessionGeneration);
  const failedOperation = [...events].reverse().find((event) => event.type === 'operationCompleted'
    && event.outcome === 'FAILED' && event.failureCode);
  if (!observation && triggerType !== 'SOURCE_REQUIRED_COLD_START'
    && (triggerType === 'AGENT_DECIDED_RESTART' || !failedOperation)) {
    throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'recovery requires a current execution observation');
  }
  const checkpointId = activeCheckpoint(plan, events, binding.execution.warmSessionGeneration);
  const checkpoint = plan.checkpoints.find((entry) => entry.id === checkpointId);
  const requirementIds = new Set(checkpoint?.requirementRefs || []);
  const sourceRefs = triggerType === 'SOURCE_REQUIRED_COLD_START'
    ? [...new Set((understanding?.requirements || [])
      .filter((requirement) => requirementIds.has(requirement.id))
      .flatMap((requirement) => requirement.sourceRefs || []))]
    : [];
  if (triggerType === 'SOURCE_REQUIRED_COLD_START' && sourceRefs.length === 0) {
    throw contractError('RECOVERY_EVIDENCE_REQUIRED', 'source-required cold start needs a source reference from the active checkpoint');
  }
  const seed = canonicalJson({
    executionId: binding.execution.executionId,
    checkpointId,
    triggerType,
    observationRef: observation?.ref || null,
    failedOperationId: failedOperation?.operationId || null,
    sourceRefs,
    reason: input.reason.trim(),
  });
  const suffix = sha256(seed, '', 16);
  const incident = ['SOURCE_REQUIRED_COLD_START', 'AGENT_DECIDED_RESTART'].includes(triggerType) ? {} : {
    incidentId: `incident-${suffix}`,
    incidentCategory: input.incidentCategory || 'TECHNICAL',
    incidentReason: input.reason.trim(),
  };
  const request = {
    schemaVersion: 1,
    recoveryId: `recovery-${suffix}`,
    executionId: binding.execution.executionId,
    checkpointId,
    triggerType,
    evidenceRefs: observation ? [observation.ref] : [],
    ...(triggerType === 'SOURCE_REQUIRED_COLD_START' ? { sourceRefs } : {}),
    ...(!observation && triggerType !== 'SOURCE_REQUIRED_COLD_START' ? { failedOperationId: failedOperation.operationId } : {}),
    generatedBy: 'agent-facade',
    ...(triggerType === 'AGENT_DECIDED_RESTART' ? { decisionReason: input.reason.trim() } : incident),
    requestedAt: options.now || new Date().toISOString(),
  };
  const file = controlRequestPath(execDir);
  const existing = readJson(file, null);
  if (existing) {
    if (canonicalJson(recoveryBinding(existing)) !== canonicalJson(recoveryBinding(request))) {
      throw contractError('AGENT_CONTROL_REQUEST_PENDING', 'another recovery request is already pending');
    }
    return { accepted: true, idempotent: true, controlRequest: existing };
  }
  writeJsonAtomic(file, request);
  return { accepted: true, controlRequested: true, controlRequest: request };
}

function clearControlRequest(execDir, recoveryId) {
  const file = controlRequestPath(execDir);
  const current = readJson(file, null);
  if (!current) return false;
  if (current.recoveryId !== recoveryId) {
    throw contractError('AGENT_CONTROL_REQUEST_MISMATCH', 'completed recovery does not match the pending control request');
  }
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  CONTROL_REQUEST_FILE,
  activeCheckpoint,
  clearControlRequest,
  controlRequestPath,
  requestRecovery,
};
