#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, readJson, writeJsonAtomic, versionKey, compareTimestamps, output, main, fail, TERMINAL_STATUSES, withFileLock } = require('./lib/common');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');

main(() => {
  const args = parseArgs(); const { scanDir, appRoot } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir);
  if (!TERMINAL_STATUSES.has(scan.status)) fail('Only terminal Runs can be registered', 'RUN_NOT_TERMINAL');
  validate(scanDir, scan.status);
  const indexFile = path.join(appRoot, 'run-index.json'); const target = readJson(path.join(scanDir, 'target.json')); const map = readJson(path.join(scanDir, 'merged', 'map.json'), { contexts: {} });
  const all = Object.values(map.contexts || {}); const item = { scanId: scan.scanId, parentScanId: scan.parentScanId, mapRevisionId: scan.mapRevisionId || scan.scanId, relativePath: `runs/${scan.scanId}`, appVersion: target.appVersion || null, buildVersion: target.buildVersion || null, versionKey: versionKey(target), scanMode: scan.scanMode, scanScope: scan.scanScope, contexts: runContextIds(scan), status: scan.status, startedAt: scan.startedAt || scan.createdAt, finalizedAt: scan.finalizedAt, visualStateCount: all.reduce((n, g) => n + g.visualStates.length, 0), reachableStateCount: all.reduce((n, g) => n + g.reachableStates.length, 0), edgeCount: all.reduce((n, g) => n + g.edges.length, 0) };
  const existing = withFileLock(path.join(appRoot, '.run-index.lock'), () => { const index = readJson(indexFile); const found = index.runs.findIndex(x => x.scanId === scan.scanId); if (found >= 0) index.runs[found] = item; else index.runs.push(item); index.runs.sort((a, b) => compareTimestamps(a.finalizedAt, b.finalizedAt)); writeJsonAtomic(indexFile, index); return found; }); output({ schemaVersion: 1, ok: true, registered: item, idempotent: existing >= 0 });
});
