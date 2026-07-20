#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, readJson, jsonArg, commitEvent, output, main, fail, contextDir, loadFrontier, hashObject, bool } = require('./lib/common');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const store = require('./lib/graph-store');
const { assertCapacity } = require('./lib/budget');
const { activeContextId, runBudget, maxDepth } = require('./lib/run-protocol');
const { establishCursor } = require('./lib/live-cursor');
const { loadObservationBundle } = require('./lib/observation-store');
const { assertAcceptedVisualReview } = require('./lib/visual-review-store');

function requireObservation(scanDir, id) {
  return loadObservationBundle(scanDir, id, { requireComplete: true, requireFiles: true });
}

function rootState(graph) {
  const roots = graph.reachableStates.filter(state => (state.depth?.pathDepth || 0) === 0);
  return roots.length === 1 ? roots[0] : null;
}

function bindExistingRootVisual(scanDir, scan, contextId, graph, { observationId, logicalScreenKey, fingerprint, visualReviewId, visualReview, allowExpectedStateEquivalent = false }) {
  const root = rootState(graph);
  if (!root) fail('Seeded graph must contain exactly one root ReachableState before root binding', 'GRAPH_INVALID');
  const visual = graph.visualStates.find(item => item.id === root.visualStateId);
  if (!visual) fail('Seeded root ReachableState references a missing VisualState', 'GRAPH_INVALID');
  if (visual.logicalScreenKey !== logicalScreenKey) fail(`Seeded root belongs to LogicalScreen ${visual.logicalScreenKey}; requested ${logicalScreenKey}`, 'LOGICAL_SCREEN_CONFLICT');
  const logicalScreen = graph.logicalScreens.find(item => item.id === logicalScreenKey);
  if (!logicalScreen) fail(`Seeded root LogicalScreen not found: ${logicalScreenKey}`, 'GRAPH_INVALID');
  const comparison = compareFingerprint(visual.fingerprint, fingerprint);
  const matched = store.findVisualMatch(graph, fingerprint);
  const reviewedEquivalent = allowExpectedStateEquivalent
    && comparison === 'UNCERTAIN'
    && visualReview?.status === 'ACCEPTED'
    && visualReview?.confidence === 'HIGH'
    && visualReview?.pageName === logicalScreen.name;
  if ((!['EXACT', 'PROBABLE'].includes(comparison) && !reviewedEquivalent) || matched.visualState && matched.visualState.id !== visual.id && matched.status === 'EXACT') {
    fail(`Current root observation does not match seeded root ${visual.id}: ${comparison}`, 'ROOT_STATE_MISMATCH');
  }
  visual.evidenceObservationIds ||= [];
  if (!visual.evidenceObservationIds.includes(observationId)) visual.evidenceObservationIds.push(observationId);
  visual.evidenceObservationRefs ||= [];
  if (!visual.evidenceObservationRefs.some(ref => ref.runId === scan.scanId && ref.observationId === observationId)) visual.evidenceObservationRefs.push({ runId: scan.scanId, observationId });
  visual.visualReviewIds ||= [];
  if (visualReviewId && !visual.visualReviewIds.includes(visualReviewId)) visual.visualReviewIds.push(visualReviewId);
  visual.dedupe = { status: reviewedEquivalent ? 'EXPECTED_STATE_EQUIVALENT' : comparison, duplicateGroupId: null, reviewStatus: reviewedEquivalent ? 'ACCEPTED' : 'NOT_REQUIRED' };
  if (logicalScreen) {
    logicalScreen.evidenceRunIds ||= [];
    if (!logicalScreen.evidenceRunIds.includes(scan.scanId)) logicalScreen.evidenceRunIds.push(scan.scanId);
    logicalScreen.visualStateIds ||= [];
    if (!logicalScreen.visualStateIds.includes(visual.id)) logicalScreen.visualStateIds.push(visual.id);
  }
  const bindingComparison = reviewedEquivalent ? 'EXPECTED_STATE_EQUIVALENT' : comparison;
  commitEvent(scanDir, 'rootVisualStateBound', { contextId, visualStateId: visual.id, reachableStateId: root.id, observationId, visualReviewId, comparison: bindingComparison }, [{ path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: logicalScreen, recompute: 'GRAPH' }, { path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'visualStates', keyFields: ['id'], value: visual, recompute: 'GRAPH' }]);
  return { visualState: visual, created: false, dedupeStatus: bindingComparison, rootBound: true, reachableStateId: root.id };
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'show'; const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: command !== 'show' && command !== 'validate' }); const contextId = args.context || activeContextId(scan);
  if (!contextId) fail('context is required', 'CONTEXT_REQUIRED'); const graph = loadGraph(scanDir, contextId);
  if (command === 'show') return output(graph);
  if (command === 'upsert-visual') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Graph mutation requires the active SCANNING context', 'RUN_STATE_INVALID');
    if (!bool(args.root, false)) fail('Direct graph upsert is reserved for initial root states; use commit-attempt.js for discovered states', 'SCAN_ENGINE_REQUIRED');
    const observationId = required(args, 'observationId'); const visualReviewId = required(args, 'visualReviewId'); const evidence = requireObservation(scanDir, observationId);
    const visualReview = assertAcceptedVisualReview(scanDir, { visualReviewId, contextId, observationId, reviewType: 'ROOT_STATE' });
    if (evidence.observation.foreground?.bundleName && evidence.observation.foreground.bundleName !== scan.target.bundleName) fail('Observation outside the target App cannot create a VisualState', 'APP_LEFT_FOREGROUND');
    if (evidence.observation.contextId !== contextId) fail('Observation context does not match graph context', 'CONTEXT_EVIDENCE_INVALID');
    const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json')); if (context.verification?.observationId !== observationId || context.verification?.preparationId !== evidence.observation.contextPreparationId) fail('Root VisualState must use the confirmed cold-start context observation', 'CONTEXT_EVIDENCE_INVALID');
    const logicalScreenKey = args.logicalScreenKey || `screen-${graph.logicalScreens.length + 1}`; const name = args.name || visualReview.pageName || logicalScreenKey; const fingerprint = buildFingerprint(evidence.layout, evidence.observation.foreground, observationVisual(evidence.observation));
    if ((graph.reachableStates || []).length || (graph.edges || []).length) return output({ schemaVersion: 1, ok: true, ...bindExistingRootVisual(scanDir, scan, contextId, graph, { observationId, logicalScreenKey, fingerprint, visualReviewId, visualReview, allowExpectedStateEquivalent: bool(args.expectedStateEquivalent, false) }) });
    const visualMatch = store.findVisualMatch(graph, fingerprint); if (visualMatch.status === 'EXACT' && visualMatch.visualState.logicalScreenKey !== logicalScreenKey) fail(`Observation already belongs to LogicalScreen ${visualMatch.visualState.logicalScreenKey}`, 'LOGICAL_SCREEN_CONFLICT');
    store.upsertLogicalScreen(graph, logicalScreenKey, name, args.description || '', scan.scanId);
    const result = store.upsertVisualState(graph, { id: args.visualStateId, logicalScreenKey, name, kind: args.kind || 'full-screen', observationId, fingerprint, visualReviewId });
    const logicalScreen = graph.logicalScreens.find(x => x.id === logicalScreenKey); commitEvent(scanDir, 'visualStateUpserted', { contextId, visualStateId: result.visualState.id, observationId, visualReviewId, created: result.created, dedupeStatus: result.dedupeStatus, logicalScreen, visualState: result.visualState }, [{ path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: logicalScreen, recompute: 'GRAPH' }, { path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'visualStates', keyFields: ['id'], value: result.visualState, recompute: 'GRAPH' }]);
    return output({ schemaVersion: 1, ok: true, ...result });
  }
  if (command === 'upsert-reachable') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Graph mutation requires the active SCANNING context', 'RUN_STATE_INVALID');
    if (!bool(args.root, false)) fail('Direct graph upsert is reserved for initial root states; use commit-attempt.js for discovered states', 'SCAN_ENGINE_REQUIRED');
    const arrivalSignature = jsonArg(args.arrivalSignature, {}); const visualStateId = required(args, 'visualStateId');
    if ((graph.reachableStates || []).length || (graph.edges || []).length) {
      const root = rootState(graph);
      if (!root) fail('Seeded graph must contain exactly one root ReachableState before root binding', 'GRAPH_INVALID');
      if (root.visualStateId !== visualStateId) fail(`Seeded root uses VisualState ${root.visualStateId}; requested ${visualStateId}`, 'ROOT_STATE_MISMATCH');
      const visual = graph.visualStates.find(item => item.id === root.visualStateId);
      const observationId = visual?.evidenceObservationIds?.at(-1) || null;
      const cursor = observationId ? establishCursor(scanDir, contextId, { reachableStateId: root.id, observationId, status: 'SOURCE_CONFIRMED', establishedBy: 'ROOT_STATE', equivalence: { type: 'SOURCE_MATCH', status: 'SOURCE_CONFIRMED', confidence: 0.9, observationId, evidence: { comparison: visual?.dedupe?.status || 'PROBABLE', source: 'ROOT_STATE_BIND' } } }, { incrementEpoch: true }) : null;
      return output({ schemaVersion: 1, ok: true, reachableState: root, created: false, rootBound: true, cursor });
    }
    const exists = graph.reachableStates.some(x => x.visualStateId === visualStateId && hashObject(x.arrivalSignature || {}) === hashObject(arrivalSignature));
    if (!exists && graph.reachableStates.some(x => (x.depth?.pathDepth || 0) === 0)) fail('Context already has a root ReachableState', 'ROOT_ALREADY_EXISTS');
    if (!exists) assertCapacity(scan, contextId, graph, loadFrontier(scanDir, contextId), readJson(path.join(contextDir(scanDir, contextId), 'metrics.json')), 'nodes');
    const depth = jsonArg(args.depth, { pathDepth: 0, routeDepth: 0, modalDepth: 0 }); if (depth.pathDepth !== 0 || depth.routeDepth !== 0 || depth.modalDepth !== 0) fail('Direct ReachableState must be a depth-zero non-modal root', 'SCAN_ENGINE_REQUIRED'); const budget = runBudget(scan, contextId); if (depth.pathDepth > maxDepth(budget)) fail('ReachableState exceeds depth budget', 'BUDGET_EXHAUSTED');
    const result = store.upsertReachableState(graph, { id: args.reachableStateId, visualStateId, arrivalSignature, depth, replayPathEdgeIds: jsonArg(args.replayPathEdgeIds, []) });
    commitEvent(scanDir, 'reachableStateUpserted', { contextId, reachableStateId: result.reachableState.id, visualStateId: result.reachableState.visualStateId, created: result.created, reachableState: result.reachableState }, [{ path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'reachableStates', keyFields: ['id'], value: result.reachableState, recompute: 'GRAPH' }]);
    const visual = graph.visualStates.find(item => item.id === result.reachableState.visualStateId); if ((result.reachableState.depth?.pathDepth || 0) === 0 && visual?.evidenceObservationIds?.[0]) establishCursor(scanDir, contextId, { reachableStateId: result.reachableState.id, observationId: visual.evidenceObservationIds[0], status: 'EXACT', establishedBy: 'ROOT_STATE' }, { incrementEpoch: true });
    return output({ schemaVersion: 1, ok: true, ...result });
  }
  if (command === 'record-edge') {
    fail('Direct Edge writes are disabled; use execute-frontier.js then commit-attempt.js', 'SCAN_ENGINE_REQUIRED');
  }
  if (command === 'validate') return output({ schemaVersion: 1, ...store.validateGraph(graph) });
  fail(`Unknown graph command: ${command}`, 'COMMAND_INVALID');
});
