#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  appendJsonl,
  formatLocalIso,
  normalizeCaseNo,
  nowIso,
  parseMarkdownCase,
  readJson,
  readJsonl,
  refreshIndexForCase,
  reapplyNotes,
  writeCaseReports,
  writePlatformCaseReports,
  writeJson,
} = require('../common');
const { parseCliArgsOrExit } = require('../lib/cli-args');

function usage() {
  console.error('用法: refresh-case.js <case-dir>');
  process.exit(2);
}

const parsedArgs = parseCliArgsOrExit(process.argv.slice(2), {
  context: 'refresh-case.js',
  maxPositionals: 1,
});
const caseDir = parsedArgs.positionals[0] ? path.resolve(parsedArgs.positionals[0]) : null;
if (!caseDir) usage();

const casePath = path.join(caseDir, 'case.json');
const sourcePath = path.join(caseDir, 'source.md');
const notesPath = path.join(caseDir, 'notes.jsonl');
const statePath = path.join(caseDir, 'state.json');

if (!fs.existsSync(casePath)) {
  throw new Error(`缺少 case.json: ${casePath}`);
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`缺少 source.md: ${sourcePath}`);
}

const previous = readJson(casePath);
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const sourceStat = fs.statSync(sourcePath);
const workspaceDir = path.dirname(path.dirname(caseDir));
const parsed = parseMarkdownCase(previous.identity.importSource || previous.identity.sourceFile || sourcePath, workspaceDir, {
  markdown: sourceText,
  sourceUpdatedAt: formatLocalIso(sourceStat.mtime),
  sourceMode: 'snapshot',
  caseKey: previous.identity.caseKey,
  importSource: previous.identity.importSource || previous.identity.sourceFile,
});

let caseJson = parsed.caseJson;
caseJson.identity.caseNo = normalizeCaseNo(previous.identity?.caseNo);
if (previous?.globalRules) {
  caseJson.globalRules = previous.globalRules;
}
const sourceChanged = previous.identity.sourceSha1 !== caseJson.identity.sourceSha1;
if (sourceChanged) {
  caseJson.sourceChanged = true;
  appendJsonl(notesPath, {
    time: nowIso(),
    source: 'system',
    type: 'source_snapshot_changed',
    from: previous.identity.sourceSha1,
    to: caseJson.identity.sourceSha1,
    mode: 'snapshot',
  });
}

const notes = readJsonl(notesPath);
caseJson = reapplyNotes(caseJson, notes, { strictStepText: sourceChanged });
writeJson(casePath, caseJson);

const state = readJson(statePath, {
  schemaVersion: 1,
  latestStatus: 'NOT_RUN',
  executionCount: 0,
  environment: {},
  statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
});
writeJson(statePath, state);
const currentNotes = readJsonl(notesPath);
const reports = writeCaseReports(caseDir, caseJson, state, currentNotes);
writePlatformCaseReports(caseDir, caseJson, currentNotes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({ caseDir, caseJson: casePath, ...reports, indexHtml, sourceChanged }, null, 2));
