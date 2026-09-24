'use strict';

const { canonicalJson, contractError, sha256 } = require('../lib/contract-utils');
const { validateAgentJson } = require('../lib/agent-json-contract');
const { AGENT_CONTRACT_DEFINITIONS } = require('./runtime-operation-contract');
const { validateDecision } = require('./contract');

const SEQUENCE_STEP_TYPES = Object.freeze(['act', 'wait', 'capture']);
const SEQUENCE_STATUSES = Object.freeze(['SEQUENCE_COMPLETED', 'SEQUENCE_PARTIAL', 'SEQUENCE_INTERRUPTED']);
const MAX_SEQUENCE_STEPS = 12;
const MAX_SEQUENCE_DURATION_MS = 30000;
const FINAL_SCENE_RESERVE_MS = 4000;
const STEP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REQUEST_FIELDS = new Set(['operation', 'basedOnSceneId', 'purpose', 'steps', 'flowContext', 'decision']);
const STEP_FIELDS = {
  act: new Set(['id', 'type', 'capabilityId', 'input', 'visual']),
  wait: new Set(['id', 'type', 'ms']),
  capture: new Set(['id', 'type', 'mode', 'purpose']),
};

function invalid(message, details = {}) {
  throw contractError('SEQUENCE_INVALID', message, details);
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateFlowContext(value) {
  if (!object(value)) invalid('flowContext must be an object');
  const issues = validateAgentJson(value, { $ref: 'flowContext' }, AGENT_CONTRACT_DEFINITIONS, 'flowContext');
  if (issues.length) invalid(`flowContext has ${issues.length} contract issue${issues.length === 1 ? '' : 's'}`, { issues });
  if (!value.nodeRef.trim()) invalid('flowContext.nodeRef must be a non-empty string');
  if (value.selectedEdgeRef !== undefined && !value.selectedEdgeRef.trim()) {
    invalid('flowContext.selectedEdgeRef must be a non-empty string');
  }
  return value;
}

function validateActionStep(step, index) {
  const prefix = `steps[${index}]`;
  const actionFields = Object.keys(step).filter((field) => !STEP_FIELDS.act.has(field));
  if (actionFields.length) invalid(`${prefix} contains unsupported fields: ${actionFields.join(', ')}`);
  const hasCapability = step.capabilityId !== undefined;
  const hasVisual = step.visual !== undefined;
  if ((hasCapability ? 1 : 0) + (hasVisual ? 1 : 0) !== 1) {
    invalid(`${prefix} requires exactly one of capabilityId or visual`);
  }
  if (hasCapability) {
    if (typeof step.capabilityId !== 'string' || !step.capabilityId.trim()) invalid(`${prefix}.capabilityId must be a non-empty string`);
    if (step.input !== undefined) {
      const issues = validateAgentJson(step.input, { $ref: 'capabilityInput' }, AGENT_CONTRACT_DEFINITIONS, `${prefix}.input`);
      if (issues.length) invalid(`${prefix}.input has ${issues.length} contract issue${issues.length === 1 ? '' : 's'}`, { issues });
    }
  }
  if (hasVisual) {
    if (step.input !== undefined) invalid(`${prefix}.input is only valid with capabilityId`);
    const issues = validateAgentJson(step.visual, { $ref: 'visualAction' }, AGENT_CONTRACT_DEFINITIONS, `${prefix}.visual`);
    if (issues.length) invalid(`${prefix}.visual has ${issues.length} contract issue${issues.length === 1 ? '' : 's'}`, { issues });
  }
}

function validateSequenceRequest(request) {
  if (!object(request)) invalid('request must be an object');
  const unsupported = Object.keys(request).filter((field) => !REQUEST_FIELDS.has(field));
  if (unsupported.length) invalid(`request contains unsupported fields: ${unsupported.join(', ')}`);
  if (request.operation !== 'runSequence') invalid('operation must be runSequence');
  if (typeof request.basedOnSceneId !== 'string' || !request.basedOnSceneId.trim()) invalid('basedOnSceneId must be a non-empty string');
  if (typeof request.purpose !== 'string' || !request.purpose.trim()) invalid('purpose must be a non-empty string');
  if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_SEQUENCE_STEPS) {
    invalid(`steps must contain 1 to ${MAX_SEQUENCE_STEPS} items`);
  }
  const ids = new Set();
  request.steps.forEach((step, index) => {
    if (!object(step)) invalid(`steps[${index}] must be an object`);
    if (typeof step.id !== 'string' || !STEP_ID_PATTERN.test(step.id)) invalid(`steps[${index}].id must be a unique step id`);
    if (ids.has(step.id)) invalid(`steps contains duplicate id: ${step.id}`);
    ids.add(step.id);
    if (!SEQUENCE_STEP_TYPES.includes(step.type)) invalid(`steps[${index}].type is invalid`);
    const unsupportedStepFields = Object.keys(step).filter((field) => !STEP_FIELDS[step.type].has(field));
    if (unsupportedStepFields.length) invalid(`steps[${index}] contains unsupported fields: ${unsupportedStepFields.join(', ')}`);
    if (step.type === 'act') validateActionStep(step, index);
    if (step.type === 'wait' && (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > MAX_SEQUENCE_DURATION_MS)) {
      invalid(`steps[${index}].ms must be an integer from 0 to ${MAX_SEQUENCE_DURATION_MS}`);
    }
    if (step.type === 'capture') {
      if (!['SCREENSHOT_ONLY', 'FULL_SCENE'].includes(step.mode)) invalid(`steps[${index}].mode is invalid`);
      if (typeof step.purpose !== 'string' || !step.purpose.trim()) invalid(`steps[${index}].purpose must be a non-empty string`);
    }
  });
  if (request.flowContext !== undefined) validateFlowContext(request.flowContext);
  if (request.decision !== undefined) {
    try {
      validateDecision(request.decision);
    } catch (error) {
      invalid(`decision is invalid: ${error.message}`, { cause: error });
    }
  }
  return true;
}

