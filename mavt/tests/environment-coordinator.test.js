'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const runtime = '../src/mobile-ai-visual-test/scripts';
const coordinator = require(`${runtime}/coordinator/agent-facing-service`);
const { createTestWorkspace } = require(`${runtime}/tests/support/workspace-fixture`);
const { createCaseContract } = require(`${runtime}/execution/contracts/case-contract`);
const { writeJsonAtomic } = require(`${runtime}/lib/execution-lifecycle`);
process.env.MAVT_SELF_TEST = '1';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-env-flow-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  createTestWorkspace(workspace);
  fs.mkdirSync(path.join(workspace, 'knowledge'));
  const caseKey = `ck-${require('node:crypto').createHash('sha256').update('验证标题').digest('hex').slice(0, 12)}`;
  const caseDir = path.join(workspace, 'cases', `001__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), '验证标题');
  writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({ caseKey, caseNo: '001', title: '标题', sourceText: '验证标题', importPath: '/fixture.md' }));
  let count = 0;
  let installed = true;
  const options = {
    probeEnvironment: platform => ({ schemaVersion: 1, type: 'environmentProbe', platform, ready: true,
      devices: [{ id: 'device', name: '测试手机' }] }),
    environmentOptions: { adapter: {
      discoverApps: () => ({ apps: installed ? [{ id: 'com.one', name: '学习 App' }, { id: 'com.two', name: '学习 App' }] : [], coverage: 'user', diagnostics: [] }),
      resolve: ({ binding }) => { count += 1; return { status: 'READY', binding: { ...binding, entry: 'Main' } }; },
      prepare: ({ binding }) => ({ schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: true }),
    } },
    batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
  };
  const prepared = coordinator.prepareRun({ operation: 'prepareRun', input: { caseNos: ['001'] } }, { workspace });
  const statePath = prepared.result.command.match(/ --state '([^']+)'$/)[1];
  const confirm = input => coordinator.confirmRun(statePath, { operation: 'confirmRun', input }, options);
  return { workspace, options, statePath, confirm, count: () => count, removeApp: () => { installed = false; } };
}

test('common flow selects named app then confirms opaque environment; final confirmation revalidates', t => {
  const f = fixture(t);
  const apps = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony' });
  assert.equal(apps.data.content.environmentStatus, 'NEED_SELECTION');
  assert.equal(apps.data.content.reason, 'SELECT_APP');
  assert.equal(JSON.stringify(apps).includes('requiredBindingFields'), false);
  assert.equal(apps.data.content.choices.filter(c => c.decision === 'SELECT_APP').length, 2);
  assert.throws(() => f.confirm({ decision: 'SELECT_APP', appId: 'com.forged' }), /候选|选择/);
  const ready = f.confirm({ decision: 'SELECT_APP', appId: 'com.one' });
  assert.equal(ready.data.content.environmentStatus, 'READY');
  const ref = ready.data.content.environmentRef;
  assert.ok(ref);
  assert.throws(() => f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: 'stale', userInstruction: '确认' }), /引用/);
  const confirmed = f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ref, userInstruction: '确认执行' });
  assert.equal(confirmed.result.outcome, 'CONFIRMED');
  assert.equal(f.count(), 2);
  const frozen = coordinator.loadCoordinatorState(f.statePath).initialization.environmentFrozen.environment.binding;
  assert.equal(frozen.entry, 'Main');
  assert.equal(frozen.appId, 'com.one');
});

for (const stale of [false, true]) test(`Android real adapter uses common entry selection and ${stale ? 'rejects a removed launcher at confirmation' : 'freezes the verified choice'}`, t => {
  const f = fixture(t);
  const calls = [];
  let removed = false;
  f.options.environmentOptions = { run: (command, args) => {
    calls.push([command, args]);
    const ok = stdout => ({ ok: true, code: 0, stdout, stderr: '' });
    if (command === 'bash') return ok(JSON.stringify({ schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [] }));
    assert.equal(command, 'adb');
    if (args.includes('list')) return ok('package:com.one\n');
    if (args.includes('query-activities')) return ok(`${removed ? '' : 'com.one/.MainActivity\n'}com.one/leakcanary.internal.activity.LeakLauncherActivity\n`);
    assert.ok(args.includes('resolve-activity'));
    return ok(args.includes('-n') ? args.at(-1) : 'android/com.android.internal.app.ResolverActivity\n');
  } };
  const offer = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'android', appId: 'com.one' });
  assert.equal(offer.data.content.environmentStatus, 'NEED_SELECTION');
  assert.equal(offer.data.content.reason, 'SELECT_ENVIRONMENT_OPTION');
  assert.equal(calls.some(([command]) => command === 'bash'), false);
  const choice = offer.data.content.choices.find(item => item.optionId === 'activity:com.one/.MainActivity');
  assert.ok(choice);
  const ready = f.confirm({ decision: choice.decision, optionId: choice.optionId });
  assert.equal(ready.data.content.environmentStatus, 'READY');
  assert.equal(calls.filter(([command]) => command === 'bash').length, 1);
  removed = stale;
  const confirmed = f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ready.data.content.environmentRef, userInstruction: '确认执行' });
  const state = coordinator.loadCoordinatorState(f.statePath);
  if (stale) {
    assert.notEqual(confirmed.result.outcome, 'CONFIRMED');
    assert.equal(state.initialization, undefined);
  } else {
    assert.equal(confirmed.result.outcome, 'CONFIRMED');
    assert.equal(state.initialization.environmentFrozen.environment.binding.entry, 'com.one/.MainActivity');
    assert.equal(calls.filter(([command]) => command === 'bash').length, 1);
  }
});
test('uninstalled App between choice and confirmation cannot enter execution', t => {
  const f = fixture(t);
  const ready = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'android', appId: 'com.one' });
  f.removeApp();
  const result = f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ready.data.content.environmentRef, userInstruction: '确认' });
  assert.equal(result.data.content.environmentStatus, 'NEED_USER_ACTION');
  assert.equal(coordinator.loadCoordinatorState(f.statePath).initialization, undefined);
  assert.ok(result.data.content.actions.length);
});
test('historical config is checked against current devices before reuse', t => {
  const f = fixture(t);
  const ready = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony', appId: 'com.one' });
  f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ready.data.content.environmentRef, userInstruction: '确认' });
  const next = coordinator.prepareRun({ operation: 'prepareRun', input: { caseNos: ['001'] } }, { workspace: f.workspace });
  const nextPath = next.result.command.match(/ --state '([^']+)'$/)[1];
  const result = coordinator.confirmRun(nextPath, { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: '复用' } }, {
    ...f.options, probeEnvironment: platform => ({ platform, ready: false, devices: [], diagnostics: [] }),
  });
  assert.equal(result.result.outcome, 'NEED_USER_CONFIRMATION');
  assert.equal(coordinator.loadCoordinatorState(nextPath).initialization, undefined);
});
test('retry revokes prior ready reference and advance only reads pending setup', t => {
  const f = fixture(t);
  const ready = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony', appId: 'com.one' });
  const count = f.count();
  coordinator.advanceRun(f.statePath, f.options);
  assert.equal(f.count(), count);
  const next = f.confirm({ decision: 'RETRY_ENVIRONMENT' });
  assert.notEqual(next.data.content.environmentRef, ready.data.content.environmentRef);
  assert.throws(() => f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ready.data.content.environmentRef, userInstruction: '确认' }), /引用/);
});
test('multiple-device choices preserve app target selectors', t => {
  const f = fixture(t);
  f.options.probeEnvironment = platform => ({ schemaVersion: 1, type: 'environmentProbe', platform, ready: true,
    devices: [{ id: 'device' }, { id: 'other' }] });
  const result = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony', appId: 'com.one', appName: '学习 App' });
  const choice = result.data.content.choices[0];
  assert.equal(choice.appId, 'com.one');
  assert.equal(choice.appName, '学习 App');
  const { id, ...input } = choice;
  const selected = f.confirm(input);
  assert.equal(selected.data.content.app.id, 'com.one');
});
test('retry drops an obsolete configuration choice and republishes current candidates', t => {
  const f = fixture(t);
  let generation = 'old';
  f.options.environmentOptions.adapter.resolve = ({ binding, optionId }) => {
    if (optionId && optionId !== generation) return { status: 'FAILED', diagnostics: [{ code: 'STALE_OPTION' }] };
    return optionId ? { status: 'READY', binding: { ...binding, entry: generation } }
      : { status: 'NEED_SELECTION', selectionKind: 'entry', candidates: [{ id: generation, label: generation, binding: { ...binding, entry: generation } }] };
  };
  f.confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony', appId: 'com.one' });
  f.confirm({ decision: 'SELECT_ENVIRONMENT_OPTION', optionId: 'old' });
  generation = 'new';
  const result = f.confirm({ decision: 'RETRY_ENVIRONMENT' });
  assert.equal(result.data.content.environmentStatus, 'NEED_SELECTION');
  assert.ok(result.data.content.choices.some(c => c.optionId === 'new'));
  const switched = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'android', appId: 'com.one' });
  assert.equal(switched.data.content.binding.platform, 'android');
});
test('automatic preparation precedes READY, is actionable on failure, and is not repeated at confirmation', t => {
  const f = fixture(t);
  let prepared = false;
  let calls = 0;
  f.options.environmentOptions.adapter.prepare = ({ binding }) => {
    calls += 1;
    return { schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: prepared,
      actions: prepared ? [] : [{ id: 'ALLOW_PERMISSION', message: '请允许设备上的自动化权限后重试。' }] };
  };
  const blocked = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'android', appId: 'com.one' });
  assert.equal(blocked.data.content.environmentStatus, 'NEED_USER_ACTION');
  assert.equal(blocked.data.content.actions[0].id, 'ALLOW_PERMISSION');
  assert.equal(coordinator.loadCoordinatorState(f.statePath).initialization, undefined);
  prepared = true;
  const ready = f.confirm({ decision: 'RETRY_ENVIRONMENT' });
  assert.equal(ready.data.content.environmentStatus, 'READY');
  assert.equal(calls, 2);
  const result = f.confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ready.data.content.environmentRef, userInstruction: '确认' });
  assert.equal(result.result.outcome, 'CONFIRMED');
  assert.equal(calls, 2);
});
for (const disconnected of [false, true]) test(`historical artifact provisioning survives ${disconnected ? 'disconnect and retry' : 'changed binding confirmation'}`, t => {
  const f = fixture(t);
  const { registerAppArtifact, workspacePackageRoot } = require(`${runtime}/lib/app-provisioning`);
  const { confirmEnvironment } = require(`${runtime}/lib/run-control`);
  const packageRoot = workspacePackageRoot(f.workspace, 'harmony');
  fs.mkdirSync(packageRoot, { recursive: true });
  const sourcePath = path.join(packageRoot, 'fixture.hap');
  fs.writeFileSync(sourcePath, 'offline fixture');
  const appProvisioning = registerAppArtifact({ workspaceRoot: f.workspace, sourcePath, platform: 'harmony', appId: 'com.one', version: '1.0', build: '1',
    inspectArtifact: () => ({ status: 'UNAVAILABLE', tool: 'fixture', toolVersion: '1' }) });
  confirmEnvironment({ workspaceRoot: f.workspace, binding: { platform: 'harmony', deviceId: 'device', appId: 'com.one', entry: 'Old' },
    probe: f.options.probeEnvironment('harmony'), appProvisioning, userConfirmation: '历史确认' });
  const prepared = coordinator.prepareRun({ operation: 'prepareRun', input: { caseNos: ['001'] } }, { workspace: f.workspace });
  const statePath = prepared.result.command.match(/ --state '([^']+)'$/)[1];
  const originalProbe = f.options.probeEnvironment;
  if (disconnected) f.options.probeEnvironment = platform => ({ platform, ready: false, devices: [] });
  let offer = coordinator.confirmRun(statePath, { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: '复用' } }, f.options);
  if (disconnected) {
    assert.equal(offer.data.content.environmentStatus, 'NEED_USER_ACTION');
    f.options.probeEnvironment = originalProbe;
    offer = coordinator.confirmRun(statePath, { operation: 'confirmRun', input: { decision: 'RETRY_ENVIRONMENT' } }, f.options);
  }
  assert.equal(offer.data.content.environmentStatus, 'READY');
  coordinator.confirmRun(statePath, { operation: 'confirmRun', input: { decision: 'CONFIRM_ENVIRONMENT', environmentRef: offer.data.content.environmentRef, userInstruction: '确认' } }, f.options);
  assert.deepEqual(coordinator.loadCoordinatorState(statePath).initialization.environmentFrozen.environment.appProvisioning, appProvisioning);
});
test('failed helper dependency reason remains available in the diagnostic resource', t => {
  const f = fixture(t);
  f.options.environmentOptions.adapter.prepare = ({ binding }) => ({ schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: false,
    dependencies: [{ id: 'helper', required: true, ok: false, failureCode: 'HELPER_OWNER_ACTIVE', reason: '另一个运行持有自动化组件，请等待该运行释放。' }] });
  const result = f.confirm({ decision: 'SELECT_PLATFORM', platform: 'android', appId: 'com.one' });
  assert.equal(result.data.content.environmentStatus, 'NEED_USER_ACTION');
  const resource = coordinator.executeRunRequest(f.statePath, { operation: 'read', input: { ref: result.resources[0].ref } });
  const text = JSON.stringify(resource.data.content);
  assert.match(text, /HELPER_OWNER_ACTIVE/);
  assert.match(text, /另一个运行持有/);
});
