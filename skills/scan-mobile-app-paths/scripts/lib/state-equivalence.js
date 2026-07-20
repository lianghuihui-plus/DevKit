'use strict';

const { compareFingerprint } = require('./fingerprint');
const { extractSemanticFingerprint, flattenLayout, overlapScore, candidateControlMatch } = require('./semantic-fingerprint');

const SAME_PAGE_STATUSES = new Set(['EXACT', 'SAME_PAGE']);

function semanticFrom(input = {}) {
  if (input.semantic) return input.semantic;
  if (input.fingerprint?.semantic) return input.fingerprint.semantic;
  if (input.layout) return extractSemanticFingerprint(input.layout);
  return {
    schemaVersion: 1,
    stableTexts: input.fingerprint?.stableTexts || [],
    stableIds: input.fingerprint?.stableIds || [],
    stableRoles: input.fingerprint?.stableRoles || [],
    titles: [],
    tabs: [],
    navItems: [],
    primaryActions: [],
    dynamicTexts: [],
    nodeCount: 0,
    roleSkeletonHash: null,
    coarseRoleSkeletonHash: null
  };
}

function nodesFrom(input = {}) {
  if (Array.isArray(input.nodes)) return input.nodes;
  if (input.layout) return flattenLayout(input.layout);
  return [];
}

function foregroundOf(input = {}) {
  const fingerprint = input.fingerprint || {};
  const foreground = input.observation?.foreground || input.foreground || {};
  return {
    app: fingerprint.app ?? foreground.bundleName ?? null,
    ability: fingerprint.ability ?? foreground.ability ?? null,
    contextId: input.observation?.contextId ?? input.contextId ?? null
  };
}

function scoreEvidence(expectedSemantic, observedSemantic, expectedFingerprint = {}, observedFingerprint = {}, observedNodes = [], candidate = null) {
  const textScore = overlapScore(expectedSemantic.stableTexts || expectedFingerprint.stableTexts || [], observedSemantic.stableTexts || observedFingerprint.stableTexts || []);
  const idScore = overlapScore(expectedSemantic.stableIds || expectedFingerprint.stableIds || [], observedSemantic.stableIds || observedFingerprint.stableIds || []);
  const roleScore = overlapScore(expectedSemantic.stableRoles || expectedFingerprint.stableRoles || [], observedSemantic.stableRoles || observedFingerprint.stableRoles || []);
  const titleScore = overlapScore(expectedSemantic.titles || [], observedSemantic.titles || []);
  const tabScore = overlapScore(expectedSemantic.tabs || [], observedSemantic.tabs || []);
  const navScore = overlapScore(expectedSemantic.navItems || [], observedSemantic.navItems || []);
  const primaryActionScore = overlapScore(expectedSemantic.primaryActions || [], observedSemantic.primaryActions || []);
  const sameLayout = Boolean(expectedFingerprint.layoutHash && expectedFingerprint.layoutHash === observedFingerprint.layoutHash);
  const sameCoarseStructure = Boolean(expectedSemantic.coarseRoleSkeletonHash && expectedSemantic.coarseRoleSkeletonHash === observedSemantic.coarseRoleSkeletonHash);
  const sameRoleStructure = Boolean(expectedSemantic.roleSkeletonHash && expectedSemantic.roleSkeletonHash === observedSemantic.roleSkeletonHash);
  const control = candidate ? candidateControlMatch(observedNodes, candidate) : { matched: false, textMatched: false, idMatched: false, boundsMatched: false };
  const anchorScore = Math.max(textScore, idScore, titleScore, tabScore, navScore, primaryActionScore, (textScore + idScore) / 2);
  return {
    sameLayout,
    sameRoleStructure,
    sameCoarseStructure,
    textScore,
    idScore,
    roleScore,
    titleScore,
    tabScore,
    navScore,
    primaryActionScore,
    anchorScore,
    candidateControlMatched: control.matched,
    candidateControlTextMatched: control.textMatched,
    candidateControlIdMatched: control.idMatched,
    candidateControlBoundsMatched: control.boundsMatched
  };
}

function hasRequiredAnchors(rule, semantic = {}, fingerprint = {}) {
  const texts = new Set([...(semantic.stableTexts || []), ...(fingerprint.stableTexts || [])]);
  const ids = new Set([...(semantic.stableIds || []), ...(fingerprint.stableIds || [])]);
  const titles = new Set(semantic.titles || []);
  const tabs = new Set(semantic.tabs || []);
  const anchors = rule.semanticAnchors || {};
  return (anchors.requiredTexts || []).every(text => texts.has(text))
    && (anchors.requiredIds || []).every(id => ids.has(id))
    && (anchors.requiredTitles || []).every(text => titles.has(text))
    && (anchors.requiredTabs || []).every(text => tabs.has(text));
}

function matchingRule({ rules = [], expectedReachableStateId, expectedVisualStateId, contextId, observedSemantic, observedFingerprint }) {
  return (rules || []).find(rule =>
    (!rule.contextId || !contextId || rule.contextId === contextId)
    && (!rule.reachableStateId || !expectedReachableStateId || rule.reachableStateId === expectedReachableStateId)
    && (!rule.visualStateId || !expectedVisualStateId || rule.visualStateId === expectedVisualStateId)
    && hasRequiredAnchors(rule, observedSemantic, observedFingerprint)
  ) || null;
}

