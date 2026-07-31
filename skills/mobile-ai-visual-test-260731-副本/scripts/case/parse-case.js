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
  rebuildCaseDerivedArtifacts,
  reapplyNotes,
  desiredCaseDir,
  syncCaseDirectory,
  validateCaseExecutionContract,
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
if (previous?.globalRules?.length && !caseJson.globalRules?.length) {
  caseJson.globalRules = previous.globalRules;
}
let sourceChanged = false;
let sourceChangeEvent = null;

if (previous && previous.identity.sourceSha1 !== caseJson.identity.sourceSha1) {
  sourceChanged = true;
  caseJson.sourceChanged = true;
  sourceChangeEvent = {
    time: nowIso(),
    source: 'system',
    type: sourceEventType,
    from: previous.identity.sourceSha1,
    to: caseJson.identity.sourceSha1,
    mode: caseJson.identity.sourceMode,
  };
}

caseJson = validateCaseExecutionContract(reapplyNotes(caseJson, notes, { strictStepText: sourceChanged }));
if (!existingCaseDir) {
  caseDir = desiredCaseDir(root, caseJson);
  ensureDir(caseDir);
} else {
  caseDir = syncCaseDirectory(root, caseDir, caseJson);
}
if (sourceChangeEvent) appendJsonl(path.join(caseDir, 'notes.jsonl'), sourceChangeEvent);
const finalCasePath = path.join(caseDir, 'case.json');
const finalSourceSnapshotPath = path.join(caseDir, 'source.md');
writeText(finalSourceSnapshotPath, selected.sourceMarkdown);
writeJson(finalCasePath, caseJson);

const rebuilt = rebuildCaseDerivedArtifacts(caseDir);
const reports = rebuilt.rootReport;
const indexHtml = rebuilt.indexHtml;

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
