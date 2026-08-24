'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureObject,
  ensureString,
  ensureUniqueIds,
  sha256,
} = require('../../lib/contract-utils');

const RESULT_SCHEMA_VERSION = 2;
const METRICS_SCHEMA_VERSION = 2;
const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const EXECUTION_STATUSES = new Set(['COMPLETED', 'STOPPED_BY_BUDGET', 'TECHNICALLY_BLOCKED', 'INTERRUPTED']);
const VERDICT_BASES = new Set(['DIRECT_EVIDENCE', 'KNOWLEDGE_SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'TECHNICAL_CONSTRAINT']);
const FINDING_STATUSES = new Set(['SATISFIED', 'NOT_SATISFIED', 'UNRESOLVED', 'BLOCKED']);

function resultSha(value) {
  const unsigned = { ...value };
  delete unsigned.resultSha;
  return sha256(canonicalJson(unsigned), 'result', 24);
}

function refIndex(values = []) {
  return new Map(values.map((item) => [item.ref || item.id, item]));
}

function sameStringSet(values, expected) {
  return Array.isArray(values) && values.length === expected.size && values.every((value) => expected.has(value));
}

function hasBoundVerdictReview(reviews, queries, evidence, understanding, plan, executionId, verdict) {
  const sourceRefs = new Set(understanding.sourceRefs?.map((item) => item.id) || []);
  const requirementRefs = new Set(understanding.requirements?.map((item) => item.id) || []);
  return reviews.some((review) => review.executionId === executionId
    && review.requestedVerdict === verdict
    && review.understandingRevision === understanding.revision
    && review.planRevision === plan?.revision
    && review.planSha === plan?.planSha
    && sameStringSet(review.requirementRefs, requirementRefs)
    && Array.isArray(review.queryRefs)
    && (verdict === 'PASS' || review.queryRefs.length > 0)
    && review.queryRefs.every((ref) => queries.get(ref)?.executionId === executionId)
    && Array.isArray(review.sourceRecheck?.sourceRefs) && review.sourceRecheck.sourceRefs.length > 0
    && typeof review.sourceRecheck?.conclusion === 'string' && review.sourceRecheck.conclusion.trim()
    && Array.isArray(review.currentObservationRefs) && (review.currentObservationRefs.length > 0 || review.observationUnavailable === true)
    && review.currentObservationRefs.every((ref) => evidence.get(ref)?.executionId === executionId && evidence.get(ref)?.usable === true)
    && review.sourceRecheck.sourceRefs.every((ref) => sourceRefs.has(ref))
    && typeof review.recoveryAttempt?.performed === 'boolean'
    && typeof review.recoveryAttempt?.explanation === 'string' && review.recoveryAttempt.explanation.trim()
    && Array.isArray(review.recoveryAttempt?.evidenceRefs)
    && review.recoveryAttempt.evidenceRefs.every((ref) => evidence.get(ref)?.executionId === executionId && evidence.get(ref)?.usable === true)
    && Array.isArray(review.remainingUncertainties));
}

function validateFinding(finding, index, context) {
  const label = `requirementFindings[${index}]`;
  ensureObject(finding, label, 'RESULT_INVALID');
  ensureString(finding.requirementId, `${label}.requirementId`, 'RESULT_INVALID');
  const requirement = context.requirements.get(finding.requirementId);
  if (!requirement) throw contractError('RESULT_REFERENCE_INVALID', `${label} references unknown requirement`);
  if (!FINDING_STATUSES.has(finding.status)) throw contractError('RESULT_INVALID', `${label}.status is invalid`);
  const evidenceRefs = ensureArray(finding.evidenceRefs, `${label}.evidenceRefs`, 'RESULT_INVALID');
  const knowledgeRefs = ensureArray(finding.knowledgeRefs, `${label}.knowledgeRefs`, 'RESULT_INVALID');
  const incidentRefs = ensureArray(finding.incidentRefs || [], `${label}.incidentRefs`, 'RESULT_INVALID');
  for (const ref of evidenceRefs) {
    ensureString(ref, `${label}.evidenceRefs item`, 'RESULT_INVALID');
    const evidence = context.evidence.get(ref);
    if (!evidence || evidence.executionId !== context.executionId || evidence.usable !== true) {
      throw contractError('RESULT_EVIDENCE_INVALID', `${label} evidence is not usable evidence from the current execution: ${ref}`, {
        fieldPath: `${label}.evidenceRefs`, expected: 'usable observation from the current execution', received: ref,
      });
    }
  }
  for (const ref of knowledgeRefs) {
    ensureString(ref, `${label}.knowledgeRefs item`, 'RESULT_INVALID');
    const assessment = context.knowledge.get(ref);
    if (!assessment || assessment.executionId !== context.executionId || assessment.assessment !== 'APPLICABLE') {
      throw contractError('RESULT_KNOWLEDGE_INVALID', `${label} knowledge is not an applicable assessment from the current execution: ${ref}`);
    }
  }
  for (const ref of incidentRefs) {
    ensureString(ref, `${label}.incidentRefs item`, 'RESULT_INVALID');
    const incident = context.incidents.get(ref);
    if (!incident || incident.executionId !== context.executionId) throw contractError('RESULT_INCIDENT_INVALID', `${label} incident does not belong to the current execution: ${ref}`);
    if (context.verdict === 'FAIL' && incident.category !== 'PRODUCT') throw contractError('RESULT_INCIDENT_INVALID', 'FAIL can only cite PRODUCT incidents');
    if (context.verdict === 'BLOCKED' && incident.category !== 'TECHNICAL') throw contractError('RESULT_INCIDENT_INVALID', 'technical BLOCKED can only cite TECHNICAL incidents');
    if (!['FAIL', 'BLOCKED'].includes(context.verdict)) throw contractError('RESULT_INCIDENT_INVALID', `${context.verdict} cannot cite runtime incidents`);
  }
  if (context.verdict === 'FAIL' && finding.status === 'NOT_SATISFIED') {
    if (requirement.basis === 'assumed') throw contractError('RESULT_INVALID', `${label} cannot fail an assumed requirement`);
    if (requirement.basis === 'implied' && !String(finding.necessityReason || '').trim()) {
      throw contractError('RESULT_INVALID', `${label} requires necessityReason for an implied requirement`);
    }
  }
  const directSupportCount = evidenceRefs.length + knowledgeRefs.length;
  const productIncidentCount = incidentRefs.filter((ref) => context.incidents.get(ref)?.category === 'PRODUCT').length;
  if (finding.status === 'SATISFIED' && directSupportCount === 0) {
    throw contractError('RESULT_EVIDENCE_INVALID', `${label} SATISFIED requires evidence or applicable knowledge`);
  }
  if (finding.status === 'NOT_SATISFIED' && directSupportCount === 0 && productIncidentCount === 0) {
    throw contractError('RESULT_EVIDENCE_INVALID', `${label} NOT_SATISFIED requires evidence, applicable knowledge, or a PRODUCT incident`);
  }
  if (context.verdict === 'FAIL' && finding.status === 'NOT_SATISFIED' && context.currentObservationRef
    && !evidenceRefs.includes(context.currentObservationRef) && productIncidentCount === 0) {
    throw contractError('CURRENT_OBSERVATION_REQUIRED', `${label} must cite the latest usable observation or a PRODUCT incident`, {
      fieldPath: `${label}.evidenceRefs`, expected: context.currentObservationRef, received: evidenceRefs,
    });
  }
  if (finding.status === 'UNRESOLVED' && directSupportCount === 0 && !String(finding.reason || '').trim()) {
    throw contractError('RESULT_EVIDENCE_INVALID', `${label} UNRESOLVED without evidence requires reason`);
  }
  if (finding.status === 'BLOCKED' && directSupportCount === 0 && incidentRefs.length === 0
    && !context.technicalFailureCode && !String(finding.reason || '').trim()) {
    throw contractError('RESULT_EVIDENCE_INVALID', `${label} BLOCKED without evidence requires a technical failure or reason`);
  }
  return { evidenceRefs, knowledgeRefs, incidentRefs };
}

function validateResult(value, options = {}) {
  ensureObject(value, 'result', 'RESULT_INVALID');
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) throw contractError('RESULT_SCHEMA_UNSUPPORTED', `schemaVersion must be ${RESULT_SCHEMA_VERSION}`);
  ensureString(value.executionId, 'executionId', 'RESULT_INVALID');
  if (options.executionId && value.executionId !== options.executionId) throw contractError('RESULT_BINDING_MISMATCH', 'executionId does not match current execution');
  if (!VERDICTS.has(value.verdict)) throw contractError('RESULT_INVALID', 'verdict is invalid');
  if (!EXECUTION_STATUSES.has(value.executionStatus)) throw contractError('RESULT_INVALID', 'executionStatus is invalid');
  if (!VERDICT_BASES.has(value.verdictBasis)) throw contractError('RESULT_INVALID', 'verdictBasis is invalid');
  ensureString(value.summary, 'summary', 'RESULT_INVALID');
  const understanding = options.understanding || { requirements: [] };
  const plan = options.plan || null;
  const requirements = new Map((understanding.requirements || []).map((item) => [item.id, item]));
  const findings = ensureArray(value.requirementFindings, 'requirementFindings', 'RESULT_INVALID');
  findings.forEach((item, index) => ensureObject(item, `requirementFindings[${index}]`, 'RESULT_INVALID'));
  const findingIds = ensureUniqueIds(findings.map((item) => ({ id: item.requirementId })), 'requirementFindings', 'RESULT_INVALID');
  for (const requirementId of requirements.keys()) {
    if (!findingIds.has(requirementId)) throw contractError('RESULT_REFERENCE_INVALID', `missing finding for requirement: ${requirementId}`);
  }
  const context = {
    executionId: value.executionId,
    verdict: value.verdict,
    requirements,
    evidence: refIndex(options.evidence),
    knowledge: refIndex(options.knowledgeAssessments),
    incidents: refIndex(options.incidents),
    technicalFailureCode: value.technicalFailureCode || null,
    currentObservationRef: options.currentObservationRef || null,
  };
  let evidenceCount = 0;
  let knowledgeCount = 0;
  let productIncidentCount = 0;
  findings.forEach((finding, index) => {
    const refs = validateFinding(finding, index, context);
    evidenceCount += refs.evidenceRefs.length;
    knowledgeCount += refs.knowledgeRefs.length;
    productIncidentCount += refs.incidentRefs.filter((ref) => context.incidents.get(ref)?.category === 'PRODUCT').length;
  });
  const findingStatuses = new Set(findings.map((finding) => finding.status));
  if (value.verdict === 'PASS' && evidenceCount === 0) throw contractError('RESULT_EVIDENCE_INVALID', 'PASS requires current business evidence');
  if (value.verdict === 'FAIL' && evidenceCount === 0 && productIncidentCount === 0) throw contractError('RESULT_EVIDENCE_INVALID', 'FAIL requires current business evidence or a PRODUCT incident');
  if (value.verdictBasis === 'KNOWLEDGE_SUPPORTED' && knowledgeCount === 0) throw contractError('RESULT_KNOWLEDGE_INVALID', 'KNOWLEDGE_SUPPORTED requires applicable knowledge');
  const uncertainties = ensureArray(value.uncertainties, 'uncertainties', 'RESULT_INVALID');
  uncertainties.forEach((item, index) => ensureString(item, `uncertainties[${index}]`, 'RESULT_INVALID'));
  if (value.technicalFailureCode !== null && value.technicalFailureCode !== undefined) ensureString(value.technicalFailureCode, 'technicalFailureCode', 'RESULT_INVALID');
  if (value.verdict === 'PASS' && (findingStatuses.size !== 1 || !findingStatuses.has('SATISFIED'))) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'PASS requires every requirement to be SATISFIED');
  }
  if (value.verdict === 'PASS' && (!['COMPLETED', 'STOPPED_BY_BUDGET'].includes(value.executionStatus)
    || !['DIRECT_EVIDENCE', 'KNOWLEDGE_SUPPORTED'].includes(value.verdictBasis))) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'PASS is inconsistent with executionStatus or verdictBasis');
  }
  if (value.verdict === 'FAIL' && !findingStatuses.has('NOT_SATISFIED')) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'FAIL requires at least one NOT_SATISFIED requirement');
  }
  if (value.verdict === 'INCONCLUSIVE' && (!findingStatuses.has('UNRESOLVED')
    || value.verdictBasis !== 'INSUFFICIENT_EVIDENCE' || uncertainties.length === 0)) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'INCONCLUSIVE requires unresolved requirements and recorded uncertainty');
  }
  if (value.verdict === 'BLOCKED' && !findingStatuses.has('BLOCKED')) {
    throw contractError('RESULT_SEMANTICS_INVALID', 'BLOCKED requires at least one BLOCKED requirement');
  }
  if (value.executionStatus === 'TECHNICALLY_BLOCKED' || value.verdictBasis === 'TECHNICAL_CONSTRAINT') {
    if (value.verdict !== 'BLOCKED' || value.executionStatus !== 'TECHNICALLY_BLOCKED'
      || value.verdictBasis !== 'TECHNICAL_CONSTRAINT' || !value.technicalFailureCode) {
      throw contractError('RESULT_SEMANTICS_INVALID', 'technical blocking fields must be expressed together');
    }
  }
  const reviews = options.verdictReviews || [];
  const queries = refIndex(options.knowledgeQueries);
  const reviewed = hasBoundVerdictReview(reviews, queries, context.evidence, understanding, plan, value.executionId, value.verdict);
  const reviewRequired = ['FAIL', 'INCONCLUSIVE'].includes(value.verdict)
    || (value.verdict === 'BLOCKED' && value.verdictBasis !== 'TECHNICAL_CONSTRAINT');
  if (reviewRequired && !reviewed) {
    const currentReviews = reviews.filter((review) => review.executionId === value.executionId);
    if (currentReviews.length && !currentReviews.some((review) => review.requestedVerdict === value.verdict)) {
      throw contractError('RESULT_REVIEW_VERDICT_MISMATCH', 'verdict review does not match the proposed result verdict', {
        fieldPath: 'verdictReview.requestedVerdict',
        expected: value.verdict,
        received: [...new Set(currentReviews.map((review) => review.requestedVerdict))],
      });
    }
    const label = value.verdict === 'BLOCKED' ? 'business BLOCKED' : value.verdict;
    throw contractError('RESULT_REVIEW_REQUIRED', `${label} requires a verdict review bound to a knowledge query`, {
      fieldPath: 'verdictReview', expected: `review for ${value.verdict} with current source, observation, recovery, and knowledge references`,
    });
  }
  const expectedSha = resultSha(value);
  if (value.resultSha !== undefined && value.resultSha !== expectedSha) throw contractError('RESULT_INVALID', 'resultSha does not match result content');
  return value;
}

