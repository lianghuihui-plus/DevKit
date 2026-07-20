'use strict';

const { loadGraph, fail } = require('./common');
const { validatePopupDisposition } = require('./popup-policy');
const { loadObservationBundle } = require('./observation-store');

const OUTCOME_DISPOSITIONS = Object.freeze(['PAGE', 'BUSINESS_MODAL', 'NO_STATE_CHANGE', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN']);
const RESTORE_BASE_DISPOSITIONS = Object.freeze(['DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN']);
const RESTORE_EQUIVALENCE = 'EXPECTED_STATE_EQUIVALENT';

function canReviewRestoreEquivalence(scanDir, attempt) {
  const mismatch = attempt.restoreMismatch;
  if (!['PROBABLE', 'UNCERTAIN'].includes(mismatch?.comparison) || !mismatch.expectedReachableStateId || !attempt.reviewObservationId) return false;
  const graph = loadGraph(scanDir, attempt.contextId);
  const state = graph.reachableStates.find(item => item.id === mismatch.expectedReachableStateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  return Boolean(visual?.fingerprint);
}

function restoreDispositions(scanDir, attempt) {
  const dispositions = [...RESTORE_BASE_DISPOSITIONS];
  if (canReviewRestoreEquivalence(scanDir, attempt)) dispositions.unshift(RESTORE_EQUIVALENCE);
  return dispositions;
}

function validateRestoreReviewDisposition(value, scanDir, attempt) {
  const disposition = String(value || '').toUpperCase();
  if (disposition !== RESTORE_EQUIVALENCE) validatePopupDisposition(disposition);
  if (!restoreDispositions(scanDir, attempt).includes(disposition)) {
    fail('Restore review only accepts expected-state equivalence when available, dismissible popup, transient, or unknown popup', 'POPUP_DISPOSITION_INVALID');
  }
  return disposition;
}

function buildReviewRequest(scanDir, attempt, phase) {
  const observationId = attempt.reviewObservationId;
  const bundle = loadObservationBundle(scanDir, observationId, { fingerprint: false });
  const equivalenceAvailable = phase === 'RESTORE' && canReviewRestoreEquivalence(scanDir, attempt);
  return {
    phase,
    observationId,
    screenshotPath: bundle.screenshotPath,
    layoutPath: bundle.layoutPath,
    dispositions: phase === 'RESTORE' ? restoreDispositions(scanDir, attempt) : [...OUTCOME_DISPOSITIONS],
    sourceComparison: phase === 'OUTCOME' ? attempt.sourceComparison || null : null,
    restoreComparison: phase === 'RESTORE' ? attempt.restoreMismatch?.comparison || null : null,
    expectedReachableStateId: phase === 'RESTORE' ? attempt.restoreMismatch?.expectedReachableStateId || null : null,
    recommendedDisposition: phase === 'OUTCOME' && attempt.sourceComparison === 'EXACT' ? 'NO_STATE_CHANGE' : equivalenceAvailable ? RESTORE_EQUIVALENCE : null,
    goalHint: '如果弹窗与目标截图匹配，选择 BUSINESS_MODAL，不要关闭。'
  };
}

module.exports = {
  OUTCOME_DISPOSITIONS,
  RESTORE_EQUIVALENCE,
  canReviewRestoreEquivalence,
  restoreDispositions,
  validateRestoreReviewDisposition,
  buildReviewRequest
};
