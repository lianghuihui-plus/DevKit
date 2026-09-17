#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseCoordinatorCliArgs } = require('../lib/coordinator-interface-contract');
const {
  normalizePlatform,
  rebuildCaseDerivedArtifacts,
} = require('./report-service');

function main(args = process.argv.slice(2)) {
  const options = parseCoordinatorCliArgs(args, 'scripts/render-context.js');
  const caseDir = path.resolve(options.caseDir);
  const platform = options.platform ? normalizePlatform(options.platform) : '';

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
