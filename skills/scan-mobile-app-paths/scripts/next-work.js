#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir, output, main } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { nextWork } = require('./lib/work-scheduler');

main(() => { const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir); const contextId = args.context || runContextId(scan); const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const metrics = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {}); output({ schemaVersion: 1, ok: true, ...nextWork({ scanDir, scan, contextId, graph, frontier, metrics }) }); });
