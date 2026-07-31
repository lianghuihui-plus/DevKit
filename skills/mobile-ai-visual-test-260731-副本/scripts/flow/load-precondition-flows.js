#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadPreconditionFlows } = require('../lib/precondition-flow');

function usage() {
  console.error('Usage: load-precondition-flows.js --platform <harmony|android|ios> [--cwd <workspace-cwd>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let cwd = process.cwd();
let platform = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else if (args[i] === '--platform') platform = args[++i];
  else usage();
}
if (!platform) usage();

try {
  const loaded = loadPreconditionFlows(cwd, platform);
  console.log(JSON.stringify({
    schemaVersion: 1,
    type: 'preconditionFlowIndex',
    workspaceRoot: loaded.workspaceRoot,
    flowsRoot: loaded.flowsRoot,
    platform: loaded.platform,
    flows: loaded.flows.map(({ flow, ...item }) => ({ ...item, flow })),
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
