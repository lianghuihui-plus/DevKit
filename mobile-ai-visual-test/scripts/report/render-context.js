#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
} = require('../common');

function usage() {
  console.error('Usage: render-context.js <case-dir>');
  process.exit(2);
}

const caseDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!caseDir) usage();

const caseJson = readJson(path.join(caseDir, 'case.json'));
const state = readJson(path.join(caseDir, 'state.json'), {});
const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));

const reports = writeCaseReports(caseDir, caseJson, state, notes);
refreshIndexForCase(caseDir);
console.log(reports.context);
