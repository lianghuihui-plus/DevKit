'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ios = require('../src/mobile-ai-visual-test/scripts/platform/adapters/ios/environment');

const simulator = { platform: 'ios', deviceId: 'SIMULATOR-1', deviceType: 'simulator', appId: 'com.example.app' };
const real = { ...simulator, deviceId: '00008110-000A12341234001E', deviceType: 'realDevice' };
const cert = Buffer.from('offline development certificate');
const fingerprint = createHash('sha1').update(cert).digest('hex').toUpperCase();
const identityName = 'Apple Development: Alice Example (TEAMONE123)';
const identities = `  1) ${fingerprint} "${identityName}"\n     1 valid identities found\n`;
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0 });
const failed = (stderr) => ({ ok: false, stdout: '', stderr, code: 1 });
const profile = (overrides = {}) => ({
  UUID: 'profile-one', Name: 'MAVT Development', TeamName: 'Example Team', TeamIdentifier: ['TEAMONE123'],
  ExpirationDate: '2030-01-01T00:00:00Z', Platform: ['iOS'], ProvisionedDevices: [real.deviceId],
  DeveloperCertificates: [cert.toString('base64')],
  Entitlements: { 'application-identifier': 'TEAMONE123.com.example.*', 'com.apple.developer.team-identifier': 'TEAMONE123', 'get-task-allow': true },
  ...overrides,
});

// Every command must be declared: these tests cannot silently reach a host tool or device.
function runner(steps) {
  const remaining = [...steps];
  const run = (command, args, options) => {
    const next = remaining.shift();
    assert.ok(next, `Unexpected command: ${command} ${args.join(' ')}`);
    assert.equal(command, next.command);
    if (next.args) assert.deepEqual(args, next.args);
    return next.handle ? next.handle(args, options) : next.result;
  };
  run.done = () => assert.equal(remaining.length, 0, 'Expected all fixture commands to run');
  return run;
}

function signingOptions(profiles = [profile()], identityOutput = identities) {
  const run = runner([{ command: 'security', args: ['find-identity', '-v', '-p', 'codesigning'], result: ok(identityOutput) }]);
  return { profiles, run, env: {}, now: new Date('2026-10-23T00:00:00Z') };
}

test('existing explicit iOS fake mode never runs a host or device command', () => {
  const options = { env: { MAVT_IOS_FAKE: '1' }, run: runner([]) };
  const discovery = ios.discoverApps({ binding: simulator }, options);
  assert.equal(discovery.apps[0].id, simulator.appId);
  assert.equal(discovery.coverage, 'limited');
  assert.equal(ios.resolve({ binding: simulator }, options).status, 'READY');
  assert.equal(ios.prepare({ binding: simulator }, options).ok, true);
  options.run.done();
});

test('iOS probe assessment ignores only resolvable real-device signing errors', () => {
  const signing = { id: 'iosRealDeviceSigningIncomplete', level: 'ERROR', message: 'missing signing' };
  assert.equal(ios.assessProbe({ ready: false, diagnostics: [signing] }, real), null);
  assert.equal(ios.assessProbe({ ready: true, diagnostics: [] }, simulator), null);
  const missingDriver = ios.assessProbe({ ready: false, diagnostics: [signing, { id: 'iosXcuitestDriverMissing', level: 'ERROR' }] }, real);
  assert.equal(missingDriver.status, 'NEED_USER_ACTION');
  assert.match(missingDriver.actions[0].message, /appium driver install xcuitest/);
  assert.equal(ios.assessProbe({ ready: false, diagnostics: [] }, simulator).status, 'NEED_USER_ACTION');
  assert.equal(ios.assessProbe({ ready: true, diagnostics: [{ id: 'unexpected', level: 'ERROR' }] }, simulator).status, 'NEED_USER_ACTION');
  assert.equal(ios.assessProbe({ ready: false, diagnostics: [signing] }, simulator).status, 'NEED_USER_ACTION');
});

