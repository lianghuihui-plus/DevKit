#!/usr/bin/env node
'use strict';

const path = require('path');
const { casesRoot, normalizeCaseNo, readCaseEntries } = require('../common');

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

function resolveCaseRef(ref, cwd) {
  const entries = readCaseEntries(casesRoot(cwd)).sort((a, b) => {
    const noA = normalizeCaseNo(a.caseJson.identity?.caseNo);
    const noB = normalizeCaseNo(b.caseJson.identity?.caseNo);
    return noA.localeCompare(noB) || a.caseDir.localeCompare(b.caseDir);
  });
  const normalizedRef = normalizeCaseNo(ref);
  const direct = normalizedRef
    ? entries.filter((entry) => normalizeCaseNo(entry.caseJson.identity?.caseNo) === normalizedRef)
    : entries.filter((entry) => entry.caseJson.identity?.caseKey === ref);
  const exactTitle = entries.filter((entry) => entry.caseJson.identity?.title === ref);
  const matches = direct.length ? direct : exactTitle.length ? exactTitle : entries.filter((entry) => String(entry.caseJson.identity?.title || '').includes(ref));
  if (!matches.length) throw new Error(`No path or case matched: ${ref}`);
  if (matches.length > 1) {
    const error = new Error(`Ambiguous case ref: ${ref}`);
    error.code = 'AMBIGUOUS_CASE_REF';
    error.matches = matches.map(toSummary);
    throw error;
  }
  return toSummary(matches[0]);
}

module.exports = { resolveCaseRef, toSummary };
