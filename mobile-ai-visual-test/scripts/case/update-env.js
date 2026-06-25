#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  nowIso,
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
  writeJson,
} = require('../common');

function usage() {
  console.error('用法: update-env.js <case-dir> [--platform <platform>] [--device <serial>] [--app <appId>] [--entry <entry>] [--bundle <bundleName>] [--ability <abilityName>] [--screen <WxH>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const caseDir = path.resolve(args[0]);
const env = {};
for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--platform': env.platform = args[++i]; break;
    case '--device': env.device = args[++i]; break;
    case '--app': env.appId = args[++i]; break;
    case '--entry': env.entry = args[++i]; break;
    case '--bundle':
      env.bundleName = args[++i];
      env.appId = env.bundleName;
      break;
    case '--ability':
      env.abilityName = args[++i];
      env.entry = env.abilityName;
      break;
    case '--screen': env.screen = args[++i]; break;
    default: usage();
  }
}

const statePath = path.join(caseDir, 'state.json');
const state = readJson(statePath, { schemaVersion: 1, executionCount: 0, statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 } });
state.environment = { ...(state.environment || {}), ...env };
const missing = ['platform', 'device', 'appId', 'entry'].filter((field) => !state.environment[field]);
if (missing.length) {
  console.error(`环境信息不完整，缺少: ${missing.join(', ')}`);
  process.exit(1);
}
state.environmentConfirmedAt = nowIso();
writeJson(statePath, state);

const caseJson = readJson(path.join(caseDir, 'case.json'));
const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));
const reports = writeCaseReports(caseDir, caseJson, state, notes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({ environment: state.environment, ...reports, indexHtml }, null, 2));
