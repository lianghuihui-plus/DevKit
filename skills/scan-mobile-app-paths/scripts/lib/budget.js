'use strict';

const { fail } = require('./common');
const { isV3, activeContextId, runBudget, activeLimitMinutes, maxStates, maxDeviceActions } = require('./run-protocol');

const PRESETS = Object.freeze({
  quick: { maxActiveMinutes: 10, maxDepth: 3, maxDeviceActions: 150, maxStates: 30, maxColdStarts: 20, maxScrollsPerState: 1, maxCandidatesPerState: 8, depthSlack: 0, cursorFreshnessMs: 15000 },
  standard: { maxActiveMinutes: 20, maxDepth: 5, maxDeviceActions: 500, maxStates: 80, maxColdStarts: 40, maxScrollsPerState: 2, maxCandidatesPerState: 12, depthSlack: 1, cursorFreshnessMs: 15000 },
  deep: { maxActiveMinutes: 60, maxDepth: 8, maxDeviceActions: 1500, maxStates: 200, maxColdStarts: 100, maxScrollsPerState: 3, maxCandidatesPerState: 20, depthSlack: 2, cursorFreshnessMs: 15000 },
  goal: { maxActiveMinutes: 15, maxDepth: 7, maxDeviceActions: 300, maxStates: 50, maxColdStarts: 30, maxScrollsPerState: 2, maxCandidatesPerState: 12, depthSlack: 0, cursorFreshnessMs: 15000 }
});

const PROFILE_META = Object.freeze({
  quick: { label: 'Quick', description: '快速摸底', scanModes: ['exploration'] },
  standard: { label: 'Standard', description: '常规扫描', scanModes: ['exploration'] },
  deep: { label: 'Deep', description: '深度扫描', scanModes: ['exploration'] },
  goal: { label: 'Goal', description: '目标页面查找', scanModes: ['goal-directed'] }
});

function assertProfileForMode(profile, scanMode) {
  if (!PRESETS[profile]) fail(`Unknown profile: ${profile}`, 'PROFILE_INVALID');
  if (!PROFILE_META[profile].scanModes.includes(scanMode)) fail(`Profile ${profile} is not available for ${scanMode}`, 'PROFILE_MODE_MISMATCH');
  return profile;
}

function profileCatalog(scanMode, selectedProfile = null) {
  const recommendedProfile = scanMode === 'goal-directed' ? 'goal' : 'standard';
  return Object.entries(PRESETS).map(([id, budget]) => ({ id, label: PROFILE_META[id].label, description: PROFILE_META[id].description, scanModes: [...PROFILE_META[id].scanModes], applicable: PROFILE_META[id].scanModes.includes(scanMode), recommended: id === recommendedProfile, selected: id === selectedProfile, budget: { ...budget } }));
}

function budgetOverrides(profile, budget) {
  const preset = PRESETS[profile] || {};
  return Object.keys(preset).filter(key => Number(budget?.[key]) !== Number(preset[key])).map(key => ({ key, presetValue: preset[key], actualValue: Number(budget[key]) }));
}

function normalizeOverrides(overrides = {}) {
  const aliases = { maxDurationMinutes: 'maxActiveMinutes', maxActions: 'maxDeviceActions', maxNodes: 'maxStates', maxPathDepth: 'maxDepth', maxCandidatesPerNode: 'maxCandidatesPerState', maxScrollsPerNode: 'maxScrollsPerState' };
  const normalized = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (['maxEdges', 'maxRouteDepth'].includes(key)) fail(`${key} was removed in Protocol v3`, 'BUDGET_FIELD_REMOVED');
    normalized[aliases[key] || key] = value;
  }
  return normalized;
}

function resolveBudget(profile, overrides = {}) {
  if (!PRESETS[profile]) fail(`Unknown profile: ${profile}`, 'PROFILE_INVALID');
  const budget = { ...PRESETS[profile], ...normalizeOverrides(overrides) };
  for (const [key, value] of Object.entries(budget)) {
    if (!Object.hasOwn(PRESETS[profile], key)) fail(`Unknown budget or strategy field ${key}`, 'BUDGET_INVALID');
    if (!Number.isFinite(Number(value)) || Number(value) < 0) fail(`Invalid budget ${key}`, 'BUDGET_INVALID');
    budget[key] = Number(value);
  }
  return budget;
}