function normalizeFlowContext(value) {
  if (value === undefined) return undefined;
  const normalized = { nodeRef: value.nodeRef.trim() };
  if (value.selectedEdgeRef !== undefined) normalized.selectedEdgeRef = value.selectedEdgeRef.trim();
  return normalized;
}

function normalizeStep(step) {
  if (step.type === 'act') {
    return {
      id: step.id.trim(), type: step.type,
      ...(step.capabilityId !== undefined ? { capabilityId: step.capabilityId.trim() } : {}),
      ...(step.input !== undefined ? { input: step.input } : {}),
      ...(step.visual !== undefined ? { visual: step.visual } : {}),
    };
  }
  if (step.type === 'wait') return { id: step.id.trim(), type: step.type, ms: step.ms };
  return { id: step.id.trim(), type: step.type, mode: step.mode, purpose: step.purpose.trim() };
}

function normalizeSequenceRequest(request) {
  validateSequenceRequest(request);
  return {
    basedOnSceneId: request.basedOnSceneId.trim(),
    purpose: request.purpose.trim(),
    steps: request.steps.map(normalizeStep),
    ...(request.flowContext !== undefined ? { flowContext: normalizeFlowContext(request.flowContext) } : {}),
  };
}

function sequenceRequestKey(request) {
  return sha256(canonicalJson(normalizeSequenceRequest(request)), 'sequence-request', 24);
}

function sequenceDurationMs(remainingMs) {
  if (remainingMs === undefined) return MAX_SEQUENCE_DURATION_MS;
  const value = Number(remainingMs);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, MAX_SEQUENCE_DURATION_MS));
}

module.exports = {
  MAX_SEQUENCE_STEPS,
  MAX_SEQUENCE_DURATION_MS,
  FINAL_SCENE_RESERVE_MS,
  SEQUENCE_STATUSES,
  SEQUENCE_STEP_TYPES,
  validateSequenceRequest,
  normalizeSequenceRequest,
  sequenceRequestKey,
  sequenceDurationMs,
};
