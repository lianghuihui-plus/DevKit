#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireAndroidHelper,
  ensureAndroidHelperSession,
  releaseAndroidHelper,
  sessionStatePath,
} = require('../platform/adapters/android/lib/android-helper-session');
const {
  claimAndroidHelperDevice,
  writeJsonAtomic,
} = require('../platform/adapters/android/lib/android-helper-ownership');
const { createDeviceSessionAdapter } = require('../batch/device-session');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-runtime-'));
const workspaceRoot = path.join(root, 'workspace');
const claimRoot = path.join(root, 'canonical-claims');
const stateRootA = path.join(root, 'state-a');
const stateRootB = path.join(root, 'state-b');
fs.mkdirSync(workspaceRoot, { recursive: true });

function fakeDevice(overrides = {}) {
  const state = {
    sdk: 30,
    user: '0',
    transportId: '41',
    installedVersion: 0,
    accessibilityEnabled: '0',
    services: ['existing.reader/.Service'],
    forwards: new Map(),
    nextPort: 41000,
    token: '',
    externalToken: false,
    installFailure: null,
    failures: new Map(),
    calls: [],
    ...overrides,
  };

  function result(status = 0, stdout = '', stderr = '') {
    return { status, stdout: String(stdout), stderr: String(stderr) };
  }

  function runAdb({ deviceId, args, stdin }) {
    state.calls.push({ deviceId, args: [...args], stdin: stdin || '' });
    const joined = args.join(' ');
    const remainingFailures = Number(state.failures.get(joined) || 0);
    if (remainingFailures > 0) {
      state.failures.set(joined, remainingFailures - 1);
      return result(1, '', `injected failure: ${joined}`);
    }
    if (joined === 'shell getprop ro.build.version.sdk') return result(0, state.sdk);
    if (joined === 'shell am get-current-user') return result(0, state.user);
    if (joined === 'get-state') return result(0, 'device');
    if (joined === 'devices -l') return result(0, `List of devices attached\n${deviceId} device product:test transport_id:${state.transportId}`);
    if (joined === 'forward --list') {
      return result(0, [...state.forwards].map(([port, remote]) => `${deviceId} tcp:${port} ${remote}`).join('\n'));
    }
    if (joined === 'forward tcp:0 tcp:18888') {
      const port = state.nextPort++;
      state.forwards.set(String(port), 'tcp:18888');
      return result(0, String(port));
    }
    if (args[0] === 'forward' && args[1] === '--remove') {
      state.forwards.delete(String(args[2]).replace(/^tcp:/, ''));
      return result();
    }
    if (joined === 'shell dumpsys package com.artemis.helper') {
      return state.installedVersion
        ? result(0, `Packages:\n  versionCode=${state.installedVersion} minSdk=23\n  versionName=1.2.1`)
        : result(1, '', 'Unable to find package');
    }
    if (args[0] === 'install') {
      if (state.installFailure) return result(1, '', state.installFailure);
      state.installedVersion = 7;
      return result(0, 'Success');
    }
    if (joined === `shell settings --user ${state.user} get secure enabled_accessibility_services`) {
      return result(0, state.services.length ? state.services.join(':') : 'null');
    }
    if (joined === `shell settings --user ${state.user} get secure accessibility_enabled`) {
      return result(0, state.accessibilityEnabled);
    }
    if (args.slice(0, 7).join(' ') === `shell settings --user ${state.user} put secure enabled_accessibility_services`) {
      state.services = String(args[7] || '').split(':').filter(Boolean);
      return result();
    }
    if (args.slice(0, 7).join(' ') === `shell settings --user ${state.user} put secure accessibility_enabled`) {
      state.accessibilityEnabled = String(args[7]);
      return result();
    }
    if (joined === 'shell') {
      const match = String(stdin || '').match(/--es token ([0-9a-f]*)/);
      state.token = match ? match[1] : '';
      return result(0, 'Broadcast completed: result=0');
    }
    return result(1, '', `unexpected adb call: ${joined}`);
  }

  async function requestPing(session) {
    if (!session.token) {
      if (state.externalToken) return {
        success: true, authenticated: false, token_set: true, protocol_version: 2, version_code: 7,
      };
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    if (session.token !== state.token) return {
      success: true, authenticated: false, token_set: Boolean(state.token), protocol_version: 2, version_code: 7,
    };
    return {
      success: true, authenticated: true, token_set: true,
      protocol_version: 2, version_code: 7, version_name: '1.2.1',
    };
  }

  return { state, runAdb, requestPing };
}

function options(device, overrides = {}) {
  return {
    deviceId: 'android-device', ownerKey: 'batch-owner-1', androidUiBackend: 'helper',
    workspaceRoot, stateRoot: stateRootA, claimRoot,
    runAdb: device.runAdb, requestPing: device.requestPing,
    randomToken: () => 'a'.repeat(64),
    ...overrides,
  };
}

(async () => {
  const disabled = fakeDevice();
  const notRequired = await acquireAndroidHelper(options(disabled, { androidUiBackend: 'uiautomator' }));
  assert.strictEqual(notRequired.status, 'NOT_REQUIRED');
  assert.strictEqual(notRequired.resource.androidHelper.backend, 'uiautomator');
  assert.strictEqual(disabled.state.calls.length, 0);

  const api29 = fakeDevice({ sdk: 29 });
  const api29Auto = await acquireAndroidHelper(options(api29, { androidUiBackend: 'auto' }));
  assert.strictEqual(api29Auto.status, 'NOT_REQUIRED');
  assert.strictEqual(api29Auto.resource.androidHelper.backend, 'uiautomator');
  assert.strictEqual(api29Auto.failureCode, 'ANDROID_HELPER_REQUIRES_API_30');
  assert.strictEqual(api29.state.calls.some((call) => call.args[0] === 'install'), false);
  const api29Strict = await acquireAndroidHelper(options(api29));
  assert.strictEqual(api29Strict.status, 'ACQUIRE_FAILED');

  const device = fakeDevice();
  const acquired = await acquireAndroidHelper(options(device));
  assert.strictEqual(acquired.ok, true);
  assert.strictEqual(acquired.status, 'ACTIVE');
  assert.strictEqual(acquired.ownership, 'FRAMEWORK_MANAGED');
  assert.strictEqual(acquired.resource.androidHelper.backend, 'helper');
  assert.strictEqual(JSON.stringify(acquired).includes('a'.repeat(64)), false);
  const sessionPath = acquired.resource.androidHelper.sessionStatePath;
  assert.strictEqual(fs.statSync(sessionPath).mode & 0o077, 0);
  const journal = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.strictEqual(journal.phase, 'ACTIVE');
  assert.strictEqual(journal.token, 'a'.repeat(64));
  assert.deepStrictEqual(device.state.services, [
    'existing.reader/.Service', 'com.artemis.helper/.ArtemisAccessibilityService',
  ]);
  assert.strictEqual(device.state.forwards.size, 1);
  assert.strictEqual(device.state.calls.some((call) => call.args.includes('a'.repeat(64))), false);
  assert.ok(device.state.calls.some((call) => call.args.at(-1) === 'shell'
    && call.stdin.includes('com.artemis.helper.SET_TOKEN')));

  const activeSession = await ensureAndroidHelperSession({
    sessionStatePath: sessionPath, kind: 'READ_ONLY', claimRoot,
    runAdb: device.runAdb, requestPing: device.requestPing,
  });
  assert.strictEqual(activeSession.token, 'a'.repeat(64));
  const forwardCount = device.state.calls.filter((call) => call.args.join(' ') === 'forward tcp:0 tcp:18888').length;
  const resumed = await acquireAndroidHelper(options(device));
  assert.strictEqual(resumed.status, 'ACTIVE');
  assert.strictEqual(device.state.calls.filter((call) => call.args.join(' ') === 'forward tcp:0 tcp:18888').length, forwardCount);

  let resolvedOwnerWorkspace = null;
  const contender = await acquireAndroidHelper(options(device, {
    ownerKey: 'batch-owner-2', stateRoot: stateRootB,
    workspaceRoot: path.join(root, 'other-workspace'),
    resolveOwnerStatus: (_ownerKey, ownerOptions) => {
      resolvedOwnerWorkspace = ownerOptions.workspaceRoot;
      return { status: 'ACTIVE', batchId: 'batch-owner-1' };
    },
  }));
  assert.strictEqual(contender.status, 'ACQUIRE_FAILED');
  assert.strictEqual(contender.failureCode, 'ANDROID_HELPER_IN_USE');
  assert.strictEqual(contender.retryable, true);
  assert.strictEqual(contender.diagnostic.recovery.kind, 'WAIT_OR_CANCEL_OWNER_BATCH');
  assert.strictEqual(resolvedOwnerWorkspace, workspaceRoot);

  const released = await releaseAndroidHelper({
    ...options(device), runtime: acquired,
  });
  assert.strictEqual(released.status, 'RELEASED');
  assert.strictEqual(device.state.token, '');
  assert.strictEqual(device.state.forwards.size, 0);
  assert.deepStrictEqual(device.state.services, ['existing.reader/.Service']);
  assert.strictEqual(device.state.accessibilityEnabled, '0');
  assert.strictEqual(fs.existsSync(sessionPath), false);
  assert.strictEqual((await releaseAndroidHelper({ ...options(device), runtime: acquired })).status, 'RELEASED');

  const interruptedDevice = fakeDevice({ installedVersion: 7 });
  interruptedDevice.state.forwards.set('41999', 'tcp:18888');
  const interruptedOptions = options(interruptedDevice, {
    ownerKey: 'batch-interrupted-forward', stateRoot: path.join(root, 'state-interrupted'),
  });
  const interruptedSessionPath = sessionStatePath(interruptedOptions);
  assert.strictEqual(claimAndroidHelperDevice({
    ...interruptedOptions, sessionStatePath: interruptedSessionPath,
  }).ok, true);
  writeJsonAtomic(interruptedSessionPath, {
    schemaVersion: 1,
    phase: 'FORWARD_INTENT',
    ownerKey: interruptedOptions.ownerKey,
    deviceId: interruptedOptions.deviceId,
    androidUserId: '0',
    transportId: '41',
    priorAccessibilityState: { enabled: '0', services: ['existing.reader/.Service'] },
    ownsServiceChange: false,
    localPort: null,
    ownsForward: false,
    token: null,
    forwardIntent: 'SESSION',
    forwardBaseline: [],
    generation: 1,
  });
  const recoveredAcquire = await acquireAndroidHelper(interruptedOptions);
  assert.strictEqual(recoveredAcquire.status, 'ACTIVE');
  assert.strictEqual(interruptedDevice.state.forwards.has('41999'), false);
  assert.strictEqual(interruptedDevice.state.forwards.size, 1);
  assert.strictEqual((await releaseAndroidHelper({
    ...interruptedOptions, runtime: recoveredAcquire,
  })).status, 'RELEASED');

  const releaseRetryDevice = fakeDevice({ installedVersion: 7 });
  const releaseRetryOptions = options(releaseRetryDevice, {
    ownerKey: 'batch-release-retry', stateRoot: path.join(root, 'state-release-retry'),
  });
  const releaseRetryRuntime = await acquireAndroidHelper(releaseRetryOptions);
  const releaseRetryJournal = JSON.parse(fs.readFileSync(
    releaseRetryRuntime.resource.androidHelper.sessionStatePath, 'utf8',
  ));
  releaseRetryDevice.state.failures.set(`forward --remove tcp:${releaseRetryJournal.localPort}`, 1);
  const firstRelease = await releaseAndroidHelper({ ...releaseRetryOptions, runtime: releaseRetryRuntime });
  assert.strictEqual(firstRelease.status, 'RELEASE_FAILED');
  assert.strictEqual(fs.existsSync(releaseRetryRuntime.resource.androidHelper.sessionStatePath), true);
  const secondRelease = await releaseAndroidHelper({ ...releaseRetryOptions, runtime: releaseRetryRuntime });
  assert.strictEqual(secondRelease.status, 'RELEASED');
  assert.strictEqual(releaseRetryDevice.state.forwards.size, 0);

  const external = fakeDevice({ externalToken: true, installedVersion: 7 });
  const externalAuto = await acquireAndroidHelper(options(external, { androidUiBackend: 'auto' }));
  assert.strictEqual(externalAuto.status, 'NOT_REQUIRED');
  assert.strictEqual(externalAuto.failureCode, 'ANDROID_HELPER_EXTERNAL_SESSION');
  assert.strictEqual(external.state.calls.some((call) => call.args[0] === 'install'), false);
  assert.strictEqual(external.state.calls.some((call) => call.args.join(' ') === 'shell'), false);

  const conflict = fakeDevice({ installFailure: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
  const conflictResult = await acquireAndroidHelper(options(conflict));
  assert.strictEqual(conflictResult.status, 'ACQUIRE_FAILED');
  assert.match(conflictResult.reason, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
  assert.strictEqual(conflict.state.calls.some((call) => call.args.includes('uninstall')), false);
  assert.strictEqual(conflict.state.forwards.size, 0);

  const insideWorkspace = await acquireAndroidHelper(options(fakeDevice(), {
    stateRoot: path.join(workspaceRoot, 'helper-state'),
  }));
  assert.strictEqual(insideWorkspace.status, 'ACQUIRE_FAILED');
  assert.strictEqual(insideWorkspace.failureCode, 'ANDROID_HELPER_STATE_DIR_INVALID');
  const broadStateRoot = path.join(root, 'state-broad');
  fs.mkdirSync(broadStateRoot, { mode: 0o755 });
  fs.chmodSync(broadStateRoot, 0o755);
  const broadState = await acquireAndroidHelper(options(fakeDevice(), { stateRoot: broadStateRoot }));
  assert.strictEqual(broadState.failureCode, 'ANDROID_HELPER_STATE_DIR_INVALID');
  const symlinkStateRoot = path.join(root, 'state-link');
  fs.symlinkSync(stateRootA, symlinkStateRoot);
  const symlinkState = await acquireAndroidHelper(options(fakeDevice(), { stateRoot: symlinkStateRoot }));
  assert.strictEqual(symlinkState.failureCode, 'ANDROID_HELPER_STATE_DIR_INVALID');

  const originalSpawnSync = childProcess.spawnSync;
  const runtimeCalls = [];
  try {
    childProcess.spawnSync = (command, args, spawnOptions) => {
      runtimeCalls.push({ command, args, env: spawnOptions.env });
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android',
          operation: args[args.indexOf('--operation') + 1], ok: true,
          status: 'NOT_REQUIRED', ownership: 'NONE', resource: { androidHelper: { backend: 'uiautomator' } },
        }),
        stderr: '',
      };
    };
    const adapter = createDeviceSessionAdapter();
    const binding = {
      platform: 'android', deviceId: 'android-device', appId: 'com.example',
      entry: '.MainActivity', androidUiBackend: 'uiautomator',
    };
    const runtime = adapter.acquirePlatformRuntime({
      binding, ownerKey: 'batch-owner-cli', workspaceRoot, batchId: 'batch-cli',
    });
    adapter.releasePlatformRuntime({ binding, ownerKey: 'batch-owner-cli', runtime, workspaceRoot });
    assert.strictEqual(runtimeCalls.length, 2);
    for (const call of runtimeCalls) {
      assert.ok(call.command.endsWith('/scripts/platform/runtime.sh'));
      assert.deepStrictEqual(call.args.slice(call.args.indexOf('--owner-key'), call.args.indexOf('--owner-key') + 2), [
        '--owner-key', 'batch-owner-cli',
      ]);
      assert.strictEqual(call.env.MAVT_ANDROID_HELPER_WORKSPACE_ROOT, workspaceRoot);
    }
    assert.ok(runtimeCalls[1].args.includes('--runtime-json'));
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('android helper runtime passed');
})().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