test('iOS simulator discovery converts simctl plist and preserves scope and system metadata', async () => {
  const plist = '{ "com.example.app" = { CFBundleDisplayName = "Example App"; }; }';
  const run = runner([
    { command: 'xcrun', args: ['simctl', 'listapps', simulator.deviceId], result: ok(plist) },
    { command: 'plutil', args: ['-convert', 'json', '-o', '-', '-'], handle: (_args, options) => {
      assert.equal(options.input, plist);
      return ok(JSON.stringify({ 'com.example.app': { CFBundleIdentifier: 'com.example.app', CFBundleDisplayName: 'Example App', ApplicationType: 'User' }, 'com.apple.Preferences': { CFBundleName: 'Settings', ApplicationType: 'System' } }));
    } },
  ]);
  const result = await ios.discoverApps({ binding: simulator }, { run });
  assert.equal(result.coverage, 'all');
  assert.deepEqual(result.apps.map(({ id, name, system }) => ({ id, name, system })), [
    { id: 'com.apple.Preferences', name: 'Settings', system: true },
    { id: 'com.example.app', name: 'Example App', system: false },
  ]);
  run.done();
});

test('real device discovery reads devicectl JSON file and requests all apps', async () => {
  let outputDir;
  const run = runner([{ command: 'xcrun', handle: (args) => {
    assert.deepEqual(args.slice(0, 8), ['devicectl', 'device', 'info', 'apps', '--device', real.deviceId, '--include-all-apps', '--timeout']);
    const output = args[args.indexOf('--json-output') + 1];
    outputDir = path.dirname(output);
    fs.writeFileSync(output, JSON.stringify({ info: { outcome: 'success' }, result: { apps: [{ bundleIdentifier: real.appId, name: 'Example', isSystem: false }] } }));
    return ok('human readable log');
  } }]);
  const result = await ios.discoverApps({ binding: real }, { run });
  assert.equal(result.coverage, 'all');
  assert.equal(result.apps[0].id, real.appId);
  assert.equal(fs.existsSync(outputDir), false);
  run.done();
});

test('discovery reports command failure and unrecognized output honestly', async () => {
  for (const output of [failed('device is locked'), ok('{"result":{"unexpected":[]}}')]) {
    const run = runner([{ command: 'xcrun', result: output }, { command: 'appium', result: failed('XCUITest driver metadata unavailable') }]);
    const result = await ios.discoverApps({ binding: real }, { run });
    assert.equal(result.coverage, 'limited');
    assert.deepEqual(result.apps, []);
    assert.ok(result.diagnostics.some((item) => item.level === 'ERROR'));
    run.done();
  }
});

test('partial enumeration retains valid apps but marks malformed records as limited coverage', async () => {
  const run = runner([{ command: 'xcrun', result: ok(JSON.stringify({ result: { apps: [{ bundleIdentifier: real.appId, name: 'Example' }, { name: 'Broken' }] } })) }]);
  const result = await ios.discoverApps({ binding: real }, { run });
  assert.equal(result.coverage, 'limited');
  assert.equal(result.apps.length, 1);
  assert.ok(result.diagnostics.some((item) => item.level === 'WARN'));
  run.done();
});

test('discovery marks WDA and custom frozen WDA identifiers as automation helpers', () => {
  const ids = ['com.facebook.WebDriverAgentRunner', 'com.example.WebDriverAgentRunner.xctrunner', 'com.example.customWDA', real.appId];
  const run = runner([{ command: 'xcrun', result: ok(JSON.stringify({ result: { apps: ids.map((id) => ({ bundleIdentifier: id, name: id })) } })) }]);
  const result = ios.discoverApps({ binding: { ...real, updatedWDABundleId: 'com.example.customWDA' } }, { run });
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result.apps.filter((app) => app.helper).map((app) => app.id).sort(), ids.slice(0, 3).sort());
  assert.equal(result.apps.find((app) => app.id === real.appId).helper, undefined);
  run.done();
});

test('simulator resolution bypasses signing without calling commands', async () => {
  const run = runner([]);
  const result = ios.resolve({ binding: simulator }, { run, env: {} });
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, { status: 'READY', binding: simulator });
  run.done();
});

test('one usable team derives WDA bundle from matching wildcard profile and private key identity', async () => {
  const options = signingOptions();
  const result = await ios.resolve({ binding: real }, options);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.xcodeOrgId, 'TEAMONE123');
  assert.equal(result.binding.xcodeSigningId, 'Apple Development');
  assert.equal(result.binding.updatedWDABundleId, 'com.example.mavt.WebDriverAgentRunner');
  options.run.done();
});

