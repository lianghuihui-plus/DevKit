#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir, output, main } = require('./lib/common');
const { contextMetrics } = require('./lib/metrics');
const { runContextIds } = require('./lib/run-protocol');
const { loadVerificationQueue } = require('./lib/verification-store');

function countBy(items, keyFn) {
  return items.reduce((sum, item) => {
    const key = keyFn(item) || 'UNKNOWN';
    sum[key] = (sum[key] || 0) + 1;
    return sum;
  }, {});
}

function existing(file) {
  return fs.existsSync(file) ? file : null;
}

function durationMs(startedAt, finalizedAt, fallback = null) {
  const start = Date.parse(startedAt || '');
  const end = Date.parse(finalizedAt || '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : fallback;
}

function orientationSummary(scanDir) {
  const dir = path.join(scanDir, 'evidence', 'preparations');
  if (!fs.existsSync(dir)) return { checked: false, records: [], latest: null };
  const records = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const preparation = readJson(path.join(dir, name), null);
    const orientation = preparation?.restartResult?.orientation || null;
    return orientation ? {
      preparationId: preparation.preparationId || path.basename(name, '.json'),
      contextId: preparation.contextId || null,
      policy: orientation.policy || null,
      deviceType: orientation.deviceType || null,
      currentOrientation: orientation.currentOrientation || null,
      applied: orientation.applied === true,
      skippedReason: orientation.skippedReason || null,
      command: orientation.command || null
    } : null;
  }).filter(Boolean);
  return { checked: records.length > 0, records, latest: records.at(-1) || null };
}

function contextSummary(scanDir, contextId) {
  const graph = loadGraph(scanDir, contextId);
  const frontier = loadFrontier(scanDir, contextId);
  const runtime = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
  const metrics = contextMetrics(graph, frontier, runtime);
  const queue = loadVerificationQueue(scanDir, contextId).items || [];
  return {
    contextId,
    counts: {
      logicalScreens: metrics.logicalScreenCount,
      visualStates: metrics.visualStateCount,
      reachableStates: metrics.reachableStateCount,
      edges: metrics.edgeCount,
      paths: metrics.pathCount,
      maxPathDepth: metrics.maxPathDepth
    },
    execution: {
      activeDurationMs: metrics.activeDurationMs,
      actions: metrics.actions,
      explorationActions: metrics.explorationActions,
      navigationActions: metrics.navigationActions,
      recoveryActions: metrics.recoveryActions,
      verificationActions: metrics.verificationActions,
      interruptionActions: metrics.interruptionActions,
      coldStarts: metrics.coldStarts,
      observations: metrics.observations,
      observationSamples: metrics.observationSamples,
      observationStabilityWaitMs: metrics.observationStabilityWaitMs,
      restoreAttempts: metrics.restoreAttempts,
      noStateChangeActions: metrics.noStateChangeActions
    },
    frontier: {
      counts: metrics.frontierCounts,
      safeCandidateCoverage: metrics.safeCandidateCoverage
    },
    verification: {
      total: queue.length,
      counts: countBy(queue, item => item.status),
      failed: queue.filter(item => item.status === 'FAILED').map(item => ({
        verificationId: item.verificationId,
        reasonCode: item.reasonCode || item.failure?.reasonCode || null,
        blockingEdgeIds: item.failure?.blockingEdgeIds || []
      }))
    }
  };
}

main(() => {
  const args = parseArgs();
  const { scanDir, appRoot } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir);
  const target = readJson(path.join(scanDir, 'target.json'));
  const contexts = runContextIds(scan).map(contextId => contextSummary(scanDir, contextId));
  const unresolved = readJson(path.join(scanDir, 'merged', 'unresolved.json'), { items: [] });
  const reportPath = existing(path.join(scanDir, 'report.md'));
  const snapshotPointer = existing(path.join(appRoot, 'snapshots', 'current.json'));
  const dashboardPath = existing(path.join(appRoot, 'dashboard', 'index.html'));
  const totals = contexts.reduce((sum, context) => {
    for (const key of ['logicalScreens', 'visualStates', 'reachableStates', 'edges', 'paths']) sum.counts[key] += context.counts[key];
    for (const key of ['activeDurationMs', 'actions', 'explorationActions', 'navigationActions', 'recoveryActions', 'verificationActions', 'interruptionActions', 'coldStarts', 'observations', 'observationSamples', 'observationStabilityWaitMs', 'restoreAttempts', 'noStateChangeActions']) sum.execution[key] += context.execution[key];
    sum.verification.total += context.verification.total;
    for (const [status, count] of Object.entries(context.verification.counts)) sum.verification.counts[status] = (sum.verification.counts[status] || 0) + count;
    return sum;
  }, { counts: { logicalScreens: 0, visualStates: 0, reachableStates: 0, edges: 0, paths: 0 }, execution: { activeDurationMs: 0, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, interruptionActions: 0, coldStarts: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, restoreAttempts: 0, noStateChangeActions: 0 }, verification: { total: 0, counts: {} } });

  output({
    schemaVersion: 1,
    ok: true,
    structuredResult: {
      scan: {
        scanId: scan.scanId,
        parentScanId: scan.parentScanId || null,
        status: scan.status,
        reasonCode: scan.reasonCode || null,
        scanMode: scan.scanMode,
        scanScope: scan.scanScope,
        profile: scan.profile,
        contextId: scan.contextId,
        navigationPolicy: scan.navigationPolicy || null,
        verificationRule: scan.verificationRule || null
      },
      target: {
        bundleName: target.bundleName,
        entryAbility: target.entryAbility,
        environment: target.environment,
        deviceId: target.deviceId,
        deviceType: target.deviceType || null,
        appVersion: target.appVersion || null,
        buildVersion: target.buildVersion || null
      },
      timing: {
        startedAt: scan.startedAt || scan.createdAt || null,
        finalizedAt: scan.finalizedAt || null,
        activeDurationMs: totals.execution.activeDurationMs,
        wallDurationMs: durationMs(scan.startedAt || scan.createdAt, scan.finalizedAt)
      },
      totals,
      contexts,
      unresolved: {
        total: (unresolved.items || []).length,
        counts: countBy(unresolved.items || [], item => item.type)
      },
      coldStartOrientation: orientationSummary(scanDir),
      artifacts: {
        scanDir,
        reportPath,
        snapshotPointer,
        dashboardPath
      }
    },
    agentSupplementContract: {
      title: 'Agent 补充内容',
      purpose: '基于结构化结果补充人类可读解释、异常原因、重要取舍和下一步建议；不得改写 structuredResult 中的事实。',
      suggestedItems: ['本次为什么停止', '哪些结果值得关注', '是否需要继续扫描或验证', 'Dashboard/报告如何查看', '失败或异常的处置建议']
    }
  });
});
