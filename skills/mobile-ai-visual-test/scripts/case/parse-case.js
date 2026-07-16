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
  validateCaseExecutionContract,
  writeCaseReports,
  writePlatformCaseReports,
  writeJson,
  writeText,
} = require('../common');
const { parseCliArgsOrExit } = require('../lib/cli-args');

function usage() {
  console.error('用法: parse-case.js <case.md> [--cwd <workspace-cwd>] [--refresh-from-input]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const parsedArgs = parseCliArgsOrExit(args, {
  context: 'parse-case.js',
  valueOptions: ['--cwd'],
  booleanOptions: ['--refresh-from-input'],
  maxPositionals: 1,
});
const caseFile = parsedArgs.positionals[0] || null;
const cwd = parsedArgs.values['--cwd'] ? path.resolve(parsedArgs.values['--cwd']) : process.cwd();
const refreshFromInput = parsedArgs.values['--refresh-from-input'] === true;
if (!caseFile) usage();

const parsed = parseMarkdownCase(caseFile, cwd);
const root = casesRoot(cwd);
const caseKey = parsed.caseJson.identity.caseKey;
const existingCaseDir = findExistingCaseDir(root, caseKey);
let caseDir = existingCaseDir || parsed.caseDir;
ensureDir(caseDir);

const casePath = path.join(caseDir, 'case.json');
const sourceSnapshotPath = path.join(caseDir, 'source.md');
const notesPath = path.join(caseDir, 'notes.jsonl');
const previous = readJson(casePath, null);
const notes = readJsonl(notesPath);
let selected = parsed;
let sourceEventType = 'source_changed';
let sourceChangeDetected = false;
if (previous && fs.existsSync(sourceSnapshotPath) && !refreshFromInput) {
  const snapshotText = fs.readFileSync(sourceSnapshotPath, 'utf8');
  const snapshotStat = fs.statSync(sourceSnapshotPath);
  const snapshotParsed = parseMarkdownCase(caseFile, cwd, {
    markdown: snapshotText,
    sourceUpdatedAt: formatLocalIso(snapshotStat.mtime),
    sourceMode: 'snapshot',
  });
  selected = snapshotParsed;
  sourceChangeDetected = parsed.caseJson.identity.sourceSha1 !== snapshotParsed.caseJson.identity.sourceSha1;
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
validateCaseExecutionContract(caseJson);
if (!existingCaseDir) {
  const targetDir = desiredCaseDir(root, caseJson);
  if (targetDir !== caseDir) {
    fs.renameSync(caseDir, targetDir);
    caseDir = targetDir;
  }
} else {
  caseDir = syncCaseDirectory(root, caseDir, caseJson);
}
const finalCasePath = path.join(caseDir, 'case.json');
const finalSourceSnapshotPath = path.join(caseDir, 'source.md');
const finalNotesPath = path.join(caseDir, 'notes.jsonl');
writeText(finalSourceSnapshotPath, selected.sourceMarkdown);
writeJson(finalCasePath, caseJson);

const state = {
  schemaVersion: 1,
  latestStatus: 'NOT_RUN',
  executionCount: 0,
  environment: {},
  statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
};
const currentNotes = readJsonl(notesPath);
const finalNotes = finalNotesPath === notesPath ? currentNotes : readJsonl(finalNotesPath);
const reports = writeCaseReports(caseDir, caseJson, state, finalNotes);
writePlatformCaseReports(caseDir, caseJson, finalNotes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({
  caseDir,
  caseJson: finalCasePath,
  sourceChangeDetected,
  requiresExplicitRefresh: sourceChangeDetected && !refreshFromInput,
  ...reports,
  indexHtml,
}, null, 2));

function findExistingCaseDir(root, caseKey) {
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((entry) => fs.statSync(entry).isDirectory() && path.basename(entry).endsWith(`__${caseKey}`))
    .sort();
  return candidates[0] || null;
}
