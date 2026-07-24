'use strict';

const path = require('path');
const { contextDir, readJson, hashObject, now } = require('./common');
const { loadFrontierSuggestions } = require('./frontier-suggestions-store');
const { runBudget, maxCandidatesPerState, maxTotalCandidatesPerState } = require('./run-protocol');
const { candidateRulesForScan } = require('./candidate-rules');

function emptyCandidateCoverage(contextId) {
  return { schemaVersion: 1, contextId, states: [], backfillRequiredStateIds: [] };
}

function countStatuses(items = []) {
  return items.reduce((sum, item) => {
    const status = item.status || 'UNKNOWN';
    sum[status] = (sum[status] || 0) + 1;
    return sum;
  }, {});
}

function isNoCandidateSuggestion(item = {}) {
  return item.source === 'NO_CANDIDATES' && item.reasonCode === 'NO_CANDIDATES_EXTRACTED';
}

function isDynamicDataCandidate(item = {}) {
  return ['DYNAMIC_DATA_ITEM', 'BUSINESS_DATA_ITEM'].includes(item.candidateClass || item.classification?.candidateClass || item.source);
}

function countedCandidateItem(item = {}) {
  return Boolean(item?.candidate) && !isNoCandidateSuggestion(item) && !isDynamicDataCandidate(item);
}

function candidateHashForItem(item = {}) {
  if (!countedCandidateItem(item)) return null;
  return item.candidateHash || hashObject(item.candidate);
}

function candidateCoverageBasis({ state = {}, visualState = {}, scan = null, budget = null, candidateRules = null } = {}) {
  const value = {
    visualStateId: state.visualStateId || visualState.id || null,
    layoutHash: visualState.fingerprint?.layoutHash || null,
    semanticHash: visualState.fingerprint?.semantic ? hashObject(visualState.fingerprint.semantic) : null,
    extractorRevision: 'dynamic-frontier-candidates-v2',
    candidateRulesHash: candidateRules ? hashObject(candidateRules) : null,
    profile: scan?.profile || null,
    maxCandidatesPerState: budget ? maxCandidatesPerState(budget) : null,
    maxTotalCandidatesPerState: budget ? maxTotalCandidatesPerState(budget) : null
  };
  return { ...value, basisHash: hashObject(value) };
}

function coverageBasisChanged(previousBasis = null, currentBasis = null) {
  if (!previousBasis?.basisHash || !currentBasis?.basisHash) return true;
  return previousBasis.basisHash !== currentBasis.basisHash;
}

function candidateSeedRefFromSuggestion(suggestion, sourceRunId = null) {
  if (!suggestion?.candidate || suggestion.status !== 'PENDING') return null;
  return {
    sourceRunId: suggestion.sourceRunId || sourceRunId || suggestion.observationRef?.runId || null,
    sourceSuggestionId: suggestion.sourceSuggestionId || suggestion.suggestionId,
    reachableStateId: suggestion.reachableStateId,
    visualStateId: suggestion.visualStateId,
    observationId: suggestion.observationId,
    observationRef: suggestion.observationRef || null,
    evidenceSource: suggestion.evidenceSource || null,
    candidateGroupKey: suggestion.candidateGroupKey,
    candidate: suggestion.candidate,
    candidateHash: suggestion.candidateHash || hashObject(suggestion.candidate),
    source: suggestion.source,
    candidateClass: suggestion.candidateClass || null,
    classification: suggestion.classification || null,
    confidence: suggestion.confidence ?? null,
    priority: suggestion.priority || {},
    risk: suggestion.risk || null,
    safety: suggestion.safety || null,
    reviewRequirement: suggestion.reviewRequirement || null,
    visualCandidateReviewId: suggestion.visualCandidateReviewId || null,
    visualCandidateReviewSourceRunId: suggestion.visualCandidateReviewSourceRunId || suggestion.visualCandidateReviewRef?.runId || (suggestion.visualCandidateReviewId ? sourceRunId || null : null),
    reviewOrigin: suggestion.reviewOrigin || null,
    rationale: suggestion.rationale || null
  };
}

