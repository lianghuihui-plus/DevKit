#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapBatch, initializeBatch } = require('../batch/core');
const { buildContract } = require('../build-agent-contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const {
  appProvisioningSha,
  createInitialStatePreflight,
  validateBootstrapPolicy,
  preparationPolicySha,
  registerAppArtifact,
  validateAppProvisioning,
  validatePreparationPolicy,
  validateInitialStatePreflight,
} = require('../lib/app-provisioning');
const { resolveStrategy } = require('../case-runtime/preparation-service');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-app-provisioning-'));
const root = path.join(temp, 'workspace');
createTestWorkspace(root);

const artifact = path.join(temp, 'fixture.hap');
fs.writeFileSync(artifact, 'frozen-harmony-artifact');
const registration = {
  workspaceRoot: root,
  sourcePath: artifact,
  platform: 'harmony',
  appId: 'com.example.provisioning',
  version: '1.2.3',
  build: '123',
  now: '2026-09-08T10:00:00.000Z',
};
const first = registerAppArtifact(registration);
const repeated = registerAppArtifact({ ...registration, now: '2026-09-08T10:01:00.000Z' });
assert.deepStrictEqual(repeated, first);
const renamedArtifact = path.join(temp, 'renamed.hap');
fs.copyFileSync(artifact, renamedArtifact);
assert.deepStrictEqual(registerAppArtifact({ ...registration, sourcePath: renamedArtifact }), first);
assert.strictEqual(first.mode, 'ARTIFACT_MANAGED');
assert.strictEqual(first.artifactIdentity.inspection.status, 'UNAVAILABLE');
assert.ok(first.artifactPath.startsWith(path.join(root, '.mavt', 'app-artifacts')));
assert.throws(() => registerAppArtifact({ ...registration, version: '9.9.9' }), (error) => error?.code === 'APP_INSTALL_ARTIFACT_CONFLICT');
assert.throws(() => validatePreparationPolicy({
  schemaVersion: 1,
  allowedEffects: ['CLEAR_APP_DATA'],
  targetAppOnly: false,
  userAuthorization: '允许清理',
}), (error) => error?.code === 'PREPARATION_POLICY_INVALID');
assert.throws(() => validateBootstrapPolicy({
  schemaVersion: 1,
  mode: 'REINSTALL_FROZEN',
  allowedEffects: ['INSTALL_FROZEN_ARTIFACT'],
  targetAppOnly: true,
  userAuthorization: '允许安装',
}), (error) => error?.code === 'BOOTSTRAP_POLICY_INVALID');
const keepExistingRequirement = {
  schemaVersion: 1,
  targetState: 'KEEP_EXISTING',
  rationale: '该契约测试不需要重置 App 状态',
};
const noPreparationEffects = { schemaVersion: 1, allowedEffects: [], targetAppOnly: true };
const initialStatePreflight = createInitialStatePreflight({
  requirement: keepExistingRequirement,
  preparationPolicy: noPreparationEffects,
  platform: 'harmony',
  now: registration.now,
});
assert.doesNotThrow(() => validateInitialStatePreflight(initialStatePreflight, {
  requirement: keepExistingRequirement,
  preparationPolicy: noPreparationEffects,
  platform: 'harmony',
}));
assert.throws(() => validateInitialStatePreflight({ ...initialStatePreflight, checkedAt: 'invalid' }, {
  requirement: keepExistingRequirement,
  preparationPolicy: noPreparationEffects,
  platform: 'harmony',
}), (error) => error?.code === 'INITIAL_STATE_PREFLIGHT_INVALID');
assert.throws(() => createInitialStatePreflight({
  requirement: keepExistingRequirement,
  preparationPolicy: noPreparationEffects,
  platform: 'unsupported',
  now: registration.now,
}), (error) => error?.code === 'INITIAL_STATE_PREFLIGHT_INVALID');

