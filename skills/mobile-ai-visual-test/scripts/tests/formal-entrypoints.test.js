#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-formal-entrypoints-'));
const workspace = path.join(temp, 'workspace');
const input = path.join(temp, 'free-form.txt');
fs.mkdirSync(workspace);
fs.writeFileSync(input, '看一下当前页面是否符合用例描述，不限定输入格式。\n');

function run(args) {
  return JSON.parse(childProcess.execFileSync(process.execPath, args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MAVT_SELF_TEST: '' },
  }));
}

const initialized = run(['scripts/workspace.js', '--cwd', workspace]);
assert.strictEqual(initialized.marker.type, 'mobile-ai-visual-test-workspace');
assert.strictEqual(initialized.initialized, true);
assert.strictEqual(fs.existsSync(path.join(workspace, 'flows')), false);

const imported = run(['scripts/import-case.js', input, '--workspace', workspace]);
assert.strictEqual(imported.caseJson.schemaVersion, 2);
assert.strictEqual(imported.caseJson.steps, undefined);
assert.strictEqual(fs.readFileSync(imported.sourcePath, 'utf8'), fs.readFileSync(input, 'utf8'));
assert.strictEqual(fs.existsSync(imported.contextHtml), true);
assert.ok(fs.readFileSync(imported.contextHtml, 'utf8').includes('看一下当前页面是否符合用例描述'));
assert.ok(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8').includes('查看详情'));

const contract = run(['scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony']);
assert.strictEqual(contract.schemaVersion, 2);
assert.strictEqual(contract.profile, undefined);
assert.strictEqual(contract.requiredResources[0], 'SKILL.md');
assert.strictEqual(contract.allowedEntrypoints.includes('scripts/execute-next-work.js'), false);

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
  '--targets-json', JSON.stringify([{ caseKey: imported.caseJson.identity.caseKey, caseDir: imported.caseDir }]),
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
assert.strictEqual(initializedBatch.contract.implementationSha, contract.implementationSha);
const status = run(['scripts/batch.js', 'status', '--workspace', workspace, '--batch-id', batchId]);
assert.strictEqual(status.state.currentIndex, 0);
assert.strictEqual(status.state.cases[0].executionId, null);

const implicitBatch = childProcess.spawnSync(process.execPath, [
  'scripts/batch.js', 'init', '--workspace', workspace, '--batch-id', 'batch-implicit',
  '--binding-json', JSON.stringify(binding), '--targets-json', JSON.stringify(executionRequest.targets),
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(implicitBatch.status, 0);
assert.match(implicitBatch.stderr, /no longer accepts --binding-json or --targets-json/);

const profile = childProcess.spawnSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony', '--profile', 'agent-driven',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.notStrictEqual(profile.status, 0);

fs.rmSync(temp, { recursive: true, force: true });
console.log('formal-entrypoints passed');
