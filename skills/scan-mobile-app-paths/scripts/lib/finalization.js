'use strict';

const path = require('path');
const { contextDir, readJson } = require('./common');
const { runContextIds } = require('./run-protocol');

function projectFinalizationMetrics(scanDir, scan, finalizationStartedAt) {
  const metricsByContext = {};
  const projectionOps = [];
  if (scan.status !== 'SCANNING') return { metricsByContext, projectionOps };
  for (const contextId of runContextIds(scan)) {
    const metrics = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
    if (!metrics.activeStartedAt) continue;
    const next = {
      ...metrics,
      activeDurationMs: Number(metrics.activeDurationMs || 0) + Math.max(0, Date.parse(finalizationStartedAt) - Date.parse(metrics.activeStartedAt)),
      activeStartedAt: null
    };
    metricsByContext[contextId] = next;
    projectionOps.push({ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: next });
  }
  return { metricsByContext, projectionOps };
}

module.exports = { projectFinalizationMetrics };
