#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  normalizePlatform,
  rebuildCaseDerivedArtifacts,
} = require('../common');

function usage() {
  console.error('Usage: render-context.js <case-dir> [--platform <platform>]');
  process.exit(2);
}

const args = process.argv.slice(2);
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
