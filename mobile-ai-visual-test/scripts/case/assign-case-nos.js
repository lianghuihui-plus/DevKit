#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  casesRoot,
  nextCaseNo,
  normalizeCaseNo,
  readCaseEntries,
  readJson,
  readJsonl,
  refreshIndexForCase,
  renderIndexForRoot,
  syncCaseDirectory,
  writeCaseReports,
  writeJson,
} = require('../common');

function usage() {
  console.error('Usage: assign-case-nos.js [--cwd <workspace-cwd>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let cwd = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else usage();
}

const root = casesRoot(cwd);
const updated = [];
for (const entry of readCaseEntries(root).sort(compareEntries)) {
  let { caseDir, caseJson } = entry;
  const beforeDir = caseDir;
  const beforeNo = normalizeCaseNo(caseJson.identity?.caseNo);
  if (!caseJson.identity) caseJson.identity = {};
  if (!beforeNo) caseJson.identity.caseNo = nextCaseNo(root);
  else caseJson.identity.caseNo = beforeNo;
  caseDir = syncCaseDirectory(root, caseDir, caseJson);
  writeJson(path.join(caseDir, 'case.json'), caseJson);
  const state = readJson(path.join(caseDir, 'state.json'), {
    schemaVersion: 1,
    latestStatus: 'NOT_RUN',
    executionCount: 0,
    environment: {},
    statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
  });
  const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));
  writeCaseReports(caseDir, caseJson, state, notes);
  refreshIndexForCase(caseDir);
  if (!beforeNo || beforeDir !== caseDir) {
    updated.push({
      caseNo: caseJson.identity.caseNo,
      title: caseJson.identity.title,
      caseKey: caseJson.identity.caseKey,
      from: beforeDir,
      caseDir,
    });
  }
}
const indexHtml = renderIndexForRoot(path.dirname(root));
console.log(JSON.stringify({ updated, indexHtml }, null, 2));

function compareEntries(a, b) {
  return (a.caseJson.identity?.sourceUpdatedAt || '').localeCompare(b.caseJson.identity?.sourceUpdatedAt || '') ||
    (a.caseJson.identity?.title || '').localeCompare(b.caseJson.identity?.title || '', 'zh-CN') ||
    a.caseDir.localeCompare(b.caseDir);
}