test('legacy App ID Prefix is independent of Team ID for wildcard and explicit WDA profiles', () => {
  for (const [pattern, bundle] of [
    ['com.example.*', 'com.example.mavt.WebDriverAgentRunner'],
    ['com.example.exactWDA.xctrunner', 'com.example.exactWDA'],
  ]) {
    const candidate = profile({
      ApplicationIdentifierPrefix: ['OLD1234567'],
      Entitlements: { 'application-identifier': `OLD1234567.${pattern}`, 'com.apple.developer.team-identifier': 'TEAMONE123', 'get-task-allow': true },
    });
    for (const binding of [real, { ...real, xcodeOrgId: 'TEAMONE123', updatedWDABundleId: bundle }]) {
      const result = ios.resolve({ binding }, signingOptions([candidate]));
      assert.equal(result.status, 'READY', JSON.stringify(result));
      assert.equal(result.binding.xcodeOrgId, 'TEAMONE123');
      assert.equal(result.binding.updatedWDABundleId, bundle);
    }
    const wrongTeam = ios.resolve({ binding: { ...real, xcodeOrgId: 'OLD1234567' } }, signingOptions([candidate]));
    assert.equal(wrongTeam.status, 'NEED_USER_ACTION');
  }
});

test('declared App ID Prefix must match the application identifier even when Team ID matches', () => {
  const result = ios.resolve({ binding: real }, signingOptions([profile({ ApplicationIdentifierPrefix: ['OLD1234567'] })]));
  assert.equal(result.status, 'NEED_USER_ACTION');
});

test('multiple teams return named choices and only a published option resolves', async () => {
  const secondCert = Buffer.from('second certificate');
  const secondFingerprint = createHash('sha1').update(secondCert).digest('hex').toUpperCase();
  const second = profile({ UUID: 'second-profile', TeamName: 'Second Team', TeamIdentifier: ['TEAMTWO123'], DeveloperCertificates: [secondCert.toString('base64')], Entitlements: { 'application-identifier': 'TEAMTWO123.com.second.*', 'com.apple.developer.team-identifier': 'TEAMTWO123', 'get-task-allow': true } });
  const output = `${identities}  2) ${secondFingerprint} "Apple Development: Bob Example (TEAMTWO123)"\n`;
  const result = await ios.resolve({ binding: real }, signingOptions([profile(), second], output));
  assert.equal(result.status, 'NEED_SELECTION');
  assert.equal(result.selectionKind, 'signing');
  assert.equal(result.candidates.length, 2);
  assert.match(result.candidates[0].label, /Example Team/);
  const selected = await ios.resolve({ binding: real, optionId: result.candidates[1].id }, signingOptions([profile(), second], output));
  assert.equal(selected.status, 'READY');
  assert.equal(selected.binding.xcodeOrgId, 'TEAMTWO123');
  const rejected = await ios.resolve({ binding: real, optionId: 'forged' }, signingOptions([profile(), second], output));
  assert.equal(rejected.status, 'FAILED');
});

test('explicit signing is preserved only when identity, team, WDA bundle and profile are valid', async () => {
  const binding = { ...real, xcodeOrgId: 'TEAMONE123', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.myWDA' };
  const result = await ios.resolve({ binding }, signingOptions());
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.xcodeSigningId, 'Apple Development');
  assert.equal(result.binding.updatedWDABundleId, binding.updatedWDABundleId);
  const invalid = await ios.resolve({ binding: { ...binding, updatedWDABundleId: 'com.unrelated.WDA' } }, signingOptions());
  assert.equal(invalid.status, 'NEED_USER_ACTION');
  assert.match(invalid.actions[0].message, /Xcode/);
});

test('full certificate names and hashes are verified then normalized for automatic signing', () => {
  for (const signingId of [identityName, fingerprint]) {
    const result = ios.resolve({ binding: { ...real, xcodeSigningId: signingId } }, signingOptions());
    assert.equal(result.status, 'READY');
    assert.equal(result.binding.xcodeSigningId, 'Apple Development');
  }
  assert.equal(ios.resolve({ binding: { ...real, xcodeSigningId: 'Apple Development: Someone Else' } }, signingOptions()).status, 'NEED_USER_ACTION');
});

