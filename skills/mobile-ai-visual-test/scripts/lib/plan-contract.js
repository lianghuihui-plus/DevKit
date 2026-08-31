'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
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
  if (requirementIds.size === 0 && checkpoints.length > 0) {
    throw contractError('PLAN_INVALID', 'an understanding without requirements must use an empty plan');
  }
  if (requirementIds.size > 0 && checkpoints.length === 0) {
    throw contractError('PLAN_INVALID', 'checkpoints must contain at least one checkpoint');
  }
  ensureUniqueIds(checkpoints, 'checkpoints', 'PLAN_INVALID');
  const requirementOwners = new Map();
  for (const [index, checkpoint] of checkpoints.entries()) {
    const label = `checkpoints[${index}]`;
    ensureObject(checkpoint, label, 'PLAN_INVALID');
    ensureString(checkpoint.objective, `${label}.objective`, 'PLAN_INVALID');
    if (checkpoint.status !== undefined) throw contractError('PLAN_INVALID', `${label}.status is generated from execution facts and must not be submitted`);
    const refs = ensureArray(checkpoint.requirementRefs, `${label}.requirementRefs`, 'PLAN_INVALID');
    if (refs.length === 0) throw contractError('PLAN_INVALID', `${label}.requirementRefs must not be empty`);
    const seenRefs = new Set();
    for (const ref of refs) {
      ensureId(ref, `${label}.requirementRefs item`, 'PLAN_INVALID');
      if (seenRefs.has(ref)) throw contractError('PLAN_INVALID', `${label} contains duplicate requirementRef: ${ref}`);
      if (!requirementIds.has(ref)) throw contractError('PLAN_INVALID', `${label} references unknown requirement: ${ref}`);
      if (requirementOwners.has(ref)) {
        throw contractError('PLAN_INVALID', `requirement must belong to exactly one checkpoint: ${ref}`, {
          fieldPath: `${label}.requirementRefs`,
          expected: 'each frozen requirement referenced by exactly one checkpoint',
          received: [requirementOwners.get(ref), checkpoint.id],
        });
      }
      seenRefs.add(ref);
      requirementOwners.set(ref, checkpoint.id);
    }
    const previousCheckpoint = previous?.checkpoints?.find((entry) => entry.id === checkpoint.id);
    if (previousCheckpoint && canonicalJson({
      objective: checkpoint.objective,
      requirementRefs: checkpoint.requirementRefs,
    }) !== canonicalJson({
      objective: previousCheckpoint.objective,
      requirementRefs: previousCheckpoint.requirementRefs,
    })) {
      throw contractError('PLAN_CHECKPOINT_ID_REUSED', `${label}.id is already bound to different checkpoint semantics`, {
        fieldPath: `${label}.id`, expected: 'new id for changed objective or requirementRefs', received: checkpoint.id,
      });
    }
  }
  const missing = [...requirementIds].filter((id) => !requirementOwners.has(id));
  if (missing.length) {
    throw contractError('PLAN_INVALID', `every requirement must be covered by the plan: ${missing.join(', ')}`, {
      fieldPath: 'checkpoints.requirementRefs', missing,
    });
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
