'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveEnvironment, prepareEnvironment } = require('../src/mobile-ai-visual-test/scripts/platform/environment/setup');

const binding = { platform: 'android', deviceId: 'device-1' };
function ports(apps, extra = {}) {
  return { adapter: {
    discoverApps: () => ({ apps, coverage: 'user', diagnostics: [] }),
    resolve: ({ binding: selected }) => ({ status: 'READY', binding: { ...selected, entry: '.Main' } }),
    prepare: () => ({ schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true }),
    ...extra,
  } };
}
const apps = [{ id: 'com.one', name: '学习' }, { id: 'com.two', name: '学习' }, { id: 'com.other', name: '其它' }];

test('without target returns named user Apps and never uses foreground app', () => {
  const result = resolveEnvironment({ binding }, ports([...apps, { id: 'com.helper', name: 'helper', helper: true }]));
  assert.equal(result.status, 'NEED_SELECTION');
  assert.equal(result.selectionKind, 'APP');
  assert.deepEqual(result.candidates.map(c => c.id), ['com.one', 'com.two', 'com.other']);
  assert.equal(result.coverage, 'user');
});
test('exact ID wins over a conflicting name and entry is resolved automatically', () => {
  const result = resolveEnvironment({ binding: { ...binding, appId: 'com.other' }, appName: '学习' }, ports(apps));
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.appId, 'com.other');
  assert.equal(result.binding.entry, '.Main');
});
test('duplicate names require selection, including case-insensitive matches', () => {
  const result = resolveEnvironment({ binding, appName: '学习' }, ports(apps));
  assert.equal(result.status, 'NEED_SELECTION');
  assert.deepEqual(result.candidates.map(c => c.id), ['com.one', 'com.two']);
});
test('missing exact target does not silently substitute a different app', () => {
  const result = resolveEnvironment({ binding: { ...binding, appId: 'com.missing' } }, ports(apps));
  assert.equal(result.status, 'NEED_USER_ACTION');
  assert.match(result.actions[0].message, /com.missing/);
});
test('limited discovery allows explicit target only after adapter validation', () => {
  let validated = null;
  const options = ports([], {
    canValidateAppWithoutInventory: true,
    discoverApps: () => ({ apps: [], coverage: 'limited', diagnostics: [{ code: 'LIST_UNSUPPORTED' }] }),
    resolve: ({ binding: candidate }) => { validated = candidate; return { status: 'READY', binding: { ...candidate, entry: '.Main' } }; },
  });
  assert.equal(resolveEnvironment({ binding }, options).allowTargetInput, true);
  assert.equal(resolveEnvironment({ binding: { ...binding, appId: 'com.explicit' } }, options).status, 'READY');
  assert.equal(validated.appId, 'com.explicit');
});
test('reused binding always revalidates entry through adapter; errors remain failures', () => {
  const previousBinding = { ...binding, appId: 'com.one', entry: '.Stale' };
  const result = resolveEnvironment({ binding: previousBinding, previousBinding }, ports(apps));
  assert.equal(result.binding.entry, '.Main');
  const failed = resolveEnvironment({ binding }, ports(apps, { discoverApps: () => { throw new Error('offline'); } }));
  assert.equal(failed.status, 'FAILED');
  assert.ok(failed.diagnostics.length);
});
test('adapter must keep selected platform device and app; unsupported statuses fail closed', () => {
  for (const resolved of [{ status: 'READY', binding: { ...binding, appId: 'com.two', entry: '.Main' } }, { status: 'SUCCESS' }]) {
    const result = resolveEnvironment({ binding: { ...binding, appId: 'com.one' } }, ports(apps, { resolve: () => resolved }));
    assert.equal(result.status, 'FAILED');
  }
});
test('preparation uses same adapter contract for every platform and no implicit runtime bootstrap', () => {
  const result = prepareEnvironment({ binding }, ports(apps));
  assert.equal(result.ok, true);
  assert.equal(result.type, 'environmentPrepare');
});
test('user inventory cannot prove an explicitly requested system app is absent', () => {
  const options = ports(apps, { canValidateAppWithoutInventory: true });
  const result = resolveEnvironment({ binding: { ...binding, appId: 'com.android.settings' } }, options);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.appId, 'com.android.settings');
});
test('failed inventory still publishes precise-target fallback when adapter can validate it', () => {
  const result = resolveEnvironment({ binding }, ports([], { canValidateAppWithoutInventory: true,
    discoverApps: () => ({ apps: [], coverage: 'limited', diagnostics: [{ level: 'ERROR', message: 'list unsupported' }] }),
  }));
  assert.equal(result.status, 'NEED_SELECTION');
  assert.equal(result.allowTargetInput, true);
  assert.equal(result.selectionKind, 'APP');
});
test('partial inventory cannot invent an app when adapter only validates configuration', () => {
  const result = resolveEnvironment({ binding: { ...binding, appId: 'com.uninstalled' } }, ports([], {
    discoverApps: () => ({ apps: [], coverage: 'limited', diagnostics: [{ level: 'WARN', message: 'partial' }] }),
    resolve: () => { throw new Error('unverified app must never reach signing-only resolver'); },
  }));
  assert.equal(result.status, 'NEED_USER_ACTION');
});
test('Harmony device discovery uses connected hdc targets when devecocli metadata is absent or stale', () => {
  const { connectedDeviceProfiles } = require('../src/mobile-ai-visual-test/scripts/platform/adapters/harmony/lib/display-state');
  assert.deepEqual(connectedDeviceProfiles('device-1\ndevice-2\n', [{ id: 'device-1', name: '测试手机' }, { id: 'offline' }]),
    [{ id: 'device-1', name: '测试手机' }, { id: 'device-2', serial: 'device-2', name: 'device-2' }]);
  assert.deepEqual(connectedDeviceProfiles('[Empty]\n', []), []);
});
test('historical retry only resets adapter-owned discovery fields, preserving runtime preferences', () => {
  const { resetBindingForRetry } = require('../src/mobile-ai-visual-test/scripts/platform/environment/setup');
  assert.deepEqual(resetBindingForRetry({ platform: 'android', deviceId: 'device', appId: 'com.one', entry: 'Old', androidUiBackend: 'helper' }),
    { platform: 'android', deviceId: 'device', appId: 'com.one', androidUiBackend: 'helper' });
  const reset = resetBindingForRetry({ platform: 'ios', deviceId: 'device', deviceType: 'realDevice', appId: 'com.one',
    appiumServer: 'http://localhost:4725', webDriverAgentUrl: 'http://localhost:8105', wdaLocalPort: 8105,
    xcodeOrgId: 'OLD', xcodeSigningId: 'Old', updatedWDABundleId: 'com.old.wda' });
  assert.equal(reset.webDriverAgentUrl, 'http://localhost:8105');
  assert.equal(reset.appiumServer, 'http://localhost:4725');
  assert.equal(reset.wdaLocalPort, 8105);
  assert.equal(reset.xcodeOrgId, undefined);
  const current = { platform: 'ios', deviceId: 'device', deviceType: 'realDevice', appId: 'com.one',
    xcodeOrgId: 'TEAM', xcodeSigningId: 'Identity', updatedWDABundleId: 'com.wda', webDriverAgentUrl: 'http://localhost:8105' };
  assert.deepEqual(resetBindingForRetry(current, {}, { diagnostics: [{ id: 'iosAppsUnavailable' }] }), current);
});
