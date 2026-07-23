#!/usr/bin/env node
'use strict';

const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir, bool, now, commitEvent, output, main, fail } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { buildSuggestionItems, suggestionApplicability } = require('./lib/frontier-candidate-service');
const { loadFrontierSuggestions, suggestionUpsertOp, pendingSuggestionsForState } = require('./lib/frontier-suggestions-store');
const { makeFrontierItem, frontierUpsertOp } = require('./lib/frontier-store');
const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./lib/verification-store');
const { deriveBlockedDependencies } = require('./lib/dependency-blocking');

function stateIdsFromArgs(args, store) {
  if (args.suggestionId) {
    const wanted = new Set(String(args.suggestionId).split(',').map(x => x.trim()).filter(Boolean));
    return item => wanted.has(item.suggestionId);
  }
  if (args.reachableStateId) return item => item.reachableStateId === String(args.reachableStateId);
  return () => true;
}

function statusForApplicability(reasonCode) {
  return ['SAFETY_BLOCKED', 'SAFETY_HARD_BLOCK', 'TEST_ENV_REQUIRED', 'ACCEPT_SAFE_ONLY', 'SOURCE_BLOCKED_BY_FAILED_DEPENDENCY'].includes(reasonCode) || String(reasonCode || '').startsWith('RISK_') ? 'BLOCKED' : 'SKIPPED';
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'list'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: ['suggest', 'apply', 'backfill'].includes(command) }); const contextId = args.context || runContextId(scan);
  if (command === 'list') return output(loadFrontierSuggestions(scanDir, contextId));
  if (command === 'suggest') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion generation requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const reachableStateId = required(args, 'reachableStateId'); const observationId = args.observationId ? String(args.observationId) : null;
    const result = buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId, observationId });
    if (result.reasonCode) return output({ schemaVersion: 1, ok: false, created: 0, reasonCode: result.reasonCode });
    if (result.ops.length) commitEvent(scanDir, 'frontierSuggestionsGenerated', { contextId, reachableStateId, observationId: result.observationId, suggestionIds: result.created.map(item => item.suggestionId), created: result.created, skipped: result.skipped }, result.ops);
    return output({ schemaVersion: 1, ok: true, created: result.created.length, suggestions: result.created, skipped: result.skipped });
  }
  if (command === 'backfill') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion backfill requires SCANNING', 'RUN_STATE_INVALID');
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const allReachable = bool(args.allReachable, false); const requestedStateId = args.reachableStateId ? String(args.reachableStateId) : null;
    if (!allReachable && !requestedStateId) fail('Backfill requires --all-reachable true or --reachable-state-id', 'BACKFILL_TARGET_REQUIRED');
    const states = (graph.reachableStates || []).filter(state => allReachable || state.id === requestedStateId).sort((a, b) => Number(a.depth?.pathDepth || 0) - Number(b.depth?.pathDepth || 0) || String(a.id).localeCompare(String(b.id)));
    const created = []; const skipped = [];
    for (const state of states) {
      const observationId = args.observationId && !allReachable ? String(args.observationId) : null;
      const result = buildSuggestionItems({ scanDir, scan, contextId, graph, frontier, reachableStateId: state.id, observationId });
      if (result.reasonCode) { skipped.push({ reachableStateId: state.id, reasonCode: result.reasonCode, evidenceSource: result.evidenceSource || null }); continue; }
      if (result.ops.length) commitEvent(scanDir, 'frontierSuggestionsBackfilled', { contextId, reachableStateId: state.id, observationId: result.observationId, observationRef: result.observationRef || null, evidenceSource: result.evidenceSource || null, suggestionIds: result.created.map(item => item.suggestionId), created: result.created, skipped: result.skipped }, result.ops);
      created.push(...result.created); skipped.push(...result.skipped.map(item => ({ reachableStateId: state.id, ...item })));
    }
    return output({ schemaVersion: 1, ok: true, scannedReachableStates: states.length, created: created.length, suggestions: created, skipped });
  }
  if (command === 'apply') {
    if (scan.status !== 'SCANNING') fail('Frontier suggestion apply requires SCANNING', 'RUN_STATE_INVALID');
    const acceptSafe = bool(args.acceptSafe, true); const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const store = loadFrontierSuggestions(scanDir, contextId); const predicate = stateIdsFromArgs(args, store); const queue = loadVerificationQueue(scanDir, contextId); const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS });
    const selected = pendingSuggestionsForState(store, args.reachableStateId ? String(args.reachableStateId) : null).filter(predicate);
    const applied = []; const skipped = []; const blocked = []; const ops = [];
    for (const suggestion of selected) {
      const applicable = suggestionApplicability({ scan, contextId, graph, frontier, suggestion, dependencyBlocking, acceptSafe });
      if (!applicable.applicable) {
        suggestion.status = statusForApplicability(applicable.reasonCode); suggestion.updatedAt = now(); suggestion.reasonCode = applicable.reasonCode || 'SUGGESTION_NOT_APPLICABLE'; if (suggestion.status === 'BLOCKED') blocked.push(suggestion); else skipped.push(suggestion); ops.push(suggestionUpsertOp(contextId, suggestion)); continue;
      }
      const made = makeFrontierItem({ scanDir, scan, contextId, graph, frontier, fromReachableStateId: suggestion.reachableStateId, candidate: suggestion.candidate, candidateGroupKey: suggestion.candidateGroupKey, priority: suggestion.priority || {}, sourceFrontierId: suggestion.suggestionId });
      if (!made.ok || !made.created) {
        suggestion.status = made.blocked ? 'BLOCKED' : 'SKIPPED'; suggestion.updatedAt = now(); suggestion.reasonCode = made.reasonCode || 'FRONTIER_NOT_CREATED'; if (made.blocked) blocked.push(suggestion); else skipped.push(suggestion); ops.push(suggestionUpsertOp(contextId, suggestion)); continue;
      }
      frontier.items.push(made.item);
      suggestion.status = 'APPLIED'; suggestion.frontierId = made.item.id; suggestion.updatedAt = now(); suggestion.reasonCode = null;
      applied.push({ suggestion, frontier: made.item });
      ops.push(suggestionUpsertOp(contextId, suggestion), frontierUpsertOp(contextId, made.item));
    }
    if (ops.length) commitEvent(scanDir, 'frontierSuggestionsApplied', { contextId, suggestionIds: selected.map(item => item.suggestionId), applied: applied.map(item => ({ suggestionId: item.suggestion.suggestionId, frontierId: item.frontier.id })), skipped: skipped.map(item => ({ suggestionId: item.suggestionId, reasonCode: item.reasonCode })), blocked: blocked.map(item => ({ suggestionId: item.suggestionId, reasonCode: item.reasonCode })) }, ops);
    return output({ schemaVersion: 1, ok: true, applied: applied.length, skipped: skipped.length, blocked: blocked.length, frontiers: applied.map(item => item.frontier), suggestions: selected });
  }
  fail(`Unknown frontier-candidates command: ${command}`, 'COMMAND_INVALID');
});