function suggestionFromCandidateSeed(contextId, seed, suggestionId, createdAt = now()) {
  return {
    schemaVersion: 1,
    suggestionId,
    contextId,
    reachableStateId: seed.reachableStateId,
    visualStateId: seed.visualStateId,
    observationId: seed.observationId,
    observationRef: seed.observationRef || (seed.sourceRunId && seed.observationId ? { runId: seed.sourceRunId, observationId: seed.observationId } : null),
    evidenceSource: seed.evidenceSource || (seed.sourceRunId ? 'CANONICAL_REF' : 'LOCAL_RUN'),
    candidateGroupKey: seed.candidateGroupKey,
    candidate: seed.candidate,
    candidateHash: seed.candidateHash || hashObject(seed.candidate),
    source: seed.source,
    candidateClass: seed.candidateClass || null,
    classification: seed.classification || null,
    confidence: seed.confidence ?? null,
    priority: seed.priority || {},
    risk: seed.risk || null,
    safety: seed.safety || { allowed: true, reasonCode: null },
    reviewRequirement: seed.reviewRequirement || null,
    status: 'PENDING',
    sourceRunId: seed.sourceRunId || null,
    sourceSuggestionId: seed.sourceSuggestionId || null,
    visualCandidateReviewId: seed.visualCandidateReviewId || null,
    visualCandidateReviewSourceRunId: seed.visualCandidateReviewId ? seed.visualCandidateReviewSourceRunId || seed.sourceRunId || null : null,
    reviewOrigin: seed.reviewOrigin || 'SEEDED_FROM_CANONICAL_COVERAGE',
    rationale: seed.rationale || null,
    createdAt,
    updatedAt: createdAt,
    reasonCode: null,
    frontierId: null
  };
}

function suggestionsFromCoverageSeeds(contextId, coverage = {}, createdAt = now()) {
  const seeds = [];
  for (const state of coverage.states || []) for (const seed of state.candidateSeedRefs || []) seeds.push(seed);
  return {
    schemaVersion: 1,
    contextId,
    items: seeds.map((seed, index) => suggestionFromCandidateSeed(contextId, seed, `suggest-${String(index + 1).padStart(4, '0')}`, createdAt))
  };
}

