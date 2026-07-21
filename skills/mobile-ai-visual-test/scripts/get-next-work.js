#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadCaseExecutionContext } = require('./lib/case-execution-context');

function usage() {
  console.error('Usage: get-next-work.js <case-dir> --platform <harmony|android|ios> [--execution-id <id>]');
  process.exit(2);
}

function parseArgs(args) {
  if (!args.length) usage();
  const options = { caseDir: path.resolve(args[0]) };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--execution-id') options.executionId = args[++i];
    else usage();
  }
  if (!['harmony', 'android', 'ios'].includes(options.platform)) usage();
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const context = loadCaseExecutionContext(options);
  console.log(JSON.stringify({
    schemaVersion: 1,
    executionId: context.executionId,
    platform: options.platform,
    lifecycle: context.execution.lifecycle,
    case: context.caseJson.identity,
    workToken: context.workToken,
    nextWork: context.nextWork,
  }, null, 2));
}

try { main(); } catch (error) { console.error(error.message || String(error)); process.exit(1); }
