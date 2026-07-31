#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  casesRoot,
  normalizeCaseNo,
  normalizePlatform,
  nowIso,
  PRECONDITION_STATUS_PRIORITY,
  readCaseEntries,
  readJson,
  worsePreconditionStatus,
  workspaceRoot,
} = require('./common');
const { parseCliArgsOrExit } = require('./lib/cli-args');
const { buildPreconditionPlan, planFlowSummaries, trimFlowName } = require('./lib/precondition-flow');

function usage() {
  console.error('Usage: preflight-preconditions.js <case-dir|caseNo|caseKey|title>... --platform <harmony|android|ios> [--cwd <workspace-cwd>] [--all]');
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

function summarizeCase(entry, root, platform) {
  const identity = entry.caseJson.identity || {};
  const preconditionPlan = buildPreconditionPlan(entry.caseJson, root, platform);
  let caseStatus = 'READY';
  const summarized = preconditionPlan.preconditions.map((item) => {
    caseStatus = worsePreconditionStatus(caseStatus, item.status);
    return { ...item, flow: undefined };
  });
  return {
    caseNo: normalizeCaseNo(identity.caseNo),
    title: identity.title || '',
    caseKey: identity.caseKey || '',
    caseDir: entry.caseDir,
    status: caseStatus,
    executableByDefault: caseStatus === 'READY',
    requiresUserDecision: caseStatus !== 'READY',
    preconditionPlanSha: preconditionPlan.preconditionPlanSha,
    flowMatches: planFlowSummaries(preconditionPlan),
    preconditionPlan,
    preconditions: summarized,
  };
}

function buildGroups(cases) {
  const groupMap = new Map();
  for (const item of cases) {
    for (const precondition of item.preconditions) {
      const textKey = trimFlowName(precondition.text);
      const key = JSON.stringify([textKey, precondition.resolution, precondition.flowId || '']);
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key: textKey,
          text: precondition.text,
          category: precondition.category,
          status: precondition.status,
          resolution: precondition.resolution,
          defaultResolution: precondition.defaultResolution,
          flowId: precondition.flowId,
          flowName: precondition.flowName,
          flowPath: precondition.flowPath,
          flowSha1: precondition.flowSha1,
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

  const parsedArgs = parseCliArgsOrExit(args, {
    context: 'preflight-preconditions.js',
    valueOptions: ['--cwd', '--platform'],
    booleanOptions: ['--all'],
  });
  const cwd = parsedArgs.values['--cwd'] ? path.resolve(parsedArgs.values['--cwd']) : process.cwd();
  const all = parsedArgs.values['--all'] === true;
  const platform = normalizePlatform(parsedArgs.values['--platform']);
  const refs = parsedArgs.positionals;
  if (!all && refs.length === 0) usage();
  if (!platform) usage();

  const root = workspaceRoot(cwd);
  const rootCases = casesRoot(root);
  const entries = readCaseEntries(rootCases).sort((a, b) => {
    return normalizeCaseNo(a.caseJson.identity?.caseNo).localeCompare(normalizeCaseNo(b.caseJson.identity?.caseNo)) ||
      a.caseDir.localeCompare(b.caseDir);
  });
  const selected = all ? entries : refs.map((ref) => resolveCase(ref, entries, rootCases));
  const cases = selected.map((entry) => summarizeCase(entry, root, platform));
  const groups = buildGroups(cases);
  const summary = {
    totalCases: cases.length,
    readyCases: cases.filter((item) => item.status === 'READY').length,
    needsConfirmationCases: cases.filter((item) => item.status === 'CONFIRM').length,
    needsSetupCases: cases.filter((item) => item.status === 'NEEDS_SETUP').length,
    unknownCases: cases.filter((item) => item.status === 'UNKNOWN').length,
    blockedCases: cases.filter((item) => item.status === 'UNSUPPORTED').length,
    totalPreconditions: cases.reduce((sum, item) => sum + item.preconditions.length, 0),
    flowMatchedPreconditions: cases.reduce((sum, item) => sum + item.preconditions.filter((precondition) => precondition.resolution === 'flow').length, 0),
    flowMatchedCases: cases.filter((item) => item.flowMatches.length > 0).length,
    groups: groups.length,
  };

  console.log(JSON.stringify({
    schemaVersion: 1,
    type: 'preconditionPreflight',
    generatedAt: nowIso(),
    workspaceRoot: root,
    platform,
    summary,
    groups,
    cases,
  }, null, 2));
}

main();
