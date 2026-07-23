'use strict';

const PORTABLE_LOCATOR_QUALITIES = new Set(['SEMANTIC_PORTABLE', 'SEMANTIC_WITH_FALLBACK']);
const BLOCKED_REPLAY_STATUSES = new Set(['NONREPEATABLE', 'INVALIDATED', 'REPLAY_UNSTABLE']);
const SYSTEM_KEYS = new Set(['BACK', 'HOME']);

function isSystemKeyIntent(intent = {}) {
  return intent.type === 'keyEvent' && SYSTEM_KEYS.has(String(intent.key || '').toUpperCase());
}

function hasDeferredSemanticIntent(intent = {}) {
  return Boolean(
    intent.target
    || intent.selector?.text
    || intent.selector?.accessibilityLabel
    || intent.selector?.resourceId
    || intent.selector?.role
    || isSystemKeyIntent(intent)
  );
}

function locatorReplayabilityReason(edge = {}) {
  const quality = edge.locatorQuality || edge.locatorEvidence?.locatorQuality || null;
  const deferredSemantic = ['UNRESOLVED', 'SEMANTIC_WITH_FALLBACK'].includes(quality) && hasDeferredSemanticIntent(edge.intent);
  if (deferredSemantic) return null;
  if (!PORTABLE_LOCATOR_QUALITIES.has(quality)) return 'EDGE_LOCATOR_NOT_PORTABLE';
  const resolution = edge.locatorResolution || edge.locatorEvidence?.resolution || null;
  if (!resolution || resolution === 'UNRESOLVED') return 'EDGE_LOCATOR_UNRESOLVED';
  if (isSystemKeyIntent(edge.intent)) return null;
  if (!edge.locatorEvidence || !edge.locatorEvidence.matchedNode) return 'EDGE_LOCATOR_NOT_RESOLVED';
  return null;
}

function edgeRunnableReason(edge = {}) {
  if (!edge || typeof edge !== 'object') return 'EDGE_MISSING';
  if (!edge.intent || edge.intent.type === 'wait') return 'EDGE_NON_GRAPH_ACTION';
  const locatorReason = locatorReplayabilityReason(edge);
  if (locatorReason) return locatorReason;
  if (edge.replayPolicy === 'NONREPEATABLE') return 'EDGE_NONREPEATABLE';
  if (edge.safety?.allowed === false) return 'EDGE_SAFETY_BLOCKED';
  if (edge.sideEffect && edge.sideEffect !== 'NONE') return 'EDGE_HAS_SIDE_EFFECT';
  return null;
}

function edgeReplayabilityReason(edge = {}) {
  const runnableReason = edgeRunnableReason(edge);
  if (runnableReason) return runnableReason;
  const replay = edge.verification?.replayStatus || edge.replayability || 'UNVERIFIED';
  if (BLOCKED_REPLAY_STATUSES.has(replay)) return `EDGE_REPLAY_${replay}`;
  return null;
}

function isRunnableEdge(edge = {}) {
  return edgeRunnableReason(edge) === null;
}

function isVerifiedEdge(edge = {}) {
  return isRunnableEdge(edge) && edge.verification?.replayStatus === 'COLD_REPLAY_VERIFIED';
}

function isReplayableEdge(edge = {}) {
  return isRunnableEdge(edge);
}

function pathStatusForEdges(edges = []) {
  if (!edges.length) return 'RUNNABLE_VERIFIED';
  if (edges.some(edge => !isRunnableEdge(edge))) return 'NOT_RUNNABLE';
  if (edges.some(edge => ['REPLAY_UNSTABLE', 'INVALIDATED'].includes(edge.verification?.replayStatus))) return 'RUNNABLE_UNSTABLE';
  if (edges.every(edge => isVerifiedEdge(edge))) return 'RUNNABLE_VERIFIED';
  return 'RUNNABLE_UNVERIFIED';
}

module.exports = {
  PORTABLE_LOCATOR_QUALITIES,
  isSystemKeyIntent,
  locatorReplayabilityReason,
  edgeRunnableReason,
  edgeReplayabilityReason,
  isRunnableEdge,
  isVerifiedEdge,
  isReplayableEdge,
  pathStatusForEdges
};
