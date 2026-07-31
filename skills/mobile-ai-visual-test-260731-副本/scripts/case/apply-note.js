#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  appendJsonl,
  nowIso,
  readJson,
  readJsonl,
  rebuildCaseDerivedArtifacts,
  reapplyNotes,
  sha1,
  validateCaseExecutionContract,
  writeJson,
} = require('../common');

function usage() {
  console.error('Usage: apply-note.js <case-dir> --text <note> [--applies-to <step-id>] [--type <note-type>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const caseDir = path.resolve(args[0]);
let text = '';
let appliesTo = null;
let type = 'target_hint';

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--text': text = args[++i]; break;
    case '--applies-to': appliesTo = args[++i]; break;
    case '--type': type = args[++i]; break;
    default: usage();
  }
}

if (!text) usage();

const notesPath = path.join(caseDir, 'notes.jsonl');
const caseJsonBefore = readJson(path.join(caseDir, 'case.json'));
const sourceStep = appliesTo ? caseJsonBefore.steps.find((step) => step.id === appliesTo) : null;
const existingNotes = readJsonl(notesPath);
const duplicate = existingNotes.find((item) => item.source === 'conversation' && item.type === type && item.appliesTo === appliesTo && item.text === text);
const note = {
  noteId: duplicate?.noteId || `note-${sha1(`${type}\n${appliesTo || ''}\n${text}`).slice(0, 16)}`,
  time: nowIso(),
  source: 'conversation',
  type,
  appliesTo,
  stepSourceText: sourceStep?.sourceText,
  text,
  applied: true,
  stale: false,
};
const candidateNotes = duplicate ? existingNotes : [...existingNotes, note];
const caseJson = validateCaseExecutionContract(reapplyNotes(caseJsonBefore, candidateNotes));
if (!duplicate) appendJsonl(notesPath, note);
writeJson(path.join(caseDir, 'case.json'), caseJson);

const rebuilt = rebuildCaseDerivedArtifacts(caseDir);
const reports = rebuilt.rootReport;
const indexHtml = rebuilt.indexHtml;

console.log(JSON.stringify({ note: duplicate || note, duplicate: Boolean(duplicate), ...reports, indexHtml }, null, 2));
