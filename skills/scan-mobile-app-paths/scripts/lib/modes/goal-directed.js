'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('../common');
const { applyGoalGuidance } = require('../frontier-candidate-extractor');
const { normalizeText } = require('../semantic-fingerprint');
const { knownTargetPrecheckWork } = require('../goal-known-target-precheck');
const { modeContract } = require('./contracts');

function loadGuidance({ scanDir }) {
  const file = path.join(scanDir, 'goal', 'goal.json');
  return fs.existsSync(file) ? readJson(file, null) : null;
}

function routeStep(item = {}) {
  const value = item.routeHintStep ?? item.priority?.routeHintStep;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function goalRelevance(item = {}) {
  return Number(item.priority?.goalRelevance || 0);
}

function isGoalRelevant(item = {}) {
  return goalRelevance(item) > 0 || routeStep(item) !== null || (item.guideMatchedTexts || []).length > 0;
}

function goalRankTuple(item = {}) {
  return [
    isGoalRelevant(item) ? 0 : 1,
    -(routeStep(item) ?? -1),
    -goalRelevance(item),
    Number(item.priority?.riskRank ?? 9),
    Number(item.priority?.entryRank ?? 9),
    Number(item.priority?.selectorRank ?? 9),
    Number(item.priority?.nextPathDepth ?? 999),
    String(item.suggestionId || item.id || item.candidateGroupKey || '')
  ];
}

function compareTuple(left, right) {
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

function sortedGoalItems(items = []) {
  return [...items].sort((a, b) => compareTuple(goalRankTuple(a), goalRankTuple(b)));
}

function filterGoalItems(items = []) {
  const sorted = sortedGoalItems(items);
  const relevant = sorted.filter(isGoalRelevant);
  return relevant.length ? relevant : sorted;
}

function goalTerms(goalSpec = null) {
  if (!goalSpec) return [];
  const guide = goalSpec.guideSpec || {};
  const target = goalSpec.targetSpec || goalSpec.successCriteria || {};
  return [
    ...(guide.routeHints || []).map((text, index) => ({ text, routeIndex: index, weight: 4 })),
    ...(guide.preferredTexts || []).map(text => ({ text, routeIndex: null, weight: 3 })),
    ...(guide.semanticHints || []).map(text => ({ text, routeIndex: null, weight: 2 })),
    ...(target.requiredTexts || []).map(text => ({ text, routeIndex: null, weight: 3 })),
    ...(target.optionalTexts || []).map(text => ({ text, routeIndex: null, weight: 1 }))
  ].map(item => ({ ...item, normalized: normalizeText(item.text) })).filter(item => item.normalized);
}

function stateGoalRank({ state, graph, guidance }) {
  const visual = (graph.visualStates || []).find(item => item.id === state.visualStateId) || {};
  const logical = (graph.logicalScreens || []).find(item => item.id === visual.logicalScreenKey || item.id === visual.logicalScreenId) || {};
  const semantic = visual.fingerprint?.semantic || {};
  const haystack = [
    state.id,
    visual.id,
    visual.name,
    visual.logicalScreenKey,
    logical.name,
    logical.description,
    ...(semantic.stableTexts || []),
    ...(semantic.primaryActions || [])
  ].map(normalizeText).filter(Boolean);
  let score = 0;
  let bestRouteStep = null;
  for (const term of goalTerms(guidance)) {
    const hit = haystack.some(value => value === term.normalized || value.includes(term.normalized) || term.normalized.includes(value));
    if (!hit) continue;
    score += term.weight;
    if (term.routeIndex !== null && (bestRouteStep === null || term.routeIndex > bestRouteStep)) bestRouteStep = term.routeIndex;
  }
  return { relevant: score > 0, score, routeStep: bestRouteStep };
}

module.exports = {
  ...modeContract('goal-directed'),
  loadGuidance,
  prioritizeSuggestion(suggestion, guidance) {
    return applyGoalGuidance(suggestion, guidance);
  },
  frontierGoalRank(priority = {}) {
    const step = Number.isFinite(Number(priority.routeHintStep)) ? Number(priority.routeHintStep) : -1;
    return -((step + 1) * 1000 + Number(priority.goalRelevance ?? 0));
  },
  depthSlack() {
    return Number.MAX_SAFE_INTEGER;
  },
  isGoalRelevant,
  filterFrontiers({ items }) {
    return filterGoalItems(items);
  },
  filterSuggestions({ items }) {
    return filterGoalItems(items);
  },
  filterBackfillStateIds({ stateIds, graph, guidance }) {
    const ranked = stateIds.map(id => ({ id, state: (graph.reachableStates || []).find(item => item.id === id) })).filter(item => item.state).map(item => ({ ...item, rank: stateGoalRank({ state: item.state, graph, guidance }) }));
    const relevant = ranked.filter(item => item.rank.relevant);
    const selected = relevant.length ? relevant : ranked;
    return selected.sort((a, b) => {
      const stepA = a.rank.routeStep ?? -1;
      const stepB = b.rank.routeStep ?? -1;
      return stepB - stepA || b.rank.score - a.rank.score || String(a.id).localeCompare(String(b.id));
    }).map(item => item.id);
  },
  filterVerifications({ items }) {
    return items;
  },
  observedDepthForBudget({ graph }) {
    return Math.max(0, ...(graph.reachableStates || []).map(item => Number(item.depth?.pathDepth || 0)));
  },
  preNextWork(context) {
    return knownTargetPrecheckWork(context);
  },
  completedStopReasons() {
    return new Set(modeContract('goal-directed').completedStopReasons);
  }
};
