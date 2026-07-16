#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, readJson, jsonArg, commitEvent, output, main, fail, contextDir, loadFrontier, hashObject, bool } = require('./lib/common');
const { buildFingerprint, observationVisual } = require('./lib/fingerprint');
const store = require('./lib/graph-store');
const { assertCapacity } = require('./lib/budget');
const { activeContextId, runBudget, maxDepth } = require('./lib/run-protocol');
const { establishCursor } = require('./lib/live-cursor');

function requireObservation(scanDir, id) {
  const dir = path.join(scanDir, 'evidence', 'observations', id); const observation = readJson(path.join(dir, 'observation.json'));
  if (observation.captureStatus !== 'COMPLETE' || !fs.existsSync(path.join(dir, 'screenshot.png')) || !fs.existsSync(path.join(dir, 'layout.json'))) fail(`Observation ${id} is incomplete`, 'EVIDENCE_INCOMPLETE');
  return { observation, layout: readJson(path.join(dir, 'layout.json')) };
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'show'; const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: command !== 'show' && command !== 'validate' }); const contextId = args.context || activeContextId(scan);
  if (!contextId) fail('context is required', 'CONTEXT_REQUIRED'); const graph = loadGraph(scanDir, contextId);
  if (command === 'show') return output(graph);
  if (command === 'upsert-visual') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Graph mutation requires the active SCANNING context', 'RUN_STATE_INVALID');
    if (!bool(args.root, false) || graph.edges.length) fail('Direct graph upsert is reserved for initial root states; use commit-attempt.js for discovered states', 'SCAN_ENGINE_REQUIRED');
    const observationId = required(args, 'observationId'); const evidence = requireObservation(scanDir, observationId);
    if (evidence.observation.foreground?.bundleName && evidence.observation.foreground.bundleName !== scan.target.bundleName) fail('Observation outside the target App cannot create a VisualState', 'APP_LEFT_FOREGROUND');
    if (evidence.observation.contextId !== contextId) fail('Observation context does not match graph context', 'CONTEXT_EVIDENCE_INVALID');
    const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json')); if (context.verification?.observationId !== observationId || context.verification?.preparationId !== evidence.observation.contextPreparationId) fail('Root VisualState must use the confirmed cold-start context observation', 'CONTEXT_EVIDENCE_INVALID');
    const logicalScreenKey = args.logicalScreenKey || `screen-${graph.logicalScreens.length + 1}`; const name = args.name || logicalScreenKey; const fingerprint = buildFingerprint(evidence.layout, evidence.observation.foreground, observationVisual(evidence.observation));
    const visualMatch = store.findVisualMatch(graph, fingerprint); if (visualMatch.status === 'EXACT' && visualMatch.visualState.logicalScreenKey !== logicalScreenKey) fail(`Observation already belongs to LogicalScreen ${visualMatch.visualState.logicalScreenKey}`, 'LOGICAL_SCREEN_CONFLICT');
    store.upsertLogicalScreen(graph, logicalScreenKey, name, args.description || '', scan.scanId);
    const result = store.upsertVisualState(graph, { id: args.visualStateId, logicalScreenKey, name, kind: args.kind || 'full-screen', observationId, fingerprint });
    const logicalScreen = graph.logicalScreens.find(x => x.id === logicalScreenKey); commitEvent(scanDir, 'visualStateUpserted', { contextId, visualStateId: result.visualState.id, observationId, created: result.created, dedupeStatus: result.dedupeStatus, logicalScreen, visualState: result.visualState }, [{ path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: logicalScreen, recompute: 'GRAPH' }, { path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'visualStates', keyFields: ['id'], value: result.visualState, recompute: 'GRAPH' }]);
    return output({ schemaVersion: 1, ok: true, ...result });
  }
  if (command === 'upsert-reachable') {
    if (scan.status !== 'SCANNING' || activeContextId(scan) !== contextId) fail('Graph mutation requires the active SCANNING context', 'RUN_STATE_INVALID');
    if (!bool(args.root, false) || graph.edges.length) fail('Direct graph upsert is reserved for initial root states; use commit-attempt.js for discovered states', 'SCAN_ENGINE_REQUIRED');
    const arrivalSignature = jsonArg(args.arrivalSignature, {}); const visualStateId = required(args, 'visualStateId');
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
