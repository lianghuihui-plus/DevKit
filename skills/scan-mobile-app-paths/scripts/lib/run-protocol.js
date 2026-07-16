'use strict';

const { fail } = require('./common');

function graphProtocolVersion(scan = {}) { return Number(scan.graphProtocolVersion || 1); }
function attemptProtocolVersion(scan = {}) { return Number(scan.attemptProtocolVersion || 1); }
function eventProtocolVersion(scan = {}) { return Number(scan.eventProtocolVersion || 1); }
function projectionProtocolVersion(scan = {}) { return Number(scan.projectionProtocolVersion || 1); }
function navigationProtocolVersion(scan = {}) { return Number(scan.navigationProtocolVersion || 1); }
function verificationProtocolVersion(scan = {}) { return Number(scan.verificationProtocolVersion || 1); }
function isV3(scan = {}) { return graphProtocolVersion(scan) >= 3 || Number(scan.schemaVersion || 1) >= 3; }

function runContextIds(scan = {}) {
  if (isV3(scan)) return scan.contextId ? [scan.contextId] : [];
  return Array.isArray(scan.plannedContextIds) ? [...scan.plannedContextIds] : [];
}

function runContextId(scan = {}) {
  const ids = runContextIds(scan);
  if (ids.length !== 1) fail(`Run requires exactly one context, observed ${ids.length}`, 'CONTEXT_CARDINALITY_INVALID');
  return ids[0];
}

function activeContextId(scan = {}) {
  return isV3(scan) ? scan.contextId || null : scan.activeContextId || null;
}

function runBudget(scan = {}, contextId = null) {
  if (isV3(scan)) {
    if (contextId && contextId !== scan.contextId) fail('Budget context differs from the fixed Run context', 'CONTEXT_INVALID');
    if (!scan.budget) fail('V3 Run budget is missing', 'BUDGET_INVALID');
    return scan.budget;
  }
  const id = contextId || activeContextId(scan);
  const budget = scan.budgetsByContext?.[id];
  if (!budget) fail(`Budget is missing for context ${id || '<none>'}`, 'BUDGET_INVALID');
  return budget;
}

function activeLimitMinutes(budget = {}) { return Number(budget.maxActiveMinutes ?? budget.maxDurationMinutes ?? 0); }
function maxDepth(budget = {}) { return Number(budget.maxDepth ?? budget.maxPathDepth ?? 0); }
function maxStates(budget = {}) { return Number(budget.maxStates ?? budget.maxNodes ?? 0); }
function maxDeviceActions(budget = {}) { return Number(budget.maxDeviceActions ?? budget.maxActions ?? 0); }
function maxColdStarts(budget = {}) { return Number(budget.maxColdStarts ?? Number.MAX_SAFE_INTEGER); }
function maxCandidatesPerState(budget = {}) { return Number(budget.maxCandidatesPerState ?? budget.maxCandidatesPerNode ?? 0); }
function maxScrollsPerState(budget = {}) { return Number(budget.maxScrollsPerState ?? budget.maxScrollsPerNode ?? 0); }

module.exports = {
  graphProtocolVersion, attemptProtocolVersion, eventProtocolVersion, projectionProtocolVersion, navigationProtocolVersion, verificationProtocolVersion, isV3, runContextIds, runContextId, activeContextId, runBudget,
  activeLimitMinutes, maxDepth, maxStates, maxDeviceActions, maxColdStarts, maxCandidatesPerState, maxScrollsPerState
};
