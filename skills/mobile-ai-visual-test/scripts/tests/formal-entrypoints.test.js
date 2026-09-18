#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { batchTechnicalResponse, commitWithDashboard } = require('../batch');

const repo = path.resolve(__dirname, '../..');
const batchTechnical = batchTechnicalResponse(new Error('unexpected batch failure'), {
  command: 'status',
  batchId: 'batch-doc-ref',
});
assert.strictEqual(batchTechnical.status, 'TECHNICAL');
assert.match(batchTechnical.documentationRef, /references\/commands\/errors\/execution\.md#technical$/);
const versionMismatch = new Error('batch belongs to a different runtimeSha');
versionMismatch.code = 'BATCH_IMPLEMENTATION_MISMATCH';
versionMismatch.errorKind = 'DOMAIN';
const batchVersionMismatch = batchTechnicalResponse(versionMismatch, {
  command: 'reconcile',
  batchId: 'batch-version-mismatch',
});
assert.strictEqual(batchVersionMismatch.status, 'FAILED');
assert.strictEqual(batchVersionMismatch.retryable, false);
assert.match(batchVersionMismatch.documentationRef, /references\/commands\/errors\/execution\.md#error-batch-implementation-mismatch$/);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-formal-entrypoints-'));
const workspace = path.join(temp, 'workspace');
const input = path.join(temp, 'free-form.txt');
assert.strictEqual(fs.existsSync(path.join(repo, 'scripts', 'knowledge.js')), false);
assert.strictEqual(fs.existsSync(path.join(repo, 'references', 'commands', 'knowledge.md')), false);
assert.strictEqual(fs.existsSync(path.join(repo, 'references', 'commands', 'errors', 'knowledge.md')), false);
fs.mkdirSync(workspace);
fs.writeFileSync(input, '看一下当前页面是否符合用例描述，不限定输入格式。\n');

function run(args) {
  return JSON.parse(childProcess.execFileSync(process.execPath, args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
  }));
}

const committedFixture = {
  state: { status: 'RUNNING' },
  item: { caseDir: '/tmp/case' },
  completion: { platform: 'harmony' },
};
const isolatedRefresh = commitWithDashboard({}, () => {
  const error = new Error('REPORT_REFRESH_TEST_FAILED: simulated');
  error.code = 'REPORT_REFRESH_TEST_FAILED';
  throw error;
}, () => committedFixture);
assert.strictEqual(isolatedRefresh.state.status, 'RUNNING');
assert.strictEqual(isolatedRefresh.dashboardRefresh.status, 'FAILED');
assert.strictEqual(isolatedRefresh.dashboardRefresh.errorCode, 'REPORT_REFRESH_TEST_FAILED');

const initialized = run(['scripts/workspace.js', '--cwd', workspace]);
assert.strictEqual(initialized.marker.type, 'mobile-ai-visual-test-workspace');
assert.strictEqual(initialized.initialized, true);
assert.strictEqual(fs.existsSync(path.join(workspace, 'flows')), false);
assert.strictEqual(initialized.coordinatorFacade.interfaceKind, 'AGENT_FACING');
assert.strictEqual(initialized.coordinatorFacade.protocol, 'agent-facing');
assert.strictEqual(initialized.coordinatorFacade.documentation, 'references/coordinator.md');
assert.strictEqual(initialized.coordinatorFacade.command,
  `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(repo, 'scripts', 'coordinator-agent.js'))}`);
assert.deepStrictEqual(Object.keys(initialized.coordinatorFacade).sort(), ['command', 'documentation', 'interfaceKind', 'protocol']);
assert.strictEqual(initialized.coordinatorCapabilities, undefined);
assert.strictEqual(JSON.stringify(initialized.coordinatorFacade).includes('definitionRef'), false);
assert.strictEqual(JSON.stringify(initialized.coordinatorFacade).includes('batchId'), false);

const imported = run(['scripts/import-case.js', input, '--workspace', workspace]);
assert.strictEqual(imported.caseJson.schemaVersion, 2);
assert.strictEqual(imported.caseJson.steps, undefined);
assert.strictEqual(fs.readFileSync(imported.sourcePath, 'utf8'), fs.readFileSync(input, 'utf8'));
assert.strictEqual(fs.existsSync(imported.contextHtml), true);
assert.ok(fs.readFileSync(imported.contextHtml, 'utf8').includes('看一下当前页面是否符合用例描述'));
assert.ok(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8').includes('查看用例内容'));
const preparedFromWorkspace = childProcess.spawnSync(
  `${initialized.coordinatorFacade.command} prepare --workspace ${JSON.stringify(path.resolve(workspace))} --case-nos ${imported.caseJson.identity.caseNo}`,
  {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
    shell: true,
  },
);
assert.strictEqual(preparedFromWorkspace.status, 0, preparedFromWorkspace.stderr);
assert.strictEqual(JSON.parse(preparedFromWorkspace.stdout).status, 'NEED_USER_CONFIRMATION');
fs.rmSync(path.join(workspace, 'runs'), { recursive: true, force: true });

const contract = run(['scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony']);
assert.strictEqual(Object.prototype.hasOwnProperty.call(contract, 'schemaVersion'), false);
assert.strictEqual(contract.profile, undefined);
assert.deepStrictEqual(contract.requiredResources, [
  'prompts/case-agent.md',
  'references/case-execution-principles.md',
  'references/case-runtime.md',
  'references/case-runtime/methods/observe.md',
  'references/case-runtime/methods/inspect.md',
  'references/case-runtime/methods/plan.md',
  'references/case-runtime/methods/record-result.md',
  'references/case-runtime/methods/act.md',
  'references/case-runtime/methods/knowledge.md',
  'references/case-runtime/methods/recover.md',
  'references/case-runtime/methods/finish.md',
  'references/case-runtime/action-refs.md',
  'references/case-runtime/errors.md',
  'references/case-runtime/errors/transport.md',
  'references/case-runtime/errors/scene-action.md',
  'references/case-runtime/errors/flow-result.md',
  'references/case-runtime/errors/knowledge-recovery.md',
]);
assert.deepStrictEqual(contract.allowedEntrypoints, [
  'scripts/case-runtime/agent-facing-client.js',
  'scripts/case-runtime/mcp-server.js',
]);
assert.strictEqual(contract.allowedEntrypoints.includes('scripts/build-agent-contract.js'), false);
assert.strictEqual(contract.allowedEntrypoints.includes('scripts/execute-next-work.js'), false);
assert.strictEqual(contract.allowedEntrypoints.includes('scripts/agent/finalize.js'), false);
assert.strictEqual(contract.allowedEntrypoints.includes('scripts/agent/query-knowledge.js'), false);
const coordinatorContract = run(['scripts/build-agent-contract.js', '--role', 'batch-coordinator', '--platform', 'harmony']);
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract.coordinatorFacade, 'schemaVersion'), false);
assert.strictEqual(coordinatorContract.requiredResources[0], 'SKILL.md');
assert.ok(coordinatorContract.requiredResources.includes('references/coordinator.md'));
assert.ok(coordinatorContract.requiredResources.includes('references/coordinator/errors.md'));
assert.strictEqual(coordinatorContract.requiredResources.includes('prompts/case-agent.md'), false);
assert.deepStrictEqual(coordinatorContract.allowedEntrypoints, ['scripts/coordinator-agent.js']);
assert.deepStrictEqual(coordinatorContract.coordinatorFacade, {
  interfaceKind: 'AGENT_FACING',
  protocol: 'agent-facing',
  command: 'scripts/coordinator-agent.js',
  documentation: 'references/coordinator.md',
});
assert.strictEqual(coordinatorContract.coordinatorCapabilities, undefined);
assert.strictEqual(fs.existsSync(path.join(repo, 'prompts/main-agent.md')), false);

