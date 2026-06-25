#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  appendJsonl,
  nowIso,
  readJson,
  readJsonl,
  refreshIndexForCase,
  reapplyNotes,
  writeCaseReports,
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
const note = {
  time: nowIso(),
  source: 'conversation',
  type,
  appliesTo,
  stepSourceText: sourceStep?.sourceText,
  text,
  applied: true,
  stale: false,
};
appendJsonl(notesPath, note);

let caseJson = caseJsonBefore;
caseJson = reapplyNotes(caseJson, readJsonl(notesPath));
writeJson(path.join(caseDir, 'case.json'), caseJson);

const state = readJson(path.join(caseDir, 'state.json'), {});
const currentNotes = readJsonl(notesPath);
const reports = writeCaseReports(caseDir, caseJson, state, currentNotes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({ note, ...reports, indexHtml }, null, 2));
