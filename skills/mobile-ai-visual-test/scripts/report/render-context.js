#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  normalizePlatform,
  rebuildCaseDerivedArtifacts,
} = require('./report-service');

function usage() {
  const error = new Error('REPORT_CONTEXT_CLI_INVALID: case directory and optional platform must match the command contract');
  error.code = 'REPORT_CONTEXT_CLI_INVALID';
  error.exitCode = 2;
  throw error;
}

function main(args = process.argv.slice(2)) {
  const caseDir = args[0] ? path.resolve(args[0]) : null;
  if (!caseDir) usage();
  let platform = '';
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': platform = normalizePlatform(args[++i]); if (!platform) usage(); break;
      default: usage();
    }
  }

  const rebuilt = rebuildCaseDerivedArtifacts(caseDir, platform ? { scope: 'platform', platform } : { scope: 'all' });
  const platformSegment = `${path.sep}platforms${path.sep}${platform}${path.sep}`;
  const reports = platform
    ? rebuilt.platformReports.find((report) => report.context.includes(platformSegment))
    : rebuilt.rootReport;
  if (!reports) throw new Error(`No derived report exists for platform ${platform}`);
  console.log(reports.context);
  return reports.context;
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { main };