const invalidEnvironment = childProcess.spawnSync(process.execPath, [
  'scripts/environment.js', 'confirm', '--workspace', workspace,
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.strictEqual(invalidEnvironment.status, 2);
const invalidEnvironmentResponse = JSON.parse(invalidEnvironment.stderr);
assert.strictEqual(invalidEnvironmentResponse.status, 'REQUEST_INVALID');
assert.strictEqual(invalidEnvironmentResponse.command, 'scripts/environment.js confirm');
assert.ok(invalidEnvironmentResponse.issues.length >= 1);
assert.match(invalidEnvironmentResponse.usage, /--binding-json/);
assert.ok(Array.isArray(invalidEnvironmentResponse.example));

const invalidBinding = childProcess.spawnSync(process.execPath, [
  'scripts/environment.js', 'confirm', '--workspace', workspace,
  '--binding-json', '{}', '--probe-json', '{}', '--user-confirmation', 'invalid fixture',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.strictEqual(invalidBinding.status, 2);
const invalidBindingResponse = JSON.parse(invalidBinding.stderr);
assert.deepStrictEqual(invalidBindingResponse.issues.map((issue) => issue.fieldPath), [
  'bindingJson.platform',
  'bindingJson.deviceId',
  'bindingJson.appId',
]);

for (const fixture of [
  { args: ['scripts/workspace.js'], command: 'scripts/workspace.js' },
  { args: ['scripts/coordinator-agent.js'], command: 'scripts/coordinator-agent.js prepare', compactError: true },
  { args: ['scripts/import-case.js'], command: 'scripts/import-case.js' },
  { args: ['scripts/import-cases.js'], command: 'scripts/import-cases.js' },
  { args: ['scripts/build-agent-contract.js'], command: 'scripts/build-agent-contract.js' },
  { args: ['scripts/probe-env.sh'], command: 'scripts/probe-env.sh', executable: 'bash' },
  { args: ['scripts/prepare-env.sh'], command: 'scripts/prepare-env.sh', executable: 'bash' },
  { args: ['scripts/environment.js', 'unknown'], command: 'scripts/environment.js confirm' },
  { args: ['scripts/app-artifact.js', 'unknown'], command: 'scripts/app-artifact.js register' },
  { args: ['scripts/execution-request.js', 'unknown'], command: 'scripts/execution-request.js create' },
  { args: ['scripts/batch.js', 'unknown'], command: 'scripts/batch.js init' },
  { args: ['scripts/render-context.js'], command: 'scripts/render-context.js' },
  { args: ['scripts/render-index.js', workspace, '--unknown'], command: 'scripts/render-index.js' },
]) {
  const result = childProcess.spawnSync(fixture.executable || process.execPath, fixture.args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
  });
  assert.notStrictEqual(result.status, 0, `${fixture.command} invalid call must fail`);
  const response = JSON.parse(result.stderr);
  assert.strictEqual(response.status, 'REQUEST_INVALID');
  assert.ok(response.issues.length >= 1);
  if (fixture.compactError) {
    assert.strictEqual(response.protocol, 'agent-facing');
    assert.match(response.documentationRef, /references\/coordinator\/errors\/input-state\.md#/);
    for (const field of ['command', 'usage', 'example', 'retryWith', 'nextCall']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(response, field), false);
    }
  } else {
    assert.strictEqual(response.command, fixture.command);
    assert.ok(response.usage);
    assert.ok(response.example.length);
  }
}

for (const fixture of [
  ['scripts/app-artifact.js', 'register', '--unknown', 'value'],
  ['scripts/batch.js', 'status', '--unknown', 'value'],
  ['scripts/environment.js', 'status', '--unknown', 'value'],
  ['scripts/execution-request.js', 'status', '--unknown', 'value'],
  ['scripts/coordinator-agent.js', 'prepare', '--unknown', 'value'],
]) {
  const result = childProcess.spawnSync(process.execPath, fixture, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
  });
  assert.notStrictEqual(result.status, 0);
  const response = JSON.parse(result.stderr);
  assert.strictEqual(response.status, 'REQUEST_INVALID');
  assert.ok(response.issues.some((issue) => issue.code === 'UNKNOWN_ARGUMENT'));
  assert.ok(response.documentationRef);
}

const duplicateBatchFlag = childProcess.spawnSync(process.execPath, [
  'scripts/batch.js', 'status', '--workspace', '/tmp/a', '--workspace', '/tmp/b', '--batch-id', 'batch-1',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(duplicateBatchFlag.status, 0);
assert.ok(JSON.parse(duplicateBatchFlag.stderr).issues.some((issue) => issue.code === 'DUPLICATE_ARGUMENT'));

const invalidArtifactPlatform = childProcess.spawnSync(process.execPath, [
  'scripts/app-artifact.js', 'register', '--workspace', '/tmp/a', '--path', '/tmp/app',
  '--platform', 'windows', '--app-id', 'app', '--version', '1', '--build', '1',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(invalidArtifactPlatform.status, 0);
assert.ok(JSON.parse(invalidArtifactPlatform.stderr).issues.some((issue) => issue.code === 'ENUM_INVALID'));

for (const fixture of [
  ['scripts/workspace.js', '--cwd', '/tmp/a', '--cwd', '/tmp/b'],
  ['scripts/import-case.js', '/tmp/input', '--workspace', '/tmp/a', '--workspace', '/tmp/b'],
  ['scripts/import-cases.js', '--request-file', '/tmp/request', '--workspace', '/tmp/a', '--workspace', '/tmp/b'],
  ['scripts/build-agent-contract.js', '--role', 'case-executor', '--role', 'batch-coordinator', '--platform', 'ios'],
  ['scripts/render-context.js', '/tmp/case', '--platform', 'ios', '--platform', 'android'],
]) {
  const result = childProcess.spawnSync(process.execPath, fixture, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
  });
  assert.notStrictEqual(result.status, 0);
  const response = JSON.parse(result.stderr);
  assert.strictEqual(response.status, 'REQUEST_INVALID');
  assert.ok(response.issues.some((issue) => issue.code === 'DUPLICATE_ARGUMENT'));
}

for (const fixture of [
  ['scripts/probe-env.sh', '--platform', 'invalid', '--platform', 'invalid'],
  ['scripts/prepare-env.sh', '--platform', 'invalid', '--platform', 'invalid'],
]) {
  const result = childProcess.spawnSync('bash', fixture, { cwd: repo, encoding: 'utf8', env: process.env });
  assert.strictEqual(result.status, 2);
  const response = JSON.parse(result.stderr);
  assert.strictEqual(response.status, 'REQUEST_INVALID');
  assert.ok(response.issues.some((issue) => issue.code === 'DUPLICATE_ARGUMENT'));
}

for (const script of ['scripts/probe-env.sh', 'scripts/prepare-env.sh']) {
  const result = childProcess.spawnSync('bash', [script, '--platform'], { cwd: repo, encoding: 'utf8', env: process.env });
  assert.strictEqual(result.status, 2);
  const response = JSON.parse(result.stderr);
  assert.strictEqual(response.status, 'REQUEST_INVALID');
  assert.ok(response.issues.some((issue) => issue.code === 'REQUIRED_FIELD_MISSING'));
}

assert.strictEqual(fs.existsSync(path.join(repo, 'scripts/agent')), false);

const batchId = 'batch-formal-entrypoints';
const binding = { platform: 'harmony', deviceId: 'offline-device', appId: 'com.example.app', entry: 'EntryAbility' };
const probe = { schemaVersion: 1, platform: 'harmony', ready: true, devices: [{ id: 'offline-device' }] };
const environment = run([
  'scripts/environment.js', 'confirm', '--workspace', workspace,
  '--binding-json', JSON.stringify(binding), '--probe-json', JSON.stringify(probe),
  '--user-confirmation', '确认使用离线测试设备和目标应用',
]);
assert.strictEqual(environment.status, 'CONFIRMED');
assert.strictEqual(fs.existsSync(path.join(workspace, 'runs')), false);
assert.strictEqual(fs.existsSync(path.join(workspace, 'environment-confirmation.json')), true);

const executionRequest = run([
  'scripts/execution-request.js', 'create', '--workspace', workspace, '--batch-id', batchId,
  '--mode', 'single',
  '--targets-json', JSON.stringify([{ caseNo: imported.caseJson.identity.caseNo }]),
  '--user-instruction', '单独执行当前导入的用例',
]);
assert.strictEqual(executionRequest.mode, 'SINGLE');
assert.strictEqual(executionRequest.interactionPolicy, 'UNATTENDED');
assert.strictEqual(fs.existsSync(path.join(workspace, 'runs', batchId, 'batch.json')), false);

const initializedBatch = run([
  'scripts/batch.js', 'init', '--workspace', workspace, '--batch-id', batchId,
]);
assert.strictEqual(initializedBatch.state.status, 'INITIALIZING');
assert.strictEqual(initializedBatch.state.interactionPolicy, 'UNATTENDED');
assert.strictEqual(initializedBatch.contract.executionRequestSha, executionRequest.requestSha);
assert.strictEqual(initializedBatch.contract.runtimeSha, contract.runtimeSha);
assert.strictEqual(initializedBatch.contract.adapterSha, contract.adapterSha);
const status = run(['scripts/batch.js', 'status', '--workspace', workspace, '--batch-id', batchId]);
assert.strictEqual(status.state.currentIndex, 0);
assert.strictEqual(status.state.cases[0].executionId, null);

const implicitBatch = childProcess.spawnSync(process.execPath, [
  'scripts/batch.js', 'init', '--workspace', workspace, '--batch-id', 'batch-implicit',
  '--binding-json', JSON.stringify(binding), '--targets-json', JSON.stringify(executionRequest.targets),
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(implicitBatch.status, 0);
const implicitFailure = JSON.parse(implicitBatch.stderr);
assert.strictEqual(implicitFailure.status, 'REQUEST_INVALID');
assert.ok(implicitFailure.issues.some((issue) => issue.code === 'UNKNOWN_ARGUMENT'));

const profile = childProcess.spawnSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony', '--profile', 'agent-driven',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(profile.status, 0);

fs.rmSync(temp, { recursive: true, force: true });
console.log('formal-entrypoints passed');
