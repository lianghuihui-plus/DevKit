'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const android = require('../src/mobile-ai-visual-test/scripts/platform/adapters/android/environment');
const harmony = require('../src/mobile-ai-visual-test/scripts/platform/adapters/harmony/environment');

function runner(expected) {
  const pending = [...expected];
  const run = (command, args) => {
    const item = pending.shift();
    assert.ok(item, `Unexpected command: ${command} ${args.join(' ')}`);
    assert.equal(command, item[0]);
    assert.deepEqual(args, item[1]);
    return typeof item[2] === 'string' ? { ok: true, stdout: item[2], stderr: '', code: 0 } : item[2];
  };
  return { run, done: () => assert.equal(pending.length, 0, 'Expected commands were not executed') };
}
const androidBinding = { platform: 'android', deviceId: 'pixel-1', appId: 'com.example.reader' };
const harmonyBinding = { platform: 'harmony', deviceId: 'harmony-1', appId: 'com.example.reader' };
const androidResolve = ['-s', 'pixel-1', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', 'com.example.reader'];
const androidQuery = androidResolve.map(value => value === 'resolve-activity' ? 'query-activities' : value);
const androidResolver = 'priority=0 preferredOrder=0 match=0x0 specificIndex=-1 isDefault=false\nandroid/com.android.internal.app.ResolverActivity\n';
const androidLaunchers = '2 activities found:\n  Activity #0:\n    com.example.reader/.MainActivity\n  Activity #1:\n    com.example.reader/leakcanary.internal.activity.LeakLauncherActivity\n';
const harmonyDump = ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.example.reader'];
const homeSkill = { actions: ['ohos.want.action.home'], entities: ['entity.system.home'] };
function bundle(abilities, extras = {}) {
  return `com.example.reader:\n${JSON.stringify({ name: 'com.example.reader', applicationInfo: { label: 'Reader', isSystemApp: false }, hapModuleInfos: [{ name: 'entry', abilityInfos: abilities }], ...extras })}`;
}
const ability = (name, extras = {}) => ({ name, label: name === 'MainAbility' ? 'Reader' : 'Reader Work', visible: true, type: 'page', skills: [homeSkill], ...extras });

for (const [platform, adapter, binding] of [['Android', android, androidBinding], ['Harmony', harmony, harmonyBinding]]) {
  test(`${platform} probe permits ready and confirmationReady without errors synchronously`, () => {
    assert.equal(adapter.assessProbe({ ready: true, diagnostics: [] }, binding), null);
    assert.equal(adapter.assessProbe({ ready: false, confirmationReady: true, diagnostics: [{ level: 'WARN', message: 'Optional sample unavailable' }] }, binding), null);
  });
  test(`${platform} probe blocks failed capability checks with a human action`, () => {
    const diagnostics = [{ id: 'screenshotUnavailable', level: 'ERROR', message: '截图能力不可用', howToFix: 'technical parameter' }];
    const result = adapter.assessProbe({ ready: false, diagnostics }, binding);
    assert.equal(result.status, 'NEED_USER_ACTION');
    assert.deepEqual(result.diagnostics, diagnostics);
    assert.ok(result.actions[0].message.includes('重试'));
    assert.doesNotMatch(result.actions[0].message, /androidUiBackend|Activity|Ability|technical parameter|--/);
  });
  test(`${platform} probe cannot bypass ERROR blockers with stale ready flags`, () => {
    assert.equal(adapter.assessProbe({ ready: true, confirmationReady: true, diagnostics: [{ level: 'ERROR', message: 'failed' }] }, binding).status, 'NEED_USER_ACTION');
    assert.equal(adapter.assessProbe({ ready: true, diagnostics: [{ severity: 'ERROR', message: 'failed' }] }, binding).status, 'NEED_USER_ACTION');
  });
  test(`${platform} probe with missing readiness fails closed`, () => {
    const result = adapter.assessProbe({ diagnostics: [] }, binding);
    assert.equal(result.status, 'NEED_USER_ACTION');
    assert.ok(result.diagnostics.length);
  });
}

test('Android lists user apps and identifies known tooling without selecting it', async () => {
  const fake = runner([['adb', ['-s', 'pixel-1', 'shell', 'pm', 'list', 'packages', '-3'], 'package:com.example.reader\npackage:com.artemis.helper\npackage:mavt.android.ime\n']]);
  const result = android.discoverApps({ binding: androidBinding }, fake);
  assert.equal(result.coverage, 'user');
  assert.deepEqual(result.apps.map((app) => app.id), ['com.example.reader', 'com.artemis.helper', 'mavt.android.ime']);
  assert.equal(result.apps[1].helper, true);
  fake.done();
});

test('Android resolves a package launcher and preserves the selected backend', async () => {
  const fake = runner([['adb', androidResolve, 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.reader/.MainActivity\n']]);
  const result = android.resolve({ binding: { ...androidBinding, androidUiBackend: 'helper' } }, fake);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.entry, 'com.example.reader/.MainActivity');
  assert.equal(result.binding.androidUiBackend, 'helper');
  fake.done();
});

test('Android validates an explicit activity instead of trusting stale history', async () => {
  const fake = runner([['adb', [...androidResolve, '-n', 'com.example.reader/.OldActivity'], 'No activity found\n']]);
  const result = await android.resolve({ binding: { ...androidBinding, entry: '.OldActivity' } }, fake);
  assert.notEqual(result.status, 'READY');
  fake.done();
});

test('Android exposes multiple launchers through the shared selection contract and revalidates the choice', () => {
  const selected = 'com.example.reader/.MainActivity';
  const fake = runner([
    ['adb', androidResolve, androidResolver], ['adb', androidQuery, androidLaunchers],
    ['adb', androidQuery, androidLaunchers], ['adb', [...androidResolve, '-n', selected], selected],
  ]);
  const result = android.resolve({ binding: { ...androidBinding, androidUiBackend: 'helper' } }, fake);
  assert.equal(result.status, 'NEED_SELECTION');
  assert.equal(result.selectionKind, 'entry');
  assert.deepEqual(result.candidates.map(item => item.binding.entry), [selected, 'com.example.reader/leakcanary.internal.activity.LeakLauncherActivity']);
  assert.ok(result.candidates.every(item => item.label && item.binding.androidUiBackend === 'helper'));
  const chosen = android.resolve({ binding: { ...androidBinding, androidUiBackend: 'helper' }, optionId: result.candidates[0].id }, fake);
  assert.equal(chosen.status, 'READY');
  assert.equal(chosen.binding.entry, selected);
  assert.equal(chosen.binding.androidUiBackend, 'helper');
  fake.done();
});

test('Android refuses a selected launcher removed from the latest inventory', () => {
  const fake = runner([['adb', androidQuery, 'com.example.reader/.MainActivity\n']]);
  const result = android.resolve({ binding: androidBinding, optionId: 'activity:com.example.reader/.RemovedActivity' }, fake);
  assert.equal(result.diagnostics[0].id, 'ANDROID_OPTION_STALE');
  fake.done();
});

test('Android refuses a selected launcher that changes during explicit verification', () => {
  const fake = runner([
    ['adb', androidQuery, androidLaunchers],
    ['adb', [...androidResolve, '-n', 'com.example.reader/.MainActivity'], 'com.example.reader/.OtherActivity'],
  ]);
  const result = android.resolve({ binding: androidBinding, optionId: 'activity:com.example.reader/.MainActivity' }, fake);
  assert.equal(result.diagnostics[0].id, 'ANDROID_ENTRY_STALE');
  fake.done();
});

test('Android validates selection syntax and package before invoking tools', () => {
  const fake = runner([]);
  for (const optionId of ['activity:com.other/.MainActivity', 'activity:com.example.reader/$(id)', 'ability:entry:Main', '']) {
    assert.equal(android.resolve({ binding: androidBinding, optionId }, fake).diagnostics[0].id, 'ANDROID_OPTION_INVALID');
  }
  fake.done();
});

test('Android can resolve a single remaining candidate after a system resolver response', () => {
  const fake = runner([
    ['adb', androidResolve, androidResolver],
    ['adb', androidQuery, 'com.other/.MainActivity\ncom.example.reader/.MainActivity\ncom.example.reader/com.example.reader.MainActivity\n'],
  ]);
  const result = android.resolve({ binding: androidBinding }, fake);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.entry, 'com.example.reader/.MainActivity');
  fake.done();
});

for (const [label, response, diagnostic] of [
  ['no candidates', 'No activities found\n', 'ANDROID_LAUNCHER_UNVERIFIED'],
  ['query failure', { ok: false, code: 1, stderr: 'device offline' }, 'ANDROID_ENTRY_QUERY_FAILED'],
  ['error output', `Error: permission denied\n${androidLaunchers}`, 'ANDROID_ENTRY_QUERY_FAILED'],
]) test(`Android reports ${label} after a resolver response without inventing a launcher`, () => {
  const fake = runner([['adb', androidResolve, androidResolver], ['adb', androidQuery, response]]);
  const result = android.resolve({ binding: androidBinding }, fake);
  assert.equal(result.status, 'NEED_USER_ACTION');
  assert.equal(result.diagnostics[0].id, diagnostic);
  fake.done();
});

test('Android preserves a full component entry when validating it for downstream launch', () => {
  const entry = 'com.example.reader/.MainActivity';
  const fake = runner([['adb', [...androidResolve, '-n', entry], `${entry}\n`]]);
  const result = android.resolve({ binding: { ...androidBinding, entry } }, fake);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.entry, 'com.example.reader/.MainActivity');
  fake.done();
});

for (const [label, response] of [
  ['missing launcher', 'No activity found\n'],
  ['wrong package', 'com.other/.MainActivity\n'],
  ['empty response', ''],
  ['tool failure', { ok: false, stdout: '', stderr: 'device offline', code: 1 }],
]) test(`Android fails closed for ${label}`, async () => {
  const fake = runner([['adb', androidResolve, response]]);
  const result = await android.resolve({ binding: androidBinding }, fake);
  assert.notEqual(result.status, 'READY');
  assert.ok(result.diagnostics.length);
  fake.done();
});

test('Android rejects shell syntax and missing device before invoking tools', async () => {
  const fake = runner([]);
  for (const binding of [{ ...androidBinding, appId: 'com.example;id' }, { ...androidBinding, deviceId: '' }, { ...androidBinding, entry: '$(touch /tmp/no)' }]) {
    assert.notEqual((await android.resolve({ binding }, fake)).status, 'READY');
  }
  fake.done();
});

test('Android enumeration failure reports limited coverage and an actionable failure', async () => {
  const fake = runner([['adb', ['-s', 'pixel-1', 'shell', 'pm', 'list', 'packages', '-3'], { ok: false, stdout: '', stderr: 'not found', code: 127 }]]);
  const result = await android.discoverApps({ binding: androidBinding }, fake);
  assert.equal(result.coverage, 'limited');
  assert.deepEqual(result.apps, []);
  assert.ok(result.actions.length);
  fake.done();
});

test('Android rejects diagnostic errors even when a component appears in successful stdout', async () => {
  const fake = runner([['adb', androidResolve, 'Error: activity query failed\ncom.example.reader/.MainActivity\n']]);
  assert.notEqual((await android.resolve({ binding: androidBinding }, fake)).status, 'READY');
  fake.done();
});

test('Android preparation reuses the existing dependency setup with the backend policy', async () => {
  const event = { schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [{ id: 'androidAccessibilityHelper', ok: true }] };
  const script = path.resolve(__dirname, '../src/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh');
  const fake = runner([['bash', [script, '--device', 'pixel-1', '--app', 'com.example.reader', '--entry', 'com.example.reader/.MainActivity', '--android-ui-backend', 'uiautomator'], JSON.stringify(event)]]);
  assert.deepEqual(android.prepare({ binding: { ...androidBinding, entry: 'com.example.reader/.MainActivity', androidUiBackend: 'uiautomator' } }, fake), event);
  fake.done();
});

test('Android preparation cannot hide a failed process behind a success payload', async () => {
  const script = path.resolve(__dirname, '../src/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh');
  const fake = runner([['bash', [script, '--device', 'pixel-1', '--app', 'com.example.reader', '--entry', '.MainActivity', '--android-ui-backend', 'auto'], { ok: false, code: 1, stdout: '{"type":"environmentPrepare","platform":"android","ok":true,"dependencies":[]}', stderr: 'provision failed' }]]);
  assert.equal((await android.prepare({ binding: { ...androidBinding, entry: '.MainActivity' } }, fake)).ok, false);
  fake.done();
});

test('Harmony parses the bundle list and marks its all-app enumeration scope', async () => {
  const fake = runner([['hdc', ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'], 'com.example.reader\ncom.ohos.settings\n']]);
  const result = harmony.discoverApps({ binding: harmonyBinding }, fake);
  assert.equal(result.coverage, 'all');
  assert.deepEqual(result.apps.map((app) => app.id), ['com.example.reader', 'com.ohos.settings']);
  fake.done();
});

test('Harmony parses bm bracketed bundle names', async () => {
  const fake = runner([['hdc', ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'], 'bundle name [com.example.reader]\nbundle name [com.ohos.settings]\n']]);
  const result = await harmony.discoverApps({ binding: harmonyBinding }, fake);
  assert.equal(result.coverage, 'all');
  assert.deepEqual(result.apps.map((app) => app.id), ['com.example.reader', 'com.ohos.settings']);
  fake.done();
});

test('Harmony marks system apps from structured bundle metadata', async () => {
  const fake = runner([['hdc', ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'], '{"bundleInfos":[{"name":"com.ohos.settings","applicationInfo":{"label":"Settings","isSystemApp":true}}]}']]);
  const result = await harmony.discoverApps({ binding: harmonyBinding }, fake);
  assert.equal(result.coverage, 'all');
  assert.equal(result.apps[0].system, true);
  assert.equal(result.apps[0].name, 'Settings');
  fake.done();
});

test('Harmony does not claim a complete inventory when structured entries are unrecognized', async () => {
  const fake = runner([['hdc', ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'], '{"bundleInfos":[{"name":"com.example.reader"},{"unknown":"com.other"}]}']]);
  const result = await harmony.discoverApps({ binding: harmonyBinding }, fake);
  assert.equal(result.coverage, 'limited');
  assert.ok(result.diagnostics.length);
  fake.done();
});

test('Harmony resolves the launchable ability from prefixed bundle metadata', async () => {
  const fake = runner([['hdc', harmonyDump, bundle([ability('MainAbility'), ability('HiddenAbility', { skills: [], visible: false })])]]);
  const result = harmony.resolve({ binding: harmonyBinding }, fake);
  assert.equal(result.status, 'READY');
  assert.equal(result.binding.entry, 'MainAbility');
  fake.done();
});

test('Harmony asks for named launchable abilities rather than selecting the first', async () => {
  const text = bundle([ability('MainAbility'), ability('WorkAbility')]);
  const fake = runner([['hdc', harmonyDump, text], ['hdc', harmonyDump, text]]);
  const result = await harmony.resolve({ binding: harmonyBinding }, fake);
  assert.equal(result.status, 'NEED_SELECTION');
  assert.equal(result.selectionKind, 'entry');
  assert.deepEqual(result.candidates.map((candidate) => candidate.binding.entry), ['MainAbility', 'WorkAbility']);
  assert.ok(result.candidates.every((candidate) => candidate.label.includes('Reader')));
  const chosen = await harmony.resolve({ binding: harmonyBinding, optionId: result.candidates[1].id }, fake);
  assert.equal(chosen.status, 'READY');
  assert.equal(chosen.binding.entry, 'WorkAbility');
  fake.done();
});

test('Harmony validates a manual ability and refuses stale or hidden entries', async () => {
  const text = bundle([ability('MainAbility'), ability('HiddenAbility', { visible: false })]);
  const fake = runner([['hdc', harmonyDump, text], ['hdc', harmonyDump, text], ['hdc', harmonyDump, text]]);
  assert.equal((await harmony.resolve({ binding: { ...harmonyBinding, entry: 'MainAbility' } }, fake)).status, 'READY');
  assert.notEqual((await harmony.resolve({ binding: { ...harmonyBinding, entry: 'OldAbility' } }, fake)).status, 'READY');
  assert.notEqual((await harmony.resolve({ binding: { ...harmonyBinding, entry: 'HiddenAbility' } }, fake)).status, 'READY');
  fake.done();
});

test('Harmony rejects an obsolete option even if the application now has only one launcher', async () => {
  const fake = runner([['hdc', harmonyDump, bundle([ability('MainAbility')])]]);
  assert.notEqual((await harmony.resolve({ binding: harmonyBinding, optionId: 'ability:entry:OldAbility' }, fake)).status, 'READY');
  fake.done();
});

test('Harmony refuses module ambiguity that the current action binding cannot represent', async () => {
  const text = bundle([], { hapModuleInfos: [{ name: 'entry', abilityInfos: [ability('MainAbility')] }, { name: 'work', abilityInfos: [ability('MainAbility')] }] });
  const fake = runner([['hdc', harmonyDump, text]]);
  const result = await harmony.resolve({ binding: harmonyBinding }, fake);
  assert.equal(result.status, 'NEED_USER_ACTION');
  assert.equal(result.actions[0].id, 'HARMONY_MODULE_SELECTION_UNSUPPORTED');
  fake.done();
});

test('Harmony rejects failure text preceding otherwise valid JSON', async () => {
  const fake = runner([['hdc', harmonyDump, `error: permission denied\n${bundle([ability('MainAbility')])}`]]);
  assert.notEqual((await harmony.resolve({ binding: harmonyBinding }, fake)).status, 'READY');
  fake.done();
});

for (const [label, response] of [
  ['missing app', 'error: bundle not found\n'],
  ['malformed metadata', 'some unknown format'],
  ['wrong bundle', bundle([ability('MainAbility')], { name: 'com.other' })],
  ['no launcher skill', bundle([ability('MainAbility', { skills: [] })])],
  ['tool failure', { ok: false, stdout: '', stderr: 'device offline', code: 1 }],
]) test(`Harmony fails closed for ${label}`, async () => {
  const fake = runner([['hdc', harmonyDump, response]]);
  const result = await harmony.resolve({ binding: harmonyBinding }, fake);
  assert.notEqual(result.status, 'READY');
  assert.ok(result.diagnostics.length);
  fake.done();
});

test('Harmony unsupported enumeration permits an explicit bundle request without claiming an empty inventory', async () => {
  const fake = runner([['hdc', ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'], 'error: unknown option -a\n']]);
  const result = await harmony.discoverApps({ binding: harmonyBinding }, fake);
  assert.equal(result.coverage, 'limited');
  assert.ok(result.actions.length);
  assert.ok(result.diagnostics.length);
  fake.done();
});

test('Harmony rejects shell syntax before invoking tools', async () => {
  const fake = runner([]);
  assert.notEqual((await harmony.resolve({ binding: { ...harmonyBinding, appId: 'com.example && id' } }, fake)).status, 'READY');
  assert.notEqual((await harmony.resolve({ binding: { ...harmonyBinding, entry: 'MainAbility;id' } }, fake)).status, 'READY');
  fake.done();
});

test('Harmony preparation verifies the chosen ability without starting or provisioning anything', async () => {
  const fake = runner([['hdc', harmonyDump, bundle([ability('MainAbility')])]]);
  const result = harmony.prepare({ binding: { ...harmonyBinding, entry: 'MainAbility' } }, fake);
  assert.equal(result.type, 'environmentPrepare');
  assert.equal(result.ok, true);
  fake.done();
});
