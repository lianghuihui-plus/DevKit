'use strict';

const {
  canonicalJson,
  contractError,
  ensureInteger,
  ensureObject,
  ensureString,
} = require('./contract-utils');
const { validateBinding } = require('./batch-contract');

const WARM_SESSION_SCHEMA_VERSION = 1;
const WARM_SESSION_STATUSES = new Set(['INITIALIZING', 'READY', 'DEGRADED', 'CLOSED']);
const ALLOWED_FIELDS = new Set([
  'schemaVersion', 'status', 'generation', 'binding', 'appStartCount', 'recoveryCount', 'updatedAt',
  'failureCode', 'reason', 'degradedAt',
]);
const FORBIDDEN_FIELDS = new Set([
  'plan', 'timeline', 'verdict', 'result', 'evidence', 'understanding', 'requirements',
  'checkpoints', 'sourceText', 'summary', 'reasoning', 'agentSession',
]);
const TRANSITIONS = Object.freeze({
  INITIALIZING: new Set(['READY', 'DEGRADED', 'CLOSED']),
  READY: new Set(['READY', 'DEGRADED', 'CLOSED']),
  DEGRADED: new Set(['READY', 'DEGRADED', 'CLOSED']),
  CLOSED: new Set(),
});

function bindingEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateWarmSession(value, options = {}) {
  ensureObject(value, 'warmSession', 'WARM_SESSION_INVALID');
  if (value.schemaVersion !== WARM_SESSION_SCHEMA_VERSION) {
    throw contractError('WARM_SESSION_SCHEMA_UNSUPPORTED', `schemaVersion must be ${WARM_SESSION_SCHEMA_VERSION}`);
  }
  if (!WARM_SESSION_STATUSES.has(value.status)) throw contractError('WARM_SESSION_INVALID', 'status is invalid');
  validateBinding(value.binding);
  ensureInteger(value.generation, 'generation', 'WARM_SESSION_INVALID', 0);
  ensureInteger(value.appStartCount, 'appStartCount', 'WARM_SESSION_INVALID', 0);
  ensureInteger(value.recoveryCount, 'recoveryCount', 'WARM_SESSION_INVALID', 0);
  ensureString(value.updatedAt, 'updatedAt', 'WARM_SESSION_INVALID');
  if (value.failureCode !== undefined) ensureString(value.failureCode, 'failureCode', 'WARM_SESSION_INVALID');
  if (value.reason !== undefined) ensureString(value.reason, 'reason', 'WARM_SESSION_INVALID');
  if (value.degradedAt !== undefined) ensureString(value.degradedAt, 'degradedAt', 'WARM_SESSION_INVALID');
  for (const field of Object.keys(value)) {
    if (FORBIDDEN_FIELDS.has(field) || !ALLOWED_FIELDS.has(field)) {
      throw contractError('WARM_SESSION_BUSINESS_CONTEXT_FORBIDDEN', `${field} does not belong in warmSession`);
    }
  }
  if (value.status === 'INITIALIZING' && (value.generation !== 0 || value.appStartCount !== 0 || value.recoveryCount !== 0)) {
    throw contractError('WARM_SESSION_INVALID', 'INITIALIZING counters must be zero');
  }
  if (value.status === 'READY' && (value.generation < 1 || value.appStartCount < 1)) {
    throw contractError('WARM_SESSION_INVALID', 'READY requires a successful App start generation');
  }
  if (value.status === 'DEGRADED' && value.appStartCount < 1) {
    throw contractError('WARM_SESSION_INVALID', 'DEGRADED requires an App start attempt');
  }
  const previous = options.previous;
  if (previous) {
    validateWarmSession(previous);
    if (!TRANSITIONS[previous.status].has(value.status)) throw contractError('WARM_SESSION_TRANSITION_INVALID', `${previous.status} cannot transition to ${value.status}`);
    if (!bindingEqual(previous.binding, value.binding)) throw contractError('WARM_SESSION_BINDING_CHANGED', 'warm session binding is immutable');
    for (const field of ['generation', 'appStartCount', 'recoveryCount']) {
      if (value[field] < previous[field]) throw contractError('WARM_SESSION_COUNTER_REGRESSION', `${field} cannot decrease`);
    }
  }
  return value;
}

function createWarmSession(binding, now = new Date().toISOString()) {
  return validateWarmSession({
    schemaVersion: WARM_SESSION_SCHEMA_VERSION,
    status: 'INITIALIZING',
    generation: 0,
    binding: { ...binding },
    appStartCount: 0,
    recoveryCount: 0,
    updatedAt: now,
  });
}

function markBootstrapReady(previous, now = new Date().toISOString()) {
  return validateWarmSession({
    ...previous,
    status: 'READY',
    generation: 1,
    appStartCount: 1,
    updatedAt: now,
  }, { previous });
}

function markBootstrapFailed(previous, now = new Date().toISOString()) {
  return validateWarmSession({
    ...previous,
    status: 'DEGRADED',
    generation: 0,
    appStartCount: 1,
    updatedAt: now,
  }, { previous });
}

function markDegraded(previous, now = new Date().toISOString(), failure = {}) {
  return validateWarmSession({
    ...previous,
    status: 'DEGRADED',
    updatedAt: now,
    degradedAt: now,
    ...(failure.failureCode ? { failureCode: failure.failureCode } : {}),
    ...(failure.reason ? { reason: failure.reason } : {}),
  }, { previous });
}

function markRecovered(previous, now = new Date().toISOString()) {
  const { failureCode, reason, degradedAt, ...stable } = previous;
  return validateWarmSession({
    ...stable,
    status: 'READY',
    generation: previous.generation + 1,
    appStartCount: previous.appStartCount + 1,
    recoveryCount: previous.recoveryCount + 1,
    updatedAt: now,
  }, { previous });
}

function markClosed(previous, now = new Date().toISOString()) {
  return validateWarmSession({ ...previous, status: 'CLOSED', updatedAt: now }, { previous });
}

module.exports = {
  ALLOWED_FIELDS,
  FORBIDDEN_FIELDS,
  WARM_SESSION_SCHEMA_VERSION,
  WARM_SESSION_STATUSES,
  createWarmSession,
  markBootstrapFailed,
  markBootstrapReady,
  markClosed,
  markDegraded,
  markRecovered,
  validateWarmSession,
};
