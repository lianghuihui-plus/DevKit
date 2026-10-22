#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  IOS_INSTALLATION_STATUS,
  parseDevicectlInstallation,
  performIosReinstall,
  waitForRuntimeAppState,
} = require('../platform/adapters/ios/lib/ios-driver');
const { parseAdapterOutput } = require('../platform/device-port');

const appId = 'arena.codemao.cn';

assert.deepStrictEqual(parseDevicectlInstallation({
  result: {
    apps: [{ bundleIdentifier: appId, version: '5.2.7', bundleVersion: '1' }],
  },
}, appId), {
  status: IOS_INSTALLATION_STATUS.INSTALLED,
  source: 'DEVICECTL',
  identity: { appId, version: '5.2.7', build: '1' },
});
assert.deepStrictEqual(parseDevicectlInstallation({ result: { apps: [] } }, appId), {
  status: IOS_INSTALLATION_STATUS.NOT_INSTALLED,
  source: 'DEVICECTL',
  identity: null,
});
assert.deepStrictEqual(parseDevicectlInstallation({ result: {} }, appId), {
  status: IOS_INSTALLATION_STATUS.UNKNOWN,
  source: 'DEVICECTL',
  identity: null,
});
assert.throws(() => parseAdapterOutput({
  status: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
}, 'PREPARATION'), (error) => error?.code === 'APP_PREPARATION_OUTCOME_UNKNOWN');

async function main() {
  const runtimeStates = [4, 1];
  const stopped = await waitForRuntimeAppState({ appId, appiumServer: 'http://127.0.0.1:4723' }, 'runtime-session',
    (state) => Number(state) <= 1, 'not running', {
      appiumClient: {
        request: async (_server, _method, endpoint) => {
          assert.ok(endpoint.endsWith('/app_state'));
          return { value: runtimeStates.shift() };
        },
      },
      sleep: async () => {},
      timeoutMs: 1000,
    });
  assert.deepStrictEqual(stopped, { ok: true, state: 1 });

  const installationStates = [
    { status: IOS_INSTALLATION_STATUS.INSTALLED, source: 'DEVICECTL', identity: { appId, version: '5.2.6', build: '9' } },
    { status: IOS_INSTALLATION_STATUS.NOT_INSTALLED, source: 'DEVICECTL', identity: null },
    { status: IOS_INSTALLATION_STATUS.INSTALLED, source: 'DEVICECTL', identity: { appId, version: '5.2.7', build: '1' } },
  ];
  const endpoints = [];
  const result = await performIosReinstall({
    appId,
    appiumServer: 'http://127.0.0.1:4723',
    device: '00008027-001120DE3A40402E',
    deviceType: 'realDevice',
  }, 'maintenance-session', '/tmp/lunar.app', {
    appiumClient: {
      request: async (_server, _method, endpoint) => {
        if (endpoint.endsWith('/app_state')) throw new Error('regression: WDA app_state remains 1 after successful removal');
        endpoints.push(endpoint);
        return { value: null };
      },
    },
    queryInstallation: async () => installationStates.shift(),
    sleep: async () => {},
    timeoutMs: 1000,
  });

  assert.deepStrictEqual(endpoints, [
    '/session/maintenance-session/appium/device/remove_app',
    '/session/maintenance-session/appium/device/install_app',
  ]);
  assert.deepStrictEqual(result, {
    status: IOS_INSTALLATION_STATUS.INSTALLED,
    source: 'DEVICECTL',
    identity: { appId, version: '5.2.7', build: '1' },
  });
  assert.strictEqual(installationStates.length, 0);
  console.log('ios app preparation passed');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
