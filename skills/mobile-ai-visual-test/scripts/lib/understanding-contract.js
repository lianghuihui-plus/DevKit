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
const DISPOSITIONS = new Set(['REPLACED', 'AMBIGUOUS', 'NOT_APPLICABLE']);

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

function validateDispositions(value, previous, requirementIds) {
  const dispositions = ensureArray(value.requirementDispositions || [], 'requirementDispositions', 'UNDERSTANDING_INVALID');
  dispositions.forEach((item, index) => ensureObject(item, `requirementDispositions[${index}]`, 'UNDERSTANDING_INVALID'));
  const dispositionIds = ensureUniqueIds(dispositions.map((item) => ({ id: item.requirementId })), 'requirementDispositions', 'UNDERSTANDING_INVALID');
  for (const [index, item] of dispositions.entries()) {
    const label = `requirementDispositions[${index}]`;
    if (!DISPOSITIONS.has(item.disposition)) throw contractError('UNDERSTANDING_INVALID', `${label}.disposition is invalid`);
    ensureString(item.reason, `${label}.reason`, 'UNDERSTANDING_INVALID');
    const replacements = ensureArray(item.replacementRefs || [], `${label}.replacementRefs`, 'UNDERSTANDING_INVALID');
    for (const id of replacements) {
      if (!requirementIds.has(id)) throw contractError('UNDERSTANDING_INVALID', `${label} references unknown replacement: ${id}`);
    }
    if (item.disposition === 'REPLACED' && replacements.length === 0) {
      throw contractError('UNDERSTANDING_INVALID', `${label} requires replacementRefs`);
    }
  }
  if (!previous) {
    if (dispositions.length) throw contractError('UNDERSTANDING_INVALID', 'initial understanding cannot dispose previous requirements');
    return;
  }
  for (const requirement of previous.requirements || []) {
    if (!requirementIds.has(requirement.id) && !dispositionIds.has(requirement.id)) {
      throw contractError('UNDERSTANDING_REQUIREMENT_DROPPED', `removed requirement requires a disposition: ${requirement.id}`);
    }
  }
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
  const requirementIds = ensureUniqueIds(requirements, 'requirements', 'UNDERSTANDING_INVALID');
  startConditions.forEach((item, index) => validateStatement(item, `startConditions[${index}]`, sourceRefIds));
  requirements.forEach((item, index) => validateStatement(item, `requirements[${index}]`, sourceRefIds));
  ensureArray(value.uncertainties, 'uncertainties', 'UNDERSTANDING_INVALID');
  value.uncertainties.forEach((item, index) => ensureString(item, `uncertainties[${index}]`, 'UNDERSTANDING_INVALID'));
  validateDispositions(value, previous, requirementIds);
  return value;
}

module.exports = {
  BASIS_VALUES,
  DISPOSITIONS,
  UNDERSTANDING_SCHEMA_VERSION,
  validateUnderstanding,
};
