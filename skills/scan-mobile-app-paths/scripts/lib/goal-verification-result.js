'use strict';

const { restoreChainVerified } = require('./verification-result');
const { inferFailedEdgeIds } = require('./dependency-blocking');

function graphChainCurrent(graph = {}, task = {}) {
  return (task.edgeIds || []).every((edgeId, index) => {
    const edge = (graph.edges || []).find(item => item.id === edgeId);
    return edge?.verification?.transitionFingerprint === (task.transitionFingerprints || [])[index];
  });
}

function scopedFailure(task = {}, restored = null, reasonCode = null) {
  const ids = inferFailedEdgeIds(task, restored, { fallbackToAll: true }) || [];
  const firstIndex = ids.length ? (task.edgeIds || []).indexOf(ids[0]) : -1;
  return {
    reasonCode,
    restoreReasonCode: restored?.reasonCode || null,
    restoreId: restored?.restoreId || null,
    failedEdgeId: ids[0] || null,
    failedEdgeIds: ids,
    blockingEdgeIds: ids,
    scope: ids.length ? (firstIndex <= 0 ? 'PREFIX_EDGE_BLOCKED' : 'BRANCH_EDGE_BLOCKED') : 'UNKNOWN'
  };
}

function classifyGoalReplay({ task = {}, graph = {}, restored = null, childStatus = 0, matchStatus = null, failedReasonCode = 'GOAL_REPLAY_FAILED' } = {}) {
  const chainCurrent = graphChainCurrent(graph, task);
  const pathReplayVerified = childStatus === 0 && chainCurrent && restoreChainVerified(task, restored);
  const goalVerified = pathReplayVerified && matchStatus === 'CANDIDATE_STRONG';
  const pathReplayStatus = pathReplayVerified ? 'COLD_REPLAY_VERIFIED' : chainCurrent ? 'REPLAY_UNSTABLE' : 'SUPERSEDED';
  const goalMatchStatus = !matchStatus ? null : goalVerified ? 'GOAL_MATCH_STRONG' : 'GOAL_REPLAY_NOT_STRONG';
  const reasonCode = goalVerified ? null
    : !chainCurrent ? 'VERIFICATION_SUPERSEDED'
      : !pathReplayVerified ? (childStatus === 0 ? 'VERIFICATION_CHAIN_MISMATCH' : failedReasonCode)
        : 'GOAL_REPLAY_NOT_STRONG';
  const failure = pathReplayVerified || !chainCurrent ? null : scopedFailure(task, restored, reasonCode);
  return { chainCurrent, pathReplayVerified, goalVerified, pathReplayStatus, goalMatchStatus, reasonCode, failure };
}

module.exports = {
  graphChainCurrent,
  scopedFailure,
  classifyGoalReplay
};
