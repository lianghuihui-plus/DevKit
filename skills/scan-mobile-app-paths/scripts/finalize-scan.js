#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, writeJsonAtomic, contextDir, transition, commitEvent, output, main, fail } = require('./lib/common');
const { validateGraph } = require('./lib/graph-store');
const { contextMetrics, authDiff } = require('./lib/metrics');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');
const { isCurrentRun } = require('./lib/run-protocol');
const { reconcileVerificationQueue } = require('./lib/verification-store');
const { projectFinalizationMetrics } = require('./lib/finalization');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  const status = String(args.status || 'COMPLETED').toUpperCase(); if (!['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(status)) fail('Invalid final status', 'STATUS_INVALID');
  if (isCurrentRun(scan)) for (const contextId of runContextIds(scan)) {
    const projection = reconcileVerificationQueue(scanDir, scan, contextId, loadGraph(scanDir, contextId), { persist: false });
    if (projection.scheduled.length || projection.superseded.length) commitEvent(scanDir, 'verificationQueueReconciled', { contextId, scheduled: projection.scheduled, superseded: projection.superseded }, [{ path: `contexts/${contextId}/verification-queue.json`, op: 'REPLACE', value: projection.queue }]);
  }
  const finalizationStartedAt = new Date().toISOString();
  const finalizationProjection = projectFinalizationMetrics(scanDir, scan, finalizationStartedAt);
  const validation = validate(scanDir, status, { metricsOverridesByContext: finalizationProjection.metricsByContext });
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
  for (const contextId of runContextIds(scan)) {
    const graph = contexts[contextId]; const frontier = loadFrontier(scanDir, contextId); const queue = require('./lib/verification-store').loadVerificationQueue(scanDir, contextId);
    unresolved.push(...graph.visualStates.filter(x => x.dedupe?.status === 'PROBABLE').map(x => ({ type: 'PROBABLE_VISUAL_DUPLICATE', contextId, visualStateId: x.id, duplicateGroupId: x.dedupe.duplicateGroupId })));
    unresolved.push(...graph.edges.filter(edge => ['UNVERIFIED', 'REPLAY_UNSTABLE'].includes(edge.verification?.replayStatus)).map(edge => ({ type: edge.verification?.replayStatus === 'REPLAY_UNSTABLE' ? 'REPLAY_UNSTABLE' : 'UNVERIFIED_EDGE', contextId, edgeId: edge.id })));
    unresolved.push(...frontier.items.filter(item => ['PENDING', 'RETRYABLE', 'FAILED', 'BLOCKED'].includes(item.status)).map(item => ({ type: 'FRONTIER_UNRESOLVED', contextId, frontierId: item.id, status: item.status, reasonCode: item.reasonCode || null })));
    unresolved.push(...queue.items.filter(item => ['PENDING', 'FAILED'].includes(item.status)).map(item => ({ type: 'VERIFICATION_UNRESOLVED', contextId, verificationId: item.verificationId, status: item.status, reasonCode: item.reasonCode || null })));
  }
  writeJsonAtomic(path.join(scanDir, 'merged', 'map.json'), map); writeJsonAtomic(path.join(scanDir, 'merged', 'unresolved.json'), { schemaVersion: 2, items: unresolved });
  if (contexts.guest && contexts.authenticated) writeJsonAtomic(path.join(scanDir, 'merged', 'auth-diff.json'), authDiff(map));
  const report = spawnSync(process.execPath, [path.join(__dirname, 'render-report.js'), '--scan-dir', scanDir, '--status', status], { encoding: 'utf8' }); if (report.status !== 0) fail(report.stderr || 'Report rendering failed', 'REPORT_FAILED');
  const finalized = transition(scanDir, status, args.reasonCode || null); output({ schemaVersion: 1, ok: true, scan: finalized, metricsByContext, validation });
});
