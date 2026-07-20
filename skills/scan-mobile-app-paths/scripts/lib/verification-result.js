'use strict';

const VERIFIED_STATUSES = new Set(['EXACT', 'SAME_PAGE']);

function equivalentObservationIds(restored = {}) {
  return new Set((restored.equivalenceReviews || [])
    .filter(item => item.status === 'EXPECTED_STATE_EQUIVALENT')
    .map(item => item.observationId));
}

function restoreStepVerified(step = {}, reviewsOrIds = []) {
  if (VERIFIED_STATUSES.has(step.verificationStatus)) return true;
  const ids = reviewsOrIds instanceof Set
    ? reviewsOrIds
    : new Set((reviewsOrIds || []).filter(item => item.status === 'EXPECTED_STATE_EQUIVALENT').map(item => item.observationId));
  return step.verificationStatus === 'PROBABLE' && ids.has(step.afterObservationId);
}

function restoreChainVerified(task = {}, restored = {}) {
  if (!restored || restored.status !== 'SUCCEEDED' || restored.reachableStateId !== task.terminalReachableStateId) return false;
  if (JSON.stringify(restored.fixedEdgeIds || []) !== JSON.stringify(task.edgeIds || [])) return false;
  if (JSON.stringify(restored.fixedTransitionFingerprints || []) !== JSON.stringify(task.transitionFingerprints || [])) return false;
  const ids = equivalentObservationIds(restored);
  return JSON.stringify((restored.steps || []).map(step => step.edgeId)) === JSON.stringify(task.edgeIds || [])
    && (restored.steps || []).every(step => restoreStepVerified(step, ids));
}

function restoreChainStrictExact(restored = {}) {
  return !(restored.equivalenceReviews || []).length
    && (restored.steps || []).every(step => step.verificationStatus === 'EXACT');
}

function legacyRestoreVerification({ restored, action }) {
  const task = {
    terminalReachableStateId: restored?.reachableStateId,
    edgeIds: (restored?.steps || []).map(step => step.edgeId),
    transitionFingerprints: restored?.fixedTransitionFingerprints || []
  };
  const compatible = restored ? { ...restored, fixedEdgeIds: task.edgeIds, fixedTransitionFingerprints: task.transitionFingerprints } : null;
  const verified = restoreChainVerified(task, compatible);
  const strictExact = restoreChainStrictExact(restored);
  const semanticAction = action?.locatorResolution === 'SEMANTIC_VERIFIED';
  return {
    verified,
    strictExact,
    replayStatus: verified && strictExact && semanticAction ? 'COLD_REPLAY_VERIFIED' : 'REPLAY_UNSTABLE',
    legacyReason: verified ? (strictExact ? 'COORDINATE_ONLY' : 'STATE_EQUIVALENCE') : 'RESTORE_CHAIN_UNVERIFIED'
  };
}

module.exports = {
  restoreStepVerified,
  restoreChainVerified,
  restoreChainStrictExact,
  legacyRestoreVerification
};