function validateMetrics(value, options = {}) {
  ensureObject(value, 'metrics', 'METRICS_INVALID');
  if (value.schemaVersion !== METRICS_SCHEMA_VERSION) throw contractError('METRICS_SCHEMA_UNSUPPORTED', `schemaVersion must be ${METRICS_SCHEMA_VERSION}`);
  ensureString(value.executionId, 'executionId', 'METRICS_INVALID');
  if (options.executionId && value.executionId !== options.executionId) throw contractError('METRICS_BINDING_MISMATCH', 'executionId does not match current execution');
  if (!VERDICTS.has(value.verdict) || !EXECUTION_STATUSES.has(value.executionStatus)) throw contractError('METRICS_INVALID', 'metrics result fields are invalid');
  ensureObject(value.counts, 'counts', 'METRICS_INVALID');
  for (const field of ['actions', 'observations', 'preparationActions', 'knowledgeQueries', 'knowledgeAssessments', 'planRevisions']) {
    if (!Number.isInteger(value.counts[field]) || value.counts[field] < 0) throw contractError('METRICS_INVALID', `counts.${field} must be a non-negative integer`);
  }
  for (const field of ['warmSessionGeneration', 'recoveryCount']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) throw contractError('METRICS_INVALID', `${field} must be a non-negative integer`);
  }
  if (typeof value.warmSessionReused !== 'boolean' || typeof value.timeLimitStopped !== 'boolean') throw contractError('METRICS_INVALID', 'metrics boolean fields are invalid');
  if (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) throw contractError('METRICS_INVALID', 'elapsedMs must be a non-negative number');
  if (value.timing !== undefined) {
    ensureObject(value.timing, 'timing', 'METRICS_INVALID');
    for (const field of ['adapterActiveMs', 'protocolActiveMs', 'agentDecisionGapMs', 'protocolAttempts', 'contractRejections']) {
      if (!Number.isFinite(value.timing[field]) || value.timing[field] < 0) throw contractError('METRICS_INVALID', `timing.${field} must be a non-negative number`);
    }
    if (value.timing.agentOrchestrationGapMs !== undefined
      && (!Number.isFinite(value.timing.agentOrchestrationGapMs) || value.timing.agentOrchestrationGapMs < 0)) {
      throw contractError('METRICS_INVALID', 'timing.agentOrchestrationGapMs must be a non-negative number');
    }
    if (value.timing.statusReads !== undefined && (!Number.isInteger(value.timing.statusReads) || value.timing.statusReads < 0)) {
      throw contractError('METRICS_INVALID', 'timing.statusReads must be a non-negative integer');
    }
    if (value.timing.inputEffects !== undefined) {
      ensureObject(value.timing.inputEffects, 'timing.inputEffects', 'METRICS_INVALID');
      for (const field of ['total', 'attempts', 'settledMs']) {
        if (!Number.isFinite(value.timing.inputEffects[field]) || value.timing.inputEffects[field] < 0) {
          throw contractError('METRICS_INVALID', `timing.inputEffects.${field} must be a non-negative number`);
        }
      }
      ensureObject(value.timing.inputEffects.statuses, 'timing.inputEffects.statuses', 'METRICS_INVALID');
      for (const status of ['VERIFIED', 'MASKED', 'UNVERIFIABLE', 'MISMATCH']) {
        if (!Number.isInteger(value.timing.inputEffects.statuses[status]) || value.timing.inputEffects.statuses[status] < 0) {
          throw contractError('METRICS_INVALID', `timing.inputEffects.statuses.${status} must be a non-negative integer`);
        }
      }
    }
    if (value.timing.firstExecutableTurnMs !== null && (!Number.isFinite(value.timing.firstExecutableTurnMs) || value.timing.firstExecutableTurnMs < 0)) {
      throw contractError('METRICS_INVALID', 'timing.firstExecutableTurnMs must be null or a non-negative number');
    }
    ensureObject(value.timing.phaseDurationsMs, 'timing.phaseDurationsMs', 'METRICS_INVALID');
  }
  return value;
}

function withResultSha(value) {
  const result = { ...value };
  result.resultSha = resultSha(result);
  return result;
}

module.exports = {
  EXECUTION_STATUSES,
  FINDING_STATUSES,
  METRICS_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  VERDICTS,
  VERDICT_BASES,
  resultSha,
  validateMetrics,
  validateResult,
  withResultSha,
};
