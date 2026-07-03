#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');

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
  };
}

module.exports = {
  buildTarget,
  commandExists,
  inferDeviceType,
  listBootedSimulators,
  parseArgs,
  run,
};
