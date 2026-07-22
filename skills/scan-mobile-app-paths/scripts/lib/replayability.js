'use strict';

const PORTABLE_LOCATOR_QUALITIES = new Set(['SEMANTIC_PORTABLE', 'SEMANTIC_WITH_FALLBACK']);
const BLOCKED_REPLAY_STATUSES = new Set(['NONREPEATABLE', 'INVALIDATED', 'REPLAY_UNSTABLE']);
const SYSTEM_KEYS = new Set(['BACK', 'HOME']);

function isSystemKeyIntent(intent = {}) {
  return intent.type === 'keyEvent' && SYSTEM_KEYS.has(String(intent.key || '').toUpperCase());
}

function locatorReplayabilityReason(edge = {}) {
  const quality = edge.locatorQuality || edge.locatorEvidence?.locatorQuality || null;
  if (!PORTABLE_LOCATOR_QUALITIES.has(quality)) return 'EDGE_LOCATOR_NOT_PORTABLE';
  const resolution = edge.locatorResolution || edge.locatorEvidence?.resolution || null;
  if (!resolution || resolution === 'UNRESOLVED') return 'EDGE_LOCATOR_UNRESOLVED';
  if (isSystemKeyIntent(edge.intent)) return null;
  if (!edge.locatorEvidence || !edge.locatorEvidence.matchedNode) return 'EDGE_LOCATOR_NOT_RESOLVED';
  return null;
}

function edgeReplayabilityReason(edge = {}) {
  if (!edge || typeof edge !== 'object') return 'EDGE_MISSING';
  if (!edge.intent || edge.intent.type === 'wait') return 'EDGE_NON_GRAPH_ACTION';
  const locatorReason = locatorReplayabilityReason(edge);
  if (locatorReason) return locatorReason;
  if (edge.replayPolicy === 'NONREPEATABLE') return 'EDGE_NONREPEATABLE';
  if (edge.safety?.allowed === false) return 'EDGE_SAFETY_BLOCKED';
  if (edge.sideEffect && edge.sideEffect !== 'NONE') return 'EDGE_HAS_SIDE_EFFECT';
  const replay = edge.verification?.replayStatus || edge.replayability || 'UNVERIFIED';
  if (BLOCKED_REPLAY_STATUSES.has(replay)) return `EDGE_REPLAY_${replay}`;
  return null;
}

function isReplayableEdge(edge = {}) {
  return edgeReplayabilityReason(edge) === null;
}

module.exports = {
  PORTABLE_LOCATOR_QUALITIES,
  isSystemKeyIntent,
  locatorReplayabilityReason,
  edgeReplayabilityReason,
  isReplayableEdge
};
