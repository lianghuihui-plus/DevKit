#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  appendJsonl,
  casesRoot,
  ensureDir,
  formatLocalIso,
  nextCaseNo,
  normalizeCaseNo,
  nowIso,
  parseMarkdownCase,
  readJson,
  readJsonl,
  refreshIndexForCase,
  reapplyNotes,
  desiredCaseDir,
  syncCaseDirectory,
  writeCaseReports,
  writeJson,
  writeText,
} = require('../common');

function usage() {
  console.error('用法: parse-case.js <case.md> [--cwd <workspace-cwd>] [--refresh-from-input]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

let caseFile = null;
let cwd = process.cwd();
let refreshFromInput = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else if (args[i] === '--refresh-from-input') refreshFromInput = true;
  else if (!caseFile) caseFile = args[i];
}
if (!caseFile) usage();

const parsed = parseMarkdownCase(caseFile, cwd);
const root = casesRoot(cwd);
const caseKey = parsed.caseJson.identity.caseKey;
const existingCaseDir = findExistingCaseDir(root, caseKey);
let caseDir = existingCaseDir || parsed.caseDir;
ensureDir(caseDir);
ensureDir(path.join(caseDir, 'executions'));

const casePath = path.join(caseDir, 'case.json');
const sourceSnapshotPath = path.join(caseDir, 'source.md');
const notesPath = path.join(caseDir, 'notes.jsonl');
const previous = readJson(casePath, null);
const notes = readJsonl(notesPath);
let selected = parsed;
let sourceEventType = 'source_changed';
if (previous && fs.existsSync(sourceSnapshotPath) && !refreshFromInput) {
  const snapshotText = fs.readFileSync(sourceSnapshotPath, 'utf8');
  const snapshotStat = fs.statSync(sourceSnapshotPath);
  const snapshotParsed = parseMarkdownCase(caseFile, cwd, {
    markdown: snapshotText,
    sourceUpdatedAt: formatLocalIso(snapshotStat.mtime),
    sourceMode: 'snapshot',
  });
  selected = snapshotParsed;
  sourceEventType = 'source_snapshot_changed';
} else if (previous && refreshFromInput) {
  sourceEventType = 'source_refreshed_from_input';
}
let caseJson = selected.caseJson;
caseJson.identity.caseNo = normalizeCaseNo(previous?.identity?.caseNo) || nextCaseNo(root);
if (previous?.globalRules) {
  caseJson.globalRules = previous.globalRules;
}
let sourceChanged = false;

if (previous && previous.identity.sourceSha1 !== caseJson.identity.sourceSha1) {
  sourceChanged = true;
  caseJson.sourceChanged = true;
  appendJsonl(notesPath, {
    time: nowIso(),
    source: 'system',
    type: sourceEventType,
    from: previous.identity.sourceSha1,
    to: caseJson.identity.sourceSha1,
    mode: caseJson.identity.sourceMode,
  });
}

caseJson = reapplyNotes(caseJson, notes, { strictStepText: sourceChanged });
if (!existingCaseDir) {
  const targetDir = desiredCaseDir(root, caseJson);
  if (targetDir !== caseDir) {
    fs.renameSync(caseDir, targetDir);
    caseDir = targetDir;
  }
} else {
  caseDir = syncCaseDirectory(root, caseDir, caseJson);
}
ensureDir(path.join(caseDir, 'executions'));
const finalCasePath = path.join(caseDir, 'case.json');
const finalSourceSnapshotPath = path.join(caseDir, 'source.md');
const finalNotesPath = path.join(caseDir, 'notes.jsonl');
writeText(finalSourceSnapshotPath, selected.sourceMarkdown);
writeJson(finalCasePath, caseJson);

const statePath = path.join(caseDir, 'state.json');
const state = readJson(statePath, {
  schemaVersion: 1,
  latestStatus: 'NOT_RUN',
  executionCount: 0,
  environment: {},
  statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
});
writeJson(statePath, state);
const currentNotes = readJsonl(notesPath);
const finalNotes = finalNotesPath === notesPath ? currentNotes : readJsonl(finalNotesPath);
const reports = writeCaseReports(caseDir, caseJson, state, finalNotes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({ caseDir, caseJson: finalCasePath, ...reports, indexHtml }, null, 2));

function findExistingCaseDir(root, caseKey) {
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((entry) => fs.statSync(entry).isDirectory() && path.basename(entry).endsWith(`__${caseKey}`))
    .sort();
  return candidates[0] || null;
}
