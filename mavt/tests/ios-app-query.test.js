'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ios = require('../src/mobile-ai-visual-test/scripts/platform/adapters/ios/environment');
const { queryNativeAppInstallation, performIosReinstall } = require('../src/mobile-ai-visual-test/scripts/platform/adapters/ios/lib/ios-driver');

const device = '00008027-001120DE3A40402E';
const binding = { platform: 'ios', deviceId: device, deviceType: 'realDevice' };
const appId = 'com.example.app';
const ok = stdout => ({ ok: true, stdout, stderr: '' });
const fail = stderr => ({ ok: false, stdout: '', stderr });
const app = { CFBundleIdentifier: appId, CFBundleDisplayName: 'Example App', ApplicationType: 'User', CFBundleShortVersionString: '5.2.7', CFBundleVersion: '12' };

// Fakes stop at the process boundary. Unexpected commands never touch this host/device.
function legacyRunner(replies = [ok(JSON.stringify({ applications: { [appId]: app } }))]) {
  let legacyCalls = 0;
  let modernCalls = 0;
  const run = (command, args) => {
    if (command === 'xcrun') {
      assert.equal(args[0], 'devicectl');
      modernCalls += 1;
      return fail('No device matching the requested identifier was found. iOS 17+ required');
    }
    if (command === 'appium') {
      assert.deepEqual(args, ['driver', 'list', '--installed', '--json']);
      return ok(JSON.stringify({ xcuitest: { installed: true, installPath: '/offline/appium-xcuitest-driver' } }));
    }
    assert.equal(command, process.execPath);
    assert.match(args[0], /installation-proxy-query\.js$/);
    assert.deepEqual(args.slice(1, 5), ['--driver', '/offline/appium-xcuitest-driver', '--device', device]);
    legacyCalls += 1;
    assert.ok(replies.length, 'Unexpected repeated legacy query');
    return replies.shift();
  };
  run.counts = () => ({ legacyCalls, modernCalls });
  return run;
}

test('iPadOS 15 app selection succeeds when devicectl cannot see a connected device', () => {
  const run = legacyRunner();
  const result = ios.discoverApps({ binding }, { run });
  assert.equal(result.coverage, 'all');
  assert.deepEqual(result.apps, [{ id: appId, name: 'Example App', system: false }]);
  assert.ok(!result.diagnostics.some(item => item.level === 'ERROR'));
});

test('installation verification on old iOS preserves version and build using the same fallback', () => {
  const result = queryNativeAppInstallation({ device, appId, deviceType: 'realDevice' }, { run: legacyRunner() });
  assert.deepEqual(result, { status: 'INSTALLED', source: 'INSTALLATION_PROXY', identity: { appId, version: '5.2.7', build: '12' } });
});

test('an authoritative empty legacy lookup proves absence; failure and malformed data stay UNKNOWN', () => {
  for (const [reply, status] of [[ok('{"applications":{}}'), 'NOT_INSTALLED'], [fail('Device is locked'), 'UNKNOWN'], [ok('{"applications":[]}'), 'UNKNOWN'], [ok('{"applications":{"com.example.app":{"CFBundleIdentifier":"com.other.app"}}}'), 'UNKNOWN']]) {
    const result = queryNativeAppInstallation({ device, appId, deviceType: 'realDevice' }, { run: legacyRunner([reply]) });
    assert.equal(result.status, status);
    if (status === 'UNKNOWN') assert.ok(result.detail);
  }
});

test('discovery does not claim complete scope when legacy records are malformed', () => {
  const result = ios.discoverApps({ binding }, { run: legacyRunner([ok(JSON.stringify({ applications: { [appId]: app, broken: { CFBundleDisplayName: 'broken' } } }))]) });
  assert.equal(result.coverage, 'limited');
  assert.equal(result.apps.length, 1);
});

