#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, readJson, writeJsonAtomic, versionKey, compareTimestamps, output, main, fail, TERMINAL_STATUSES, withFileLock, emptyGraph } = require('./lib/common');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');
const { syncCanonicalFromRun } = require('./lib/canonical-map-store');

function contextGraphs(scanDir, contextIds) {
  return contextIds.map(contextId => readJson(path.join(scanDir, 'contexts', contextId, 'graph.json'), emptyGraph(contextId)));
}

main(() => {
  const args = parseArgs(); const { scanDir, appRoot } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir);
  if (!TERMINAL_STATUSES.has(scan.status)) fail('Only terminal Runs can be registered', 'RUN_NOT_TERMINAL');
  validate(scanDir, scan.status);
  const indexFile = path.join(appRoot, 'run-index.json'); const target = readJson(path.join(scanDir, 'target.json')); const contextIds = runContextIds(scan); const graphs = contextGraphs(scanDir, contextIds);
  const item = { scanId: scan.scanId, parentScanId: scan.parentScanId, mapRevisionId: scan.mapRevisionId || scan.scanId, mapBaseRevisionId: scan.mapBaseRevisionId || null, relativePath: `runs/${scan.scanId}`, appVersion: target.appVersion || null, buildVersion: target.buildVersion || null, versionKey: versionKey(target), scanMode: scan.scanMode, scanScope: scan.scanScope, contexts: contextIds, status: scan.status, startedAt: scan.startedAt || scan.createdAt, finalizedAt: scan.finalizedAt, visualStateCount: graphs.reduce((n, g) => n + (g.visualStates || []).length, 0), reachableStateCount: graphs.reduce((n, g) => n + (g.reachableStates || []).length, 0), edgeCount: graphs.reduce((n, g) => n + (g.edges || []).length, 0) };
  const existing = withFileLock(path.join(appRoot, '.run-index.lock'), () => { const index = readJson(indexFile); const found = index.runs.findIndex(x => x.scanId === scan.scanId); if (found >= 0) index.runs[found] = item; else index.runs.push(item); index.runs.sort((a, b) => compareTimestamps(a.finalizedAt, b.finalizedAt)); writeJsonAtomic(indexFile, index); return found; });
  const canonicalSync = ['COMPLETED', 'PARTIAL'].includes(scan.status)
    ? contextIds.map(contextId => syncCanonicalFromRun(scanDir, contextId))
    : contextIds.map(contextId => ({ synced: false, contextId, reasonCode: 'RUN_STATUS_NOT_CANONICAL_SYNCABLE', status: scan.status }));
  output({ schemaVersion: 1, ok: true, registered: item, idempotent: existing >= 0, canonicalSync });
});