test('documented signing environment preferences are validated with explicit binding taking precedence', () => {
  const env = { MAVT_IOS_XCODE_ORG_ID: 'TEAMONE123', MAVT_IOS_XCODE_SIGNING_ID: 'Apple Development', MAVT_IOS_UPDATED_WDA_BUNDLE_ID: 'com.example.configuredWDA' };
  const result = ios.resolve({ binding: real }, { ...signingOptions(), env });
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.xcodeSigningId, env.MAVT_IOS_XCODE_SIGNING_ID);
  assert.equal(result.binding.updatedWDABundleId, env.MAVT_IOS_UPDATED_WDA_BUNDLE_ID);
  const stale = ios.resolve({ binding: real }, { ...signingOptions(), env: { ...env, MAVT_IOS_XCODE_ORG_ID: 'STALETEAM' } });
  assert.equal(stale.status, 'NEED_USER_ACTION');
  const explicit = ios.resolve({ binding: { ...real, xcodeOrgId: 'TEAMONE123' } }, { ...signingOptions(), env: { MAVT_IOS_XCODE_ORG_ID: 'STALETEAM' } });
  assert.equal(explicit.status, 'READY');
});

test('stale previous signing is revalidated against available certificates and provisioning', async () => {
  const result = await ios.resolve({ binding: real, previousBinding: { ...real, xcodeOrgId: 'DELETEDTEAM', xcodeSigningId: identityName, updatedWDABundleId: 'com.old.WDA' } }, signingOptions());
  assert.equal(result.status, 'NEED_USER_ACTION');
});

test('simulator resolution preserves explicitly configured external WDA without acquiring a runtime', () => {
  const run = runner([]);
  const binding = { ...simulator, webDriverAgentUrl: 'http://127.0.0.1:8100' };
  const result = ios.resolve({ binding }, { run, env: {} });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.binding, binding);
  run.done();
});

test('external WDA environment preference is frozen in binding with explicit binding precedence', () => {
  const run = runner([]);
  const env = { MAVT_IOS_WDA_URL: 'http://127.0.0.1:8101' };
  const configured = ios.resolve({ binding: simulator }, { run, env });
  assert.equal(configured.status, 'READY');
  assert.equal(configured.binding.webDriverAgentUrl, env.MAVT_IOS_WDA_URL);
  const explicit = ios.resolve({ binding: { ...simulator, webDriverAgentUrl: 'http://127.0.0.1:8102' } }, { run, env });
  assert.equal(explicit.binding.webDriverAgentUrl, 'http://127.0.0.1:8102');
  run.done();
});

test('real-device external WDA preserves the URL while requiring normal signing validation', () => {
  const binding = { ...real, webDriverAgentUrl: 'http://127.0.0.1:8100' };
  const unsigned = ios.resolve({ binding }, signingOptions([], '     0 valid identities found\n'));
  assert.equal(unsigned.status, 'NEED_USER_ACTION');
  assert.equal(unsigned.diagnostics[0].id, 'iosSigningIdentityMissing');
  const signed = ios.resolve({ binding }, signingOptions());
  assert.equal(signed.status, 'READY');
  assert.equal(signed.binding.webDriverAgentUrl, binding.webDriverAgentUrl);
  assert.equal(signed.binding.xcodeOrgId, 'TEAMONE123');
});

test('expired, wrong-device, wrong-team, distribution and missing-private-key profiles cannot sign WDA', async () => {
  const unusable = [
    profile({ ExpirationDate: '2020-01-01T00:00:00Z' }),
    profile({ ProvisionedDevices: ['OTHER-DEVICE'] }),
    profile({ Entitlements: { 'application-identifier': 'OTHERTEAM.com.example.*', 'get-task-allow': true } }),
    profile({ Entitlements: { 'application-identifier': 'TEAMONE123.com.example.*', 'get-task-allow': false } }),
    profile({ DeveloperCertificates: [Buffer.from('unavailable private key').toString('base64')] }),
  ];
  for (const candidate of unusable) {
    const result = await ios.resolve({ binding: real }, signingOptions([candidate]));
    assert.equal(result.status, 'NEED_USER_ACTION');
    assert.match(result.actions[0].message, /Xcode/);
  }
});

test('explicit profile bundle is accepted directly and a unique team chooses its newest usable profile', async () => {
  const explicit = profile({ Entitlements: { 'application-identifier': 'TEAMONE123.com.example.exactWDA.xctrunner', 'get-task-allow': true } });
  const result = await ios.resolve({ binding: real }, signingOptions([profile({ ExpirationDate: '2027-01-01T00:00:00Z' }), explicit]));
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.updatedWDABundleId, 'com.example.exactWDA');
});

