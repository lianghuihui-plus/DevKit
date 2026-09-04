'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
} = require('./contract-utils');

function nullableId(value, label, code) {
  if (value === null) return;
  ensureId(value, label, code);
}

function validateKnowledgeContext(value, label = 'knowledgeContext', code = 'KNOWLEDGE_CONTEXT_INVALID') {
  ensureObject(value, label, code);
  if (value.schemaVersion !== 1) throw contractError(code, `${label}.schemaVersion must be 1`);
  ensureInteger(value.understandingRevision, `${label}.understandingRevision`, code, 1);
  ensureInteger(value.warmSessionGeneration, `${label}.warmSessionGeneration`, code, 1);
  if (!Number.isInteger(value.stateBoundaryIndex) || value.stateBoundaryIndex < -1) {
    throw contractError(code, `${label}.stateBoundaryIndex must be an integer greater than or equal to -1`);
  }
  if (value.observationRef !== null) ensureString(value.observationRef, `${label}.observationRef`, code);
  nullableId(value.checkpointRef, `${label}.checkpointRef`, code);
  const requirementRefs = ensureArray(value.requirementRefs, `${label}.requirementRefs`, code);
  requirementRefs.forEach((ref, index) => ensureId(ref, `${label}.requirementRefs[${index}]`, code));
  if (new Set(requirementRefs).size !== requirementRefs.length) {
    throw contractError(code, `${label}.requirementRefs must be unique`);
  }
  return value;
}

function buildKnowledgeContext(options) {
  return validateKnowledgeContext({
    schemaVersion: 1,
    understandingRevision: options.understanding.revision,
    warmSessionGeneration: options.execution.warmSessionGeneration,
    stateBoundaryIndex: options.stateBoundaryIndex,
    observationRef: options.observation?.ref || null,
    checkpointRef: options.checkpoint?.id || null,
    requirementRefs: [...(options.checkpoint?.requirementRefs || [])],
  });
}

function selectKnowledgeCheckpoint(plan, events, warmSessionGeneration) {
  const checkpoints = plan?.checkpoints || [];
  const ids = new Set(checkpoints.map((entry) => entry.id));
  const checkpointRef = [...events].reverse().find((event) => ids.has(event.authorization?.checkpointId)
    && (warmSessionGeneration === undefined || event.warmSessionGeneration === warmSessionGeneration))
    ?.authorization?.checkpointId || checkpoints[0]?.id || null;
  return checkpointRef ? checkpoints.find((entry) => entry.id === checkpointRef) || null : null;
}

function buildCurrentKnowledgeContext(options) {
  return buildKnowledgeContext({
    ...options,
    checkpoint: selectKnowledgeCheckpoint(
      options.plan,
      options.events,
      options.execution.warmSessionGeneration,
    ),
  });
}

function sameKnowledgeContext(left, right) {
  return canonicalJson(validateKnowledgeContext(left)) === canonicalJson(validateKnowledgeContext(right));
}

function sameKnowledgeDecisionContext(left, right) {
  const decisionFields = (value) => {
    const context = validateKnowledgeContext(value);
    return {
      understandingRevision: context.understandingRevision,
      warmSessionGeneration: context.warmSessionGeneration,
      stateBoundaryIndex: context.stateBoundaryIndex,
    };
  };
  return canonicalJson(decisionFields(left)) === canonicalJson(decisionFields(right));
}

function assertCurrentKnowledgeContext(frozen, current, options = {}) {
  validateKnowledgeContext(frozen);
  validateKnowledgeContext(current, 'currentKnowledgeContext');
  if (!sameKnowledgeDecisionContext(frozen, current)) {
    throw contractError('KNOWLEDGE_CONTEXT_STALE', 'knowledge investigation does not match the current understanding and scene', {
      fieldPath: options.fieldPath || 'knowledgeContext',
      expected: current,
      received: frozen,
    });
  }
  return frozen;
}

module.exports = {
  assertCurrentKnowledgeContext,
  buildCurrentKnowledgeContext,
  buildKnowledgeContext,
  sameKnowledgeDecisionContext,
  sameKnowledgeContext,
  selectKnowledgeCheckpoint,
  validateKnowledgeContext,
};
