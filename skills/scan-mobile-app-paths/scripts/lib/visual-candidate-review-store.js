'use strict';

const fs = require('fs');
const path = require('path');
const { fail, readJson, safeSegment, hashObject } = require('./common');

function appRootFromScanDir(scanDir) {
  return path.dirname(path.dirname(scanDir));
}

function visualCandidateReviewRef(visualCandidateReviewId) {
  return `evidence/visual-candidate-reviews/${safeSegment(visualCandidateReviewId, 'visualCandidateReviewId')}.json`;
}

function visualCandidateReviewFile(scanDir, visualCandidateReviewId) {
  return path.join(scanDir, visualCandidateReviewRef(visualCandidateReviewId));
}

function baseScanDirForSuggestion(scanDir, suggestion = {}) {
  const runId = suggestion.visualCandidateReviewSourceRunId || suggestion.visualCandidateReviewRef?.runId || null;
  return runId ? path.join(appRootFromScanDir(scanDir), 'runs', safeSegment(runId, 'visualCandidateReviewSourceRunId')) : scanDir;
}

function loadVisualCandidateReview(scanDir, visualCandidateReviewId) {
  return readJson(visualCandidateReviewFile(scanDir, visualCandidateReviewId));
}

function candidateFromSupplement(entry = {}) {
  const type = String(entry.type || (entry.direction ? 'swipe' : 'tap'));
  if (type === 'swipe') return null;
  const bounds = entry.bounds || entry.fallbackBounds || entry.rect || null;
  const target = entry.target || entry.text || entry.label || null;
  return target && bounds ? { type: 'tap', target, fallbackBounds: bounds } : null;
}

function reviewContainsCandidate(review, suggestion) {
  const sourceSuggestionId = suggestion.sourceSuggestionId || suggestion.suggestionId;
  if ((review.createdSuggestionIds || []).includes(sourceSuggestionId) || (review.affectedSuggestionIds || []).includes(sourceSuggestionId)) return true;
  const candidateHash = suggestion.candidateHash || (suggestion.candidate ? hashObject(suggestion.candidate) : null);
  if (!candidateHash) return false;
  for (const entry of review.review?.supplemented || []) {
    const candidate = candidateFromSupplement(entry);
    if (candidate && hashObject(candidate) === candidateHash) return true;
  }
  return false;
}

function assertVisualCandidateReviewSuggestion(scanDir, suggestion, contextId) {
  if (!suggestion.visualCandidateReviewId) return null;
  const baseScanDir = baseScanDirForSuggestion(scanDir, suggestion);
  const file = visualCandidateReviewFile(baseScanDir, suggestion.visualCandidateReviewId);
  if (!fs.existsSync(file)) fail(`Visual candidate review ${suggestion.visualCandidateReviewId} is missing`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  const review = readJson(file);
  if (review.contextId !== contextId || review.contextId !== suggestion.contextId && suggestion.contextId) fail(`Visual candidate review ${review.visualCandidateReviewId} belongs to another context`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  if (review.reachableStateId !== suggestion.reachableStateId || review.visualStateId !== suggestion.visualStateId) fail(`Visual candidate review ${review.visualCandidateReviewId} is bound to another state`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  if (review.observationId !== suggestion.observationId) fail(`Visual candidate review ${review.visualCandidateReviewId} is bound to another observation`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  if (!reviewContainsCandidate(review, suggestion)) fail(`Visual candidate review ${review.visualCandidateReviewId} does not reference suggestion ${suggestion.suggestionId}`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  const observationRef = suggestion.observationRef || review.observationRef || null;
  const observationBase = observationRef?.runId ? path.join(appRootFromScanDir(scanDir), 'runs', safeSegment(observationRef.runId, 'observationRef.runId')) : baseScanDir;
  const observationId = String(observationRef?.observationId || suggestion.observationId || review.observationId);
  for (const name of ['observation.json', 'layout.json', 'screenshot.png']) {
    if (!fs.existsSync(path.join(observationBase, 'evidence', 'observations', observationId, name))) fail(`Visual candidate review ${review.visualCandidateReviewId} references missing observation evidence`, 'VISUAL_CANDIDATE_REVIEW_INVALID');
  }
  return review;
}

module.exports = {
  visualCandidateReviewRef,
  visualCandidateReviewFile,
  loadVisualCandidateReview,
  assertVisualCandidateReviewSuggestion
};
