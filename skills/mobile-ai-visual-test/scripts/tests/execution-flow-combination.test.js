#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { confirmRun } = require('../coordinator/agent-facing-service');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { confirmEnvironment } = require('../lib/run-control');
const { collectIndexCases } = require('../report/report-service');

const skillRoot = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-flow-combination-'));
const workspace = path.join(temp, 'workspace');
const childEnv = { ...process.env, MAVT_SELF_TEST: '', MAVT_IOS_FAKE: '1' };
fs.mkdirSync(workspace);

function run(executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, {
    cwd: skillRoot,
    encoding: 'utf8',
    env: { ...childEnv, ...(options.env || {}) },
    input: options.input === undefined ? undefined : JSON.stringify(options.input),
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return options.json === false ? result.stdout.trim() : JSON.parse(result.stdout);
}

function runCoordinator(args, request) {
  return run(process.execPath, ['scripts/coordinator-agent.js', ...args], { input: request });
}
function statePath(response) { return response.result.command.match(/ --state '([^']+)'$/)[1]; }
function submit(response, request) {
  return run('/bin/zsh', ['-c', response.result.command], { input: request });
}
function createCase(caseNo) {
  const source = `验证组合流程用例 ${caseNo}`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseDir = path.join(workspace, 'cases', `${caseNo}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({
    caseKey,
    caseNo,
    title: `${caseNo} 组合流程`,
    sourceText: source,
    importPath: `/fixtures/${caseNo}.md`,
  }));
  return { caseNo, caseKey, caseDir };
}

try {
  const initialized = run(process.execPath, ['scripts/workspace.js', '--cwd', workspace]);
  assert.strictEqual(initialized.initialized, true);

  const probe = run('/bin/bash', ['scripts/probe-env.sh', '--platform', 'ios']);
  assert.strictEqual(probe.ready, true);
  assert.strictEqual(probe.platform, 'ios');
  assert.strictEqual(probe.devices[0].id, 'FAKE-IOS-SIMULATOR');

  const current = createCase('014');
  confirmEnvironment({
    workspaceRoot: workspace,
    binding: { platform: 'harmony', deviceId: 'harmony-existing', appId: 'com.example.existing', entry: 'EntryAbility' },
    probe: { schemaVersion: 1, platform: 'harmony', ready: true, devices: [{ id: 'harmony-existing' }] },
    userConfirmation: '确认已有 HarmonyOS 测试环境',
    now: '2026-09-14T08:01:00.000Z',
  });

  const prepared = runCoordinator(['--workspace', workspace], { operation: 'prepareRun', input: { caseNos: [current.caseNo] } });
  assert.strictEqual(prepared.result.outcome, 'NEED_USER_CONFIRMATION');
  assert.strictEqual(prepared.data.content.binding.platform, 'harmony');
  const selectIos = prepared.data.content.choices.find((choice) => choice.id === 'SELECT_IOS');
  const needIosBinding = submit(prepared, { operation: 'confirmRun', input: { decision: selectIos.decision, platform: selectIos.platform,
   } });
  assert.strictEqual(needIosBinding.result.outcome, 'NEED_USER_CONFIRMATION');
  assert.strictEqual(needIosBinding.data.content.binding.platform, 'ios');
  const iosConfirmation = { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
    userInstruction: '确认切换到 fake iOS 环境执行 014',
    binding: {
      ...needIosBinding.data.content.binding,
      appId: 'com.example.ios',
      entry: 'com.example.ios.Main',
    },
   } };
  const switched = submit(needIosBinding, iosConfirmation);
  assert.strictEqual(switched.result.outcome, 'CONFIRMED');
  const frozenRequest = JSON.parse(fs.readFileSync(path.join(path.dirname(statePath(switched)), 'execution-request.json'), 'utf8'));
  assert.strictEqual(frozenRequest.binding.platform, 'ios');

  const interrupted = runCoordinator(['--workspace', workspace], { operation: 'prepareRun', input: { caseNos: [current.caseNo] } });
  assert.throws(() => confirmRun(statePath(interrupted), { operation: 'confirmRun', input: { decision: 'USE_CURRENT',
    userInstruction: '验证初始化中断后由真实 CLI 恢复',
   } }, {
    interruptAfter: 'environmentFrozen',
    now: '2026-09-14T08:02:00.000Z',
  }), /MAVT_COORDINATOR_INTERRUPTED: environmentFrozen/);
  const recovered = submit(interrupted, { operation: 'advanceRun', input: {} });
  assert.strictEqual(recovered.result.outcome, 'CONFIRMED');
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath(interrupted), 'utf8')).phase, 'BATCH_READY');

  const delegated = submit(interrupted, { operation: 'advanceRun', input: {} });
  assert.strictEqual(delegated.result.outcome, 'NEED_CASE_AGENT');
  const delegatedAgain = submit(interrupted, { operation: 'advanceRun', input: {} });
  assert.strictEqual(delegatedAgain.result.outcome, 'NEED_CASE_AGENT');
  assert.strictEqual(delegatedAgain.data.content.loaderCommand, delegated.data.content.loaderCommand);
  const claimed = childProcess.spawnSync('/bin/zsh', ['-lc', delegated.data.content.loaderCommand], {
    cwd: skillRoot,
    encoding: 'utf8',
    env: childEnv,
  });
  assert.strictEqual(claimed.status, 0, claimed.stderr || claimed.stdout);
  const waitingAgain = submit(interrupted, { operation: 'advanceRun', input: {} });
  assert.strictEqual(waitingAgain.result.outcome, 'WAITING');
  assert.strictEqual(waitingAgain.data.content.reason, 'WAIT_EXECUTION_RESULT');
  assert.strictEqual(waitingAgain.result.waitFor, 'EXECUTION_RESULT');

  fs.writeFileSync(path.join(path.dirname(statePath(interrupted)), 'report-publication.json'), '{ invalid json');
  const cancelled = submit(waitingAgain, { operation: 'cancelRun', input: { reason: '组合测试取消'  } });
  assert.strictEqual(cancelled.result.outcome, 'COMPLETE');
  assert.strictEqual(cancelled.data.content.runOutcome, 'CANCELLED');
  assert.strictEqual(cancelled.result.reportStatus, 'DEGRADED');
  assert.strictEqual(cancelled.data.content.reportPath, undefined);
  const cancelledAgain = submit(interrupted, { operation: 'advanceRun', input: {} });
  assert.strictEqual(cancelledAgain.result.outcome, 'COMPLETE');
  assert.strictEqual(cancelledAgain.data.content.runOutcome, 'CANCELLED');
  assert.strictEqual(cancelledAgain.result.reportStatus, 'DEGRADED');

  const historical = createCase('099');
  const oldExecutionDir = path.join(historical.caseDir, 'platforms', 'harmony', 'executions', 'execution-schema-10');
  fs.mkdirSync(oldExecutionDir, { recursive: true });
  const oldExecution = `${JSON.stringify({
    schemaVersion: 10,
    runtime: 'case-runtime',
    executionId: 'execution-schema-10',
    platform: 'harmony',
    startedAt: '2026-09-14T07:00:00.000Z',
    endedAt: '2026-09-14T07:01:00.000Z',
    finalized: true,
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(oldExecutionDir, 'execution.json'), oldExecution);
  const indexPath = run(process.execPath, ['scripts/render-index.js', workspace], { json: false });
  assert.strictEqual(indexPath, path.join(workspace, 'index.html'));
  const cases = collectIndexCases(workspace);
  const historicalSummary = cases.find((item) => item.caseKey === historical.caseKey);
  const currentSummary = cases.find((item) => item.caseKey === current.caseKey);
  assert.strictEqual(historicalSummary.status, 'NEEDS_RERUN');
  assert.strictEqual(historicalSummary.platforms[0].readability, 'FORMAT_UNSUPPORTED');
  assert.notStrictEqual(currentSummary.status, 'REPORT_ERROR');
  assert.strictEqual(fs.readFileSync(path.join(oldExecutionDir, 'execution.json'), 'utf8'), oldExecution);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('execution flow combination passed');
