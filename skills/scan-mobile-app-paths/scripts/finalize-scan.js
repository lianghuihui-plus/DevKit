#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, writeJsonAtomic, contextDir, transitionWithOps, commitEvent, output, main, fail, bool } = require('./lib/common');
const { validateGraph } = require('./lib/graph-store');
const { contextMetrics, authDiff } = require('./lib/metrics');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');
const { isCurrentRun } = require('./lib/run-protocol');
const { reconcileVerificationQueue } = require('./lib/verification-store');
const { projectFinalizationMetrics } = require('./lib/finalization');
const { assessFinalization } = require('./lib/finalization-guard');
const { verificationUnresolvedItems } = require('./lib/finalization-unresolved');
const { modeForScan } = require('./lib/modes');

function goalFoundVerified(scanDir, scan) {
  if (scan.scanMode !== 'goal-directed') return false;
  const result = readJson(path.join(scanDir, 'goal', 'match-result.json'), null);
  return result?.status === 'FOUND_VERIFIED';
}

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  const status = String(args.status || 'COMPLETED').toUpperCase(); if (!['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(status)) fail('Invalid final status', 'STATUS_INVALID');
  if (isCurrentRun(scan)) for (const contextId of runContextIds(scan)) {
    const projection = reconcileVerificationQueue(scanDir, scan, contextId, loadGraph(scanDir, contextId), { persist: false });
    if (projection.scheduled.length || projection.superseded.length) commitEvent(scanDir, 'verificationQueueReconciled', { contextId, scheduled: projection.scheduled, superseded: projection.superseded }, [{ path: `contexts/${contextId}/verification-queue.json`, op: 'REPLACE', value: projection.queue }]);
  }
  const finalizationStartedAt = new Date().toISOString();
  const finalizationProjection = projectFinalizationMetrics(scanDir, scan, finalizationStartedAt);
  const reasonCode = args.reasonCode || null;
  const finalizationAssessment = assessFinalization({
    scanDir,
    scan,
    requestedStatus: status,
    reasonCode,
    confirmUserStop: bool(args.confirmUserStop, false),
    userStopNote: args.userStopNote || null,
    metricsOverridesByContext: finalizationProjection.metricsByContext
  });
  if (!finalizationAssessment.canFinalize) fail(finalizationAssessment.message, finalizationAssessment.reasonCode, 2, { finalizationAssessment });
  const validation = validate(scanDir, status, { metricsOverridesByContext: finalizationProjection.metricsByContext });
  commitEvent(scanDir, 'finalizationAssessed', { allowed: true, finalizationStartedAt, finalizationAssessment }, []);
  for (const op of finalizationProjection.projectionOps) commitEvent(scanDir, 'activeWindowClosedForFinalization', { contextId: op.value.contextId, finalizationStartedAt, activeDurationMs: op.value.activeDurationMs }, [op]);
  const contexts = {}; const metricsByContext = {};
  for (const contextId of runContextIds(scan)) {
    const graph = loadGraph(scanDir, contextId); validateGraph(graph);
    const localObservationIds = new Set();
    for (const visual of graph.visualStates || []) for (const observationId of visual.evidenceObservationIds || []) localObservationIds.add(observationId);
    for (const edge of graph.edges || []) {
      const inheritedEdge = edge.inheritedFromCanonicalMap === true || edge.evidence?.sourceRunId && edge.evidence.sourceRunId !== scan.scanId;
      if (inheritedEdge) continue;
      if (edge.evidence?.beforeObservationId) localObservationIds.add(edge.evidence.beforeObservationId);
      if (edge.evidence?.afterObservationId) localObservationIds.add(edge.evidence.afterObservationId);
    }
    for (const observationId of localObservationIds) {
      const dir = path.join(scanDir, 'evidence', 'observations', observationId);
      if (!fs.existsSync(path.join(dir, 'observation.json')) || !fs.existsSync(path.join(dir, 'screenshot.png')) || !fs.existsSync(path.join(dir, 'layout.json'))) fail(`Missing evidence for ${observationId}`, 'EVIDENCE_INCOMPLETE');
    }
    const frontier = loadFrontier(scanDir, contextId); const runtime = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
    const metrics = contextMetrics(graph, frontier, runtime); commitEvent(scanDir, 'contextMetricsMaterialized', { contextId, metrics }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]); metricsByContext[contextId] = metrics; contexts[contextId] = graph;
  }
  const map = { schemaVersion: 1, runId: scan.scanId, scanMode: scan.scanMode, scanScope: scan.scanScope, contexts };
  const unresolved = [];
  const targetCompleted = goalFoundVerified(scanDir, scan);
  for (const contextId of runContextIds(scan)) {
    const graph = contexts[contextId]; const frontier = loadFrontier(scanDir, contextId); const queue = require('./lib/verification-store').loadVerificationQueue(scanDir, contextId); const suggestions = readJson(path.join(contextDir(scanDir, contextId), 'frontier-suggestions.json'), { items: [] });
    const mode = modeForScan(scan);
    const guidance = mode.loadGuidance({ scanDir, scan, contextId, graph, frontier });
    const scopeUnresolved = scan.scanMode === 'exploration';
    const rawPendingFrontiers = frontier.items.filter(item => ['PENDING', 'RETRYABLE', 'FAILED', 'BLOCKED'].includes(item.status));
    const rawPendingSuggestions = suggestions.items.filter(item => item.status === 'PENDING');
    const scopedPendingFrontiers = scopeUnresolved ? mode.filterFrontiers({ items: rawPendingFrontiers, scanDir, scan, contextId, graph, frontier, guidance }) : rawPendingFrontiers;
    const scopedPendingSuggestions = scopeUnresolved ? mode.filterSuggestions({ items: rawPendingSuggestions, scanDir, scan, contextId, graph, frontier, guidance }) : rawPendingSuggestions;
    const scopedVerificationItems = scopeUnresolved && typeof mode.filterVerifications === 'function' ? mode.filterVerifications({ items: queue.items, scanDir, scan, contextId, graph, frontier, guidance }) : queue.items;
    const inScopeStateIds = new Set(scopeUnresolved ? mode.filterBackfillStateIds({ stateIds: (graph.reachableStates || []).map(item => item.id), scanDir, scan, contextId, graph, frontier, guidance }) : (graph.reachableStates || []).map(item => item.id));
    unresolved.push(...graph.visualStates.filter(x => x.dedupe?.status === 'PROBABLE').map(x => ({ type: 'PROBABLE_VISUAL_DUPLICATE', contextId, visualStateId: x.id, duplicateGroupId: x.dedupe.duplicateGroupId })));
    unresolved.push(...graph.edges.filter(edge => ['UNVERIFIED', 'REPLAY_UNSTABLE'].includes(edge.verification?.replayStatus) && inScopeStateIds.has(edge.fromReachableStateId) && inScopeStateIds.has(edge.toReachableStateId)).map(edge => ({ type: edge.verification?.replayStatus === 'REPLAY_UNSTABLE' ? 'REPLAY_UNSTABLE' : 'UNVERIFIED_EDGE', contextId, edgeId: edge.id })));
    unresolved.push(...scopedPendingFrontiers.map(item => ({ type: 'FRONTIER_UNRESOLVED', contextId, frontierId: item.id, status: item.status, reasonCode: item.reasonCode || null })));
    if (!targetCompleted) unresolved.push(...scopedPendingSuggestions.map(item => ({ type: 'FRONTIER_SUGGESTION_PENDING', contextId, suggestionId: item.suggestionId, reachableStateId: item.reachableStateId, candidateGroupKey: item.candidateGroupKey, status: item.status, reasonCode: item.reasonCode || null })));
    const candidateCoverage = require('./lib/candidate-coverage').candidateCoverageFromRun(scanDir, contextId, graph);
    if (!targetCompleted) unresolved.push(...(candidateCoverage.states || []).filter(item => item.backfillRequired && inScopeStateIds.has(item.reachableStateId)).map(item => ({ type: 'CANDIDATE_BACKFILL_REQUIRED', contextId, reachableStateId: item.reachableStateId, candidateCoverageStatus: item.candidateCoverageStatus || 'UNKNOWN', knownCandidateCount: item.knownCandidateCount || 0, reasonCode: item.backfillReasonCode || null })));
    unresolved.push(...verificationUnresolvedItems({ ...queue, items: scopedVerificationItems }, contextId, targetCompleted));
  }
  writeJsonAtomic(path.join(scanDir, 'merged', 'map.json'), map); writeJsonAtomic(path.join(scanDir, 'merged', 'unresolved.json'), { schemaVersion: 2, items: unresolved });
  if (contexts.guest && contexts.authenticated) writeJsonAtomic(path.join(scanDir, 'merged', 'auth-diff.json'), authDiff(map));
  const report = spawnSync(process.execPath, [path.join(__dirname, 'render-report.js'), '--scan-dir', scanDir, '--status', status], { encoding: 'utf8' }); if (report.status !== 0) fail(report.stderr || 'Report rendering failed', 'REPORT_FAILED');
  const finalized = transitionWithOps(scanDir, status, reasonCode, null, { finalizationAssessment, ...(args.userStopNote ? { userStopNote: String(args.userStopNote) } : {}) });
  output({ schemaVersion: 1, ok: true, scan: finalized, metricsByContext, validation, finalizationAssessment });
});
