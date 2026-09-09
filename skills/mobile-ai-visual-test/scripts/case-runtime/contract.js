'use strict';

const { contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const { TARGET_STATES } = require('../lib/app-provisioning');

const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const RESULT_FIELDS = new Set(['verdict', 'summary', 'checks', 'uncertainties']);
const CHECK_FIELDS = new Set(['expectationRef', 'status', 'actual', 'sceneRefs', 'knowledgeRefs', 'technicalRefs', 'evidenceBasis']);
const VERIFICATION_KINDS = new Set(['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE']);
const DECISION_FIELDS = new Set([
  'assessment', 'observation', 'conclusion', 'purpose', 'expectedOutcome',
  'expectationRefs', 'planUpdate', 'knowledgeReview', 'uncertainties',
]);
const REQUEST_FIELDS = Object.freeze({
  prepare: new Set(['operation', 'preparation', 'decision']),
  observe: new Set(['operation', 'purpose', 'decision']),
  act: new Set(['operation', 'basedOnSceneId', 'capabilityId', 'visual', 'input', 'observationPolicy', 'decision']),
  inspectVisual: new Set(['operation', 'basedOnSceneId', 'decision']),
  knowledge: new Set(['operation', 'basedOnSceneId', 'query', 'decision']),
  recover: new Set(['operation', 'basedOnSceneId', 'reason', 'decision']),
  finish: new Set(['operation', 'basedOnSceneId', 'result', 'decision']),
  status: new Set(['operation']),
});

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
    else {
      const expectation = ensureObject(item, `caseContext.expectations[${index}]`, 'CASE_NARRATIVE_INVALID');
      ensureString(expectation.text, `caseContext.expectations[${index}].text`, 'CASE_NARRATIVE_INVALID');
      if (expectation.verificationKind !== undefined && !VERIFICATION_KINDS.has(expectation.verificationKind)) {
        throw contractError('CASE_NARRATIVE_INVALID', `caseContext.expectations[${index}].verificationKind is invalid`);
      }
    }
  });
  validateStringArray(context.initialPlan, 'caseContext.initialPlan');
  validateStringArray(context.uncertainties, 'caseContext.uncertainties');
  if (context.revisionReason !== undefined) ensureString(context.revisionReason, 'caseContext.revisionReason', 'CASE_NARRATIVE_INVALID');
  return context;
}

