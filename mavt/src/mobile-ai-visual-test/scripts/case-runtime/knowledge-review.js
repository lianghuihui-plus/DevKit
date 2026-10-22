'use strict';

const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureObject,
  ensureString,
} = require('../lib/contract-utils');
const store = require('./store');

const ASSESSMENT_STATUSES = Object.freeze(['APPLICABLE', 'NOT_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT']);
const REVIEW_CONCLUSIONS = Object.freeze(['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT', 'NO_MATCH']);

function buildKnowledgeReviewGuidance(queryId, candidates = []) {
  if (!candidates.length) return null;
  return {
    fieldPath: 'decision.knowledgeReview',
    required: true,
    instruction: 'Assess every candidate, replace the template statuses and reasons with your actual judgment, and attach the review to the next Runtime request decision.',
    template: {
      queryId,
      conclusion: 'NO_APPLICABLE',
      assessments: candidates.map((candidate) => ({
        entryId: candidate.entryId,
        status: 'NOT_APPLICABLE',
        reason: '<explain why this candidate is or is not applicable>',
      })),
    },
    allowedConclusions: REVIEW_CONCLUSIONS.filter((item) => item !== 'NO_MATCH'),
    allowedAssessmentStatuses: [...ASSESSMENT_STATUSES],
  };
}

function projectPendingKnowledgeReview(queryEvent) {
  const candidates = (queryEvent.candidates || []).map((candidate) => ({
    entryId: candidate.entryId,
    title: candidate.title,
    snapshotRef: candidate.snapshotRef,
    metadata: candidate.metadata,
    expired: candidate.expired === true,
    conflictsWith: candidate.conflictsWith || [],
    snippets: candidate.snippets || [],
  }));
  return {
    queryId: queryEvent.queryId,
    query: queryEvent.query,
    candidateCount: candidates.length,
    expectationRefs: queryEvent.expectationRefs || [],
    candidates,
    requiredReview: buildKnowledgeReviewGuidance(queryEvent.queryId, candidates),
  };
}

function onlyFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unsupported.length) {
    throw contractError('CASE_NARRATIVE_INVALID', `${label} contains unsupported fields: ${unsupported.join(', ')}`);
  }
}

function normalizeKnowledgeReview(value) {
  const review = ensureObject(value, 'decision.knowledgeReview', 'CASE_NARRATIVE_INVALID');
  onlyFields(review, ['queryId', 'conclusion', 'assessments'], 'decision.knowledgeReview');
  const queryId = ensureString(review.queryId, 'decision.knowledgeReview.queryId', 'CASE_NARRATIVE_INVALID').trim();
  const conclusion = ensureString(review.conclusion, 'decision.knowledgeReview.conclusion', 'CASE_NARRATIVE_INVALID').trim();
  if (!REVIEW_CONCLUSIONS.includes(conclusion) || conclusion === 'NO_MATCH') {
    throw contractError('CASE_NARRATIVE_INVALID', `knowledgeReview.conclusion must be one of ${REVIEW_CONCLUSIONS.filter((item) => item !== 'NO_MATCH').join(', ')}`);
  }
  const assessments = ensureArray(review.assessments, 'decision.knowledgeReview.assessments', 'CASE_NARRATIVE_INVALID')
    .map((item, index) => {
      const assessment = ensureObject(item, `decision.knowledgeReview.assessments[${index}]`, 'CASE_NARRATIVE_INVALID');
      onlyFields(assessment, ['entryId', 'status', 'reason'], `decision.knowledgeReview.assessments[${index}]`);
      const status = ensureString(assessment.status, `decision.knowledgeReview.assessments[${index}].status`, 'CASE_NARRATIVE_INVALID').trim();
      if (!ASSESSMENT_STATUSES.includes(status)) {
        throw contractError('CASE_NARRATIVE_INVALID', `knowledge assessment status must be one of ${ASSESSMENT_STATUSES.join(', ')}`);
      }
      return {
        entryId: ensureString(assessment.entryId, `decision.knowledgeReview.assessments[${index}].entryId`, 'CASE_NARRATIVE_INVALID').trim(),
        status,
        reason: ensureString(assessment.reason, `decision.knowledgeReview.assessments[${index}].reason`, 'CASE_NARRATIVE_INVALID').trim(),
      };
    });
  const ids = assessments.map((item) => item.entryId);
  if (new Set(ids).size !== ids.length) {
    throw contractError('CASE_NARRATIVE_INVALID', 'knowledgeReview.assessments must not repeat entryId');
  }
  return { queryId, conclusion, assessments };
}

