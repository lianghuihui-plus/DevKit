#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  casesRoot,
  classifyPrecondition,
  normalizeCaseNo,
  normalizePreconditionText,
  nowIso,
  PRECONDITION_STATUS_PRIORITY,
  readCaseEntries,
  readJson,
  worsePreconditionStatus,
  workspaceRoot,
} = require('./common');

function usage() {
  console.error('Usage: preflight-preconditions.js <case-dir|caseNo|caseKey|title>... [--cwd <workspace-cwd>] [--all]');
  process.exit(2);
}

function resolveCase(ref, entries, root) {
  const abs = path.resolve(ref);
  if (fs.existsSync(path.join(abs, 'case.json'))) {
    const caseJson = readJson(path.join(abs, 'case.json'));
    return { caseDir: abs, caseJson };
  }
  const normalizedRef = normalizeCaseNo(ref);
  const matches = normalizedRef
    ? entries.filter((entry) => normalizeCaseNo(entry.caseJson.identity?.caseNo) === normalizedRef)
    : entries.filter((entry) => entry.caseJson.identity?.caseKey === ref);
  const titleMatches = matches.length
    ? matches
    : entries.filter((entry) => entry.caseJson.identity?.title === ref);
  const finalMatches = titleMatches.length
    ? titleMatches
    : entries.filter((entry) => String(entry.caseJson.identity?.title || '').includes(ref));

  if (!finalMatches.length) throw new Error(`No case matched: ${ref} in ${root}`);
  if (finalMatches.length > 1) {
    const summary = finalMatches.map((entry) => `${normalizeCaseNo(entry.caseJson.identity?.caseNo)} ${entry.caseJson.identity?.title || ''}`);
    throw new Error(`Ambiguous case ref: ${ref}; matches: ${summary.join(', ')}`);
  }
  return finalMatches[0];
}

function summarizeCase(entry) {
  const identity = entry.caseJson.identity || {};
  const preconditions = Array.isArray(entry.caseJson.preconditions) ? entry.caseJson.preconditions : [];
  let caseStatus = 'READY';
  const summarized = preconditions.map((item) => {
    const classification = classifyPrecondition(item);
    caseStatus = worsePreconditionStatus(caseStatus, classification.status);
    return {
      id: item.id,
      text: item.text || '',
      checkMode: item.checkMode || '',
      ...classification,
    };
  });
  return {
    caseNo: normalizeCaseNo(identity.caseNo),
    title: identity.title || '',
    caseKey: identity.caseKey || '',
    caseDir: entry.caseDir,
    status: caseStatus,
    executableByDefault: caseStatus === 'READY',
    requiresUserDecision: caseStatus !== 'READY',
    preconditions: summarized,
  };
}

function buildGroups(cases) {
  const groupMap = new Map();
  for (const item of cases) {
    for (const precondition of item.preconditions) {
      const key = normalizePreconditionText(precondition.text);
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          text: precondition.text,
          category: precondition.category,
          status: precondition.status,
          defaultResolution: precondition.defaultResolution,
          caseRefs: [],
          preconditionRefs: [],
        });
      }
      const group = groupMap.get(key);
      group.status = worsePreconditionStatus(group.status, precondition.status);
      if (!group.caseRefs.includes(item.caseNo)) group.caseRefs.push(item.caseNo);
      group.preconditionRefs.push({
        caseNo: item.caseNo,
        title: item.title,
        caseDir: item.caseDir,
        preconditionId: precondition.id,
        text: precondition.text,
      });
    }
  }
  return Array.from(groupMap.values()).sort((a, b) => {
    return PRECONDITION_STATUS_PRIORITY[b.status] - PRECONDITION_STATUS_PRIORITY[a.status] || a.text.localeCompare(b.text, 'zh-CN');
  });
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();

  let cwd = process.cwd();
  let all = false;
  const refs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cwd') cwd = path.resolve(args[++i]);
    else if (arg === '--all') all = true;
    else refs.push(arg);
  }
  if (!all && refs.length === 0) usage();

  const root = workspaceRoot(cwd);
  const rootCases = casesRoot(root);
  const entries = readCaseEntries(rootCases).sort((a, b) => {
    return normalizeCaseNo(a.caseJson.identity?.caseNo).localeCompare(normalizeCaseNo(b.caseJson.identity?.caseNo)) ||
      a.caseDir.localeCompare(b.caseDir);
  });
  const selected = all ? entries : refs.map((ref) => resolveCase(ref, entries, rootCases));
  const cases = selected.map(summarizeCase);
  const groups = buildGroups(cases);
  const summary = {
    totalCases: cases.length,
    readyCases: cases.filter((item) => item.status === 'READY').length,
    needsConfirmationCases: cases.filter((item) => item.status === 'CONFIRM').length,
    needsSetupCases: cases.filter((item) => item.status === 'NEEDS_SETUP').length,
    unknownCases: cases.filter((item) => item.status === 'UNKNOWN').length,
    blockedCases: cases.filter((item) => item.status === 'UNSUPPORTED').length,
    totalPreconditions: cases.reduce((sum, item) => sum + item.preconditions.length, 0),
    groups: groups.length,
  };

  console.log(JSON.stringify({
    schemaVersion: 1,
    type: 'preconditionPreflight',
    generatedAt: nowIso(),
    workspaceRoot: root,
    summary,
    groups,
    cases,
  }, null, 2));
}

main();
