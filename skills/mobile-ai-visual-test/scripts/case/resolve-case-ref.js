#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  casesRoot,
  normalizeCaseNo,
  readCaseEntries,
} = require('../common');

function usage() {
  console.error('Usage: resolve-case-ref.js <caseNo|caseKey|title-keyword> [--cwd <workspace-cwd>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();
let ref = '';
let cwd = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') cwd = path.resolve(args[++i]);
  else if (!ref) ref = args[i];
  else usage();
}
if (!ref) usage();

const entries = readCaseEntries(casesRoot(cwd)).sort((a, b) => {
  const noA = normalizeCaseNo(a.caseJson.identity?.caseNo);
  const noB = normalizeCaseNo(b.caseJson.identity?.caseNo);
  return noA.localeCompare(noB) || a.caseDir.localeCompare(b.caseDir);
});
const normalizedRef = normalizeCaseNo(ref);
const matches = normalizedRef
  ? entries.filter((entry) => normalizeCaseNo(entry.caseJson.identity?.caseNo) === normalizedRef)
  : entries.filter((entry) => entry.caseJson.identity?.caseKey === ref);
const finalMatches = matches.length ? matches : matchByTitle(entries, ref);

if (!finalMatches.length) {
  console.error(`No case matched: ${ref}`);
  process.exit(1);
}
if (finalMatches.length > 1) {
  console.error(JSON.stringify({
    error: 'AMBIGUOUS_CASE_REF',
    ref,
    matches: finalMatches.map(toSummary),
  }, null, 2));
  process.exit(3);
}

console.log(JSON.stringify(toSummary(finalMatches[0]), null, 2));

function matchByTitle(items, keyword) {
  const exact = items.filter((entry) => entry.caseJson.identity?.title === keyword);
  if (exact.length) return exact;
  return items.filter((entry) => String(entry.caseJson.identity?.title || '').includes(keyword));
}

function toSummary(entry) {
  return {
    caseNo: normalizeCaseNo(entry.caseJson.identity?.caseNo),
    title: entry.caseJson.identity?.title || '',
    caseKey: entry.caseJson.identity?.caseKey || '',
    caseDir: entry.caseDir,
    context: path.join(entry.caseDir, 'CONTEXT.md'),
    contextHtml: path.join(entry.caseDir, 'CONTEXT.html'),
  };
}