function validateConclusion(review, queryEvent) {
  const candidateIds = new Set((queryEvent.candidates || []).map((item) => item.entryId));
  const unknown = review.assessments.filter((item) => !candidateIds.has(item.entryId)).map((item) => item.entryId);
  if (unknown.length) {
    throw contractError('CASE_NARRATIVE_INVALID', `knowledgeReview references candidates not returned by ${review.queryId}: ${unknown.join(', ')}`);
  }
  if (!candidateIds.size) {
    throw contractError('CASE_NARRATIVE_INVALID', `${review.queryId} has no candidates and was closed automatically`);
  }
  const statuses = new Set(review.assessments.map((item) => item.status));
  if (review.conclusion === 'APPLICABLE_FOUND' && !statuses.has('APPLICABLE')) {
    throw contractError('CASE_NARRATIVE_INVALID', 'APPLICABLE_FOUND requires an APPLICABLE assessment');
  }
  if (review.conclusion === 'NO_APPLICABLE') {
    const assessed = new Set(review.assessments.map((item) => item.entryId));
    const missing = [...candidateIds].filter((id) => !assessed.has(id));
    if (statuses.has('APPLICABLE') || missing.length) {
      throw contractError('CASE_NARRATIVE_INVALID', 'NO_APPLICABLE requires every candidate to be assessed and none to be APPLICABLE');
    }
  }
  if (review.conclusion === 'CONFLICTING' && !statuses.has('CONFLICTING')) {
    throw contractError('CASE_NARRATIVE_INVALID', 'CONFLICTING requires a CONFLICTING assessment');
  }
  if (review.conclusion === 'INSUFFICIENT' && !statuses.has('INSUFFICIENT')) {
    throw contractError('CASE_NARRATIVE_INVALID', 'INSUFFICIENT requires an INSUFFICIENT assessment');
  }
  const expiredApplicable = review.assessments.filter((item) => item.status === 'APPLICABLE'
    && (queryEvent.candidates || []).find((candidate) => candidate.entryId === item.entryId)?.expired);
  if (expiredApplicable.length) {
    throw contractError('CASE_NARRATIVE_INVALID', `expired knowledge cannot be APPLICABLE: ${expiredApplicable.map((item) => item.entryId).join(', ')}`);
  }
}

function validateKnowledgeReview(execDir, rawReview) {
  const review = normalizeKnowledgeReview(rawReview);
  const events = store.events(execDir);
  const queryEvent = events.find((event) => event.type === 'knowledgeQueried' && event.queryId === review.queryId);
  if (!queryEvent) throw contractError('CASE_NARRATIVE_INVALID', `knowledge query does not exist: ${review.queryId}`);
  validateConclusion(review, queryEvent);
  const existing = events.find((event) => event.type === 'knowledgeReviewed' && event.queryId === review.queryId);
  if (existing) {
    const recorded = { queryId: existing.queryId, conclusion: existing.conclusion, assessments: existing.assessments || [] };
    if (canonicalJson(recorded) !== canonicalJson(review)) {
      throw contractError('CASE_NARRATIVE_INVALID', `knowledge query already has a different review: ${review.queryId}`);
    }
    return { review, queryEvent, existing };
  }
  return { review, queryEvent, existing: null };
}

function recordKnowledgeReview(execDir, rawReview, decisionEvent, options = {}) {
  const { review, queryEvent, existing } = validateKnowledgeReview(execDir, rawReview);
  if (existing) return existing;
  return store.appendEvent(execDir, 'knowledgeReviewed', {
    ...review,
    automatic: false,
    decisionId: decisionEvent?.decisionId || null,
    sceneId: queryEvent.sceneId || null,
    contextVersion: queryEvent.contextVersion || null,
    expectationRefs: queryEvent.expectationRefs || [],
  }, options);
}

function recordNoMatch(execDir, queryEvent, options = {}) {
  return store.appendEvent(execDir, 'knowledgeReviewed', {
    queryId: queryEvent.queryId,
    conclusion: 'NO_MATCH',
    assessments: [],
    automatic: true,
    decisionId: queryEvent.decisionId || null,
    sceneId: queryEvent.sceneId || null,
    contextVersion: queryEvent.contextVersion || null,
    expectationRefs: queryEvent.expectationRefs || [],
  }, options);
}

function buildKnowledgeIndex(events) {
  const queryEvents = events.filter((event) => event.type === 'knowledgeQueried');
  const reviewEvents = events.filter((event) => event.type === 'knowledgeReviewed');
  const queries = new Map(queryEvents.map((event) => [event.queryId, event]));
  const reviews = new Map(reviewEvents.map((event) => [event.queryId, event]));
  if (queries.size !== queryEvents.length) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'knowledge query IDs must be unique');
  if (reviews.size !== reviewEvents.length) throw contractError('KNOWLEDGE_REVIEW_INVALID', 'each knowledge query can have only one review');
  for (const review of reviewEvents) {
    const queryEvent = queries.get(review.queryId);
    if (!queryEvent) throw contractError('KNOWLEDGE_REVIEW_INVALID', `knowledge review has no query: ${review.queryId}`);
    if (review.conclusion === 'NO_MATCH') {
      if (queryEvent.candidateCount !== 0 || (review.assessments || []).length || review.automatic !== true) {
        throw contractError('KNOWLEDGE_REVIEW_INVALID', `NO_MATCH review is invalid: ${review.queryId}`);
      }
    } else {
      normalizeKnowledgeReview({
        queryId: review.queryId,
        conclusion: review.conclusion,
        assessments: review.assessments || [],
      });
      if (!REVIEW_CONCLUSIONS.includes(review.conclusion)) {
        throw contractError('KNOWLEDGE_REVIEW_INVALID', `knowledge review conclusion is invalid: ${review.queryId}`);
      }
      validateConclusion(review, queryEvent);
    }
  }
  const applicableByExpectation = new Map();
  for (const review of reviews.values()) {
    for (const ref of review.expectationRefs || []) {
      const current = applicableByExpectation.get(ref) || new Set();
      for (const assessment of review.assessments || []) {
        if (assessment.status === 'APPLICABLE') current.add(assessment.entryId);
      }
      applicableByExpectation.set(ref, current);
    }
  }
  return { queries, reviews, applicableByExpectation };
}

module.exports = {
  ASSESSMENT_STATUSES,
  REVIEW_CONCLUSIONS,
  buildKnowledgeIndex,
  buildKnowledgeReviewGuidance,
  normalizeKnowledgeReview,
  projectPendingKnowledgeReview,
  recordKnowledgeReview,
  recordNoMatch,
  validateKnowledgeReview,
};