test('an explicit profile for the unsuffixed test bundle cannot sign the installed WDA runner', async () => {
  const explicit = profile({ Entitlements: { 'application-identifier': 'TEAMONE123.com.example.exactWDA', 'get-task-allow': true } });
  const result = ios.resolve({ binding: real }, signingOptions([explicit]));
  assert.equal(result.status, 'NEED_USER_ACTION');
});

test('no signing identities yields a concrete Xcode account and device setup action', async () => {
  const result = await ios.resolve({ binding: real }, signingOptions([], '     0 valid identities found\n'));
  assert.equal(result.status, 'NEED_USER_ACTION');
  assert.match(result.actions[0].message, /Xcode/);
  assert.doesNotMatch(result.actions[0].message, /填写.*(Team ID|Signing ID|bundle id)/i);
});

test('profile files are decoded through injected security CMS runner using real XML plist data', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-profile-test-'));
  const profilePath = path.join(temp, 'fixture.mobileprovision');
  fs.writeFileSync(profilePath, 'offline encrypted profile fixture');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
    <key>UUID</key><string>xml-profile</string><key>Name</key><string>Alice &amp; Example Development</string>
    <key>TeamIdentifier</key><array><string>TEAMONE123</string></array>
    <key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
    <key>ProvisionedDevices</key><array><string>${real.deviceId}</string></array>
    <key>DeveloperCertificates</key><array><data>${cert.toString('base64')}</data></array>
    <key>Entitlements</key><dict><key>application-identifier</key><string>TEAMONE123.com.example.*</string><key>get-task-allow</key><true/></dict>
  </dict></plist>`;
  const run = runner([
    { command: 'security', args: ['find-identity', '-v', '-p', 'codesigning'], result: ok(identities) },
    { command: 'security', args: ['cms', '-D', '-i', profilePath], result: ok(xml) },
  ]);
  try {
    const result = await ios.resolve({ binding: real }, { run, env: {}, profilePaths: [profilePath], now: new Date('2026-10-23T00:00:00Z') });
    assert.equal(result.status, 'READY');
    run.done();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('prepare validates dependencies without launching Appium or WDA or making a session', async () => {
  const run = runner([
    { command: 'xcodebuild', args: ['-version'], result: ok('Xcode 16.4\nBuild version 16F6') },
    { command: 'xcrun', args: ['--find', 'simctl'], result: ok('/Applications/Xcode.app/Contents/Developer/usr/bin/simctl') },
    { command: 'appium', args: ['-v'], result: ok('3.0.0') },
    { command: 'appium', args: ['driver', 'list', '--installed', '--json'], result: ok('{"xcuitest":{"installed":true,"version":"10.0.0"}}') },
  ]);
  const result = ios.prepare({ binding: simulator }, { run, env: {} });
  assert.equal(result instanceof Promise, false);
  assert.equal(result.type, 'environmentPrepare');
  assert.equal(result.platform, 'ios');
  assert.equal(result.ok, true);
  assert.ok(result.dependencies.every((item) => item.ok));
  run.done();
});

test('prepare fails closed on malformed driver output and missing Xcode', async () => {
  const run = runner([
    { command: 'xcodebuild', result: failed('xcodebuild missing') },
    { command: 'xcrun', result: ok('/usr/bin/simctl') },
    { command: 'appium', result: ok('3.0.0') },
    { command: 'appium', result: ok('xcuitest appears installed somewhere') },
  ]);
  const result = await ios.prepare({ binding: simulator }, { run, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.dependencies.find((item) => item.id === 'xcuitestDriver').ok, false);
  run.done();
});

test('real-device preparation revalidates frozen signing and refuses an unfrozen discovered replacement', () => {
  const steps = () => [
    { command: 'xcodebuild', args: ['-version'], result: ok('Xcode 14.3.1') },
    { command: 'xcrun', args: ['--find', 'xcdevice'], result: ok('/usr/bin/xcdevice') },
    { command: 'appium', args: ['-v'], result: ok('3.0.0') },
    { command: 'appium', args: ['driver', 'list', '--installed', '--json'], result: ok('{"xcuitest":{"installed":true}}') },
    { command: 'security', args: ['find-identity', '-v', '-p', 'codesigning'], result: ok(identities) },
  ];
  const binding = { ...real, xcodeOrgId: 'TEAMONE123', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.myWDA' };
  for (const [target, expected] of [[binding, true], [real, false]]) {
    const run = runner(steps());
    const result = ios.prepare({ binding: target }, { ...signingOptions(), run });
    assert.equal(result.ok, expected);
    run.done();
  }
});
