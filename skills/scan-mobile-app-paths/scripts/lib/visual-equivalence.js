'use strict';

const path = require('path');
const { contextDir, readJson, now } = require('./common');
const { loadObservationBundle } = require('./observation-store');

function equivalenceFile(scanDir, contextId) {
  return path.join(contextDir(scanDir, contextId), 'visual-equivalence.json');
}

function emptyEquivalence(contextId) {
  return { schemaVersion: 1, contextId, rules: [] };
}

function loadVisualEquivalence(scanDir, contextId) {
  return readJson(equivalenceFile(scanDir, contextId), emptyEquivalence(contextId));
}

function observationFingerprint(scanDir, observationId) {
  return loadObservationBundle(scanDir, observationId);
}

function visualForState(graph, reachableStateId) {
  const state = graph.reachableStates.find(item => item.id === reachableStateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  return { state, visual };
}

function anchorsMatch(rule, fingerprint = {}) {
  const texts = new Set(fingerprint.stableTexts || []);
  const ids = new Set(fingerprint.stableIds || []);
  return (rule.semanticAnchors?.requiredTexts || []).every(text => texts.has(text))
    && (rule.semanticAnchors?.requiredIds || []).every(id => ids.has(id));
}

function makeEquivalenceReview({ rule = null, visual, observed, observationId, comparison, assessment = null }) {
  return {
    schemaVersion: 1,
    status: 'EXPECTED_STATE_EQUIVALENT',
    source: rule ? 'CACHED_RULE' : 'HUMAN_REVIEW',
    ruleId: rule?.ruleId || null,
    expectedReachableStateId: rule?.reachableStateId || assessment?.expectedReachableStateId,
    observationId,
    comparison,
    expectedScreenshotSha256: visual.fingerprint.screenshotSha256,
    observedSha256: observed.fingerprint.screenshotSha256,
    layoutHash: observed.fingerprint.layoutHash,
    rationale: rule ? `Matched visual equivalence rule ${rule.ruleId}` : String(assessment.rationale).trim(),
    reviewedAt: now()
  };
}

function matchVisualEquivalence(scanDir, contextId, graph, reachableStateId, observationId, comparison) {
  if (comparison !== 'PROBABLE') return null;
  const { visual } = visualForState(graph, reachableStateId);
  if (!visual?.fingerprint) return null;
  const observed = observationFingerprint(scanDir, observationId);
  const rule = loadVisualEquivalence(scanDir, contextId).rules.find(item =>
    item.reachableStateId === reachableStateId
    && item.visualStateId === visual.id
    && item.layoutHash === observed.fingerprint.layoutHash
    && item.contextId === contextId
    && item.logicalScreenKey === visual.logicalScreenKey
    && anchorsMatch(item, observed.fingerprint)
  );
  return rule ? { rule, review: makeEquivalenceReview({ rule, visual, observed, observationId, comparison }) } : null;
}

module.exports = { equivalenceFile, emptyEquivalence, loadVisualEquivalence, observationFingerprint, matchVisualEquivalence, makeEquivalenceReview, visualForState };
