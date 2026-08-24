'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureBoolean,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
  ensureUniqueIds,
  sha256,
} = require('./contract-utils');

const PLAN_SCHEMA_VERSION = 1;
function planSha(value) {
  const unsigned = { ...value };
  delete unsigned.planSha;
  return sha256(canonicalJson(unsigned), 'plan', 24);
}

function validatePlan(value, options = {}) {
  ensureObject(value, 'plan', 'PLAN_INVALID');
  if (value.schemaVersion !== PLAN_SCHEMA_VERSION) throw contractError('PLAN_SCHEMA_UNSUPPORTED', `schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  ensureInteger(value.revision, 'revision', 'PLAN_INVALID', 1);
  ensureString(value.reason, 'reason', 'PLAN_INVALID');
  const previous = options.previous || null;
  if (!previous && value.revision !== 1) throw contractError('PLAN_REVISION_INVALID', 'initial revision must be 1');
  if (previous && value.revision <= previous.revision) throw contractError('PLAN_REVISION_STALE', 'revision must increase');
  const requirementIds = new Set((options.understanding?.requirements || []).map((item) => item.id));
  const checkpoints = ensureArray(value.checkpoints, 'checkpoints', 'PLAN_INVALID');
  if (checkpoints.length === 0) throw contractError('PLAN_INVALID', 'checkpoints must contain at least one checkpoint');
  ensureUniqueIds(checkpoints, 'checkpoints', 'PLAN_INVALID');
  for (const [index, checkpoint] of checkpoints.entries()) {
    const label = `checkpoints[${index}]`;
    ensureObject(checkpoint, label, 'PLAN_INVALID');
    ensureString(checkpoint.goal, `${label}.goal`, 'PLAN_INVALID');
    ensureBoolean(checkpoint.requiredAction, `${label}.requiredAction`, 'PLAN_INVALID');
    if (checkpoint.status !== undefined) throw contractError('PLAN_INVALID', `${label}.status is generated from execution facts and must not be submitted`);
    const refs = ensureArray(checkpoint.requirementRefs, `${label}.requirementRefs`, 'PLAN_INVALID');
    const seenRefs = new Set();
    for (const ref of refs) {
      ensureId(ref, `${label}.requirementRefs item`, 'PLAN_INVALID');
      if (seenRefs.has(ref)) throw contractError('PLAN_INVALID', `${label} contains duplicate requirementRef: ${ref}`);
      if (!requirementIds.has(ref)) throw contractError('PLAN_INVALID', `${label} references unknown requirement: ${ref}`);
      seenRefs.add(ref);
    }
  }
  const expectedSha = planSha(value);
  if (value.planSha !== undefined && value.planSha !== expectedSha) throw contractError('PLAN_INVALID', 'planSha does not match plan content');
  return value;
}

function withPlanSha(value) {
  const result = { ...value };
  result.planSha = planSha(result);
  return result;
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  planSha,
  validatePlan,
  withPlanSha,
};
