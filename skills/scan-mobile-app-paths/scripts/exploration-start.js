#!/usr/bin/env node
'use strict';

const { parseArgs, required, requiredId, resolveScanDir, loadScan, loadGraph, commitEvent, output, main, fail, now } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const {
  loadExplorationStart,
  resolveAppRootStartValue,
  resolveSpecifiedStartValue,
  evaluateKnownStartCandidates
} = require('./lib/exploration-start');

function startOp(contextId, value) {
  return { path: `contexts/${contextId}/exploration-start.json`, op: 'REPLACE', value };
}

main(() => {
  const args = parseArgs();
  const command = args._[0] || 'show';
  const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: !['show'].includes(command) });
  if (scan.scanMode !== 'exploration') fail('exploration-start is only available for exploration mode', 'EXPLORATION_START_UNSUPPORTED');
  const contextId = args.context || runContextId(scan);
  const graph = loadGraph(scanDir, contextId);
  const current = loadExplorationStart(scanDir, contextId);

  if (command === 'show') return output({ schemaVersion: 1, ok: true, explorationStart: current });

  if (command === 'resolve-root') {
    const value = resolveAppRootStartValue(scanDir, contextId, graph, { at: now(), resolvedBy: 'APP_ROOT' });
    if (!value) return output({ schemaVersion: 1, ok: true, changed: false, explorationStart: current });
    commitEvent(scanDir, 'explorationStartResolved', { contextId, kind: value.kind, startReachableStateId: value.startReachableStateId, resolvedBy: value.resolvedBy }, [startOp(contextId, value)]);
    return output({ schemaVersion: 1, ok: true, changed: true, explorationStart: value });
  }

  if (command === 'evaluate-known') {
    if ((current.kind || current.spec?.kind) !== 'specified-page') fail('evaluate-known requires specified-page explorationStart', 'EXPLORATION_START_INVALID');
    const candidates = evaluateKnownStartCandidates(graph, current.spec);
    const value = {
      ...current,
      status: candidates.length ? 'CANDIDATE_REVIEW' : 'NOT_FOUND',
      candidates: candidates.slice(0, 10),
      reasonCode: candidates.length ? 'KNOWN_MAP_CANDIDATES_REVIEW_REQUIRED' : 'KNOWN_MAP_START_NOT_FOUND',
      evaluatedAt: now()
    };
    commitEvent(scanDir, 'explorationStartKnownMapEvaluated', { contextId, candidateCount: candidates.length, status: value.status, candidates: value.candidates }, [startOp(contextId, value)]);
    return output({
      schemaVersion: 1,
      ok: true,
      explorationStart: value,
      requiresConfirmation: candidates.length > 0,
      suggestedCommand: candidates[0] ? { command: 'exploration-start.js', args: ['confirm', '--scan-dir', scanDir, '--context', contextId, '--candidate-id', candidates[0].candidateId] } : null
    });
  }

  if (command === 'confirm') {
    if ((current.kind || current.spec?.kind) !== 'specified-page') fail('confirm requires specified-page explorationStart', 'EXPLORATION_START_INVALID');
    const candidateId = args.candidateId ? requiredId(args, 'candidateId') : null;
    const reachableStateId = args.reachableStateId ? requiredId(args, 'reachableStateId') : null;
    if (!candidateId && !reachableStateId) fail('confirm requires --candidate-id or --reachable-state-id', 'ARG_REQUIRED');
    const candidate = candidateId ? (current.candidates || []).find(item => item.candidateId === candidateId) : null;
    const selectedStateId = reachableStateId || candidate?.reachableStateId;
    if (!selectedStateId) fail(`Start candidate not found: ${candidateId}`, 'EXPLORATION_START_CANDIDATE_MISSING');
    const value = resolveSpecifiedStartValue(scanDir, contextId, graph, selectedStateId, { at: now(), resolvedBy: candidate ? 'KNOWN_MAP_CONFIRMED' : 'USER_CONFIRMED_STATE', candidate });
    commitEvent(scanDir, 'explorationStartConfirmed', { contextId, kind: value.kind, startReachableStateId: value.startReachableStateId, resolvedBy: value.resolvedBy, candidateId }, [startOp(contextId, value)]);
    return output({ schemaVersion: 1, ok: true, explorationStart: value });
  }

  if (command === 'reset-evaluation') {
    const value = { ...current, status: current.kind === 'app-root' ? 'PENDING_ROOT' : 'PENDING', candidates: [], startReachableStateId: null, startVisualStateId: null, pathEdgeIdsFromAppRoot: [], resolvedBy: null, resolvedAt: null, reasonCode: null };
    commitEvent(scanDir, 'explorationStartReset', { contextId, kind: value.kind }, [startOp(contextId, value)]);
    return output({ schemaVersion: 1, ok: true, explorationStart: value });
  }

  fail(`Unknown exploration-start command: ${command}`, 'COMMAND_INVALID');
});
