'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const coordinator = require('../src/mobile-ai-visual-test/scripts/coordinator/agent-facing-service');
const { createTestWorkspace } = require('../src/mobile-ai-visual-test/scripts/tests/support/workspace-fixture');
const { createCaseContract } = require('../src/mobile-ai-visual-test/scripts/execution/contracts/case-contract');
const { createReportingService } = require('../src/mobile-ai-visual-test/scripts/reporting/service');
const { createRepository } = require('../src/mobile-ai-visual-test/scripts/reporting/repository');
const { createIntents } = require('../src/mobile-ai-visual-test/scripts/reporting/intents');
const reportingIntegration = require('../src/mobile-ai-visual-test/scripts/reporting/integration');
const resourceStore = require('../src/mobile-ai-visual-test/scripts/coordinator/agent-resource-store');
process.env.MAVT_SELF_TEST = '1';

function fixture(t, service) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createTestWorkspace(root);
  fs.mkdirSync(path.join(root, 'knowledge'));
  const source = '验证标题';
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseDir = path.join(root, 'cases', `001__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify(createCaseContract({ caseKey, caseNo: '001', title: '标题', sourceText: source, importPath: '/fixture.md' })));
  const prepared = coordinator.prepareRunBound({ operation: 'prepareRun', input: { caseNos: ['001'] } }, { workspace: root, reportingService: service });
  return { root, prepared };
}
function confirmationOptions(service) {
  return { reportingService: service,
    probeEnvironment: platform => ({ schemaVersion: 1, type: 'environmentProbe', platform, ready: true,
      devices: [{ id: 'device', name: '测试设备' }] }),
    environmentOptions: { adapter: {
      discoverApps: () => ({ apps: [{ id: 'com.one', name: 'App' }], coverage: 'user', diagnostics: [] }),
      resolve: ({ binding }) => ({ status: 'READY', binding: { ...binding, entry: 'Main' } }),
      prepare: ({ binding }) => ({ schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: true }),
    } },
    batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
  };
}
function readyConfirmation(prepared, options) {
  const confirm = (input, extra = {}) => coordinator.confirmRun(prepared.statePath, { operation: 'confirmRun', input }, { ...options, ...extra });
  let offer = confirm({ decision: 'SELECT_PLATFORM', platform: 'harmony', appId: 'com.one' });
  if (offer.data.content.reason === 'SELECT_APP') offer = confirm({ decision: 'SELECT_APP', appId: 'com.one' });
  assert.ok(offer.data.content.environmentRef, JSON.stringify(offer.result));
  return { confirm, ref: offer.data.content.environmentRef };
}

test('prepare hint survives projection and a reporting failure preserves the completed envelope', t => {
  const submitted = [];
  const service = {
    preflight: () => ({ serverUrl: 'http://127.0.0.1:18188/', configured: false, autoUpload: true, noticeCode: 'REPORTING_NOTICE_REQUIRED' }),
    submit: input => { submitted.push(input); throw new Error('reporting unavailable'); },
  };
  const { prepared } = fixture(t, service);
  assert.equal(prepared.response.result.reporting.serverUrl, 'http://127.0.0.1:18188/');
  const cancelled = coordinator.cancelRun(prepared.statePath, { operation: 'cancelRun', input: { reason: '停止' } }, { reportingService: service });
  assert.equal(cancelled.status, 'SUCCEEDED');
  assert.equal(cancelled.result.phase, 'COMPLETE');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].scope, 'batch');
  assert.equal(submitted[0].trigger, 'automatic');
});

test('terminal reporting submits only after a successful terminal response', t => {
  const submissions = [];
  const service = {
    preflight: () => ({ configured: true, autoUpload: true }),
    submit: input => { submissions.push(input); return { state: 'QUEUED' }; },
  };
  const { prepared } = fixture(t, service);
  const completed = coordinator.cancelRun(prepared.statePath, { operation: 'cancelRun', input: { reason: '停止' } },
    { reportingService: service });
  const state = coordinator.loadCoordinatorState(prepared.statePath);
  assert.equal(submissions.length, 1);
  for (const response of [undefined, { status: 'FAILED', operation: 'advanceRun', result: { phase: 'COMPLETE' } },
    { status: 'SUCCEEDED', operation: 'advanceRun', result: { phase: 'INITIALIZING' } }]) {
    reportingIntegration.afterRequest(state, { operation: 'advanceRun' }, response, { reportingService: service });
    assert.equal(submissions.length, 1);
  }
  reportingIntegration.afterRequest(state, { operation: 'advanceRun' }, completed, { reportingService: service });
  assert.equal(submissions.length, 2);
});

test('terminal projection failure preserves its error and recovers the saved reporting attempt without submitting', t => {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-projection-'));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const repository = createRepository({ configDir: path.join(privateRoot, 'mavt') });
  const service = createReportingService({ repository, launcher: () => {} });
  service.updateSettings({ serverUrl: 'http://127.0.0.1:18188/' });
  const { prepared, root } = fixture(t, service);
  const options = confirmationOptions(service);
  const { confirm, ref } = readyConfirmation(prepared, options);
  assert.throws(() => confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ref, userInstruction: '确认执行' },
    { interruptAfter: 'environmentFrozen' }), /MAVT_COORDINATOR_INTERRUPTED/);
  coordinator.advanceRun(prepared.statePath, options);

  const projectionError = new Error('run summary projection failed');
  const originalPublish = resourceStore.publishSnapshot;
  t.mock.method(resourceStore, 'publishSnapshot', (...args) => {
    if (args[1] === 'runSummary') throw projectionError;
    return originalPublish(...args);
  });
  let thrown;
  try {
    coordinator.advanceRun(prepared.statePath, { ...options,
      batchExecute: () => ({ action: 'BATCH_COMPLETE', publicationState: { status: 'PUBLISHED' } }),
    });
  } catch (error) { thrown = error; }
  assert.equal(thrown, projectionError);
  const state = coordinator.loadCoordinatorState(prepared.statePath);
  assert.equal(state.phase, 'COMPLETE');
  assert.ok(state.initialization.reportingAttemptId);
  const intents = createIntents({ repository });
  assert.equal(intents.readRunSnapshot(root, state.batchId).attemptId, state.initialization.reportingAttemptId);
  assert.deepEqual(service.status(root), []);
});

test('reporting load failure adds an unavailable hint without blocking prepare', t => {
  const { prepared } = fixture(t, { preflight: () => { throw new Error('cannot load settings'); } });
  assert.equal(prepared.response.status, 'SUCCEEDED');
  assert.equal(prepared.response.result.reporting.code, 'REPORTING_UNAVAILABLE');
});

test('cancellation before confirmation records a skipped reporting submission', t => {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-unstarted-'));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const service = createReportingService({ repository: createRepository({ configDir: path.join(privateRoot, 'mavt') }), launcher: () => {} });
  const { root, prepared } = fixture(t, service);
  const cancelled = coordinator.cancelRun(prepared.statePath, { operation: 'cancelRun', input: { reason: '停止' } }, { reportingService: service });
  assert.equal(cancelled.status, 'SUCCEEDED');
  assert.equal(cancelled.result.phase, 'COMPLETE');
  assert.equal(cancelled.result.reporting.state, 'SKIPPED_NOT_STARTED');
  assert.equal(service.status(root).length, 1);
});

test('candidate storage failure leaves original confirmation result intact and unavailable', t => {
  const service = { preflight: () => ({ serverUrl: 'http://127.0.0.1:18188/', configured: true, autoUpload: true, noticeCode: null }),
    prepareRunSnapshot: () => { throw new Error('storage failed'); },
    submit: () => { throw new Error('must not submit without a frozen candidate'); } };
  const { prepared } = fixture(t, service);
  const options = confirmationOptions(service);
  const { confirm, ref } = readyConfirmation(prepared, options);
  assert.throws(() => confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ref, userInstruction: '确认执行' },
    { interruptAfter: 'environmentFrozen' }), /MAVT_COORDINATOR_INTERRUPTED/);
  const state = coordinator.loadCoordinatorState(prepared.statePath);
  assert.equal(state.environmentConfirmed, true);
  assert.equal(state.initialization.reportingAttemptId, undefined);
  const continued = coordinator.advanceRun(prepared.statePath, options);
  assert.equal(continued.status, 'SUCCEEDED');
  assert.equal(continued.result.reporting.code, 'REPORTING_UNAVAILABLE');
});

test('reporting tool descriptors have explicit effects, safe inputs, and workspace role', () => {
  const { descriptors, invoke } = require('../src/mobile-ai-visual-test/scripts/reporting/tools');
  const { definitions } = require('../src/mobile-ai-visual-test/scripts/mcp/contract');
  const { reportingTools } = require('./support/release-contract');
  assert.deepEqual(descriptors.map(item => item.name).sort(), reportingTools);
  const tools = definitions().filter(tool => tool.name.startsWith('mavt_reporting_'));
  assert.deepEqual(tools.map(item => item.name).sort(), reportingTools);
  for (const descriptor of descriptors) {
    const tool = tools.find(item => item.name === descriptor.name);
    assert.ok(tool);
    assert.deepEqual(tool.annotations, descriptor.annotations);
    assert.equal(JSON.stringify(tool.inputSchema).includes('Token'), false);
  }
  assert.equal(descriptors.find(item => item.name === 'mavt_reporting_settings_update').annotations.readOnlyHint, false);
  assert.equal(descriptors.find(item => item.name === 'mavt_reporting_identity_reset').annotations.destructiveHint, true);
  assert.equal(descriptors.find(item => item.name === 'mavt_reporting_check').annotations.openWorldHint, true);
  let pinned;
  const context = { workspace: '/fixture/workspace', runtimeRoot: '/fixture/bundle/runtime/mobile-ai-visual-test', bundleId: 'bundle-fixture' };
  const submitted = invoke('mavt_reporting_submit', { scope: 'workspace' }, context, {
    submit: input => { pinned = input; return { jobId: 'job-fixture', state: 'QUEUED' }; },
  });
  assert.equal(submitted.result.state, 'QUEUED');
  assert.deepEqual(pinned, { workspace: context.workspace, scope: 'workspace', trigger: 'manual',
    runtimeRoot: context.runtimeRoot, bundleId: context.bundleId });
});

test('confirmation persists the selected attempt before interrupted initialization and keeps its target', t => {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-config-'));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const repository = createRepository({ configDir: path.join(privateRoot, 'mavt') });
  const service = createReportingService({ repository, launcher: () => {} });
  service.updateSettings({ serverUrl: 'http://127.0.0.1:18188/' });
  const { prepared, root } = fixture(t, service);
  const options = confirmationOptions(service);
  const { confirm, ref } = readyConfirmation(prepared, options);
  const intents = createIntents({ repository });
  const competing = intents.prepareRunSnapshot({ workspace: root, batchId: prepared.batchId, request: { decision: 'CONFIRM_ENVIRONMENT' } });
  assert.throws(() => confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ref, userInstruction: '确认执行' },
    { interruptAfter: 'environmentFrozen' }), /MAVT_COORDINATOR_INTERRUPTED/);
  const state = coordinator.loadCoordinatorState(prepared.statePath);
  assert.equal(state.environmentConfirmed, true);
  assert.ok(state.initialization.reportingAttemptId);
  assert.equal(intents.readRunSnapshot(root, state.batchId).attemptId, state.initialization.reportingAttemptId);
  assert.notEqual(competing.attemptId, state.initialization.reportingAttemptId);
  service.updateSettings({ serverUrl: 'http://127.0.0.1:18189/' });
  const rejected = intents.prepareRunSnapshot({ workspace: root, batchId: state.batchId, request: { decision: 'CONFIRM_ENVIRONMENT' } });
  assert.notEqual(rejected.attemptId, state.initialization.reportingAttemptId);
  const after = coordinator.advanceRun(prepared.statePath, options);
  assert.equal(after.result.reporting.serverUrl, 'http://127.0.0.1:18188/');
  assert.equal(intents.readRunSnapshot(root, state.batchId).attemptId, state.initialization.reportingAttemptId);
  const terminal = coordinator.advanceRun(prepared.statePath, { ...options,
    batchExecute: () => ({ action: 'BATCH_COMPLETE', publicationState: { status: 'PUBLISHED' } }) });
  assert.equal(terminal.status, 'SUCCEEDED');
  assert.equal(terminal.result.phase, 'COMPLETE');
  assert.equal(terminal.result.reporting.state, 'SKIPPED_UNCONFIGURED');
  const jobsBeforeRead = service.status(root);
  const read = coordinator.executeRunRequest(prepared.statePath, { operation: 'read', input: { ref: terminal.data.ref } }, options);
  assert.deepEqual(read.data.content, terminal.data.content);
  assert.deepEqual(service.status(root), jobsBeforeRead);
  fs.rmSync(path.join(root, '.mavt/reporting/runs', `${state.batchId}.json`));
  fs.rmSync(path.join(root, '.mavt/reporting/attempts', `${state.initialization.reportingAttemptId}.json`));
  const missing = coordinator.advanceRun(prepared.statePath, options);
  assert.equal(missing.result.reporting.code, 'REPORTING_UNAVAILABLE');
  assert.deepEqual(service.status(root), jobsBeforeRead);
});

test('confirmed run keeps disabled automatic upload after global setting changes', t => {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-disabled-'));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const repository = createRepository({ configDir: path.join(privateRoot, 'mavt') });
  const service = createReportingService({ repository, launcher: () => {} });
  service.updateSettings({ serverUrl: 'http://127.0.0.1:18188/', autoUpload: false });
  const { prepared, root } = fixture(t, service);
  const options = confirmationOptions(service);
  const { confirm, ref } = readyConfirmation(prepared, options);
  assert.throws(() => confirm({ decision: 'CONFIRM_ENVIRONMENT', environmentRef: ref, userInstruction: '确认执行' },
    { interruptAfter: 'environmentFrozen' }), /MAVT_COORDINATOR_INTERRUPTED/);
  service.updateSettings({ autoUpload: true });
  coordinator.advanceRun(prepared.statePath, options);
  const terminal = coordinator.advanceRun(prepared.statePath, { ...options,
    batchExecute: () => ({ action: 'BATCH_BLOCKED', failureCode: 'FIXTURE_BLOCKED', reason: 'fixture', publicationState: { status: 'DEGRADED' } }) });
  assert.equal(terminal.status, 'SUCCEEDED');
  assert.equal(terminal.result.phase, 'BLOCKED');
  assert.equal(terminal.result.reporting.state, 'SKIPPED_DISABLED');
  assert.equal(service.status(root).length, 1);
});

test('transport changes alter bundle identity but leave Case runtime identity unchanged', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-identity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const { buildPlugin } = require('../build-plugin');
  const { createManifest } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  const { buildContract } = require('../src/mobile-ai-visual-test/scripts/build-agent-contract');
  const built = buildPlugin({ outputRoot: path.join(temp, 'built') });
  const skillRoot = path.join(built.pluginRoot, 'runtime/mobile-ai-visual-test');
  const before = buildContract({ skillRoot, role: 'case-executor', platform: 'harmony' });
  const bundleId = createManifest(built.pluginRoot, 'fixture').bundleId;
  fs.appendFileSync(path.join(skillRoot, 'scripts/reporting/transport.js'), '\n// transport fixture change\n');
  const after = buildContract({ skillRoot, role: 'case-executor', platform: 'harmony' });
  assert.equal(after.runtimeSha, before.runtimeSha);
  assert.notEqual(createManifest(built.pluginRoot, 'fixture').bundleId, bundleId);
});
