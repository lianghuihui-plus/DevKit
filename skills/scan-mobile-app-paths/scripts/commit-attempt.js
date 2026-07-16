#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, nextId, jsonArg, now, event, commitEvent, output, main, fail, safeSegment, hashObject } = require('./lib/common');
const { buildFingerprint, observationVisual } = require('./lib/fingerprint');
const { assertCapacity } = require('./lib/budget');
const store = require('./lib/graph-store');
const { isV3, activeContextId, runBudget, maxDepth } = require('./lib/run-protocol');
const { projectedCursor } = require('./lib/live-cursor');
const { reconcileVerificationQueue } = require('./lib/verification-store');

function evidence(scanDir, observationId, contextId) {
  const dir = path.join(scanDir, 'evidence', 'observations', observationId); const observation = readJson(path.join(dir, 'observation.json'));
  if (observation.contextId !== contextId || observation.captureStatus !== 'COMPLETE' || !fs.existsSync(path.join(dir, 'screenshot.png'))) fail('Attempt observation evidence is invalid', 'EVIDENCE_INCOMPLETE');
  return { observation, layout: readJson(path.join(dir, 'layout.json')) };
}

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.status !== 'SCANNING') fail('Attempt commit requires SCANNING', 'RUN_STATE_INVALID');
  const attemptId = safeSegment(required(args, 'attemptId'), 'attemptId'); const attemptFile = path.join(scanDir, 'attempts', `${attemptId}.json`); const attempt = readJson(attemptFile);
  if (attempt.status !== 'READY_TO_COMMIT' || attempt.contextId !== activeContextId(scan)) fail('Attempt is not ready for the active context', 'ATTEMPT_STATE_INVALID');
  const contextId = attempt.contextId; const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === attempt.frontierId);
  if (!item || item.status !== 'CLAIMED' || item.claimedAttemptId !== attemptId || item.claimToken !== attempt.claimToken || item.fromReachableStateId !== attempt.fromReachableStateId || hashObject(item.candidate) !== attempt.candidateHash) fail('Attempt/frontier causality is broken', 'ATTEMPT_CAUSALITY_INVALID');
  const graph = loadGraph(scanDir, contextId); const from = graph.reachableStates.find(x => x.id === attempt.fromReachableStateId); if (!from) fail('Attempt source ReachableState is missing', 'GRAPH_REFERENCE_MISSING');
  if (!['full-screen', 'modal'].includes(attempt.outcomeKind)) fail('Attempt outcome must be reviewed before commit', 'POPUP_REVIEW_REQUIRED');
  if (args.kind && args.kind !== attempt.outcomeKind) fail('Commit kind differs from reviewed outcome', 'ATTEMPT_OUTCOME_MISMATCH');
  const fromVisual = graph.visualStates.find(x => x.id === from.visualStateId); if (!fromVisual) fail('Attempt source VisualState is missing', 'GRAPH_REFERENCE_MISSING');
  const before = evidence(scanDir, attempt.beforeObservationId, contextId); const after = evidence(scanDir, attempt.afterObservationId, contextId); void before;
  const actionResult = readJson(path.join(scanDir, 'evidence', 'actions', `${attempt.actionResultId}.json`));
  if (actionResult.status !== 'SUCCEEDED' || actionResult.attemptId !== attemptId || actionResult.beforeObservationId !== attempt.beforeObservationId || (actionResult.candidateHash || hashObject(actionResult.action)) !== attempt.candidateHash) fail('Attempt action evidence is invalid', 'ATTEMPT_CAUSALITY_INVALID');
  const metrics = readJson(path.join(scanDir, 'contexts', contextId, 'metrics.json')); const budget = runBudget(scan, contextId);
  const fingerprint = buildFingerprint(after.layout, after.observation.foreground, observationVisual(after.observation));
  const logicalScreenKey = args.logicalScreenKey || `screen-${hashObject(fingerprint).slice(-12)}`;
  const visualMatch = store.findVisualMatch(graph, fingerprint); if (visualMatch.status === 'EXACT' && visualMatch.visualState.logicalScreenKey !== logicalScreenKey) fail(`Observation matches ${visualMatch.visualState.id} on LogicalScreen ${visualMatch.visualState.logicalScreenKey}; retry commit with that key`, 'LOGICAL_SCREEN_CONFLICT');
  store.upsertLogicalScreen(graph, logicalScreenKey, args.name || logicalScreenKey, args.description || '', scan.scanId);
  const visualResult = store.upsertVisualState(graph, { logicalScreenKey, name: args.name || logicalScreenKey, kind: attempt.outcomeKind, observationId: attempt.afterObservationId, fingerprint });
  const routeIncrement = item.candidate.routeTransition === true ? 1 : 0; const modalDepth = attempt.outcomeKind === 'modal' ? 1 : fromVisual.kind === 'modal' ? 0 : (from.depth?.modalDepth || 0); const depth = { pathDepth: (from.depth?.pathDepth || 0) + 1, routeDepth: (from.depth?.routeDepth || 0) + routeIncrement, modalDepth };
  if (depth.pathDepth > maxDepth(budget) || !isV3(scan) && depth.routeDepth > budget.maxRouteDepth) fail('Committed state exceeds depth budget', 'BUDGET_EXHAUSTED');
  const arrivalSignature = jsonArg(args.arrivalSignature, { expectedBackReachableStateId: isV3(scan) ? null : from.id, backBehaviorKey: args.backBehaviorKey || 'unverified', stateInvariantHash: hashObject({ visualStateId: visualResult.visualState.id, from: from.id, candidateGroupKey: item.candidateGroupKey }) });
  const previewReachable = graph.reachableStates.find(x => x.visualStateId === visualResult.visualState.id && hashObject(x.arrivalSignature || {}) === hashObject(arrivalSignature));
  if (!previewReachable) assertCapacity(scan, contextId, graph, frontier, metrics, 'nodes');
  const reachableResult = store.upsertReachableState(graph, { visualStateId: visualResult.visualState.id, arrivalSignature, depth, replayPathEdgeIds: from.replayPathEdgeIds || [] });
  const duplicateEdge = graph.edges.some(x => x.fromReachableStateId === from.id && x.toReachableStateId === reachableResult.reachableState.id && store.actionKey(x.action) === store.actionKey(actionResult.action));
  if (!duplicateEdge) assertCapacity(scan, contextId, graph, frontier, metrics, 'edges');
  const edge = { id: nextId(scanDir, 'edge', 'edge'), fromReachableStateId: from.id, toReachableStateId: reachableResult.reachableState.id, contextGuard: { authState: contextId }, action: actionResult.action,
    risk: actionResult.safety.risk, replayability: actionResult.locatorResolution === 'SEMANTIC_VERIFIED' ? 'STABLE' : 'UNSTABLE', sideEffect: actionResult.safety.sideEffect, replayPolicy: actionResult.safety.replayPolicy,
    attemptId, evidence: { beforeObservationId: attempt.beforeObservationId, actionResultId: attempt.actionResultId, afterObservationId: attempt.afterObservationId } };
  if (isV3(scan)) { edge.locatorResolution = actionResult.locatorResolution; edge.verification = { discoveryStatus: 'OBSERVED', replayStatus: edge.replayPolicy === 'NONREPEATABLE' ? 'NONREPEATABLE' : 'UNVERIFIED', transitionFingerprint: store.transitionFingerprint(graph, edge), verificationRefs: [] }; }
  const edgeResult = store.recordEdge(graph, edge);
  item.status = 'EXPLORED'; item.reasonCode = null; item.resolvedAt = now(); item.attemptId = attemptId; item.claimToken = null; item.claimedAttemptId = null;
  attempt.status = 'COMMITTED'; attempt.edgeId = edgeResult.edge.id; attempt.toReachableStateId = reachableResult.reachableState.id; attempt.updatedAt = now();
  const logicalScreen = graph.logicalScreens.find(x => x.id === visualResult.visualState.logicalScreenKey); const cursor = isV3(scan) ? projectedCursor(scanDir, contextId, { reachableStateId: reachableResult.reachableState.id, observationId: attempt.afterObservationId, status: 'EXACT', establishedBy: 'ATTEMPT_COMMIT' }) : null; const verificationProjection = isV3(scan) ? reconcileVerificationQueue(scanDir, scan, contextId, graph, { persist: false }) : null; const graphPath = `contexts/${contextId}/graph.json`; const ops = [
    { path: graphPath, op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: logicalScreen, recompute: 'GRAPH' },
    { path: graphPath, op: 'UPSERT', collection: 'visualStates', keyFields: ['id'], value: visualResult.visualState, recompute: 'GRAPH' },
    { path: graphPath, op: 'UPSERT', collection: 'reachableStates', keyFields: ['id'], value: reachableResult.reachableState, recompute: 'GRAPH' },
    { path: graphPath, op: 'UPSERT', collection: 'edges', keyFields: ['id'], value: edgeResult.edge, recompute: 'GRAPH' },
    { path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item },
    { path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }
  ]; if (cursor) ops.push({ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: cursor }); if (verificationProjection) for (const task of [...verificationProjection.scheduled, ...verificationProjection.superseded]) ops.push({ path: `contexts/${contextId}/verification-queue.json`, op: 'UPSERT', collection: 'items', keyFields: ['verificationId'], value: task, fallback: { schemaVersion: 2, contextId, items: [] } });
  commitEvent(scanDir, 'attemptCommitted', { contextId, attemptId, frontierId: item.id, edgeId: edgeResult.edge.id, toReachableStateId: reachableResult.reachableState.id, commitProjection: { logicalScreen, visualState: visualResult.visualState, reachableState: reachableResult.reachableState, edge: edgeResult.edge, frontierItem: item, attempt, cursor }, verificationProjection: verificationProjection ? { scheduled: verificationProjection.scheduled, superseded: verificationProjection.superseded } : null }, ops);
  event(scanDir, 'visualStateUpserted', { contextId, visualStateId: visualResult.visualState.id, observationId: attempt.afterObservationId, created: visualResult.created, dedupeStatus: visualResult.dedupeStatus, logicalScreen, visualState: visualResult.visualState });
  event(scanDir, 'reachableStateUpserted', { contextId, reachableStateId: reachableResult.reachableState.id, visualStateId: reachableResult.reachableState.visualStateId, created: reachableResult.created, reachableState: reachableResult.reachableState });
  event(scanDir, 'edgeRecorded', { contextId, edgeId: edgeResult.edge.id, created: edgeResult.created, edge: edgeResult.edge });
  event(scanDir, 'frontierResolved', { contextId, frontierId: item.id, status: item.status, reasonCode: null, item });
  if (verificationProjection) { for (const task of verificationProjection.scheduled) event(scanDir, 'verificationScheduled', { contextId, verification: task }); for (const task of verificationProjection.superseded) event(scanDir, 'verificationSuperseded', { contextId, verification: task }); }
  output({ schemaVersion: 1, ok: true, attempt, visualState: visualResult.visualState, reachableState: reachableResult.reachableState, edge: edgeResult.edge });
});
