#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

const NEXT_WORK_TYPES = Object.freeze([
  'STOP_FINALIZED',
  'RECORD_FLOW_PRECONDITION_TERMINAL',
  'OBSERVE_FLOW_ENTRY',
  'DECIDE_FLOW_ENTRY',
  'OBSERVE_FLOW_BEFORE',
  'EXECUTE_FLOW_ACTION',
  'OBSERVE_FLOW_AFTER',
  'RECORD_FLOW_STEP_COMPLETED',
  'OBSERVE_FLOW_END',
  'DECIDE_FLOW_END',
  'FINALIZE_PRECONDITION_BLOCKED',
  'RECORD_PRECONDITION',
  'FINALIZE_STEP_FAILURE',
  'OBSERVE_STEP',
  'OBSERVE_AFTER_ACTION',
  'EXECUTE_STEP_ACTION',
  'DECIDE_STEP',
  'FINALIZE_PASS',
]);

const VISUAL_DECISION_TYPES = new Set([
  'DECIDE_FLOW_ENTRY',
  'EXECUTE_FLOW_ACTION',
  'DECIDE_FLOW_END',
  'DECIDE_STEP',
]);

function validateNextWork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('nextWork must be an object');
  if (!NEXT_WORK_TYPES.includes(value.type)) throw new Error(`Unsupported nextWork type: ${value.type || 'unknown'}`);
  const flowType = value.type.includes('FLOW');
  if (flowType && (!value.preconditionId || !value.flowId)) throw new Error(`${value.type} requires preconditionId and flowId`);
  if (['OBSERVE_FLOW_BEFORE', 'EXECUTE_FLOW_ACTION', 'OBSERVE_FLOW_AFTER', 'RECORD_FLOW_STEP_COMPLETED'].includes(value.type) && !value.flowStepId) {
    throw new Error(`${value.type} requires flowStepId`);
  }
  if (['OBSERVE_STEP', 'OBSERVE_AFTER_ACTION', 'EXECUTE_STEP_ACTION', 'DECIDE_STEP'].includes(value.type) && !value.step?.id) {
    throw new Error(`${value.type} requires step.id`);
  }
  if (['DECIDE_FLOW_ENTRY', 'DECIDE_FLOW_END', 'DECIDE_STEP', 'EXECUTE_FLOW_ACTION'].includes(value.type) && !value.latestObservation?.label) {
    throw new Error(`${value.type} requires latestObservation.label`);
  }
  if (value.type === 'EXECUTE_STEP_ACTION' && !value.requestedAction?.type) throw new Error('EXECUTE_STEP_ACTION requires requestedAction');
  return value;
}

function operationClass(nextWork) {
  validateNextWork(nextWork);
  if (VISUAL_DECISION_TYPES.has(nextWork.type)) return 'VISUAL_DECISION';
  if (nextWork.type === 'STOP_FINALIZED') return 'STOP';
  return 'DETERMINISTIC';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nextWorkToken({ execution, events, nextWork }) {
  validateNextWork(nextWork);
  const latest = events.at(-1) || null;
  const binding = {
    executionId: execution.executionId,
    lifecycle: execution.lifecycle,
    finalized: execution.finalized === true,
    caseContractSha: execution.caseContractSha,
    preconditionPlanSha: execution.preconditionPlanSha,
    eventCount: events.length,
    latestEvent: latest,
    nextWork,
  };
  return `work-${crypto.createHash('sha256').update(canonicalJson(binding)).digest('hex').slice(0, 24)}`;
}

module.exports = {
  NEXT_WORK_TYPES,
  VISUAL_DECISION_TYPES,
  operationClass,
  nextWorkToken,
  validateNextWork,
};
