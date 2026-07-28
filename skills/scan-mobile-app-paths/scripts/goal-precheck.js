#!/usr/bin/env node
'use strict';

const { parseArgs, required, resolveScanDir, loadScan, loadGraph, output, main, fail } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { applyKnownTargetPrecheck } = require('./lib/goal-known-target-precheck');

main(() => {
  const args = parseArgs();
  const command = args._[0] || 'evaluate';
  if (command !== 'evaluate') fail(`Unknown goal-precheck command: ${command}`, 'COMMAND_INVALID');
  const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: true });
  const contextId = runContextId(scan);
  if (args.context && args.context !== contextId) fail('goal-precheck --context must match Run contextId', 'CONTEXT_INVALID');
  const graph = loadGraph(scanDir, contextId);
  const result = applyKnownTargetPrecheck({ scanDir, scan, graph });
  output({ schemaVersion: 1, ok: true, ...result, runStatus: loadScan(scanDir).status });
});
