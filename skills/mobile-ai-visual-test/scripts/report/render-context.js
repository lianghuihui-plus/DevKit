#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  normalizePlatform,
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
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

const caseJson = readJson(path.join(caseDir, 'case.json'));
const statePath = platform ? path.join(caseDir, 'platforms', platform, 'state.json') : path.join(caseDir, 'state.json');
const state = readJson(statePath, {});
const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));

const reports = writeCaseReports(caseDir, caseJson, state, notes, null, { platform });
refreshIndexForCase(caseDir);
console.log(reports.context);
