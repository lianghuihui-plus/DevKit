#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const path = require('path');
const {
  normalizePlatform,
  nowIso,
  workspaceRoot,
} = require('../common');

function usage() {
  console.error('Usage: record-scan.js <case-dir> --platform <platform> --execution-id <id> [--cwd <workspace-cwd>] [--step-id <step-id>] [--matched-flow-ids <id,id>] [--status COMPLETED|EMPTY|FAILED] [--reason <text>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const caseDir = path.resolve(args[0]);
let cwd = process.cwd();
let platform = '';
let executionId = '';
let stepId = '';
let matchedFlowIds = [];
let status = '';
let reason = '';
let root = '';
let flowsRoot = '';
let scannedFlowIds = [];

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--cwd': cwd = path.resolve(args[++i]); break;
    case '--platform': platform = normalizePlatform(args[++i]); if (!platform) usage(); break;
    case '--execution-id': executionId = args[++i]; break;
    case '--step-id': stepId = args[++i]; break;
    case '--matched-flow-ids': matchedFlowIds = splitIds(args[++i]); break;
    case '--status': status = args[++i]; break;
    case '--reason': reason = args[++i]; break;
    default: usage();
  }
}

if (!platform) usage();
if (!executionId) usage();
if (status && !['COMPLETED', 'EMPTY', 'FAILED'].includes(status)) usage();

try {
  root = workspaceRoot(cwd);
  flowsRoot = path.join(root, 'flows');
  const list = JSON.parse(childProcess.execFileSync(process.execPath, [
    path.join(__dirname, 'list-flows.js'),
    '--cwd',
    root,
    '--platform',
    platform,
  ], { encoding: 'utf8' }));
  scannedFlowIds = (Array.isArray(list.flows) ? list.flows : [])
    .map((flow) => flow.flowId)
    .filter(Boolean);
  flowsRoot = list.flowsRoot || flowsRoot;
  const scanned = new Set(scannedFlowIds);
  const unknown = matchedFlowIds.filter((flowId) => !scanned.has(flowId));
  if (unknown.length) {
    throw new Error(`matched Flow 不在扫描结果中: ${unknown.join(', ')}`);
  }
  const event = {
    type: 'flowScan',
    source: 'list-flows',
    status: status || (scannedFlowIds.length ? 'COMPLETED' : 'EMPTY'),
    candidateCount: scannedFlowIds.length,
    matchedFlowIds,
    scannedFlowIds,
    flowsRoot,
    scannedAt: nowIso(),
    stepId: stepId || undefined,
    reason: reason || undefined,
  };
  const runCaseArgs = [
    path.join(__dirname, '..', 'run-case.js'),
    caseDir,
    '--platform',
    platform,
    '--record-json',
    JSON.stringify(event),
  ];
  runCaseArgs.push('--execution-id', executionId);
  const output = childProcess.execFileSync(process.execPath, runCaseArgs, { encoding: 'utf8' });
  const recorded = JSON.parse(output);
  console.log(JSON.stringify({ ...recorded, flowScan: event, flows: list.flows || [] }, null, 2));
} catch (error) {
  recordFailedScan(error);
  console.error(error.message);
  process.exit(1);
}

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function recordFailedScan(error) {
  if (!platform) return;
  const scanned = new Set(scannedFlowIds);
  const safeMatchedFlowIds = matchedFlowIds.filter((flowId) => scanned.has(flowId));
  const event = {
    type: 'flowScan',
    source: 'list-flows',
    status: 'FAILED',
    candidateCount: scannedFlowIds.length,
    matchedFlowIds: safeMatchedFlowIds,
    scannedFlowIds,
    flowsRoot: flowsRoot || (root ? path.join(root, 'flows') : path.join(cwd, 'flows')),
    scannedAt: nowIso(),
    stepId: stepId || undefined,
    reason: [reason, error?.message || String(error)].filter(Boolean).join('；'),
  };
  const runCaseArgs = [
    path.join(__dirname, '..', 'run-case.js'),
    caseDir,
    '--platform',
    platform,
    '--record-json',
    JSON.stringify(event),
  ];
  runCaseArgs.push('--execution-id', executionId);
  try {
    childProcess.execFileSync(process.execPath, runCaseArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Best effort: record-scan should still surface the original scan failure.
  }
}
