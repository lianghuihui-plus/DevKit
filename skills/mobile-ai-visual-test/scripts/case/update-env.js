#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  caseRootFromCaseDir,
  caseRuntimeDir,
  nowIso,
  normalizePlatform,
  readJson,
  rebuildCaseDerivedArtifacts,
  sha1,
  writeJson,
} = require('../common');
const {
  normalizeDeviceFormFactor,
  normalizeStartupDisplayPolicy,
} = require('../lib/startup-display');
const { normalizeEnvironmentBinding, requiredEnvironmentFields } = require('../lib/execution-environment');

function usage() {
  console.error('用法: update-env.js <case-dir> [--platform <platform>] [--device <serial>] [--app <appId>] [--entry <entry>] [--device-form-factor <form>] [--startup-orientation <portrait|preserve>] [--startup-orientation-enforcement <required|none>] [--startup-orientation-applies-to <forms>] [iOS WDA options]');
  process.exit(2);
}

function parseBoolean(value, flag) {
  if (value === undefined || value === null || value === '') return true;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  console.error(`无效 ${flag}: ${value}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const caseDir = path.resolve(args[0]);
const env = {};
let startupOrientation;
let startupOrientationEnforcement;
let startupOrientationAppliesTo;
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
    case '--device-form-factor': env.deviceFormFactor = args[++i]; break;
    case '--startup-orientation': startupOrientation = args[++i]; break;
    case '--startup-orientation-enforcement': startupOrientationEnforcement = args[++i]; break;
    case '--startup-orientation-applies-to': startupOrientationAppliesTo = args[++i]; break;
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
env.platform = platform;
const runtimeDir = caseRuntimeDir(caseDir, platform);
const statePath = path.join(runtimeDir, 'state.json');
const state = readJson(statePath, { schemaVersion: 1, executionCount: 0, statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 } });
const executionsRoot = path.join(runtimeDir, 'executions');
if (fs.existsSync(executionsRoot)) {
  const active = fs.readdirSync(executionsRoot).find((name) => {
    const execution = readJson(path.join(executionsRoot, name, 'execution.json'), null);
    return execution && execution.finalized !== true;
  });
  if (active) {
    console.error(`ACTIVE_EXECUTION_ENVIRONMENT_LOCKED: execution ${active} 尚未结束，环境只能在下一次 execution 前修改。`);
    process.exit(1);
  }
}
const workspaceRoot = caseRootFromCaseDir(caseDir);
const probePath = path.join(workspaceRoot, 'platforms', `${platform}-probe.json`);
const probeSnapshot = readJson(probePath, null);
const targetDevice = env.device || state.environment?.device;
const probeDevices = [];
for (const item of Array.isArray(probeSnapshot?.devices) ? probeSnapshot.devices : []) {
  if (typeof item === 'string') probeDevices.push({ id: item });
  else if (item && typeof item === 'object' && !Array.isArray(item)) probeDevices.push(item);
}
for (const id of Array.isArray(probeSnapshot?.targets) ? probeSnapshot.targets : []) {
  if (id && !probeDevices.some((item) => [item.id, item.serial, item.name].filter(Boolean).includes(id))) probeDevices.push({ id });
}
if (probeSnapshot?.device && !probeDevices.some((item) => [item.id, item.serial, item.name].filter(Boolean).includes(probeSnapshot.device))) {
  probeDevices.push({ id: probeSnapshot.device });
}
const selectedProbeDevice = probeDevices.find((item) => (
  [item.id, item.serial, item.name].filter(Boolean).includes(targetDevice)
));
if (targetDevice && probeDevices.length && !selectedProbeDevice) {
  console.error(`PROBE_DEVICE_NOT_FOUND: 已确认设备 ${targetDevice} 不在当前 ${platform} probe 中，请重新探测。`);
  process.exit(1);
}
if (!env.deviceFormFactor && selectedProbeDevice?.deviceFormFactor) {
  env.deviceFormFactor = selectedProbeDevice.deviceFormFactor;
  env.deviceFormFactorSource = 'probe-device-match';
} else if (env.deviceFormFactor) {
  env.deviceFormFactorSource = 'explicit';
}
if (env.deviceFormFactor) {
  const normalized = normalizeDeviceFormFactor(env.deviceFormFactor);
  if (!normalized) {
    console.error(`无效 --device-form-factor: ${env.deviceFormFactor}`);
    process.exit(2);
  }
  env.deviceFormFactor = normalized;
}
let mergedEnvironment = { ...(state.environment || {}), ...env };
try {
  const existingPolicy = mergedEnvironment.startupDisplayPolicy || {};
  const hasPolicyOverride = startupOrientation !== undefined
    || startupOrientationEnforcement !== undefined
    || startupOrientationAppliesTo !== undefined;
  mergedEnvironment.startupDisplayPolicy = normalizeStartupDisplayPolicy(
    hasPolicyOverride ? {
      orientation: startupOrientation ?? existingPolicy.orientation,
      enforcement: startupOrientationEnforcement ?? existingPolicy.enforcement,
      appliesTo: startupOrientationAppliesTo === undefined
        ? existingPolicy.appliesTo
        : String(startupOrientationAppliesTo).split(',').map((item) => item.trim()).filter(Boolean),
    } : existingPolicy,
    { platform },
  );
  mergedEnvironment = normalizeEnvironmentBinding(mergedEnvironment, platform);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(2);
}
state.environment = mergedEnvironment;
if (probeSnapshot) {
  state.environmentProbe = {
    path: path.relative(workspaceRoot, probePath).replace(/\\/g, '/'),
    sha1: `probe-${sha1(JSON.stringify(probeSnapshot)).slice(0, 12)}`,
    ready: probeSnapshot.ready === true,
    capabilities: probeSnapshot.capabilities || {},
    devices: probeDevices.map((device) => device.id || device.serial || device.name).filter(Boolean),
  };
}
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
  environmentProbe: state.environmentProbe || null,
  confirmedAt: state.environmentConfirmedAt,
});

const rebuilt = rebuildCaseDerivedArtifacts(caseDir, { scope: 'platform', platform });
const platformSegment = `${path.sep}platforms${path.sep}${platform}${path.sep}`;
const reports = rebuilt.platformReports.find((report) => report.context.includes(platformSegment)) || rebuilt.rootReport;
const indexHtml = rebuilt.indexHtml;

console.log(JSON.stringify({ environment: state.environment, ...reports, indexHtml }, null, 2));