test('reinstall uses fresh legacy state on each poll without repeating incompatible devicectl', async () => {
  const run = legacyRunner([
    ok(JSON.stringify({ applications: { [appId]: app } })),
    ok('{"applications":{}}'),
    ok(JSON.stringify({ applications: { [appId]: { ...app, CFBundleVersion: '13' } } })),
  ]);
  const effects = [];
  const result = await performIosReinstall({ device, appId, deviceType: 'realDevice', appiumServer: 'http://offline' }, 'maintenance', '/tmp/app.ipa', {
    queryInstallation: target => queryNativeAppInstallation(target, { run }),
    appiumClient: { request: async (_server, _method, endpoint) => { effects.push(endpoint); } },
    sleep: async () => {}, timeoutMs: 1000,
  });
  assert.equal(result.identity.build, '13');
  assert.deepEqual(effects, ['/session/maintenance/appium/device/remove_app', '/session/maintenance/appium/device/install_app']);
  assert.deepEqual(run.counts(), { legacyCalls: 3, modernCalls: 1 });
});

test('modern devices keep the single devicectl query without loading a legacy driver', () => {
  let calls = 0;
  const result = queryNativeAppInstallation({ device, appId, deviceType: 'realDevice' }, {
    run: (command, args) => {
      calls += 1;
      assert.equal(command, 'xcrun');
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { apps: [{ bundleIdentifier: appId, version: '5.2.7', bundleVersion: '12' }] } }));
      return ok('');
    },
  });
  assert.equal(result.status, 'INSTALLED');
  assert.equal(result.source, 'DEVICECTL');
  assert.equal(calls, 1);
});

test('legacy helper reads only requested metadata and closes the connection on success and error', async () => {
  // Run the actual helper against a local driver dependency double, never a USB service.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-installation-proxy-test-'));
  try {
    const moduleRoot = path.join(temp, 'node_modules/appium-ios-device');
    fs.mkdirSync(moduleRoot, { recursive: true });
    fs.writeFileSync(path.join(temp, 'package.json'), '{"name":"offline-driver"}');
    fs.writeFileSync(path.join(moduleRoot, 'index.js'), `
      const fs = require('node:fs');
      module.exports.services = { startInstallationProxyService: async udid => {
        if (udid !== '${device}') throw new Error('wrong target');
        return {
          listApplications: async opts => {
            if (opts.applicationType !== 'Any') throw new Error('wrong scope');
            return { '${appId}': ${JSON.stringify(app)} };
          },
          lookupApplications: async opts => {
            if (JSON.stringify(opts.bundleIds) !== '["${appId}"]') throw new Error('wrong app');
            if (process.env.OFFLINE_QUERY_FAIL) throw new Error('Device is locked');
            return { '${appId}': ${JSON.stringify(app)} };
          },
          close: () => fs.writeFileSync(${JSON.stringify(path.join(temp, 'closed'))}, 'closed'),
        };
      } };
    `);
    const helper = path.resolve(__dirname, '../src/mobile-ai-visual-test/scripts/platform/adapters/ios/lib/installation-proxy-query.js');
    for (const extra of [[], ['--app', appId]]) {
      const result = spawnSync(process.execPath, [helper, '--driver', temp, '--device', device, ...extra], { encoding: 'utf8', env: { ...process.env, OFFLINE_QUERY_FAIL: '' } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).applications[appId].CFBundleVersion, '12');
      assert.equal(fs.readFileSync(path.join(temp, 'closed'), 'utf8'), 'closed');
      fs.unlinkSync(path.join(temp, 'closed'));
    }
    const failure = spawnSync(process.execPath, [helper, '--driver', temp, '--device', device, '--app', appId], { encoding: 'utf8', env: { ...process.env, OFFLINE_QUERY_FAIL: '1' } });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Device is locked/);
    assert.equal(failure.stdout, '');
    assert.equal(fs.readFileSync(path.join(temp, 'closed'), 'utf8'), 'closed');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
