'use strict';

const { contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');

const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const RESULT_FIELDS = new Set(['verdict', 'summary', 'checks', 'uncertainties']);
const CHECK_FIELDS = new Set(['expectationRef', 'status', 'actual', 'sceneRefs', 'knowledgeRefs', 'technicalRefs']);

function validateStringArray(value, label) {
  return ensureArray(value, label, 'CASE_NARRATIVE_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_NARRATIVE_INVALID'));
}

function validateCaseContext(value) {
  const context = ensureObject(value, 'caseContext', 'CASE_NARRATIVE_INVALID');
  ensureString(context.summary, 'caseContext.summary', 'CASE_NARRATIVE_INVALID');
  validateStringArray(context.preconditions, 'caseContext.preconditions');
  const expectations = ensureArray(context.expectations, 'caseContext.expectations', 'CASE_NARRATIVE_INVALID');
  if (!expectations.length) throw contractError('CASE_NARRATIVE_INVALID', 'caseContext.expectations must contain at least one item', { fieldPath: 'caseContext.expectations' });
  expectations.forEach((item, index) => {
    if (typeof item === 'string') ensureString(item, `caseContext.expectations[${index}]`, 'CASE_NARRATIVE_INVALID');
    else ensureString(ensureObject(item, `caseContext.expectations[${index}]`, 'CASE_NARRATIVE_INVALID').text,
      `caseContext.expectations[${index}].text`, 'CASE_NARRATIVE_INVALID');
  });
  validateStringArray(context.initialPlan, 'caseContext.initialPlan');
  validateStringArray(context.uncertainties, 'caseContext.uncertainties');
  if (context.revisionReason !== undefined) ensureString(context.revisionReason, 'caseContext.revisionReason', 'CASE_NARRATIVE_INVALID');
  return context;
}

function validateDecision(value) {
  const decision = ensureObject(value, 'decision', 'CASE_NARRATIVE_INVALID');
  for (const field of ['observation', 'conclusion', 'purpose', 'expectedOutcome']) {
    ensureString(decision[field], `decision.${field}`, 'CASE_NARRATIVE_INVALID');
  }
  validateStringArray(decision.expectationRefs, 'decision.expectationRefs');
  if (decision.planUpdate !== undefined) {
    const update = ensureObject(decision.planUpdate, 'decision.planUpdate', 'CASE_NARRATIVE_INVALID');
    ensureString(update.reason, 'decision.planUpdate.reason', 'CASE_NARRATIVE_INVALID');
    const next = validateStringArray(update.next, 'decision.planUpdate.next');
    if (!next.length) throw contractError('CASE_NARRATIVE_INVALID', 'decision.planUpdate.next must contain at least one item', { fieldPath: 'decision.planUpdate.next' });
  }
  if (decision.knowledgeReview !== undefined) require('./knowledge-review').normalizeKnowledgeReview(decision.knowledgeReview);
  return decision;
}

function ensureOnlyFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length) {
    throw contractError('CASE_RESULT_INVALID', `${label} contains unsupported fields: ${unsupported.join(', ')}`);
  }
}

function validateCaseResult(value) {
  ensureObject(value, 'CaseResult', 'CASE_RESULT_INVALID');
  ensureOnlyFields(value, RESULT_FIELDS, 'CaseResult');
  if (!VERDICTS.includes(value.verdict)) throw contractError('CASE_RESULT_INVALID', `verdict must be one of ${VERDICTS.join(', ')}`);
  ensureString(value.summary, 'summary', 'CASE_RESULT_INVALID');
  ensureArray(value.checks, 'checks', 'CASE_RESULT_INVALID').forEach((check, index) => {
    ensureObject(check, `checks[${index}]`, 'CASE_RESULT_INVALID');
    ensureOnlyFields(check, CHECK_FIELDS, `checks[${index}]`);
    ensureString(check.expectationRef, `checks[${index}].expectationRef`, 'CASE_RESULT_INVALID');
    if (!CHECK_STATUSES.includes(check.status)) {
      throw contractError('CASE_RESULT_INVALID', `checks[${index}].status must be one of ${CHECK_STATUSES.join(', ')}`);
    }
    ensureString(check.actual, `checks[${index}].actual`, 'CASE_RESULT_INVALID');
    if (check.sceneRefs !== undefined) {
      ensureArray(check.sceneRefs, `checks[${index}].sceneRefs`, 'CASE_RESULT_INVALID')
        .forEach((ref, refIndex) => ensureString(ref, `checks[${index}].sceneRefs[${refIndex}]`, 'CASE_RESULT_INVALID'));
    }
    if (check.knowledgeRefs !== undefined) {
      ensureArray(check.knowledgeRefs, `checks[${index}].knowledgeRefs`, 'CASE_RESULT_INVALID')
        .forEach((ref, refIndex) => ensureString(ref, `checks[${index}].knowledgeRefs[${refIndex}]`, 'CASE_RESULT_INVALID'));
      if (new Set(check.knowledgeRefs).size !== check.knowledgeRefs.length) {
        throw contractError('CASE_RESULT_INVALID', `checks[${index}].knowledgeRefs must not contain duplicates`);
      }
    }
    if (check.technicalRefs !== undefined) {
      ensureArray(check.technicalRefs, `checks[${index}].technicalRefs`, 'CASE_RESULT_INVALID')
        .forEach((ref, refIndex) => ensureString(ref, `checks[${index}].technicalRefs[${refIndex}]`, 'CASE_RESULT_INVALID'));
      if (new Set(check.technicalRefs).size !== check.technicalRefs.length) {
        throw contractError('CASE_RESULT_INVALID', `checks[${index}].technicalRefs must not contain duplicates`);
      }
    }
  });
  if (value.uncertainties !== undefined) {
    ensureArray(value.uncertainties, 'uncertainties', 'CASE_RESULT_INVALID')
      .forEach((item, index) => ensureString(item, `uncertainties[${index}]`, 'CASE_RESULT_INVALID'));
  }
  return value;
}

function validateRuntimeRequest(value) {
  ensureObject(value, 'RuntimeRequest', 'CASE_RUNTIME_REQUEST_INVALID');
  const operation = String(value.operation || '').trim();
  if (!['observe', 'act', 'knowledge', 'recover', 'finish', 'status'].includes(operation)) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'operation must be observe, act, knowledge, recover, finish, or status');
  }
  if (operation === 'act') {
    if (!value.capabilityId && !value.visual) {
      throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'act requires capabilityId or visual');
    }
    if (value.capabilityId !== undefined) ensureString(value.capabilityId, 'capabilityId', 'CASE_RUNTIME_REQUEST_INVALID');
    if (value.intent !== undefined) ensureString(value.intent, 'intent', 'CASE_RUNTIME_REQUEST_INVALID');
  }
  if (operation === 'knowledge') ensureString(value.query, 'query', 'CASE_RUNTIME_REQUEST_INVALID');
  if (operation === 'recover') ensureString(value.reason, 'reason', 'CASE_RUNTIME_REQUEST_INVALID');
  if (operation === 'finish') validateCaseResult(value.result);
  return value;
}

module.exports = {
  CHECK_STATUSES,
  VERDICTS,
  validateCaseContext,
  validateCaseResult,
  validateDecision,
  validateRuntimeRequest,
};
