#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, readJson, writeJsonAtomic, ensureDir, hashObject, sha256, now, compactLocalTimestamp, compareTimestamps, output, main, fail, safeSegment } = require('./lib/common');
const { authDiff } = require('./lib/metrics');
const { validateGraph } = require('./lib/graph-store');
const { normalizeGraphForConsumption, assertConsumableGraph } = require('./lib/graph-normalization');
const { runContextIds } = require('./lib/run-protocol');
const { canonicalContexts, loadCanonicalContext } = require('./lib/canonical-map-store');

function compareRuns(left, right) {
  return compareTimestamps(left.finalizedAt, right.finalizedAt) || String(left.scanId).localeCompare(String(right.scanId));
}

function latest(items) { return [...items].sort(compareRuns).at(-1) || null; }
function checksum(value) { return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
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
      visualVarianceObservations: Number(metric.visualVarianceObservations || 0),
      restoreAttempts: Number(metric.restoreAttempts || 0),
      interruptionActions: Number(metric.interruptionActions || 0),
      noStateChangeActions: Number(metric.noStateChangeActions || 0),
      safeCandidateCoverage: metric.safeCandidateCoverage ?? null,
      frontierCounts: addCounts({}, metric.frontierCounts)
    };
  });
  const totals = contexts.reduce((sum, context) => {
    for (const key of ['activeDurationMs', 'actions', 'explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'coldStarts', 'cursorReuseHits', 'cursorInvalidations', 'backtrackNavigations', 'graphPathNavigations', 'coldReplayNavigations', 'observations', 'observationSamples', 'observationStabilityWaitMs', 'visualVarianceObservations', 'restoreAttempts', 'interruptionActions', 'noStateChangeActions']) sum[key] += context[key];
    addCounts(sum.frontierCounts, context.frontierCounts); return sum;
  }, { activeDurationMs: 0, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, coldStarts: 0, cursorReuseHits: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, visualVarianceObservations: 0, restoreAttempts: 0, interruptionActions: 0, noStateChangeActions: 0, frontierCounts: {} });
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

function graphHasContent(graph) {
  return Boolean((graph.reachableStates || []).length || (graph.edges || []).length || (graph.visualStates || []).length);
}

function frontierCounts(frontier) {
  return (frontier.items || []).reduce((sum, item) => {
    const status = item.status || 'UNKNOWN';
    sum[status] = (sum[status] || 0) + 1;
    return sum;
  }, {});
}

function canonicalUnresolved(contextId, graph, frontier, queue, sourceRunIds) {
  const unresolved = [];
  unresolved.push(...(graph.visualStates || []).filter(x => x.dedupe?.status === 'PROBABLE').map(x => ({ type: 'PROBABLE_VISUAL_DUPLICATE', contextId, visualStateId: x.id, duplicateGroupId: x.dedupe.duplicateGroupId, sourceRunId: sourceRunIds.at(-1) || null })));
  unresolved.push(...(graph.edges || []).filter(edge => ['UNVERIFIED', 'REPLAY_UNSTABLE'].includes(edge.verification?.replayStatus)).map(edge => ({ type: edge.verification?.replayStatus === 'REPLAY_UNSTABLE' ? 'REPLAY_UNSTABLE' : 'UNVERIFIED_EDGE', contextId, edgeId: edge.id, sourceRunId: edge.evidence?.sourceRunId || edge.verification?.sourceRunId || null })));
  unresolved.push(...(frontier.items || []).filter(item => ['PENDING', 'RETRYABLE', 'FAILED', 'BLOCKED'].includes(item.status)).map(item => ({ type: 'FRONTIER_UNRESOLVED', contextId, frontierId: item.id, status: item.status, reasonCode: item.reasonCode || null, sourceRunId: item.sourceRunId || null })));
  unresolved.push(...(queue.items || []).filter(item => ['PENDING', 'FAILED'].includes(item.status)).map(item => ({ type: 'VERIFICATION_UNRESOLVED', contextId, verificationId: item.verificationId, status: item.status, reasonCode: item.reasonCode || null, sourceRunId: item.sourceRunId || null })));
  return unresolved;
}

function candidateCoverageUnresolved(contextId, graph, coverage = {}, sourceRunIds = []) {
  const stateIds = new Set((graph.reachableStates || []).map(item => item.id));
  return [...new Set(coverage.backfillRequiredStateIds || [])]
    .filter(id => stateIds.has(id))
    .map(reachableStateId => ({
      type: 'CANDIDATE_BACKFILL_REQUIRED',
      contextId,
      reachableStateId,
      sourceRunId: sourceRunIds.at(-1) || null
    }));
}

function buildCanonicalSnapshotIfAvailable(root, app, args, index) {
  const available = canonicalContexts(root).map(contextId => loadCanonicalContext(root, contextId)).filter(canonical => graphHasContent(canonical.graph));
  if (!available.length) return null;
  const selectedRevision = args.mapRevisionId ? safeSegment(args.mapRevisionId, 'mapRevisionId') : null;
  if (selectedRevision && !available.some(canonical => canonical.meta.mapRevisionId === selectedRevision)) fail('No canonical map matches the requested map revision', 'SNAPSHOT_NO_SOURCE');
  const contexts = {}; const sourcePlans = {}; const missingContexts = []; const unresolved = []; const canonicalMetrics = {}; const sourceRunIdSet = new Set(); const mapRevisionIds = [];
  for (const contextId of ['guest', 'authenticated']) {
    const canonical = available.find(item => item.contextId === contextId);
    if (!canonical || selectedRevision && canonical.meta.mapRevisionId !== selectedRevision) { missingContexts.push(contextId); continue; }
    const sourceRunIds = canonical.meta.sourceSessionIds || [];
    for (const id of sourceRunIds) sourceRunIdSet.add(id);
    if (canonical.meta.mapRevisionId) mapRevisionIds.push(canonical.meta.mapRevisionId);
    sourcePlans[contextId] = sourceRunIds;
    const normalized = normalizeGraphForConsumption(canonical.graph, { runId: 'canonical-map', contextId });
    unresolved.push(...normalized.issues);
    if (!normalized.graph.reachableStates.length) { missingContexts.push(contextId); continue; }
    validateGraph(normalized.graph);
    assertConsumableGraph(normalized.graph, fail);
    contexts[contextId] = normalized.graph;
    unresolved.push(...canonicalUnresolved(contextId, normalized.graph, canonical.frontier, canonical.verificationQueue, sourceRunIds));
    unresolved.push(...candidateCoverageUnresolved(contextId, normalized.graph, canonical.meta.candidateCoverage, sourceRunIds));
    const coverage = canonical.meta.candidateCoverage || {};
    canonicalMetrics[contextId] = { logicalScreenCount: normalized.graph.logicalScreens.length, visualStateCount: normalized.graph.visualStates.length, reachableStateCount: normalized.graph.reachableStates.length, edgeCount: normalized.graph.edges.length, replacementCount: 0, prunedReachableStates: 0, prunedEdges: 0, frontierCounts: frontierCounts(canonical.frontier), candidateCoverage: { backfillRequiredStateCount: (coverage.backfillRequiredStateIds || []).filter(id => normalized.graph.reachableStates.some(state => state.id === id)).length, states: coverage.states || [] }, mapRevisionId: canonical.meta.mapRevisionId || null };
  }
  const qualified = (index.runs || []).filter(run => ['COMPLETED', 'PARTIAL'].includes(run.status));
  const sourceRuns = qualified.filter(run => sourceRunIdSet.has(run.scanId)).sort(compareRuns);
  const selectedVersion = args.versionKey || latest(sourceRuns.filter(run => run.versionKey))?.versionKey || latest(qualified.filter(run => run.versionKey))?.versionKey || null;
  const executionCandidates = selectedVersion ? sourceRuns.filter(run => run.versionKey === selectedVersion) : sourceRuns;
  const executionRuns = executionCandidates.map(run => runExecution(root, run));
  const executionTotals = executionRuns.reduce((sum, run) => {
    for (const key of ['activeDurationMs', 'actions', 'explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'coldStarts', 'cursorReuseHits', 'cursorInvalidations', 'backtrackNavigations', 'graphPathNavigations', 'coldReplayNavigations', 'observations', 'observationSamples', 'observationStabilityWaitMs', 'visualVarianceObservations', 'restoreAttempts', 'interruptionActions', 'noStateChangeActions']) sum[key] += run.totals[key];
    addCounts(sum.frontierCounts, run.totals.frontierCounts); return sum;
  }, { runCount: executionRuns.length, activeDurationMs: 0, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, coldStarts: 0, cursorReuseHits: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, visualVarianceObservations: 0, restoreAttempts: 0, interruptionActions: 0, noStateChangeActions: 0, frontierCounts: {} });
  const map = { schemaVersion: 1, appKey: app.appKey, versionKey: selectedVersion, contexts }; const unresolvedDoc = { schemaVersion: 1, items: unresolved }; const diff = authDiff(map);
  const metrics = { schemaVersion: 2, contexts: canonicalMetrics, execution: { schemaVersion: 1, totals: executionTotals, runs: executionRuns }, merge: { policy: 'CANONICAL_MAP_ONLY', replacementCount: 0 }, normalization: { issueCount: 0, droppedWaitEdges: 0, prunedReachableStates: 0 } };
  const generationId = `snapshot-${compactLocalTimestamp(new Date(), { milliseconds: true })}-${hashObject({ sourcePlans, mapRevisionIds, selectedRevision }).slice(-8)}`; const dir = path.join(root, 'snapshots', 'generations', generationId); if (fs.existsSync(dir)) fail('Snapshot generation already exists', 'SNAPSHOT_EXISTS'); ensureDir(dir);
  writeJsonAtomic(path.join(dir, 'map.json'), map); writeJsonAtomic(path.join(dir, 'auth-diff.json'), diff); writeJsonAtomic(path.join(dir, 'unresolved.json'), unresolvedDoc); writeJsonAtomic(path.join(dir, 'metrics.json'), metrics);
  const representative = latest(sourceRuns) || latest(qualified);
  const manifest = { schemaVersion: 2, generationId, appKey: app.appKey, appVersion: representative?.appVersion || null, buildVersion: representative?.buildVersion || null, versionKey: selectedVersion, aggregationScope: 'CANONICAL_MAP', aggregationPolicy: 'CANONICAL_MAP_ONLY', mapRevisionId: selectedRevision || null, mapRevisionIds: [...new Set(mapRevisionIds)], generatedAt: now(), sourceRuns: sourceRuns.map(run => ({ scanId: run.scanId, status: run.status, scanMode: run.scanMode, scanScope: run.scanScope, mapRevisionId: run.mapRevisionId || run.scanId, mapBaseRevisionId: run.mapBaseRevisionId || null, finalizedAt: run.finalizedAt })), sourcePlans, missingContexts, status: missingContexts.length || unresolved.length ? 'PARTIAL' : 'READY', checksums: { map: checksum(map), authDiff: checksum(diff), unresolved: checksum(unresolvedDoc), metrics: checksum(metrics) } };
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest); const pointer = { schemaVersion: 1, generationId, relativePath: `generations/${generationId}`, manifestSha256: checksum(manifest), updatedAt: now() }; writeJsonAtomic(path.join(root, 'snapshots', 'current.json'), pointer);
  return { schemaVersion: 1, ok: true, snapshotDir: dir, currentPointer: path.join(root, 'snapshots', 'current.json'), manifest };
}

main(() => {
  const args = parseArgs(); const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root'); const app = readJson(path.join(root, 'app.json')); const index = readJson(path.join(root, 'run-index.json'));
  const canonicalSnapshot = buildCanonicalSnapshotIfAvailable(root, app, args, index);
  if (canonicalSnapshot) { output(canonicalSnapshot); return; }
  fail('No canonical map is available for Snapshot generation; register a COMPLETED or PARTIAL Run first', 'SNAPSHOT_NO_CANONICAL_MAP');
});
