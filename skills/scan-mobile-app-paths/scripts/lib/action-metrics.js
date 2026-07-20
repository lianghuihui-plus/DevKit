'use strict';

const path = require('path');
const { contextDir, readJson, commitEvent, fail } = require('./common');

const CATEGORY_KEYS = Object.freeze({ exploration: 'explorationActions', navigation: 'navigationActions', recovery: 'recoveryActions', verification: 'verificationActions', interruption: 'interruptionActions' });

function recordDeviceAction(scanDir, contextId, category) {
  const key = CATEGORY_KEYS[category]; if (!key) fail(`Unknown action category ${category}`, 'ACTION_CATEGORY_INVALID');
  const file = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(file, {});
  metrics.actions = Number(metrics.actions || 0) + 1; metrics[key] = Number(metrics[key] || 0) + 1; metrics.deviceMutationSeq = Number(metrics.deviceMutationSeq || 0) + 1;
  commitEvent(scanDir, 'deviceActionMetricRecorded', { contextId, category, actions: metrics.actions, deviceMutationSeq: metrics.deviceMutationSeq }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]); return metrics;
}

function recordColdStart(scanDir, contextId) {
  const file = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(file, {}); metrics.coldStarts = Number(metrics.coldStarts || 0) + 1; metrics.deviceMutationSeq = Number(metrics.deviceMutationSeq || 0) + 1; commitEvent(scanDir, 'coldStartMetricRecorded', { contextId, coldStarts: metrics.coldStarts, deviceMutationSeq: metrics.deviceMutationSeq }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]); return metrics;
}

function recordNavigationMode(scanDir, contextId, mode) {
  const keys = { LIVE_CURSOR: 'cursorReuseHits', SOURCE_MATCH: 'sourceMatchNavigations', BACKTRACK: 'backtrackNavigations', GRAPH_PATH: 'graphPathNavigations', COLD_REPLAY: 'coldReplayNavigations' }; const key = keys[mode]; if (!key) fail(`Unknown navigation mode ${mode}`, 'NAVIGATION_MODE_INVALID');
  const file = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(file, {}); metrics[key] = Number(metrics[key] || 0) + 1; commitEvent(scanDir, 'navigationModeMetricRecorded', { contextId, mode, count: metrics[key] }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]); return metrics;
}

module.exports = { CATEGORY_KEYS, recordDeviceAction, recordColdStart, recordNavigationMode };