const inspectedArtifact = path.join(temp, 'inspected.hap');
fs.writeFileSync(inspectedArtifact, 'inspected-artifact');
const inspected = registerAppArtifact({
  ...registration,
  sourcePath: inspectedArtifact,
  inspectArtifact: () => ({
    status: 'VERIFIED',
    identity: { appId: registration.appId, version: registration.version, build: registration.build },
    tool: 'fixture-inspector',
    toolVersion: '1.0.0',
  }),
});
assert.strictEqual(inspected.artifactIdentity.inspection.status, 'VERIFIED');
const mismatchedArtifact = path.join(temp, 'mismatched.hap');
fs.writeFileSync(mismatchedArtifact, 'mismatched-artifact');
assert.throws(() => registerAppArtifact({
  ...registration,
  sourcePath: mismatchedArtifact,
  inspectArtifact: () => ({
    status: 'VERIFIED',
    identity: { appId: 'com.example.other', version: registration.version, build: registration.build },
    tool: 'fixture-inspector',
    toolVersion: '1.0.0',
  }),
}), (error) => error?.code === 'APP_ARTIFACT_IDENTITY_MISMATCH');

const appDir = path.join(temp, 'Fixture.app');
fs.mkdirSync(appDir);
fs.writeFileSync(path.join(appDir, 'Info.plist'), 'fixture');
fs.symlinkSync(path.join(appDir, 'Info.plist'), path.join(appDir, 'Info-link.plist'));
assert.throws(() => registerAppArtifact({
  ...registration,
  sourcePath: appDir,
  platform: 'ios',
  deviceType: 'simulator',
}), (error) => error?.code === 'APP_INSTALL_ARTIFACT_INVALID');

const iosApp = path.join(temp, 'Installable.app');
fs.mkdirSync(iosApp);
fs.writeFileSync(path.join(iosApp, 'Info.plist'), 'installable-fixture');
const iosProvisioning = registerAppArtifact({
  workspaceRoot: root,
  sourcePath: iosApp,
  platform: 'ios',
  deviceType: 'simulator',
  appId: 'com.example.ios-provisioning',
  version: '5.0.0',
  build: '500',
  now: '2026-09-08T10:00:00.000Z',
});
const reinstallPolicy = validatePreparationPolicy({
  schemaVersion: 1,
  allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'],
  targetAppOnly: true,
  userAuthorization: '允许重装目标 App',
});
const iosStrategy = resolveStrategy({
  platform: 'ios',
  targetBinding: { appId: iosProvisioning.appId, deviceType: 'simulator' },
  appProvisioning: iosProvisioning,
  appProvisioningSha: appProvisioningSha(iosProvisioning),
  preparationPolicy: reinstallPolicy,
  preparationPolicySha: preparationPolicySha(reinstallPolicy),
}, {
  sessionRef: { statePath: path.join(root, 'runs', 'fixture-batch', 'batch.json') },
}, 'APP_LOCAL_STATE_EMPTY');
assert.strictEqual(iosStrategy.strategy, 'REINSTALL_APP');

