#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  caseRootFromCaseDir,
  caseRuntimeDir,
  nowIso,
  normalizePlatform,
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
  writeJson,
} = require('../common');

function usage() {
  console.error('用法: update-env.js <case-dir> [--platform <platform>] [--device <serial>] [--app <appId>] [--entry <entry>] [--bundle <bundleName>] [--ability <abilityName>] [--screen <WxH>] [iOS WDA options]');
  process.exit(2);
}

function parseBoolean(value, flag) {
  if (value === undefined || value === null || value === '') return true;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  console.error(`无效 ${flag}: ${value}`);
  process.exit(2);
}

function requiredEnvironmentFields(platform) {
  if (platform === 'ios') return ['platform', 'device', 'appId'];
  return ['platform', 'device', 'appId', 'entry'];
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
    case '--device-type': env.deviceType = args[++i]; break;
    case '--appium-server': env.appiumServer = args[++i]; break;
    case '--wda-local-port': env.wdaLocalPort = args[++i]; break;
    case '--web-driver-agent-url': env.webDriverAgentUrl = args[++i]; break;
    case '--xcode-org-id': env.xcodeOrgId = args[++i]; break;
    case '--xcode-signing-id': env.xcodeSigningId = args[++i]; break;
    case '--updated-wda-bundle-id': env.updatedWDABundleId = args[++i]; break;
    case '--show-xcode-log':
      env.showXcodeLog = args[i + 1] && !args[i + 1].startsWith('--') ? parseBoolean(args[++i], '--show-xcode-log') : true;
      break;
    case '--show-ios-log':
      env.showIOSLog = args[i + 1] && !args[i + 1].startsWith('--') ? parseBoolean(args[++i], '--show-ios-log') : true;
      break;
    case '--use-new-wda':
      env.useNewWDA = args[i + 1] && !args[i + 1].startsWith('--') ? parseBoolean(args[++i], '--use-new-wda') : true;
      break;
    case '--allow-provisioning-device-registration':
      env.allowProvisioningDeviceRegistration = args[i + 1] && !args[i + 1].startsWith('--') ? parseBoolean(args[++i], '--allow-provisioning-device-registration') : true;
      break;
    case '--wda-launch-timeout': env.wdaLaunchTimeout = args[++i]; break;
    case '--derived-data-path': env.derivedDataPath = args[++i]; break;
    default: usage();
  }
}

const platform = normalizePlatform(env.platform);
if (!platform) {
  console.error('环境信息不完整，缺少或无效: platform');
  process.exit(1);
}
const runtimeDir = caseRuntimeDir(caseDir, platform);
const statePath = path.join(runtimeDir, 'state.json');
const state = readJson(statePath, { schemaVersion: 1, executionCount: 0, statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 } });
state.environment = { ...(state.environment || {}), ...env };
const missing = requiredEnvironmentFields(platform).filter((field) => !state.environment[field]);
if (missing.length) {
  console.error(`环境信息不完整，缺少: ${missing.join(', ')}`);
  process.exit(1);
}
state.environmentConfirmedAt = nowIso();
writeJson(statePath, state);
writeJson(path.join(caseRootFromCaseDir(caseDir), 'platforms', `${platform}.json`), {
  schemaVersion: 1,
  platform,
  environment: state.environment,
  confirmedAt: state.environmentConfirmedAt,
});

const caseJson = readJson(path.join(caseDir, 'case.json'));
const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));
const reports = writeCaseReports(caseDir, caseJson, state, notes, null, { platform });
writeCaseReports(caseDir, caseJson, {}, notes);
const indexHtml = refreshIndexForCase(caseDir);

console.log(JSON.stringify({ environment: state.environment, ...reports, indexHtml }, null, 2));
