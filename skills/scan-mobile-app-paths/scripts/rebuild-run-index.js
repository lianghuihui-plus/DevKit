#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, readJson, writeJsonAtomic, versionKey, safeSegment, now, compareTimestamps, output, main, withFileLock } = require('./lib/common');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');

main(() => {
  const args = parseArgs(); const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root'); readJson(path.join(root, 'app.json'));
  const runs = []; const skipped = []; const runsDir = path.join(root, 'runs');
  for (const name of fs.readdirSync(runsDir, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort()) {
    try {
      safeSegment(name, 'scanId'); const scanDir = path.join(runsDir, name); const scan = readJson(path.join(scanDir, 'scan.json'));
      if (!['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(scan.status)) { skipped.push({ scanId: name, reasonCode: 'RUN_NOT_TERMINAL' }); continue; }
      validate(scanDir, scan.status); const target = readJson(path.join(scanDir, 'target.json')); const map = readJson(path.join(scanDir, 'merged', 'map.json'), { contexts: {} }); const graphs = Object.values(map.contexts || {});
      runs.push({ scanId: scan.scanId, parentScanId: scan.parentScanId || null, mapRevisionId: scan.mapRevisionId || scan.scanId, relativePath: `runs/${scan.scanId}`, appVersion: target.appVersion || null, buildVersion: target.buildVersion || null, versionKey: versionKey(target), scanMode: scan.scanMode, scanScope: scan.scanScope, contexts: runContextIds(scan), status: scan.status, startedAt: scan.startedAt || scan.createdAt, finalizedAt: scan.finalizedAt, visualStateCount: graphs.reduce((n, g) => n + g.visualStates.length, 0), reachableStateCount: graphs.reduce((n, g) => n + g.reachableStates.length, 0), edgeCount: graphs.reduce((n, g) => n + g.edges.length, 0) });
    } catch (error) { skipped.push({ scanId: name, reasonCode: error.code || 'RUN_INVALID', message: error.message }); }
  }
  runs.sort((a, b) => compareTimestamps(a.finalizedAt, b.finalizedAt)); const app = readJson(path.join(root, 'app.json')); const index = { schemaVersion: 1, appKey: app.appKey, runs, rebuiltAt: now(), skipped };
  withFileLock(path.join(root, '.run-index.lock'), () => writeJsonAtomic(path.join(root, 'run-index.json'), index)); output({ schemaVersion: 1, ok: true, indexed: runs.length, skipped, indexPath: path.join(root, 'run-index.json') });
});