function candidateCoverageFromStores({ contextId, graph = {}, frontier = {}, suggestions = null, previousCoverage = null, sourceRunId = null, scan = null, budget = null, candidateRules = null }) {
  const previousByState = new Map((previousCoverage?.states || []).map(item => [item.reachableStateId, item]));
  const suggestionItems = Array.isArray(suggestions?.items) ? suggestions.items : null;
  const visualById = new Map((graph.visualStates || []).map(item => [item.id, item]));
  const states = (graph.reachableStates || []).map(state => {
    const stateFrontiers = (frontier.items || []).filter(item => item.fromReachableStateId === state.id);
    const stateSuggestions = suggestionItems
      ? suggestionItems.filter(item => item.reachableStateId === state.id)
      : null;
    const previous = previousByState.get(state.id) || {};
    const counts = stateSuggestions ? countStatuses(stateSuggestions) : {};
    const timestamps = stateSuggestions ? stateSuggestions.map(item => item.updatedAt || item.createdAt).filter(Boolean).sort() : [];
    const suggestionCount = stateSuggestions ? stateSuggestions.length : Number(previous.suggestionCount || 0);
    const pendingSuggestionCount = stateSuggestions ? Number(counts.PENDING || 0) : Number(previous.pendingSuggestionCount || 0);
    const appliedSuggestionCount = stateSuggestions ? Number(counts.APPLIED || 0) : Number(previous.appliedSuggestionCount || 0);
    const computedCoverageBasis = candidateCoverageBasis({ state, visualState: visualById.get(state.visualStateId) || {}, scan, budget, candidateRules });
    const coverageBasis = !scan && !budget && !candidateRules && previous.candidateCoverageBasis ? previous.candidateCoverageBasis : computedCoverageBasis;
    const currentNoCandidateSuggestions = stateSuggestions ? stateSuggestions.filter(isNoCandidateSuggestion) : [];
    const dynamicAuditSuppressedCount = stateSuggestions
      ? stateSuggestions.reduce((sum, item) => sum + Number(item.dynamicAudit?.suppressedCount || 0), 0)
      : Number(previous.dynamicAuditSuppressedCount || 0);
    const dynamicDataSuggestionCount = stateSuggestions
      ? stateSuggestions.filter(isDynamicDataCandidate).length
      : Number(previous.dynamicDataSuggestionCount || 0);
    const validCurrentNoCandidateCount = currentNoCandidateSuggestions.filter(item => !coverageBasisChanged(item.candidateCoverageBasis || previous.candidateCoverageBasis, coverageBasis)).length;
    const previousExhaustedValid = previous.candidateCoverageStatus === 'EXHAUSTED' && !coverageBasisChanged(previous.candidateCoverageBasis, coverageBasis);
    const noCandidateSuggestionCount = stateSuggestions
      ? validCurrentNoCandidateCount + (validCurrentNoCandidateCount ? 0 : previousExhaustedValid ? Number(previous.noCandidateSuggestionCount || 1) : 0)
      : previousExhaustedValid ? Number(previous.noCandidateSuggestionCount || 1) : 0;
    const candidateHashes = new Set([
      ...stateFrontiers.map(candidateHashForItem).filter(Boolean),
      ...((stateSuggestions || []).map(candidateHashForItem).filter(Boolean)),
      ...(Array.isArray(previous.seenCandidateHashes) ? previous.seenCandidateHashes : [])
    ]);
    const knownCandidateCount = Math.max(candidateHashes.size, Number(previous.knownCandidateCount || 0));
    const candidateCoverageStatus = noCandidateSuggestionCount > 0 ? 'EXHAUSTED' : knownCandidateCount > 0 ? 'PARTIAL' : 'UNKNOWN';
    const backfillRequired = candidateCoverageStatus !== 'EXHAUSTED';
    const candidateSeedRefs = stateSuggestions
      ? stateSuggestions.map(item => candidateSeedRefFromSuggestion(item, sourceRunId)).filter(Boolean).concat(stateSuggestions.length ? [] : previous.candidateSeedRefs || [])
      : previous.candidateSeedRefs || [];
    return {
      reachableStateId: state.id,
      frontierCount: stateFrontiers.length,
      pendingFrontierCount: stateFrontiers.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status)).length,
      suggestionCount,
      pendingSuggestionCount,
      appliedSuggestionCount,
      noCandidateSuggestionCount,
      blockedSuggestionCount: stateSuggestions ? Number(counts.BLOCKED || 0) : Number(previous.blockedSuggestionCount || 0),
      skippedSuggestionCount: stateSuggestions ? Number(counts.SKIPPED || 0) : Number(previous.skippedSuggestionCount || 0),
      dynamicDataSuggestionCount,
      dynamicAuditSuppressedCount,
      lastSuggestedAt: stateSuggestions ? timestamps.at(-1) || null : previous.lastSuggestedAt || null,
      candidateSeedRefs,
      knownCandidateCount,
      seenCandidateHashes: [...candidateHashes].sort().slice(0, 200),
      candidateCoverageStatus,
      candidateCoverageBasis: coverageBasis,
      backfillRequired,
      backfillReasonCode: backfillRequired
        ? previous.candidateCoverageStatus === 'EXHAUSTED' && coverageBasisChanged(previous.candidateCoverageBasis, coverageBasis)
          ? 'CANDIDATE_COVERAGE_BASIS_CHANGED'
          : candidateCoverageStatus === 'UNKNOWN' ? 'CANDIDATE_COVERAGE_UNKNOWN' : 'CANDIDATE_COVERAGE_PARTIAL'
        : null
    };
  });
  return { schemaVersion: 1, contextId, states, backfillRequiredStateIds: states.filter(item => item.backfillRequired).map(item => item.reachableStateId) };
}

