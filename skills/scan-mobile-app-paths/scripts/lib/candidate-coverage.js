'use strict';

const path = require('path');
const { contextDir, readJson } = require('./common');
const { loadFrontierSuggestions } = require('./frontier-suggestions-store');

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

function candidateCoverageFromStores({ contextId, graph = {}, frontier = {}, suggestions = null, previousCoverage = null }) {
  const previousByState = new Map((previousCoverage?.states || []).map(item => [item.reachableStateId, item]));
  const suggestionItems = Array.isArray(suggestions?.items) ? suggestions.items : null;
  const states = (graph.reachableStates || []).map(state => {
    const stateFrontiers = (frontier.items || []).filter(item => item.fromReachableStateId === state.id);
    const stateSuggestions = suggestionItems
      ? suggestionItems.filter(item => item.reachableStateId === state.id)
      : null;
    const previous = previousByState.get(state.id) || {};
    const counts = stateSuggestions ? countStatuses(stateSuggestions) : {};
    const timestamps = stateSuggestions ? stateSuggestions.map(item => item.updatedAt || item.createdAt).filter(Boolean).sort() : [];
    const suggestionCount = stateSuggestions ? stateSuggestions.length : Number(previous.suggestionCount || 0);
    return {
      reachableStateId: state.id,
      frontierCount: stateFrontiers.length,
      pendingFrontierCount: stateFrontiers.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status)).length,
      suggestionCount,
      pendingSuggestionCount: stateSuggestions ? Number(counts.PENDING || 0) : Number(previous.pendingSuggestionCount || 0),
      appliedSuggestionCount: stateSuggestions ? Number(counts.APPLIED || 0) : Number(previous.appliedSuggestionCount || 0),
      blockedSuggestionCount: stateSuggestions ? Number(counts.BLOCKED || 0) : Number(previous.blockedSuggestionCount || 0),
      skippedSuggestionCount: stateSuggestions ? Number(counts.SKIPPED || 0) : Number(previous.skippedSuggestionCount || 0),
      lastSuggestedAt: stateSuggestions ? timestamps.at(-1) || null : previous.lastSuggestedAt || null,
      backfillRequired: !stateFrontiers.length && !suggestionCount
    };
  });
  return { schemaVersion: 1, contextId, states, backfillRequiredStateIds: states.filter(item => item.backfillRequired).map(item => item.reachableStateId) };
}

function candidateCoverageFromRun(scanDir, contextId, graph) {
  const frontier = readJson(path.join(contextDir(scanDir, contextId), 'frontier.json'), { schemaVersion: 1, contextId, items: [] });
  const suggestions = readJson(path.join(contextDir(scanDir, contextId), 'frontier-suggestions.json'), { schemaVersion: 1, contextId, items: [] });
  return candidateCoverageFromStores({ contextId, graph, frontier, suggestions });
}

function backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking = null }) {
  const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json'), {});
  const coverage = context.inheritedCandidateCoverage || emptyCandidateCoverage(contextId);
  const stateIds = new Set((graph.reachableStates || []).map(item => item.id));
  const suggestions = loadFrontierSuggestions(scanDir, contextId);
  const hasFrontier = new Set((frontier.items || []).map(item => item.fromReachableStateId).filter(Boolean));
  const hasSuggestion = new Set((suggestions.items || []).map(item => item.reachableStateId).filter(Boolean));
  return [...new Set(coverage.backfillRequiredStateIds || [])]
    .filter(id => stateIds.has(id))
    .filter(id => !hasFrontier.has(id) && !hasSuggestion.has(id))
    .filter(id => !dependencyBlocking?.isFrontierBlocked({ fromReachableStateId: id }))
    .sort((a, b) => {
      const left = (graph.reachableStates || []).find(item => item.id === a);
      const right = (graph.reachableStates || []).find(item => item.id === b);
      return Number(left?.depth?.pathDepth || 0) - Number(right?.depth?.pathDepth || 0) || String(a).localeCompare(String(b));
    });
}

module.exports = {
  emptyCandidateCoverage,
  candidateCoverageFromStores,
  candidateCoverageFromRun,
  backfillRequiredFromCoverage
};
