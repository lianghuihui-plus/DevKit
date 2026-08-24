'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
  sha256,
} = require('./contract-utils');

const AUTHORIZATION_SCHEMA_VERSION = 1;
const AUTHORIZATION_SCOPES = new Set(['case-prepare', 'case-business']);

function authorizationSha(value) {
  const unsigned = { ...value };
  delete unsigned.authorizationSha;
  return sha256(canonicalJson(unsigned), 'plan-authorization', 24);
}

function validateStringRefs(value, label) {
  const refs = ensureArray(value, label, 'PLAN_AUTHORIZATION_INVALID');
  const unique = new Set();
  for (const ref of refs) {
    ensureId(ref, `${label} item`, 'PLAN_AUTHORIZATION_INVALID');
    if (unique.has(ref)) throw contractError('PLAN_AUTHORIZATION_INVALID', `${label} contains duplicate ref: ${ref}`);
    unique.add(ref);
  }
  return refs;
}

function validatePlanAuthorization(value, context = {}) {
  ensureObject(value, 'plan authorization', 'PLAN_AUTHORIZATION_INVALID');
  if (value.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION || value.source !== 'agent-plan') {
    throw contractError('PLAN_AUTHORIZATION_INVALID', 'authorization identity is invalid');
  }
  ensureId(value.executionId, 'executionId', 'PLAN_AUTHORIZATION_INVALID');
  if (!AUTHORIZATION_SCOPES.has(value.phase)) throw contractError('PLAN_AUTHORIZATION_INVALID', 'phase is invalid');
  ensureInteger(value.understandingRevision, 'understandingRevision', 'PLAN_AUTHORIZATION_INVALID', 1);
  ensureString(value.purpose, 'purpose', 'PLAN_AUTHORIZATION_INVALID');
  const requirementRefs = validateStringRefs(value.requirementRefs || [], 'requirementRefs');
  const sourceRefs = validateStringRefs(value.sourceRefs || [], 'sourceRefs');
  const { execution, understanding, plan } = context;
  if (execution) {
    if (value.executionId !== execution.executionId) throw contractError('PLAN_AUTHORIZATION_BINDING_MISMATCH', 'authorization belongs to another execution');
    const allowedPhases = value.phase === 'case-prepare'
      ? ['ESTABLISH_START', 'EXECUTE', 'INVESTIGATE']
      : ['EXECUTE', 'INVESTIGATE'];
    if (!allowedPhases.includes(execution.phase)) throw contractError('PLAN_AUTHORIZATION_PHASE_INVALID', `${value.phase} is invalid during ${execution.phase}`);
  }
  if (!understanding || value.understandingRevision !== understanding.revision) {
    throw contractError('PLAN_AUTHORIZATION_STALE', 'authorization must bind the current understanding revision');
  }
  const requirements = new Map(understanding.requirements.map((entry) => [entry.id, entry]));
  const sourceIds = new Set(understanding.sourceRefs.map((entry) => entry.id));
  if (!requirementRefs.every((ref) => requirements.has(ref)) || !sourceRefs.every((ref) => sourceIds.has(ref))) {
    throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', 'authorization contains unknown requirement or source refs');
  }
  if (value.phase === 'case-prepare') {
    if (value.startConditionId !== undefined) ensureId(value.startConditionId, 'startConditionId', 'PLAN_AUTHORIZATION_INVALID');
    if (value.checkpointId !== undefined || value.planRevision !== undefined) throw contractError('PLAN_AUTHORIZATION_INVALID', 'case-prepare cannot bind a checkpoint');
    if (value.startConditionId !== undefined && !understanding.startConditions.some((entry) => entry.id === value.startConditionId)) {
      throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', 'startConditionId is unknown');
    }
  } else {
    if (value.checkpointId !== undefined) ensureId(value.checkpointId, 'checkpointId', 'PLAN_AUTHORIZATION_INVALID');
    if (value.planRevision !== undefined) ensureInteger(value.planRevision, 'planRevision', 'PLAN_AUTHORIZATION_INVALID', 1);
    if (value.startConditionId !== undefined) throw contractError('PLAN_AUTHORIZATION_INVALID', 'case-business cannot bind a start condition');
    if (value.planRevision !== undefined && (!plan || value.planRevision !== plan.revision)) {
      throw contractError('PLAN_AUTHORIZATION_STALE', 'authorization must bind the current plan revision');
    }
    const checkpoint = value.checkpointId === undefined ? null : plan?.checkpoints.find((entry) => entry.id === value.checkpointId);
    if (value.checkpointId !== undefined && !checkpoint) throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', 'checkpointId is unknown');
    if (checkpoint && !requirementRefs.every((ref) => checkpoint.requirementRefs.includes(ref))) {
      throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', 'business requirementRefs must belong to the checkpoint');
    }
  }
  if (value.authorizationSha !== authorizationSha(value)) throw contractError('PLAN_AUTHORIZATION_INVALID', 'authorizationSha does not match content');
  return value;
}

function withAuthorizationSha(value) {
  const authorization = { ...value };
  authorization.authorizationSha = authorizationSha(authorization);
  return authorization;
}

module.exports = {
  AUTHORIZATION_SCHEMA_VERSION,
  AUTHORIZATION_SCOPES,
  authorizationSha,
  validatePlanAuthorization,
  withAuthorizationSha,
};