function validateDecision(value) {
  const decision = ensureObject(value, 'decision', 'CASE_NARRATIVE_INVALID');
  const unsupported = Object.keys(decision).filter((field) => !DECISION_FIELDS.has(field));
  if (unsupported.length) throw contractError('CASE_NARRATIVE_INVALID', `decision contains unsupported fields: ${unsupported.join(', ')}`);
  for (const field of ['assessment', 'observation', 'conclusion', 'expectedOutcome']) {
    if (decision[field] !== undefined) ensureString(decision[field], `decision.${field}`, 'CASE_NARRATIVE_INVALID');
  }
  ensureString(decision.purpose, 'decision.purpose', 'CASE_NARRATIVE_INVALID');
  validateStringArray(decision.expectationRefs, 'decision.expectationRefs');
  if (decision.planUpdate !== undefined) {
    const update = ensureObject(decision.planUpdate, 'decision.planUpdate', 'CASE_NARRATIVE_INVALID');
    ensureString(update.reason, 'decision.planUpdate.reason', 'CASE_NARRATIVE_INVALID');
    const next = validateStringArray(update.next, 'decision.planUpdate.next');
    if (!next.length) throw contractError('CASE_NARRATIVE_INVALID', 'decision.planUpdate.next must contain at least one item', { fieldPath: 'decision.planUpdate.next' });
  }
  if (decision.knowledgeReview !== undefined) require('./knowledge-review').normalizeKnowledgeReview(decision.knowledgeReview);
  if (decision.uncertainties !== undefined) validateStringArray(decision.uncertainties, 'decision.uncertainties');
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
    if (check.evidenceBasis !== undefined) {
      const basis = ensureObject(check.evidenceBasis, `checks[${index}].evidenceBasis`, 'CASE_RESULT_INVALID');
      ensureOnlyFields(basis, new Set(['type', 'sceneRef', 'scrollContextRef']), `checks[${index}].evidenceBasis`);
      if (basis.type !== 'SEARCH_ABSENCE') {
        throw contractError('CASE_RESULT_INVALID', `checks[${index}].evidenceBasis.type must be SEARCH_ABSENCE`);
      }
      ensureString(basis.scrollContextRef, `checks[${index}].evidenceBasis.scrollContextRef`, 'CASE_RESULT_INVALID');
      ensureString(basis.sceneRef, `checks[${index}].evidenceBasis.sceneRef`, 'CASE_RESULT_INVALID');
      if (check.status === 'PASS') throw contractError('CASE_RESULT_INVALID', `checks[${index}] cannot use SEARCH_ABSENCE with PASS`);
    }
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
  if (!['prepare', 'observe', 'act', 'inspectVisual', 'knowledge', 'recover', 'finish', 'status'].includes(operation)) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'operation must be prepare, observe, act, inspectVisual, knowledge, recover, finish, or status');
  }
  const unsupportedRequestFields = Object.keys(value).filter((field) => !REQUEST_FIELDS[operation].has(field));
  if (unsupportedRequestFields.length) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', `${operation} request contains unsupported fields: ${unsupportedRequestFields.join(', ')}`);
  }
  if (value.decision !== undefined) validateDecision(value.decision);
  if (value.basedOnSceneId !== undefined) {
    ensureString(value.basedOnSceneId, 'basedOnSceneId', 'CASE_RUNTIME_REQUEST_INVALID');
  }
  if (operation === 'prepare') {
    if (value.basedOnSceneId !== undefined) throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'prepare cannot include basedOnSceneId');
    const preparation = ensureObject(value.preparation, 'preparation', 'CASE_RUNTIME_REQUEST_INVALID');
    const unsupported = Object.keys(preparation).filter((field) => field !== 'targetState');
    if (unsupported.length) throw contractError('CASE_RUNTIME_REQUEST_INVALID', `preparation contains unsupported fields: ${unsupported.join(', ')}`);
    ensureString(preparation.targetState, 'preparation.targetState', 'CASE_RUNTIME_REQUEST_INVALID');
    if (!TARGET_STATES.has(preparation.targetState)) throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'preparation.targetState is invalid');
  }
  if (operation === 'act') {
    if (!value.capabilityId && !value.visual) {
      throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'act requires exactly one of capabilityId or visual');
    }
    if (value.capabilityId && value.visual) {
      throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'act capabilityId and visual are mutually exclusive');
    }
    if (value.decision === undefined) throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'act requires decision.purpose and decision.expectationRefs');
    if (value.capabilityId !== undefined) ensureString(value.capabilityId, 'capabilityId', 'CASE_RUNTIME_REQUEST_INVALID');
    if (value.observationPolicy !== undefined) {
      const policy = ensureObject(value.observationPolicy, 'observationPolicy', 'CASE_RUNTIME_REQUEST_INVALID');
      const unsupported = Object.keys(policy).filter((field) => field !== 'duringActionAtMs');
      if (unsupported.length) throw contractError('CASE_RUNTIME_REQUEST_INVALID', `observationPolicy contains unsupported fields: ${unsupported.join(', ')}`);
      if (!Number.isInteger(Number(policy.duringActionAtMs)) || Number(policy.duringActionAtMs) < 20) {
        throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'observationPolicy.duringActionAtMs must be an integer greater than or equal to 20');
      }
    }
    if (value.visual?.gesture === 'longPress') validateLongPressTiming(value.visual.durationMs, value.observationPolicy);
  }
  if (operation === 'inspectVisual') {
    ensureString(value.basedOnSceneId, 'basedOnSceneId', 'CASE_RUNTIME_REQUEST_INVALID');
    if (value.decision === undefined) {
      throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'inspectVisual requires decision.purpose, decision.expectationRefs, and decision.observation');
    }
    ensureString(value.decision.observation, 'decision.observation', 'CASE_RUNTIME_REQUEST_INVALID');
  }
  if (operation === 'knowledge') ensureString(value.query, 'query', 'CASE_RUNTIME_REQUEST_INVALID');
  if (operation === 'recover') ensureString(value.reason, 'reason', 'CASE_RUNTIME_REQUEST_INVALID');
  if (operation === 'finish') validateCaseResult(value.result);
  return value;
}

function validateLongPressTiming(durationMs, observationPolicy) {
  if (!Number.isInteger(Number(durationMs)) || Number(durationMs) <= 0) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'longPress requires a positive integer durationMs');
  }
  if (observationPolicy?.duringActionAtMs !== undefined
    && Number(observationPolicy.duringActionAtMs) >= Number(durationMs)) {
    throw contractError('CASE_RUNTIME_REQUEST_INVALID', 'observationPolicy.duringActionAtMs must be less than longPress durationMs');
  }
}

module.exports = {
  CHECK_STATUSES,
  VERIFICATION_KINDS,
  VERDICTS,
  REQUEST_FIELDS,
  validateCaseContext,
  validateCaseResult,
  validateDecision,
  validateRuntimeRequest,
  validateLongPressTiming,
};
