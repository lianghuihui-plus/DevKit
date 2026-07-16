#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, readJson, writeJsonAtomic, ensureDir, hashObject, sha256, now, compactLocalTimestamp, compareTimestamps, output, main, fail, safeSegment } = require('./lib/common');
const { authDiff } = require('./lib/metrics');
const { updateCanonicalPaths, actionKey } = require('./lib/graph-store');
const { normalizeGraphForConsumption, assertConsumableGraph } = require('./lib/graph-normalization');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');

function compareRuns(left, right) {
  return compareTimestamps(left.finalizedAt, right.finalizedAt) || String(left.scanId).localeCompare(String(right.scanId));
}

function latest(items) { return [...items].sort(compareRuns).at(-1) || null; }
function snapId(prefix, value) { return `${prefix}-${hashObject(value).slice(-16)}`; }
function checksum(value) { return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function provenance(runId, sourceId, contextId) { return { runId, sourceId, evidencePath: `runs/${runId}/contexts/${contextId}/graph.json` }; }
function pushUnique(items, value, key = item => JSON.stringify(item)) { const encoded = key(value); if (!items.some(item => key(item) === encoded)) items.push(value); }
const FRONTIER_STATUSES = ['PENDING', 'CLAIMED', 'RETRYABLE', 'EXPLORED', 'COVERED_BY_GROUP', 'SKIPPED', 'BLOCKED', 'FAILED'];

function addCounts(target, source = {}) {
  for (const status of FRONTIER_STATUSES) target[status] = (target[status] || 0) + Number(source[status] || 0);
  return target;
}

function runExecution(root, registered) {
  const runDir = path.join(root, 'runs', registered.scanId); const scan = readJson(path.join(runDir, 'scan.json'));
  const contexts = (registered.contexts || runContextIds(scan)).map(contextId => {
    const metric = readJson(path.join(runDir, 'contexts', contextId, 'metrics.json'), {});
    return {
      contextId,
      activeDurationMs: Number(metric.activeDurationMs || 0),
      actions: Number(metric.actions || 0),
      explorationActions: Number(metric.explorationActions || 0),
      navigationActions: Number(metric.navigationActions || 0),
      recoveryActions: Number(metric.recoveryActions || 0),
      verificationActions: Number(metric.verificationActions || 0),
      coldStarts: Number(metric.coldStarts || 0),
      cursorReuseHits: Number(metric.cursorReuseHits || 0),
      cursorInvalidations: Number(metric.cursorInvalidations || 0),
      backtrackNavigations: Number(metric.backtrackNavigations || 0),
      graphPathNavigations: Number(metric.graphPathNavigations || 0),
      coldReplayNavigations: Number(metric.coldReplayNavigations || 0),
      observations: Number(metric.observations || 0),
      observationSamples: Number(metric.observationSamples || 0),
      observationStabilityWaitMs: Number(metric.observationStabilityWaitMs || 0),
      dynamicVisualObservations: Number(metric.dynamicVisualObservations || 0),
      restoreAttempts: Number(metric.restoreAttempts || 0),
      interruptionActions: Number(metric.interruptionActions || 0),
      noStateChangeActions: Number(metric.noStateChangeActions || 0),
      safeCandidateCoverage: metric.safeCandidateCoverage ?? null,
      frontierCounts: addCounts({}, metric.frontierCounts)
    };
  });
  const totals = contexts.reduce((sum, context) => {
    for (const key of ['activeDurationMs', 'actions', 'explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'coldStarts', 'cursorReuseHits', 'cursorInvalidations', 'backtrackNavigations', 'graphPathNavigations', 'coldReplayNavigations', 'observations', 'observationSamples', 'observationStabilityWaitMs', 'dynamicVisualObservations', 'restoreAttempts', 'interruptionActions', 'noStateChangeActions']) sum[key] += context[key];
    addCounts(sum.frontierCounts, context.frontierCounts); return sum;
  }, { activeDurationMs: 0, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, coldStarts: 0, cursorReuseHits: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, dynamicVisualObservations: 0, restoreAttempts: 0, interruptionActions: 0, noStateChangeActions: 0, frontierCounts: {} });
  const startedAt = scan.startedAt || scan.createdAt || registered.startedAt || null; const finalizedAt = scan.finalizedAt || registered.finalizedAt || null;
  const startedMs = Date.parse(startedAt || ''); const finalizedMs = Date.parse(finalizedAt || '');
  return {
    scanId: scan.scanId,
    parentScanId: scan.parentScanId || null,
    mapRevisionId: scan.mapRevisionId || scan.scanId,
    status: scan.status,
    scanMode: scan.scanMode,
    scanScope: scan.scanScope,
    profile: scan.profile,
    contexts,
    startedAt,
    finalizedAt,
    wallDurationMs: Number.isFinite(startedMs) && Number.isFinite(finalizedMs) ? Math.max(0, finalizedMs - startedMs) : null,
    pausedDurationMs: Number(scan.pausedDurationMs || 0),
    totals
  };
}

function logicalSemanticKey(logical) {
  return String(logical.id || hashObject([logical.name || '', logical.description || '']));
}

function verificationFact(root, runId, edge) {
  if (edge.verification?.transitionFingerprint) return { ...edge.verification, sourceRunId: runId };
  const attemptFile = edge.attemptId ? path.join(root, 'runs', runId, 'attempts', `${edge.attemptId}.json`) : null; if (!attemptFile || !fs.existsSync(attemptFile)) return { discoveryStatus: 'OBSERVED', replayStatus: 'UNVERIFIED', transitionFingerprint: null, verificationRefs: [], sourceRunId: runId, legacyReason: 'ATTEMPT_MISSING' };
  const attempt = readJson(attemptFile); const restores = attempt.restoreResults || []; const successful = restores.find(item => item.status === 'SUCCEEDED'); if (!successful) return { discoveryStatus: 'OBSERVED', replayStatus: 'UNVERIFIED', transitionFingerprint: null, verificationRefs: [], sourceRunId: runId, legacyReason: 'RESTORE_CHAIN_MISSING' };
  const exact = !(successful.equivalenceReviews || []).length && (successful.steps || []).every(step => step.verificationStatus === 'EXACT'); const actionFile = path.join(root, 'runs', runId, 'evidence', 'actions', `${edge.evidence?.actionResultId}.json`); const action = fs.existsSync(actionFile) ? readJson(actionFile) : null;
  return { discoveryStatus: 'OBSERVED', replayStatus: exact && action?.locatorResolution === 'SEMANTIC_VERIFIED' ? 'COLD_REPLAY_VERIFIED' : exact ? 'REPLAY_UNSTABLE' : 'REPLAY_UNSTABLE', transitionFingerprint: null, verificationRefs: [`runs/${runId}/evidence/restores/${successful.restoreId}.json`], sourceRunId: runId, legacyReason: exact ? 'COORDINATE_ONLY' : 'EXPECTED_STATE_EQUIVALENT' };
}

function arrivalDescriptor(graph, state, visualMetaById) {
  const root = (state.depth?.pathDepth || 0) === 0;
  const visual = visualMetaById.get(state.visualStateId);
  const sourceBack = graph.reachableStates.find(item => item.id === state.arrivalSignature?.expectedBackReachableStateId);
  const backVisual = sourceBack ? visualMetaById.get(sourceBack.visualStateId) : null;
  const { expectedBackReachableStateId: ignoredBack, stateInvariantHash: ignoredInvariant, expectedBackVisualStateId: ignoredVisual, expectedBackLogicalScreenKey: ignoredLogical, ...arrival } = state.arrivalSignature || {};
  void ignoredBack; void ignoredInvariant; void ignoredVisual; void ignoredLogical;
  return root ? { root: true } : {
    root: false,
    logicalScreenKey: visual?.logicalSemanticKey || null,
    kind: visual?.kind || 'full-screen',
    expectedBackLogicalScreenKey: backVisual?.logicalSemanticKey || null,
    arrival
  };
}

function pruneToActiveGraph(graph) {
  const roots = graph.reachableStates.filter(state => (state.depth?.pathDepth || 0) === 0);
  const reachable = new Set(roots.map(state => state.id)); const queue = [...reachable];
  while (queue.length) {
    const from = queue.shift();
    for (const edge of graph.edges.filter(item => item.fromReachableStateId === from)) {
      if (!reachable.has(edge.toReachableStateId)) { reachable.add(edge.toReachableStateId); queue.push(edge.toReachableStateId); }
    }
  }
  const before = { states: graph.reachableStates.length, edges: graph.edges.length };
  graph.reachableStates = graph.reachableStates.filter(state => reachable.has(state.id));
  const stateIds = new Set(graph.reachableStates.map(state => state.id));
  graph.edges = graph.edges.filter(edge => stateIds.has(edge.fromReachableStateId) && stateIds.has(edge.toReachableStateId));
  const visualIds = new Set(graph.reachableStates.map(state => state.visualStateId));
  graph.visualStates = graph.visualStates.filter(visual => visualIds.has(visual.id));
  const logicalIds = new Set(graph.visualStates.map(visual => visual.logicalScreenKey));
  graph.logicalScreens = graph.logicalScreens.filter(logical => logicalIds.has(logical.id));
  for (const logical of graph.logicalScreens) logical.visualStateIds = graph.visualStates.filter(visual => visual.logicalScreenKey === logical.id).map(visual => visual.id);
  for (const state of graph.reachableStates) {
    if (state.arrivalSignature?.expectedBackReachableStateId && !stateIds.has(state.arrivalSignature.expectedBackReachableStateId)) state.arrivalSignature.expectedBackReachableStateId = null;
    state.incomingEdgeIds = graph.edges.filter(edge => edge.toReachableStateId === state.id).map(edge => edge.id);
  }
  updateCanonicalPaths(graph);
  return { prunedReachableStates: before.states - graph.reachableStates.length, prunedEdges: before.edges - graph.edges.length };
}

function mergeContext(root, contextId, sourceRuns) {
  const target = { schemaVersion: 1, contextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] };
  const logicalByKey = new Map(); const visualByKey = new Map(); const reachableByKey = new Map(); const edgeByKey = new Map(); const verificationByKey = new Map();
  const unresolved = []; let replacementCount = 0;
  for (const run of sourceRuns) {
    const runId = run.scanId; const sourceGraph = readJson(path.join(root, 'runs', runId, 'contexts', contextId, 'graph.json'));
    const normalized = normalizeGraphForConsumption(sourceGraph, { runId, contextId }); const graph = normalized.graph; unresolved.push(...normalized.issues);
    const logicalMap = new Map(); const logicalSemanticById = new Map(); const visualMap = new Map(); const visualMetaById = new Map(); const reachableMap = new Map();

    for (const logical of graph.logicalScreens) {
      const semantic = logicalSemanticKey(logical); const key = hashObject(['logical-screen', semantic]); let item = logicalByKey.get(key);
      const source = provenance(runId, logical.id, contextId);
      if (!item) {
        item = { id: snapId('ls', key), name: logical.name, description: logical.description || '', visualStateIds: [], evidenceRunIds: [], semanticKey: semantic, provenance: [] };
        logicalByKey.set(key, item); target.logicalScreens.push(item);
      }
      item.name = logical.name; item.description = logical.description || ''; pushUnique(item.evidenceRunIds, runId, value => value); pushUnique(item.provenance, source);
      logicalMap.set(logical.id, item.id); logicalSemanticById.set(logical.id, semantic);
    }

    for (const visual of graph.visualStates) {
      const logicalId = logicalMap.get(visual.logicalScreenKey); const logicalSemantic = logicalSemanticById.get(visual.logicalScreenKey);
      const key = hashObject([contextId, logicalSemantic, visual.kind || 'full-screen', visual.fingerprint || null]); let item = visualByKey.get(key);
      const sources = item?.provenance || []; const evidence = item?.evidenceObservationRefs || [];
      if (!item) {
        item = { ...visual, id: snapId('vs', key), logicalScreenKey: logicalId, availableIn: [contextId], evidenceObservationRefs: evidence, snapshotKey: key, provenance: sources };
        delete item.evidenceObservationIds; visualByKey.set(key, item); target.visualStates.push(item);
      } else Object.assign(item, { ...visual, id: item.id, logicalScreenKey: logicalId, availableIn: [contextId], evidenceObservationRefs: evidence, snapshotKey: key, provenance: sources });
      delete item.evidenceObservationIds;
      pushUnique(item.provenance, provenance(runId, visual.id, contextId));
      for (const observationId of visual.evidenceObservationIds || []) pushUnique(item.evidenceObservationRefs, { runId, observationId });
      visualMap.set(visual.id, item.id); visualMetaById.set(visual.id, { logicalSemanticKey: logicalSemantic, logicalSnapshotId: logicalId, kind: visual.kind || 'full-screen' });
    }

    for (const state of graph.reachableStates) {
      const descriptor = arrivalDescriptor(graph, state, visualMetaById); const key = hashObject([contextId, descriptor]); let item = reachableByKey.get(key);
      const sources = item?.provenance || []; const id = item?.id || snapId('rs', key);
      const visualMeta = visualMetaById.get(state.visualStateId); const normalizedArrival = {
        ...descriptor.arrival,
        expectedBackReachableStateId: null,
        expectedBackLogicalScreenKey: descriptor.expectedBackLogicalScreenKey ? snapId('ls', hashObject(['logical-screen', descriptor.expectedBackLogicalScreenKey])) : null,
        stateInvariantHash: hashObject([contextId, descriptor])
      };
      if (!item) {
        item = { ...state, id, visualStateId: visualMap.get(state.visualStateId), arrivalSignature: normalizedArrival, incomingEdgeIds: [], replayPathEdgeIds: [], snapshotKey: key, semanticDescriptor: descriptor, provenance: sources };
        reachableByKey.set(key, item); target.reachableStates.push(item);
      } else Object.assign(item, { ...state, id, visualStateId: visualMap.get(state.visualStateId), arrivalSignature: normalizedArrival, incomingEdgeIds: [], replayPathEdgeIds: [], snapshotKey: key, semanticDescriptor: descriptor, provenance: sources });
      if (!visualMeta) unresolved.push({ type: 'EDGE_ENDPOINT_UNRESOLVED', contextId, runId, sourceReachableStateId: state.id });
      pushUnique(item.provenance, provenance(runId, state.id, contextId)); reachableMap.set(state.id, item.id);
    }

    for (const state of graph.reachableStates) {
      const mapped = target.reachableStates.find(item => item.id === reachableMap.get(state.id));
      if (mapped) mapped.arrivalSignature.expectedBackReachableStateId = reachableMap.get(state.arrivalSignature?.expectedBackReachableStateId) || null;
    }

    for (const edge of graph.edges) {
      const from = reachableMap.get(edge.fromReachableStateId); const to = reachableMap.get(edge.toReachableStateId);
      if (!from || !to) { unresolved.push({ type: 'EDGE_ENDPOINT_UNRESOLVED', contextId, runId, sourceEdgeId: edge.id }); continue; }
      const sourceState = target.reachableStates.find(state => state.id === from); const semanticKey = hashObject([contextId, sourceState?.snapshotKey || from, actionKey(edge.action)]); let item = edgeByKey.get(semanticKey);
      const sources = item?.provenance || []; const superseded = item?.superseded || []; const source = provenance(runId, edge.id, contextId);
      if (item && item.toReachableStateId !== to) {
        superseded.push({ sourceRunId: item.evidence?.sourceRunId || sources.at(-1)?.runId || null, sourceEdgeId: sources.at(-1)?.sourceId || null, toReachableStateId: item.toReachableStateId, replacedByRunId: runId, replacedBySourceEdgeId: edge.id }); replacementCount += 1;
      }
      const id = item?.id || snapId('edge', semanticKey); const sourceVerification = verificationFact(root, runId, edge); const transitionFingerprint = sourceVerification.transitionFingerprint || hashObject({ contextId, sourceSnapshotKey: sourceState?.snapshotKey || from, action: edge.action, targetSnapshotKey: target.reachableStates.find(state => state.id === to)?.snapshotKey || to }); const factKey = hashObject([semanticKey, transitionFingerprint]);
      if (sourceVerification.replayStatus !== 'UNVERIFIED') verificationByKey.set(factKey, { ...sourceVerification, transitionFingerprint }); const inheritedVerification = verificationByKey.get(factKey); const verification = sourceVerification.replayStatus === 'UNVERIFIED' && inheritedVerification ? { ...inheritedVerification, inheritedByFingerprint: true } : { ...sourceVerification, transitionFingerprint };
      const latestEdge = { ...edge, verification, id, fromReachableStateId: from, toReachableStateId: to, semanticKey, evidence: { ...(edge.evidence || {}), sourceRunId: runId }, provenance: sources, superseded };
      if (!item) { item = latestEdge; edgeByKey.set(semanticKey, item); target.edges.push(item); } else Object.assign(item, latestEdge);
      pushUnique(item.provenance, source);
    }
  }
  for (const edge of target.edges) if (['UNVERIFIED', 'REPLAY_UNSTABLE'].includes(edge.verification?.replayStatus)) unresolved.push({ type: edge.verification.replayStatus === 'REPLAY_UNSTABLE' ? 'REPLAY_UNSTABLE' : 'UNVERIFIED_EDGE', contextId, edgeId: edge.id, sourceRunId: edge.evidence?.sourceRunId || null });
  const pruning = pruneToActiveGraph(target); assertConsumableGraph(target, fail);
  return { graph: target, unresolved, replacementCount, ...pruning };
}

main(() => {
  const args = parseArgs(); const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root'); const app = readJson(path.join(root, 'app.json')); const index = readJson(path.join(root, 'run-index.json'));
  const qualified = index.runs.filter(run => ['COMPLETED', 'PARTIAL'].includes(run.status)); if (!qualified.length) fail('No qualified terminal Runs', 'SNAPSHOT_NO_SOURCE');
  const explicitVersion = args.versionKey || null; const selectedVersion = explicitVersion || latest(qualified.filter(run => run.versionKey))?.versionKey || null;
  const versionCandidates = selectedVersion ? qualified.filter(run => run.versionKey === selectedVersion) : qualified.filter(run => !run.versionKey); if (!versionCandidates.length) fail('No source Run matches the requested version', 'SNAPSHOT_NO_SOURCE');
  const selectedRevision = args.mapRevisionId ? safeSegment(args.mapRevisionId, 'mapRevisionId') : null;
  const candidates = versionCandidates.filter(run => !selectedRevision || (run.mapRevisionId || run.scanId) === selectedRevision).sort(compareRuns); if (!candidates.length) fail('No source Run matches the requested map revision', 'SNAPSHOT_NO_SOURCE');
  for (const run of candidates) { safeSegment(run.scanId, 'scanId'); validate(path.join(root, 'runs', run.scanId), run.status); }

  const contextIds = ['guest', 'authenticated']; const contexts = {}; const sourcePlans = {}; const missingContexts = []; const unresolved = []; const mergeMetrics = {};
  for (const contextId of contextIds) {
    const sources = candidates.filter(run => run.contexts.includes(contextId)); sourcePlans[contextId] = sources.map(run => run.scanId);
    const merged = mergeContext(root, contextId, sources); unresolved.push(...merged.unresolved);
    mergeMetrics[contextId] = { replacementCount: merged.replacementCount, prunedReachableStates: merged.prunedReachableStates, prunedEdges: merged.prunedEdges };
    if (merged.graph.reachableStates.length) contexts[contextId] = merged.graph; else missingContexts.push(contextId);
  }

  const map = { schemaVersion: 1, appKey: app.appKey, versionKey: selectedVersion, contexts }; const unresolvedDoc = { schemaVersion: 1, items: unresolved }; const diff = authDiff(map);
  const normalizationIssues = unresolved.filter(item => ['LEGACY_NON_GRAPH_ACTION_DROPPED', 'LEGACY_REACHABILITY_PRUNED'].includes(item.type));
  const executionRuns = candidates.map(run => runExecution(root, run));
  const executionTotals = executionRuns.reduce((sum, run) => {
    for (const key of ['activeDurationMs', 'actions', 'explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'coldStarts', 'cursorReuseHits', 'cursorInvalidations', 'backtrackNavigations', 'graphPathNavigations', 'coldReplayNavigations', 'observations', 'observationSamples', 'observationStabilityWaitMs', 'dynamicVisualObservations', 'restoreAttempts', 'interruptionActions', 'noStateChangeActions']) sum[key] += run.totals[key];
    addCounts(sum.frontierCounts, run.totals.frontierCounts); return sum;
  }, { runCount: executionRuns.length, activeDurationMs: 0, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, coldStarts: 0, cursorReuseHits: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, dynamicVisualObservations: 0, restoreAttempts: 0, interruptionActions: 0, noStateChangeActions: 0, frontierCounts: {} });
  const metrics = { schemaVersion: 2, contexts: Object.fromEntries(Object.entries(contexts).map(([id, graph]) => [id, { logicalScreenCount: graph.logicalScreens.length, visualStateCount: graph.visualStates.length, reachableStateCount: graph.reachableStates.length, edgeCount: graph.edges.length, ...mergeMetrics[id] }])), execution: { schemaVersion: 1, totals: executionTotals, runs: executionRuns }, merge: { policy: 'LATEST_OBSERVATION_WINS', replacementCount: Object.values(mergeMetrics).reduce((sum, item) => sum + item.replacementCount, 0) }, normalization: { issueCount: normalizationIssues.length, droppedWaitEdges: normalizationIssues.filter(item => item.type === 'LEGACY_NON_GRAPH_ACTION_DROPPED').reduce((sum, item) => sum + (item.count || 0), 0), prunedReachableStates: normalizationIssues.filter(item => item.type === 'LEGACY_REACHABILITY_PRUNED').reduce((sum, item) => sum + (item.droppedReachableStateIds?.length || 0), 0) } };
  const generationId = `snapshot-${compactLocalTimestamp(new Date(), { milliseconds: true })}-${hashObject({ sourcePlans, selectedVersion, selectedRevision }).slice(-8)}`; const dir = path.join(root, 'snapshots', 'generations', generationId); if (fs.existsSync(dir)) fail('Snapshot generation already exists', 'SNAPSHOT_EXISTS'); ensureDir(dir);
  writeJsonAtomic(path.join(dir, 'map.json'), map); writeJsonAtomic(path.join(dir, 'auth-diff.json'), diff); writeJsonAtomic(path.join(dir, 'unresolved.json'), unresolvedDoc); writeJsonAtomic(path.join(dir, 'metrics.json'), metrics);
  const representative = latest(candidates); const mapRevisionIds = [...new Set(candidates.map(run => run.mapRevisionId || run.scanId))];
  const manifest = { schemaVersion: 2, generationId, appKey: app.appKey, appVersion: representative?.appVersion || null, buildVersion: representative?.buildVersion || null, versionKey: selectedVersion, aggregationScope: selectedRevision ? 'MAP_REVISION' : 'APP_VERSION', aggregationPolicy: 'LATEST_OBSERVATION_WINS', mapRevisionId: selectedRevision, mapRevisionIds, generatedAt: now(), sourceRuns: candidates.map(run => ({ scanId: run.scanId, status: run.status, scanMode: run.scanMode, scanScope: run.scanScope, mapRevisionId: run.mapRevisionId || run.scanId, finalizedAt: run.finalizedAt })), sourcePlans, missingContexts, status: selectedVersion ? missingContexts.length || unresolved.length ? 'PARTIAL' : 'READY' : 'VERSION_UNKNOWN', checksums: { map: checksum(map), authDiff: checksum(diff), unresolved: checksum(unresolvedDoc), metrics: checksum(metrics) } };
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest); const pointer = { schemaVersion: 1, generationId, relativePath: `generations/${generationId}`, manifestSha256: checksum(manifest), updatedAt: now() }; writeJsonAtomic(path.join(root, 'snapshots', 'current.json'), pointer);
  output({ schemaVersion: 1, ok: true, snapshotDir: dir, currentPointer: path.join(root, 'snapshots', 'current.json'), manifest });
});