const source = '验证冻结制品从批次启动开始生效';
const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
const caseJson = createCaseContract({ caseKey, title: '制品启动', sourceText: source, importPath: '/fixture/provisioning.md' });
const caseDir = path.join(root, 'cases', `provisioning__${caseKey}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), source);
writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
const binding = { platform: 'harmony', deviceId: 'provisioning-device', appId: registration.appId, entry: 'EntryAbility' };
const bootstrapPolicy = validateBootstrapPolicy({
  schemaVersion: 1,
  mode: 'REINSTALL_FROZEN',
  allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'],
  targetAppOnly: true,
  userAuthorization: '允许批次启动时重装冻结制品',
});
const keepExistingBatchId = 'batch-artifact-keep-existing';
createTestExecutionRequest(root, keepExistingBatchId, binding, [{ caseKey, caseDir }], { appProvisioning: first });
initializeBatch({ workspaceRoot: root, batchId: keepExistingBatchId });
const keepExistingCalls = [];
bootstrapBatch({
  workspaceRoot: root,
  batchId: keepExistingBatchId,
  adapter: {
    prepareApp: () => { keepExistingCalls.push('install'); },
    restartApp: () => { keepExistingCalls.push('restart'); return { ok: true, coldStartVerified: true, startupDisplayVerified: true }; },
  },
});
assert.deepStrictEqual(keepExistingCalls, ['restart']);
const batchId = 'batch-artifact-managed';
const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }], { appProvisioning: first, bootstrapPolicy });
initializeBatch({ workspaceRoot: root, batchId });
const calls = [];
const adapter = {
  prepareApp: ({ binding: target, provisioning }) => {
    calls.push(`install:${provisioning.artifactRef}`);
    return {
      schemaVersion: 1,
      type: 'appPreparationResult',
      platform: 'harmony',
      strategy: 'REINSTALL_APP',
      ok: true,
      status: 'SUCCEEDED',
      device: { id: target.deviceId },
      app: { appId: target.appId },
      installedIdentity: { appId: target.appId, version: provisioning.version, build: provisioning.build },
    };
  },
  restartApp: () => {
    calls.push('restart');
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
};
const bootstrapped = bootstrapBatch({ workspaceRoot: root, batchId, adapter });
assert.deepStrictEqual(calls, [`install:${first.artifactRef}`, 'restart']);
assert.strictEqual(bootstrapped.state.warmSession.status, 'READY');
assert.strictEqual(bootstrapped.state.warmSession.sessionId, 'warm-0001');

const resumedBatchId = 'batch-artifact-managed-resumed';
createTestExecutionRequest(root, resumedBatchId, binding, [{ caseKey, caseDir }], { appProvisioning: first, bootstrapPolicy });
initializeBatch({ workspaceRoot: root, batchId: resumedBatchId });
const resumedCalls = [];
const resumedAdapter = {
  prepareApp: ({ provisioning }) => {
    resumedCalls.push(`install:${provisioning.artifactRef}`);
    return {
      schemaVersion: 1,
      type: 'appPreparationResult',
      platform: 'harmony',
      strategy: 'REINSTALL_APP',
      ok: true,
      status: 'SUCCEEDED',
      device: { id: binding.deviceId },
      app: { appId: binding.appId },
      installedIdentity: { appId: binding.appId, version: provisioning.version, build: provisioning.build },
    };
  },
  restartApp: () => {
    resumedCalls.push('restart');
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
};
assert.throws(() => bootstrapBatch({
  workspaceRoot: root,
  batchId: resumedBatchId,
  adapter: resumedAdapter,
  interruptAfter: 'artifact-preparation',
}), /MAVT_BATCH_BOOTSTRAP_INTERRUPTED/);
const resumed = bootstrapBatch({ workspaceRoot: root, batchId: resumedBatchId, adapter: resumedAdapter });
assert.deepStrictEqual(resumedCalls, [`install:${first.artifactRef}`, 'restart']);
assert.strictEqual(resumed.state.warmSession.status, 'READY');
const mismatchBatchId = 'batch-artifact-identity-mismatch';
createTestExecutionRequest(root, mismatchBatchId, binding, [{ caseKey, caseDir }], { appProvisioning: first, bootstrapPolicy });
initializeBatch({ workspaceRoot: root, batchId: mismatchBatchId });
assert.throws(() => bootstrapBatch({
  workspaceRoot: root,
  batchId: mismatchBatchId,
  adapter: {
    prepareApp: () => ({
      schemaVersion: 1,
      type: 'appPreparationResult',
      platform: 'harmony',
      strategy: 'REINSTALL_APP',
      ok: true,
      status: 'SUCCEEDED',
      device: { id: binding.deviceId },
      app: { appId: binding.appId },
      installedIdentity: { appId: binding.appId, version: '9.9.9', build: first.build },
    }),
    restartApp: () => { throw new Error('restart must not run after identity mismatch'); },
  },
}), (error) => error?.code === 'APP_ARTIFACT_IDENTITY_MISMATCH');
const mismatchState = JSON.parse(fs.readFileSync(path.join(root, 'runs', mismatchBatchId, 'batch.json'), 'utf8'));
assert.strictEqual(mismatchState.status, 'BLOCKING');
assert.strictEqual(mismatchState.failureCode, 'APP_ARTIFACT_IDENTITY_MISMATCH');
assert.strictEqual(validateAppProvisioning(first, { workspaceRoot: root, platform: 'harmony', appId: binding.appId }).artifactRef, first.artifactRef);
fs.appendFileSync(first.artifactPath, '-changed');
assert.throws(() => validateAppProvisioning(first, {
  workspaceRoot: root,
  platform: 'harmony',
  appId: binding.appId,
}), (error) => error?.code === 'APP_INSTALL_ARTIFACT_MISMATCH');

fs.rmSync(temp, { recursive: true, force: true });
console.log('app provisioning passed');
