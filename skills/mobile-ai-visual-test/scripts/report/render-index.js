#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  renderIndexForRoot,
} = require('./report-service');
const { assertWorkspace } = require('../lib/workspace');

function usage() {
  const error = new Error('REPORT_INDEX_CLI_INVALID: expected at most one workspace path');
  error.code = 'REPORT_INDEX_CLI_INVALID';
  error.exitCode = 2;
  throw error;
}

function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some((argument) => argument.startsWith('--'))) usage();
  const input = args[0] ? path.resolve(args[0]) : process.cwd();
  const rootDir = assertWorkspace(input).root;
  const casesRoot = path.join(rootDir, 'cases');

  if (!fs.existsSync(casesRoot)) usage();

  const report = renderIndexForRoot(rootDir);
  console.log(report);
  return report;
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { main };
