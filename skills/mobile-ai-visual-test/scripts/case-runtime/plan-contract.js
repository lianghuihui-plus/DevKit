'use strict';

const { contractError } = require('../lib/contract-utils');

const PLAN_STEP_TYPES = Object.freeze(['act', 'wait', 'capture', 'locate', 'check', 'checkpoint']);
const PLAN_LOCATOR_KINDS = Object.freeze(['ELEMENT_REF', 'POINT', 'REGION']);
const PLAN_CHECK_KINDS = Object.freeze([
  'CAPTURE_AVAILABLE', 'ELEMENT_VISIBLE', 'ELEMENT_ENABLED', 'APP_IN_FOREGROUND', 'REFERENCE_EXISTS',
]);
const PLAN_STATUSES = Object.freeze(['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED']);
const MAX_PLAN_STEPS = 12;
const MAX_PLAN_DURATION_MS = 30000;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REF_PATTERN = /^\$([A-Za-z][A-Za-z0-9_-]{0,63})\.([A-Za-z][A-Za-z0-9_.-]{0,127})$/;
const RESERVED_FIELDS = new Set(['schemaVersion', 'eventId', 'executionId', 'sequence', 'time']);

const STEP_FIELDS = Object.freeze({
  act: new Set(['id', 'type', 'actionRef', 'input']),
  wait: new Set(['id', 'type', 'ms']),
  capture: new Set(['id', 'type', 'mode', 'promote']),
  locate: new Set(['id', 'type', 'sourceRef', 'locator']),
  check: new Set(['id', 'type', 'sourceRef', 'predicate']),
  checkpoint: new Set(['id', 'type', 'evidenceRefs']),
});

