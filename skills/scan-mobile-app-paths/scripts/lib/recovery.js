'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, contextDir, timelineEvents, hashObject, appendJsonl, now } = require('./common');
const { updateCanonicalPaths } = require('./graph-store');

function upsert(items, value) {
  if (!value?.id && !value?.attemptId) return;
  const id = value.id || value.attemptId; const index = items.findIndex(item => (item.id || item.attemptId) === id);
  if (index >= 0) items[index] = value; else items.push(value);
}

function recoverCommittedEvents(scanDir) {
  const protocolScan = readJson(path.join(scanDir, 'scan.json'));
  if (Number(protocolScan.eventProtocolVersion || 1) >= 2) {
    const projected = require('./event-store').recover(scanDir);
    let recovered = projected.recovered || 0;
    const { runContextIds } = require('./run-protocol'); const { recoverVerificationExecutions } = require('./verification-store');
    for (const contextId of runContextIds(protocolScan)) recovered += recoverVerificationExecutions(scanDir, contextId, { persist: true }).recovered;
    recovered += require('./operation-journal').recoverDeviceOperations(scanDir);
    return recovered;
  }
  let recovered = 0;
  for (const record of timelineEvents(scanDir).filter(item => item.type === 'attemptCommitted' && item.commitProjection)) {
    const projection = record.commitProjection; const contextId = record.contextId; const graphFile = path.join(contextDir(scanDir, contextId), 'graph.json'); const frontierFile = path.join(contextDir(scanDir, contextId), 'frontier.json');
    const graph = readJson(graphFile); const frontier = readJson(frontierFile); const before = hashObject({ graph, frontier });
    upsert(graph.logicalScreens, projection.logicalScreen); upsert(graph.visualStates, projection.visualState); upsert(graph.reachableStates, projection.reachableState); upsert(graph.edges, projection.edge); upsert(frontier.items, projection.frontierItem);
    for (const logical of graph.logicalScreens) logical.visualStateIds = graph.visualStates.filter(item => item.logicalScreenKey === logical.id).map(item => item.id);
    for (const state of graph.reachableStates) state.incomingEdgeIds = graph.edges.filter(item => item.toReachableStateId === state.id).map(item => item.id);
    updateCanonicalPaths(graph);
    if (hashObject({ graph, frontier }) !== before) { writeJsonAtomic(graphFile, graph); writeJsonAtomic(frontierFile, frontier); recovered += 1; }
    const attempt = projection.attempt; if (attempt?.attemptId) { const file = path.join(scanDir, 'attempts', `${attempt.attemptId}.json`); if (!fs.existsSync(file) || hashObject(readJson(file)) !== hashObject(attempt)) { writeJsonAtomic(file, attempt); recovered += 1; } }
  }
  const scan = readJson(path.join(scanDir, 'scan.json'));
  if (Number(scan.graphProtocolVersion || 1) >= 3) {
    const { runContextIds } = require('./run-protocol'); const { reconcileVerificationQueue } = require('./verification-store'); let sequence = timelineEvents(scanDir).reduce((max, item) => Math.max(max, Number(String(item.eventId || '').replace(/^evt-/, '')) || 0), 0);
    for (const contextId of runContextIds(scan)) {
      const cursorEvents = timelineEvents(scanDir).filter(record => record.contextId === contextId).map(record => record.cursor || record.commitProjection?.cursor).filter(Boolean); const latestCursor = cursorEvents.at(-1); if (latestCursor) { const file = path.join(contextDir(scanDir, contextId), 'live-cursor.json'); if (!fs.existsSync(file) || hashObject(readJson(file)) !== hashObject(latestCursor)) { writeJsonAtomic(file, latestCursor); recovered += 1; } }
      const graph = readJson(path.join(contextDir(scanDir, contextId), 'graph.json')); const projection = reconcileVerificationQueue(scanDir, scan, contextId, graph, { persist: true });
      for (const task of projection.scheduled) { sequence += 1; appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: `evt-${String(sequence).padStart(6, '0')}`, type: 'verificationScheduled', at: now(), scanId: scan.scanId, contextId, verification: task, recovered: true }); recovered += 1; }
    }
    if (sequence > Number(scan.counters?.event || 0)) { scan.counters = { ...(scan.counters || {}), event: sequence }; scan.updatedAt = now(); writeJsonAtomic(path.join(scanDir, 'scan.json'), scan); }
  }
  return recovered;
}

module.exports = { recoverCommittedEvents };
