'use strict';

const { hashObject } = require('./common');
const { assessAction } = require('./safety');
const { compareStateEquivalence } = require('./state-equivalence');
const { loadStateEquivalence } = require('./state-equivalence-store');
const { loadObservationBundle } = require('./observation-store');

const ACCEPTED = new Set(['EXACT', 'SOURCE_CONFIRMED']);

function observationFingerprint(scanDir, observationId) {
  return loadObservationBundle(scanDir, observationId, { includeNodes: true });
}

function sourceAccepted(match) { return ACCEPTED.has(match?.status); }

function cursorStatusFor(match) {
  if (['EXACT', 'SOURCE_CONFIRMED', 'REVIEW_CONFIRMED'].includes(match?.status)) return match.status;
  return 'SOURCE_CONFIRMED';
}

function sourceEquivalence(match) {
  if (!match || match.status === 'EXACT') return null;
  return {
    type: 'SOURCE_MATCH',
    status: match.status,
    confidence: match.confidence,
    observationId: match.observationId,
    evidence: match.evidence,
    signatureHash: hashObject({ reachableStateId: match.expectedReachableStateId, evidence: match.evidence })
  };
}

function matchSourceState({ scanDir, scan, contextId, graph, reachableStateId, observationId, candidate = null }) {
  const state = graph.reachableStates.find(item => item.id === reachableStateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  if (!state || !visual?.fingerprint) return { status: 'MISMATCH', confidence: 0, reasonCode: 'SOURCE_STATE_MISSING', expectedReachableStateId: reachableStateId, observationId };
  const observed = observationFingerprint(scanDir, observationId);
  const comparison = compareStateEquivalence({
    expected: { fingerprint: visual.fingerprint },
    observed,
    candidate,
    contextId,
    expectedReachableStateId: reachableStateId,
    expectedVisualStateId: visual.id,
    rules: loadStateEquivalence(scanDir, contextId).rules
  });
  const foregroundMatched = comparison.evidence.appMatched && comparison.evidence.contextMatched && observed.observation.foreground?.bundleName === scan.target.bundleName;
  const safety = candidate ? assessAction(candidate, scan.target) : { allowed: true, risk: 'SAFE' };
  const evidence = {
    ...comparison.evidence,
    foregroundMatched,
    candidateRisk: safety.risk || null,
    comparison: comparison.status,
    equivalenceReasonCode: comparison.reasonCode,
    ruleId: comparison.ruleId || null
  };
  if (comparison.status === 'EXACT') return { status: 'EXACT', confidence: 1, expectedReachableStateId: reachableStateId, observationId, evidence };
  const safeForSource = safety.allowed !== false && (safety.risk || 'SAFE') === 'SAFE' && (safety.sideEffect || 'NONE') === 'NONE';
  const confirmed = foregroundMatched && safeForSource && comparison.status === 'SAME_PAGE';
  if (confirmed) {
    const confidence = Math.max(0.7, Math.min(0.96, comparison.confidence || 0.7));
    return { status: 'SOURCE_CONFIRMED', confidence, expectedReachableStateId: reachableStateId, observationId, evidence };
  }
  return {
    status: foregroundMatched && comparison.status === 'PROBABLE' ? 'PROBABLE' : 'MISMATCH',
    confidence: foregroundMatched ? comparison.confidence || 0 : 0,
    expectedReachableStateId: reachableStateId,
    observationId,
    evidence,
    reasonCode: foregroundMatched ? comparison.reasonCode || 'SOURCE_ANCHORS_INSUFFICIENT' : 'APP_OR_CONTEXT_MISMATCH'
  };
}

module.exports = { matchSourceState, sourceAccepted, cursorStatusFor, sourceEquivalence, observationFingerprint };
