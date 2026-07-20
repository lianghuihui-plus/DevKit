'use strict';

const path = require('path');
const { contextDir, readJson, hashObject, now, commitEvent } = require('./common');
const { semanticFrom } = require('./state-equivalence');
const { loadObservationBundle } = require('./observation-store');

function stateEquivalenceFile(scanDir, contextId) {
  return path.join(contextDir(scanDir, contextId), 'state-equivalence.json');
}

function emptyStateEquivalence(contextId) {
  return { schemaVersion: 1, contextId, rules: [] };
}

function loadStateEquivalence(scanDir, contextId) {
  return readJson(stateEquivalenceFile(scanDir, contextId), emptyStateEquivalence(contextId));
}

function observationFingerprint(scanDir, observationId) {
  return loadObservationBundle(scanDir, observationId);
}

function visualForState(graph, reachableStateId) {
  const state = graph.reachableStates.find(item => item.id === reachableStateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  return { state, visual };
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function intersect(left = [], right = [], limit = 8) {
  const rightSet = new Set(right.filter(Boolean).map(String));
  return unique(left).filter(item => rightSet.has(item)).slice(0, limit);
}

function semanticInput(value = {}) {
  if (value.semantic) return { semantic: value.semantic };
  if (value.fingerprint) return { fingerprint: value.fingerprint };
  return { fingerprint: value };
}

function mergedStrongTexts(semantic = {}) {
  return unique([
    ...(semantic.titles || []),
    ...(semantic.tabs || []),
    ...(semantic.navItems || []),
    ...(semantic.primaryActions || [])
  ]);
}

function semanticAnchors(fingerprint = {}, observed = null) {
  const semantic = semanticFrom({ fingerprint });
  const observedSemantic = observed ? semanticFrom(semanticInput(observed)) : null;
  const strongTexts = mergedStrongTexts(semantic);
  const observedStrongTexts = observedSemantic ? mergedStrongTexts(observedSemantic) : null;
  const stableTexts = unique(semantic.stableTexts || fingerprint.stableTexts || []);
  const observedStableTexts = observedSemantic ? unique(observedSemantic.stableTexts || []) : null;
  const stableIds = unique(semantic.stableIds || fingerprint.stableIds || []);
  const observedStableIds = observedSemantic ? unique(observedSemantic.stableIds || []) : null;

  const requiredTitles = observedSemantic
    ? intersect(semantic.titles || [], observedSemantic.titles || [], 3)
    : unique(semantic.titles || []).slice(0, 2);
  const requiredTabs = observedSemantic
    ? intersect(unique([...(semantic.tabs || []), ...(semantic.navItems || [])]), unique([...(observedSemantic.tabs || []), ...(observedSemantic.navItems || [])]), 4)
    : unique([...(semantic.tabs || []), ...(semantic.navItems || [])]).slice(0, 3);
  const strongTextIntersection = observedSemantic ? intersect(strongTexts, observedStrongTexts, 5) : strongTexts.slice(0, 4);
  const stableTextIntersection = observedSemantic ? intersect(stableTexts, observedStableTexts, 3) : [];
  const requiredTexts = unique([...strongTextIntersection, ...stableTextIntersection]).slice(0, 6);
  const requiredIds = observedSemantic ? intersect(stableIds, observedStableIds, 6) : stableIds.slice(0, 4);

  return {
    requiredTexts,
    requiredIds,
    requiredTitles,
    requiredTabs
  };
}

function makeStateEquivalenceReview({ rule = null, visual, observed, observationId, comparison, assessment = null }) {
  return {
    schemaVersion: 2,
    status: 'EXPECTED_STATE_EQUIVALENT',
    source: rule ? 'CACHED_RULE' : 'HUMAN_REVIEW',
    ruleId: rule?.ruleId || null,
    expectedReachableStateId: rule?.reachableStateId || assessment?.expectedReachableStateId,
    observationId,
    comparison,
    expectedScreenshotSha256: visual.fingerprint.screenshotSha256,
    observedSha256: observed.fingerprint.screenshotSha256,
    layoutHash: observed.fingerprint.layoutHash,
    semanticEvidence: observed.fingerprint.semantic || null,
    rationale: rule ? `Matched state equivalence rule ${rule.ruleId}` : String(assessment.rationale).trim(),
    reviewedAt: now()
  };
}

function recordStateEquivalenceRule(scanDir, contextId, graph, checkpoint, accepted) {
  const { visual } = visualForState(graph, checkpoint.expectedReachableStateId);
  if (!visual?.fingerprint) return null;
  const anchors = semanticAnchors(visual.fingerprint, { semantic: accepted.semanticEvidence });
  if (!anchors.requiredTexts.length && !anchors.requiredIds.length && !anchors.requiredTitles.length && !anchors.requiredTabs.length) return null;
  const rule = {
    schemaVersion: 1,
    ruleId: `seq-${hashObject({ contextId, reachableStateId: checkpoint.expectedReachableStateId, visualStateId: visual.id, anchors }).slice(-16)}`,
    contextId,
    reachableStateId: checkpoint.expectedReachableStateId,
    visualStateId: visual.id,
    logicalScreenKey: visual.logicalScreenKey,
    semanticAnchors: anchors,
    allowedVariance: ['screenshotSha256', 'layoutHash', 'dynamicTexts', 'listItems'],
    createdFrom: {
      restoreId: accepted.restoreId || null,
      attemptId: accepted.attemptId || null,
      observationId: accepted.observationId
    },
    humanAssessment: {
      status: accepted.status,
      rationale: accepted.rationale
    },
    createdAt: now()
  };
  const existing = loadStateEquivalence(scanDir, contextId).rules.find(item => item.ruleId === rule.ruleId);
  if (existing) return existing;
  commitEvent(scanDir, 'stateEquivalenceRuleRecorded', { contextId, rule }, [{ path: `contexts/${contextId}/state-equivalence.json`, op: 'UPSERT', collection: 'rules', keyFields: ['ruleId'], value: rule, fallback: emptyStateEquivalence(contextId) }]);
  return rule;
}

module.exports = {
  stateEquivalenceFile,
  emptyStateEquivalence,
  loadStateEquivalence,
  observationFingerprint,
  visualForState,
  semanticAnchors,
  makeStateEquivalenceReview,
  recordStateEquivalenceRule
};