function candidateCoverageAfterCanonicalEdit({ contextId, graph = {}, frontier = {}, previousCoverage = null, invalidatedReachableStateIds = [] }) {
  const invalidated = new Set([...invalidatedReachableStateIds].filter(Boolean));
  const coverage = candidateCoverageFromStores({ contextId, graph, frontier, previousCoverage });
  const frontierItems = frontier.items || [];
  coverage.states = coverage.states.map(state => {
    if (!invalidated.has(state.reachableStateId)) return state;
    const stateFrontiers = frontierItems.filter(item => item.fromReachableStateId === state.reachableStateId);
    return {
      ...state,
      frontierCount: stateFrontiers.length,
      pendingFrontierCount: stateFrontiers.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status)).length,
      suggestionCount: 0,
      pendingSuggestionCount: 0,
      appliedSuggestionCount: 0,
      noCandidateSuggestionCount: 0,
      blockedSuggestionCount: 0,
      skippedSuggestionCount: 0,
      dynamicDataSuggestionCount: 0,
      dynamicAuditSuppressedCount: 0,
      lastSuggestedAt: null,
      candidateSeedRefs: [],
      knownCandidateCount: 0,
      seenCandidateHashes: [],
      candidateCoverageStatus: 'UNKNOWN',
      backfillRequired: true,
      backfillReasonCode: 'MAP_EDIT_INVALIDATED_CANDIDATE_COVERAGE'
    };
  });
  coverage.backfillRequiredStateIds = coverage.states.filter(item => item.backfillRequired).map(item => item.reachableStateId);
  return coverage;
}

function candidateCoverageFromRun(scanDir, contextId, graph) {
  const frontier = readJson(path.join(contextDir(scanDir, contextId), 'frontier.json'), { schemaVersion: 1, contextId, items: [] });
  const suggestions = readJson(path.join(contextDir(scanDir, contextId), 'frontier-suggestions.json'), { schemaVersion: 1, contextId, items: [] });
  const scan = readJson(path.join(scanDir, 'scan.json'), {});
  const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json'), {});
  const budget = runBudget(scan, contextId);
  const candidateRules = candidateRulesForScan(scanDir, scan);
  return candidateCoverageFromStores({ contextId, graph, frontier, suggestions, previousCoverage: context.inheritedCandidateCoverage || null, sourceRunId: scan.scanId || null, scan, budget, candidateRules });
}

function backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking = null, coverage = null }) {
  const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json'), {});
  const coverageDoc = coverage || context.inheritedCandidateCoverage || emptyCandidateCoverage(contextId);
  const stateIds = new Set((graph.reachableStates || []).map(item => item.id));
  const suggestions = loadFrontierSuggestions(scanDir, contextId);
  const scan = readJson(path.join(scanDir, 'scan.json'), {});
  const budget = runBudget(scan, contextId);
  const candidateRules = candidateRulesForScan(scanDir, scan);
  const totalLimit = maxTotalCandidatesPerState(budget);
  const visualById = new Map((graph.visualStates || []).map(item => [item.id, item]));
  const stateHasCandidateEvidence = id => {
    const state = (graph.reachableStates || []).find(item => item.id === id);
    const visual = state && visualById.get(state.visualStateId);
    return Boolean((visual?.evidenceObservationIds || []).length || (visual?.evidenceObservationRefs || []).length);
  };
  const basisByState = new Map((graph.reachableStates || []).map(state => [state.id, candidateCoverageBasis({ state, visualState: visualById.get(state.visualStateId) || {}, scan, budget, candidateRules })]));
  const openFrontier = new Set((frontier.items || [])
    .filter(item => ['PENDING', 'RETRYABLE', 'CLAIMED'].includes(item.status))
    .map(item => item.fromReachableStateId)
    .filter(Boolean));
  const pendingSuggestion = new Set((suggestions.items || [])
    .filter(item => item.status === 'PENDING')
    .map(item => item.reachableStateId)
    .filter(Boolean));
  const validCurrentNoCandidate = new Set((suggestions.items || [])
    .filter(item => isNoCandidateSuggestion(item) && !coverageBasisChanged(item.candidateCoverageBasis, basisByState.get(item.reachableStateId)))
    .map(item => item.reachableStateId)
    .filter(Boolean));
  const coverageByState = new Map((coverageDoc.states || []).map(item => [item.reachableStateId, item]));
  const currentKnownByState = new Map();
  const rememberCurrent = (id, item) => {
    if (!id || !countedCandidateItem(item)) return;
    if (!currentKnownByState.has(id)) currentKnownByState.set(id, new Set());
    currentKnownByState.get(id).add(item.candidateGroupKey || candidateHashForItem(item));
  };
  for (const item of frontier.items || []) {
    rememberCurrent(item.fromReachableStateId, item);
  }
  for (const item of suggestions.items || []) {
    rememberCurrent(item.reachableStateId, item);
  }
  const candidateIds = (graph.reachableStates || [])
    .map(item => item.id)
    .filter(id => {
      const stateCoverage = coverageByState.get(id);
      if (!stateCoverage) return true;
      if (stateCoverage.backfillReasonCode === 'MAP_EDIT_INVALIDATED_CANDIDATE_COVERAGE') return true;
      if (stateCoverage.candidateCoverageStatus === 'EXHAUSTED') return coverageBasisChanged(stateCoverage.candidateCoverageBasis, basisByState.get(id));
      return stateCoverage.backfillRequired !== false;
    });
  return [...new Set(candidateIds)]
    .filter(id => stateIds.has(id))
    .filter(id => stateHasCandidateEvidence(id))
    .filter(id => coverageByState.get(id)?.candidateCoverageStatus !== 'EXHAUSTED' || coverageBasisChanged(coverageByState.get(id)?.candidateCoverageBasis, basisByState.get(id)))
    .filter(id => !validCurrentNoCandidate.has(id))
    .filter(id => coverageByState.get(id)?.backfillReasonCode === 'MAP_EDIT_INVALIDATED_CANDIDATE_COVERAGE' || !openFrontier.has(id))
    .filter(id => !pendingSuggestion.has(id))
    .filter(id => {
      const invalidated = coverageByState.get(id)?.backfillReasonCode === 'MAP_EDIT_INVALIDATED_CANDIDATE_COVERAGE';
      const known = Math.max(Number(coverageByState.get(id)?.knownCandidateCount || 0), Number(currentKnownByState.get(id)?.size || 0));
      return invalidated || !Number.isFinite(totalLimit) || known < totalLimit;
    })
    .filter(id => !dependencyBlocking?.isFrontierBlocked({ fromReachableStateId: id }))
    .sort((a, b) => {
      const left = (graph.reachableStates || []).find(item => item.id === a);
      const right = (graph.reachableStates || []).find(item => item.id === b);
      return Number(left?.depth?.pathDepth || 0) - Number(right?.depth?.pathDepth || 0) || String(a).localeCompare(String(b));
    });
}

function backfillRequiredFromCurrentRun({ scanDir, contextId, graph, frontier, dependencyBlocking = null }) {
  const coverage = candidateCoverageFromRun(scanDir, contextId, graph);
  return backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking, coverage });
}

module.exports = {
  emptyCandidateCoverage,
  candidateCoverageBasis,
  coverageBasisChanged,
  candidateCoverageFromStores,
  candidateCoverageAfterCanonicalEdit,
  candidateCoverageFromRun,
  suggestionsFromCoverageSeeds,
  suggestionFromCandidateSeed,
  backfillRequiredFromCoverage,
  backfillRequiredFromCurrentRun
};
