#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  normalizePlatform,
  readJson,
  workspaceRoot,
} = require('../common');

function usage() {
  console.error('Usage: list-flows.js [--cwd <workspace-cwd>] [--platform <platform>] [--all]');
  process.exit(2);
}

const args = process.argv.slice(2);
let cwd = process.cwd();
let includeAll = false;
let currentPlatform = '';
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--cwd': cwd = path.resolve(args[++i]); break;
    case '--platform': currentPlatform = normalizePlatform(args[++i]); if (!currentPlatform) usage(); break;
    case '--all': includeAll = true; break;
    default: usage();
  }
}

const flowsRoot = path.join(workspaceRoot(cwd), 'flows');
const flows = [];
for (const flowJsonPath of findFlowJsons(flowsRoot)) {
  const flowDir = path.dirname(flowJsonPath);
  const flow = readJson(flowJsonPath, {});
  const state = readJson(path.join(flowDir, 'state.json'), {});
  const status = flow.status || state.latestStatus || 'UNKNOWN';
  if (!includeAll && status !== 'READY') continue;
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const platform = normalizePlatform(flow.platform || state.platform || platformFromName(flow.name || state.name || path.basename(flowDir)));
  if (!includeAll && currentPlatform && platform && platform !== currentPlatform) continue;
  flows.push({
    flowId: flow.id || state.flowId || '',
    name: flow.name || state.name || path.basename(flowDir),
    platform,
    recordingPlatform: normalizePlatform(flow.recordingPlatform || state.recordingPlatform || state.environment?.platform || ''),
    flowScope: flow.flowScope || state.flowScope || (platform ? 'platform' : 'universal'),
    platformSpecific: Boolean(currentPlatform && platform === currentPlatform),
    intent: Array.isArray(flow.intent) ? flow.intent : Array.isArray(state.intent) ? state.intent : [],
    status,
    latestRecordingId: flow.latestRecordingId || state.latestRecordingId || '',
    updatedAt: flow.updatedAt || state.updatedAt || '',
    flowDir,
    flowJson: flowJsonPath,
    flowMd: path.join(flowDir, 'flow.md'),
    stepCount: steps.length,
    successHints: Array.from(new Set(steps.map((step) => step.successHint).filter(Boolean))),
    humanInstructions: steps.map((step) => step.humanInstruction).filter(Boolean),
    steps: steps.map((step) => ({
      id: step.id || '',
      humanInstruction: step.humanInstruction || '',
      beforeObservation: step.beforeObservation || {},
      action: step.action || {},
      afterObservation: step.afterObservation || {},
      successHint: step.successHint || '',
    })),
  });
}
flows.sort((a, b) => flowRank(a, currentPlatform) - flowRank(b, currentPlatform) || a.name.localeCompare(b.name, 'zh-CN') || a.flowId.localeCompare(b.flowId));

console.log(JSON.stringify({ flowsRoot, flows }, null, 2));

function platformFromName(name) {
  const text = String(name || '').toLowerCase();
  for (const platform of ['harmony', 'android', 'ios']) {
    if (new RegExp(`(?:^|[-_])${platform}(?:$|[-_])`).test(text)) return platform;
  }
  return '';
}

function flowRank(flow, platform) {
  if (!platform) return 1;
  if (flow.platform === platform) return 0;
  if (!flow.platform) return 1;
  return 2;
}

function findFlowJsons(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (name === 'recordings') continue;
        stack.push(full);
      } else if (name === 'flow.json') {
        out.push(full);
      }
    }
  }
  return out;
}
