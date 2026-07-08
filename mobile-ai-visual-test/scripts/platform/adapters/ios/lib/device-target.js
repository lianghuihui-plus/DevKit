#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');

function parseBoolean(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseArgs(argv) {
  const options = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--device':
        options.device = argv[++i];
        break;
      case '--app':
      case '--bundle':
        options.appId = argv[++i];
        break;
      case '--device-type':
        options.deviceType = argv[++i];
        break;
      case '--appium-server':
        options.appiumServer = argv[++i];
        break;
      case '--wda-local-port':
        options.wdaLocalPort = argv[++i];
        break;
      case '--web-driver-agent-url':
        options.webDriverAgentUrl = argv[++i];
        break;
      case '--xcode-org-id':
        options.xcodeOrgId = argv[++i];
        break;
      case '--xcode-signing-id':
        options.xcodeSigningId = argv[++i];
        break;
      case '--updated-wda-bundle-id':
        options.updatedWDABundleId = argv[++i];
        break;
      case '--show-xcode-log':
        options.showXcodeLog = argv[i + 1] && !argv[i + 1].startsWith('--') ? parseBoolean(argv[++i]) : true;
        break;
      case '--show-ios-log':
        options.showIOSLog = argv[i + 1] && !argv[i + 1].startsWith('--') ? parseBoolean(argv[++i]) : true;
        break;
      case '--use-new-wda':
        options.useNewWDA = argv[i + 1] && !argv[i + 1].startsWith('--') ? parseBoolean(argv[++i]) : true;
        break;
      case '--allow-provisioning-device-registration':
        options.allowProvisioningDeviceRegistration = argv[i + 1] && !argv[i + 1].startsWith('--') ? parseBoolean(argv[++i]) : true;
        break;
      case '--wda-launch-timeout':
        options.wdaLaunchTimeout = argv[++i];
        break;
      case '--derived-data-path':
        options.derivedDataPath = argv[++i];
        break;
      default:
        options.rest.push(arg);
        break;
    }
  }
  return options;
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 15000,
        env: options.env || process.env,
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || String(error),
      status: error.status || 1,
    };
  }
}

function commandExists(command) {
  return run('sh', ['-lc', `command -v ${command}`], { timeout: 5000 }).ok;
}

function listBootedSimulators() {
  const result = run('xcrun', ['simctl', 'list', 'devices', 'booted'], { timeout: 15000 });
  if (!result.ok) return [];
  const devices = [];
  const pattern = /^\s*(.+?) \(([0-9A-Fa-f-]{36})\) \(Booted\)/;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) devices.push({ name: match[1], udid: match[2], state: 'Booted', deviceType: 'simulator' });
  }
  return devices;
}

function inferDeviceType(deviceType, device) {
  if (deviceType) return deviceType;
  if (!device) return 'simulator';
  if (/^[0-9A-Fa-f-]{36}$/.test(device)) return 'simulator';
  return 'realDevice';
}

function buildTarget(options = {}) {
  const device = options.device || process.env.MAVT_IOS_DEVICE || '';
  const appId = options.appId || process.env.MAVT_IOS_APP || process.env.MAVT_IOS_BUNDLE || '';
  return {
    device,
    appId,
    deviceType: inferDeviceType(options.deviceType || process.env.MAVT_IOS_DEVICE_TYPE, device),
    appiumServer: options.appiumServer || process.env.MAVT_IOS_APPIUM_SERVER || 'http://127.0.0.1:4723',
    wdaLocalPort: options.wdaLocalPort || process.env.MAVT_IOS_WDA_LOCAL_PORT || '8100',
    webDriverAgentUrl: options.webDriverAgentUrl || process.env.MAVT_IOS_WDA_URL || '',
    xcodeOrgId: options.xcodeOrgId || process.env.MAVT_IOS_XCODE_ORG_ID || '',
    xcodeSigningId: options.xcodeSigningId || process.env.MAVT_IOS_XCODE_SIGNING_ID || '',
    updatedWDABundleId: options.updatedWDABundleId || process.env.MAVT_IOS_UPDATED_WDA_BUNDLE_ID || '',
    showXcodeLog: parseBoolean(options.showXcodeLog, parseBoolean(process.env.MAVT_IOS_SHOW_XCODE_LOG)),
    showIOSLog: parseBoolean(options.showIOSLog, parseBoolean(process.env.MAVT_IOS_SHOW_IOS_LOG)),
    useNewWDA: parseBoolean(options.useNewWDA, parseBoolean(process.env.MAVT_IOS_USE_NEW_WDA)),
    allowProvisioningDeviceRegistration: parseBoolean(options.allowProvisioningDeviceRegistration, parseBoolean(process.env.MAVT_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION)),
    wdaLaunchTimeout: parseOptionalNumber(options.wdaLaunchTimeout || process.env.MAVT_IOS_WDA_LAUNCH_TIMEOUT),
    derivedDataPath: options.derivedDataPath || process.env.MAVT_IOS_DERIVED_DATA_PATH || '',
  };
}

module.exports = {
  buildTarget,
  commandExists,
  inferDeviceType,
  listBootedSimulators,
  parseArgs,
  parseBoolean,
  run,
};
