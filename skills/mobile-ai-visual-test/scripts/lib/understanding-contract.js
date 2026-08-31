'use strict';

const {
  contractError,
  ensureArray,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
  ensureUniqueIds,
} = require('./contract-utils');
const { validateSourceReferences } = require('./source-reference');

const UNDERSTANDING_SCHEMA_VERSION = 1;
const BASIS_VALUES = new Set(['explicit', 'implied', 'assumed']);

function validateReferenceIds(values, knownIds, label) {
  ensureArray(values, label, 'UNDERSTANDING_INVALID');
  for (const id of values) {
    ensureId(id, `${label} item`, 'UNDERSTANDING_INVALID');
    if (!knownIds.has(id)) throw contractError('UNDERSTANDING_INVALID', `${label} references unknown sourceRef: ${id}`);
  }
}

function validateStatement(value, label, sourceRefIds) {
  ensureObject(value, label, 'UNDERSTANDING_INVALID');
  ensureId(value.id, `${label}.id`, 'UNDERSTANDING_INVALID');
  ensureString(value.text, `${label}.text`, 'UNDERSTANDING_INVALID');
  if (!BASIS_VALUES.has(value.basis)) throw contractError('UNDERSTANDING_INVALID', `${label}.basis is invalid`);
  validateReferenceIds(value.sourceRefs, sourceRefIds, `${label}.sourceRefs`);
  if (value.basis !== 'assumed' && value.sourceRefs.length === 0) {
    throw contractError('UNDERSTANDING_INVALID', `${label} with ${value.basis} basis requires a source reference`);
  }
}

function validateRequirement(value, label, sourceRefIds) {
  validateStatement(value, label, sourceRefIds);
  const interactions = ensureArray(value.requiredInteractions, `${label}.requiredInteractions`, 'UNDERSTANDING_INVALID');
  const outcomes = ensureArray(value.expectedOutcomes, `${label}.expectedOutcomes`, 'UNDERSTANDING_INVALID');
  interactions.forEach((item, index) => ensureString(item, `${label}.requiredInteractions[${index}]`, 'UNDERSTANDING_INVALID'));
  outcomes.forEach((item, index) => ensureString(item, `${label}.expectedOutcomes[${index}]`, 'UNDERSTANDING_INVALID'));
  if (interactions.length === 0 && outcomes.length === 0) {
    throw contractError('UNDERSTANDING_INVALID', `${label} requires at least one required interaction or expected outcome`);
  }
}

function requirementSemantics(value) {
  return {
    text: value.text,
    basis: value.basis,
    sourceRefs: value.sourceRefs,
    requiredInteractions: value.requiredInteractions,
    expectedOutcomes: value.expectedOutcomes,
  };
}

function validateUnderstanding(value, options = {}) {
  ensureObject(value, 'understanding', 'UNDERSTANDING_INVALID');
  if (value.schemaVersion !== UNDERSTANDING_SCHEMA_VERSION) throw contractError('UNDERSTANDING_SCHEMA_UNSUPPORTED', `schemaVersion must be ${UNDERSTANDING_SCHEMA_VERSION}`);
  ensureInteger(value.revision, 'revision', 'UNDERSTANDING_INVALID', 1);
  ensureString(value.summary, 'summary', 'UNDERSTANDING_INVALID');
  const previous = options.previous || null;
  if (!previous && value.revision !== 1) throw contractError('UNDERSTANDING_REVISION_INVALID', 'initial revision must be 1');
  if (previous && value.revision <= previous.revision) throw contractError('UNDERSTANDING_REVISION_STALE', 'revision must increase');
  if (previous) ensureString(value.reason, 'reason', 'UNDERSTANDING_INVALID');
  const sourceRefIds = validateSourceReferences(value.sourceRefs, options);
  const startConditions = ensureArray(value.startConditions, 'startConditions', 'UNDERSTANDING_INVALID');
  const requirements = ensureArray(value.requirements, 'requirements', 'UNDERSTANDING_INVALID');
  ensureUniqueIds(startConditions, 'startConditions', 'UNDERSTANDING_INVALID');
  ensureUniqueIds(requirements, 'requirements', 'UNDERSTANDING_INVALID');
  startConditions.forEach((item, index) => validateStatement(item, `startConditions[${index}]`, sourceRefIds));
  requirements.forEach((item, index) => validateRequirement(item, `requirements[${index}]`, sourceRefIds));
  const uncertainties = ensureArray(value.uncertainties, 'uncertainties', 'UNDERSTANDING_INVALID');
  uncertainties.forEach((item, index) => ensureString(item, `uncertainties[${index}]`, 'UNDERSTANDING_INVALID'));
  if (requirements.length === 0 && uncertainties.length === 0) {
    throw contractError('UNDERSTANDING_INVALID', 'an understanding without executable requirements must record uncertainty');
  }
  if (previous) {
    const previousRequirements = new Map(previous.requirements.map((item) => [item.id, item]));
    for (const requirement of requirements) {
      const prior = previousRequirements.get(requirement.id);
      if (prior && JSON.stringify(requirementSemantics(prior)) !== JSON.stringify(requirementSemantics(requirement))) {
        throw contractError('UNDERSTANDING_REQUIREMENT_ID_REUSED', `requirement id is already bound to different semantics: ${requirement.id}`, {
          fieldPath: `requirements.${requirement.id}`,
          expected: 'use a new requirement id when its semantics change',
          received: requirement.id,
        });
      }
    }
  }
  return value;
}

module.exports = {
  BASIS_VALUES,
  UNDERSTANDING_SCHEMA_VERSION,
  validateUnderstanding,
};