function totalActions(metrics = {}) {
  const categories = ['explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'interruptionActions'];
  const categorized = categories.reduce((sum, key) => sum + Number(metrics[key] || 0), 0);
  return Math.max(Number(metrics.actions || 0), categorized);
}

function budgetUsage(scan, graph, frontier, metrics = {}) {
  const currentIntervalMs = scan.status === 'SCANNING' && activeContextId(scan) === graph.contextId && metrics.activeStartedAt ? Math.max(0, Date.now() - Date.parse(metrics.activeStartedAt)) : 0;
  const elapsedMs = (metrics.activeDurationMs || 0) + currentIntervalMs;
  return { nodes: graph.reachableStates.length, states: graph.reachableStates.length, edges: graph.edges.length, actions: totalActions(metrics), coldStarts: Number(metrics.coldStarts || 0), durationMinutes: elapsedMs / 60000, pending: frontier.items.filter(i => ['PENDING', 'RETRYABLE'].includes(i.status)).length };
}

function assertCapacity(scan, contextId, graph, frontier, metrics, resource, increment = 1) {
  const usage = budgetUsage(scan, graph, frontier, metrics); const budget = runBudget(scan, contextId);
  if (resource === 'edges' && isV3(scan)) return;
  const map = isV3(scan)
    ? { nodes: ['MAX_STATES', maxStates(budget)], states: ['MAX_STATES', maxStates(budget)], actions: ['MAX_DEVICE_ACTIONS', maxDeviceActions(budget)], coldStarts: ['MAX_COLD_STARTS', Number(budget.maxColdStarts)] }
    : { nodes: ['MAX_NODES', Number(budget.maxNodes)], edges: ['MAX_EDGES', Number(budget.maxEdges)], actions: ['MAX_ACTIONS', Number(budget.maxActions)] };
  if (!map[resource]) fail(`Unknown budget resource: ${resource}`, 'BUDGET_RESOURCE_INVALID');
  const [reasonCode, limit] = map[resource];
  if (usage[resource] + increment > limit) fail(`${reasonCode}: ${usage[resource]} + ${increment} exceeds ${limit}`, 'BUDGET_EXHAUSTED');
}

function assertExecutionWindow(scan, contextId, graph, frontier, metrics) {
  const usage = budgetUsage(scan, graph, frontier, metrics); const limit = activeLimitMinutes(runBudget(scan, contextId));
  if (usage.durationMinutes >= limit) fail(`MAX_ACTIVE_MINUTES: ${usage.durationMinutes} exceeds ${limit}`, 'BUDGET_EXHAUSTED');
}

function exhausted(budget, usage, protocol = 3) {
  const checks = protocol >= 3
    ? [['MAX_STATES', usage.states ?? usage.nodes, maxStates(budget)], ['MAX_DEVICE_ACTIONS', usage.actions, maxDeviceActions(budget)], ['MAX_COLD_STARTS', usage.coldStarts || 0, Number(budget.maxColdStarts)], ['MAX_ACTIVE_MINUTES', usage.durationMinutes, activeLimitMinutes(budget)]]
    : [['MAX_NODES', usage.nodes, budget.maxNodes], ['MAX_EDGES', usage.edges, budget.maxEdges], ['MAX_ACTIONS', usage.actions, budget.maxActions], ['MAX_DURATION', usage.durationMinutes, budget.maxDurationMinutes]];
  const hit = checks.find(([, used, max]) => used >= max);
  return hit ? { exhausted: true, reasonCode: hit[0], used: hit[1], limit: hit[2] } : { exhausted: false };
}

module.exports = { PRESETS, PROFILE_META, assertProfileForMode, profileCatalog, budgetOverrides, resolveBudget, budgetUsage, exhausted, assertCapacity, assertExecutionWindow, totalActions };