function compareStateEquivalence({ expected, observed, candidate = null, rules = [], expectedReachableStateId = null, expectedVisualStateId = null, contextId = null } = {}) {
  const expectedFingerprint = expected?.fingerprint || null;
  const observedFingerprint = observed?.fingerprint || null;
  if (!expectedFingerprint || !observedFingerprint) {
    return { status: 'UNCERTAIN', confidence: 0, reasonCode: 'FINGERPRINT_MISSING', evidence: {} };
  }

  const expectedForeground = foregroundOf(expected);
  const observedForeground = foregroundOf(observed);
  const appMatched = !expectedForeground.app || !observedForeground.app || expectedForeground.app === observedForeground.app;
  const abilityMatched = !expectedForeground.ability || !observedForeground.ability || expectedForeground.ability === observedForeground.ability;
  const contextMatched = !contextId || !observedForeground.contextId || observedForeground.contextId === contextId;
  const baseComparison = compareFingerprint(expectedFingerprint, observedFingerprint);
  const expectedSemantic = semanticFrom(expected);
  const observedSemantic = semanticFrom(observed);
  const observedNodes = nodesFrom(observed);
  const scores = scoreEvidence(expectedSemantic, observedSemantic, expectedFingerprint, observedFingerprint, observedNodes, candidate);
  const evidence = {
    appMatched,
    abilityMatched,
    contextMatched,
    baseComparison,
    ...scores
  };

  if (!appMatched || !abilityMatched || !contextMatched) {
    return { status: 'DIFFERENT', confidence: 0, reasonCode: 'APP_OR_CONTEXT_MISMATCH', evidence };
  }
  if (baseComparison === 'EXACT') {
    return { status: 'EXACT', confidence: 1, reasonCode: 'FINGERPRINT_EXACT', evidence };
  }

  const rule = matchingRule({ rules, expectedReachableStateId, expectedVisualStateId, contextId, observedSemantic, observedFingerprint });
  if (rule) {
    return { status: 'SAME_PAGE', confidence: 0.98, reasonCode: 'STATE_EQUIVALENCE_RULE_MATCHED', ruleId: rule.ruleId, rule, evidence };
  }

  const different =
    (expectedSemantic.titles || []).length
    && (observedSemantic.titles || []).length
    && scores.titleScore === 0
    && scores.textScore < 0.2
    && scores.navScore < 0.2;
  if (different) {
    return { status: 'DIFFERENT', confidence: 1 - Math.max(scores.textScore, scores.idScore * 0.2), reasonCode: 'SEMANTIC_CONFLICT', evidence };
  }

  const samePage =
    scores.sameLayout
    || scores.sameRoleStructure
    || (scores.sameCoarseStructure && Math.max(scores.textScore, scores.titleScore, scores.navScore, scores.tabScore) >= 0.35)
    || (scores.titleScore >= 0.75 && (scores.textScore >= 0.3 || scores.roleScore >= 0.55))
    || (scores.navScore >= 0.6 && scores.textScore >= 0.35)
    || (scores.idScore >= 0.5 && scores.roleScore >= 0.45 && (scores.textScore >= 0.25 || scores.titleScore > 0 || scores.navScore > 0))
    || (scores.textScore >= 0.6 && scores.roleScore >= 0.45)
    || (scores.candidateControlMatched && Math.max(scores.textScore, scores.titleScore, scores.navScore, scores.tabScore) >= 0.3);
  if (samePage) {
    const confidence = Math.min(0.96, Math.max(0.72,
      (scores.sameLayout ? 0.28 : 0)
      + (scores.sameRoleStructure ? 0.2 : 0)
      + (scores.sameCoarseStructure ? 0.12 : 0)
      + scores.anchorScore * 0.34
      + scores.roleScore * 0.14
      + (scores.candidateControlMatched ? 0.08 : 0)
    ));
    return { status: 'SAME_PAGE', confidence, reasonCode: 'SEMANTIC_ANCHORS_MATCHED', evidence };
  }

  const probable = scores.anchorScore >= 0.25 || scores.roleScore >= 0.5 || baseComparison === 'PROBABLE';
  if (probable) {
    return { status: 'PROBABLE', confidence: Math.max(scores.anchorScore, scores.roleScore * 0.5, baseComparison === 'PROBABLE' ? 0.5 : 0), reasonCode: 'SEMANTIC_ANCHORS_PARTIAL', evidence };
  }
  return { status: 'UNCERTAIN', confidence: Math.max(scores.anchorScore, scores.roleScore * 0.4), reasonCode: 'SEMANTIC_ANCHORS_INSUFFICIENT', evidence };
}

function isSamePage(resultOrStatus) {
  const status = typeof resultOrStatus === 'string' ? resultOrStatus : resultOrStatus?.status;
  return SAME_PAGE_STATUSES.has(status);
}

module.exports = { compareStateEquivalence, isSamePage, semanticFrom, nodesFrom };