function issue(fieldPath, expected, code = 'INVALID') {
  return { fieldPath, expected, code };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pointValid(point) {
  return Array.isArray(point) && point.length === 2
    && point.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

function references(value, fieldPath, output = []) {
  if (typeof value === 'string' && value.startsWith('$')) output.push({ value, fieldPath });
  else if (Array.isArray(value)) value.forEach((child, index) => references(child, `${fieldPath}[${index}]`, output));
  else if (isObject(value)) Object.entries(value).forEach(([key, child]) => references(child, `${fieldPath}.${key}`, output));
  return output;
}

function validateStep(step, index, priorIds, issues) {
  const prefix = `steps[${index}]`;
  if (!isObject(step)) {
    issues.push(issue(prefix, 'an object'));
    return;
  }
  if (!ID_PATTERN.test(String(step.id || ''))) issues.push(issue(`${prefix}.id`, 'a unique step id'));
  if (!PLAN_STEP_TYPES.includes(step.type)) {
    issues.push(issue(`${prefix}.type`, PLAN_STEP_TYPES.join(' | ')));
    return;
  }
  for (const field of Object.keys(step)) {
    if (RESERVED_FIELDS.has(field) || !STEP_FIELDS[step.type].has(field)) {
      issues.push(issue(`${prefix}.${field}`, `fields allowed for ${step.type}`, 'FIELD_UNSUPPORTED'));
    }
  }
  if (step.type === 'act') {
    if (typeof step.actionRef !== 'string' || !step.actionRef.trim()) issues.push(issue(`${prefix}.actionRef`, 'a non-empty ActionRef'));
    if (step.actionRef === 'visual:doubleTap') issues.push(issue(`${prefix}.actionRef`, 'an explicit sequence of tap/wait/tap steps'));
    if (step.input !== undefined && !isObject(step.input)) issues.push(issue(`${prefix}.input`, 'an object'));
    if (step.actionRef?.startsWith('visual:') && isObject(step.input)) {
      const gesture = step.actionRef.slice('visual:'.length);
      const allowed = gesture === 'swipe' ? new Set(['from', 'to'])
        : gesture === 'longPress' ? new Set(['point', 'pointRef', 'durationMs']) : new Set(['point', 'pointRef']);
      for (const field of Object.keys(step.input)) {
        if (!allowed.has(field)) issues.push(issue(`${prefix}.input.${field}`, `fields allowed for visual:${gesture}`, 'FIELD_UNSUPPORTED'));
      }
      if (step.input.point !== undefined && !pointValid(step.input.point)) issues.push(issue(`${prefix}.input.point`, 'a normalized point'));
      if (gesture === 'swipe') {
        if (!pointValid(step.input.from)) issues.push(issue(`${prefix}.input.from`, 'a normalized point'));
        if (!pointValid(step.input.to)) issues.push(issue(`${prefix}.input.to`, 'a normalized point'));
      }
    }
  }
  if (step.type === 'wait' && (!Number.isInteger(step.ms) || step.ms < 0)) issues.push(issue(`${prefix}.ms`, 'a non-negative integer'));
  if (step.type === 'capture') {
    if (!['SCREENSHOT_ONLY', 'FULL_SCENE'].includes(step.mode)) issues.push(issue(`${prefix}.mode`, 'SCREENSHOT_ONLY | FULL_SCENE'));
    if (step.promote !== undefined && typeof step.promote !== 'boolean') issues.push(issue(`${prefix}.promote`, 'a boolean'));
  }
  if (step.type === 'locate') {
    if (typeof step.sourceRef !== 'string' || !step.sourceRef.startsWith('$')) {
      issues.push(issue(`${prefix}.sourceRef`, 'a reference to a prior Scene output'));
    }
    if (!isObject(step.locator)) issues.push(issue(`${prefix}.locator`, 'a locator object'));
    else {
      const allowed = step.locator.kind === 'ELEMENT_REF' ? new Set(['kind', 'elementRef'])
        : step.locator.kind === 'POINT' ? new Set(['kind', 'point'])
          : step.locator.kind === 'REGION' ? new Set(['kind', 'region']) : new Set(['kind']);
      if (!PLAN_LOCATOR_KINDS.includes(step.locator.kind)) issues.push(issue(`${prefix}.locator.kind`, PLAN_LOCATOR_KINDS.join(' | ')));
      for (const field of Object.keys(step.locator)) {
        if (!allowed.has(field)) issues.push(issue(`${prefix}.locator.${field}`, `fields allowed for ${step.locator.kind || 'locator'}`, 'FIELD_UNSUPPORTED'));
      }
      if (step.locator.kind === 'POINT' && !pointValid(step.locator.point)) issues.push(issue(`${prefix}.locator.point`, 'a normalized point'));
      if (step.locator.kind === 'REGION' && (!Array.isArray(step.locator.region) || step.locator.region.length !== 4
        || !step.locator.region.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        || step.locator.region[0] >= step.locator.region[2] || step.locator.region[1] >= step.locator.region[3])) {
        issues.push(issue(`${prefix}.locator.region`, 'normalized [left, top, right, bottom] bounds'));
      }
      if (step.locator.kind === 'ELEMENT_REF' && typeof step.locator.elementRef !== 'string') {
        issues.push(issue(`${prefix}.locator.elementRef`, 'an element ref'));
      }
    }
  }
  if (step.type === 'check') {
    if (typeof step.sourceRef !== 'string' || !step.sourceRef.startsWith('$')) {
      issues.push(issue(`${prefix}.sourceRef`, 'a reference to a prior Scene output'));
    }
    if (!isObject(step.predicate)) issues.push(issue(`${prefix}.predicate`, 'a predicate object'));
    else {
      if (!PLAN_CHECK_KINDS.includes(step.predicate.kind)) issues.push(issue(`${prefix}.predicate.kind`, PLAN_CHECK_KINDS.join(' | ')));
      const allowed = ['ELEMENT_VISIBLE', 'ELEMENT_ENABLED'].includes(step.predicate.kind) ? new Set(['kind', 'elementRef'])
        : step.predicate.kind === 'REFERENCE_EXISTS' ? new Set(['kind', 'reference']) : new Set(['kind']);
      for (const field of Object.keys(step.predicate)) {
        if (!allowed.has(field)) issues.push(issue(`${prefix}.predicate.${field}`, `fields allowed for ${step.predicate.kind || 'predicate'}`, 'FIELD_UNSUPPORTED'));
      }
      if (['ELEMENT_VISIBLE', 'ELEMENT_ENABLED'].includes(step.predicate.kind)
        && (typeof step.predicate.elementRef !== 'string' || !step.predicate.elementRef)) {
        issues.push(issue(`${prefix}.predicate.elementRef`, 'a non-empty element ref'));
      }
      if (step.predicate.kind === 'REFERENCE_EXISTS'
        && (typeof step.predicate.reference !== 'string' || !step.predicate.reference)) {
        issues.push(issue(`${prefix}.predicate.reference`, 'a non-empty reference'));
      }
    }
  }
  for (const ref of references(step, prefix)) {
    const match = ref.value.match(REF_PATTERN);
    if (!match || !priorIds.has(match[1])) issues.push(issue(ref.fieldPath, 'a reference to a prior completed step output'));
  }
}

function validationIssues(request, context = {}) {
  const issues = [];
  if (!isObject(request)) return [issue('request', 'an object')];
  const allowed = new Set(['operation', 'submissionId', 'basedOnSceneId', 'purpose', 'maxDurationMs', 'onFailure', 'steps', 'flowContext', 'decision']);
  for (const field of Object.keys(request)) {
    if (RESERVED_FIELDS.has(field) || !allowed.has(field)) issues.push(issue(field, 'a declared runPlan field', 'FIELD_UNSUPPORTED'));
  }
  if (request.operation !== undefined && request.operation !== 'runPlan') issues.push(issue('operation', 'runPlan'));
  for (const field of ['submissionId', 'basedOnSceneId', 'purpose']) {
    if (typeof request[field] !== 'string' || !request[field].trim()) issues.push(issue(field, 'a non-empty string'));
  }
  const durationLimit = Number.isFinite(context.remainingMs) ? Math.min(context.remainingMs, MAX_PLAN_DURATION_MS) : MAX_PLAN_DURATION_MS;
  if (!Number.isInteger(request.maxDurationMs) || request.maxDurationMs <= 0 || request.maxDurationMs > durationLimit) {
    issues.push(issue('maxDurationMs', `an integer from 1 to ${durationLimit}`));
  }
  if (!['STOP', 'CONTINUE'].includes(request.onFailure)) issues.push(issue('onFailure', 'STOP | CONTINUE'));
  if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_PLAN_STEPS) {
    issues.push(issue('steps', `an array with 1 to ${MAX_PLAN_STEPS} steps`));
    return issues;
  }
  const priorIds = new Set();
  request.steps.forEach((step, index) => {
    validateStep(step, index, priorIds, issues);
    if (step?.id && priorIds.has(step.id)) issues.push(issue(`steps[${index}].id`, 'a unique step id'));
    if (step?.id) priorIds.add(step.id);
    if (request.onFailure === 'CONTINUE' && step?.type === 'act') issues.push(issue('onFailure', 'STOP when the plan contains device actions'));
  });
  return issues;
}

function validatePlanRequest(request, context = {}) {
  const issues = validationIssues(request, context);
  if (issues.length) throw contractError('PLAN_INVALID', `runPlan request has ${issues.length} contract issue${issues.length === 1 ? '' : 's'}`, { issues });
  return true;
}

function normalizePlanRequest(request) {
  const normalized = {
    operation: 'runPlan',
    submissionId: request.submissionId.trim(),
    basedOnSceneId: request.basedOnSceneId.trim(),
    purpose: request.purpose.trim(),
    maxDurationMs: Number(request.maxDurationMs),
    onFailure: request.onFailure,
    steps: request.steps.map((step) => ({
      ...step,
      ...(step.type === 'capture' ? { promote: step.promote ?? step.mode === 'FULL_SCENE' } : {}),
    })),
    ...(request.flowContext ? { flowContext: request.flowContext } : {}),
    ...(request.decision ? { decision: request.decision } : {}),
  };
  return normalized;
}

module.exports = {
  MAX_PLAN_DURATION_MS,
  MAX_PLAN_STEPS,
  PLAN_CHECK_KINDS,
  PLAN_LOCATOR_KINDS,
  PLAN_STATUSES,
  PLAN_STEP_TYPES,
  normalizePlanRequest,
  validatePlanRequest,
};
