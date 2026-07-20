'use strict';

const fs = require('fs');
const path = require('path');
const { fail, readJson, nextId, now, commitEvent, safeSegment } = require('./common');
const { requireObservationBundle } = require('./observation-store');

const REVIEW_TYPES = Object.freeze(['ROOT_STATE', 'PAGE_OUTCOME', 'RESTORE_STATE', 'SOURCE_STATE', 'TARGET_MATCH']);
const STATUSES = Object.freeze(['ACCEPTED', 'REJECTED', 'NEEDS_REOBSERVE', 'NEEDS_HUMAN_REVIEW']);
const CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

function visualReviewRef(visualReviewId) {
  return `evidence/visual-reviews/${safeSegment(visualReviewId, 'visualReviewId')}.json`;
}

function visualReviewFile(scanDir, visualReviewId) {
  return path.join(scanDir, visualReviewRef(visualReviewId));
}

function normalizeReviewType(value) {
  const reviewType = String(value || '').toUpperCase();
  if (!REVIEW_TYPES.includes(reviewType)) fail(`Invalid visual review type: ${value}`, 'VISUAL_REVIEW_TYPE_INVALID');
  return reviewType;
}

function normalizeStatus(value) {
  const status = String(value || '').toUpperCase();
  if (!STATUSES.includes(status)) fail(`Invalid visual review status: ${value}`, 'VISUAL_REVIEW_STATUS_INVALID');
  return status;
}

function normalizeAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) fail('Visual review assessment must be an object', 'VISUAL_REVIEW_INVALID');
  const status = normalizeStatus(assessment.status);
  const pageUsable = assessment.pageUsable === true;
  const confidence = assessment.confidence === undefined ? 'MEDIUM' : String(assessment.confidence).toUpperCase();
  if (!CONFIDENCE.includes(confidence)) fail('Visual review confidence must be HIGH, MEDIUM, or LOW', 'VISUAL_REVIEW_INVALID');
  const rationale = String(assessment.rationale || '').trim();
  if (!rationale) fail('Visual review requires a rationale', 'VISUAL_REVIEW_INVALID');
  if (status === 'ACCEPTED' && !pageUsable) fail('Accepted visual review requires pageUsable=true', 'VISUAL_REVIEW_INVALID');
  if (status !== 'ACCEPTED' && !String(assessment.reasonCode || '').trim()) fail('Rejected or deferred visual review requires reasonCode', 'VISUAL_REVIEW_INVALID');
  return {
    status,
    pageUsable,
    pageKind: assessment.pageKind ? String(assessment.pageKind) : null,
    pageName: assessment.pageName ? String(assessment.pageName) : null,
    reasonCode: assessment.reasonCode ? String(assessment.reasonCode) : null,
    confidence,
    rationale
  };
}

function loadVisualReview(scanDir, visualReviewId) {
  return readJson(visualReviewFile(scanDir, visualReviewId));
}

function listVisualReviews(scanDir) {
  const dir = path.join(scanDir, 'evidence', 'visual-reviews');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => readJson(path.join(dir, name)));
}

function findVisualReviewsForObservation(scanDir, observationId) {
  return listVisualReviews(scanDir).filter(item => item.observationId === observationId);
}

function recordVisualReview(scanDir, input) {
  const contextId = String(input.contextId || '');
  if (!['guest', 'authenticated'].includes(contextId)) fail('contextId must be guest or authenticated', 'CONTEXT_INVALID');
  const observationId = safeSegment(input.observationId, 'observationId');
  const reviewType = normalizeReviewType(input.reviewType);
  const observation = requireObservationBundle(scanDir, observationId, contextId, { requireComplete: true, requireFiles: true });
  const assessment = normalizeAssessment(input.assessment);
  const visualReviewId = nextId(scanDir, 'visualReview', 'vreview');
  const visualReview = {
    schemaVersion: 1,
    visualReviewId,
    contextId,
    observationId,
    reviewType,
    status: assessment.status,
    pageUsable: assessment.pageUsable,
    pageKind: assessment.pageKind,
    pageName: assessment.pageName,
    reasonCode: assessment.reasonCode,
    confidence: assessment.confidence,
    rationale: assessment.rationale,
    screenshotPath: path.relative(scanDir, observation.screenshotPath).split(path.sep).join('/'),
    layoutPath: path.relative(scanDir, observation.layoutPath).split(path.sep).join('/'),
    owner: input.owner || null,
    createdAt: now()
  };
  const relative = visualReviewRef(visualReviewId);
  commitEvent(scanDir, 'visualReviewRecorded', { contextId, visualReviewId, observationId, reviewType, status: visualReview.status, owner: visualReview.owner }, [
    { path: relative, op: 'REPLACE', value: visualReview }
  ]);
  return visualReview;
}

function assertAcceptedVisualReview(scanDir, options) {
  const visualReviewId = safeSegment(options.visualReviewId, 'visualReviewId');
  const review = loadVisualReview(scanDir, visualReviewId);
  if (review.status !== 'ACCEPTED' || review.pageUsable !== true) fail(`VisualReview ${visualReviewId} is not accepted`, 'VISUAL_REVIEW_REQUIRED');
  if (options.contextId && review.contextId !== options.contextId) fail(`VisualReview ${visualReviewId} belongs to another context`, 'VISUAL_REVIEW_INVALID');
  if (options.observationId && review.observationId !== options.observationId) fail(`VisualReview ${visualReviewId} is not bound to observation ${options.observationId}`, 'VISUAL_REVIEW_INVALID');
  if (options.reviewType && review.reviewType !== normalizeReviewType(options.reviewType)) fail(`VisualReview ${visualReviewId} has type ${review.reviewType}, expected ${options.reviewType}`, 'VISUAL_REVIEW_INVALID');
  requireObservationBundle(scanDir, review.observationId, review.contextId, { requireComplete: true, requireFiles: true });
  return review;
}

module.exports = {
  REVIEW_TYPES,
  STATUSES,
  visualReviewRef,
  visualReviewFile,
  normalizeAssessment,
  recordVisualReview,
  loadVisualReview,
  listVisualReviews,
  findVisualReviewsForObservation,
  assertAcceptedVisualReview
};
