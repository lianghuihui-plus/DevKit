#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { invokeDeviceOperation, invokeScreenshotCapture } = require('../platform/device-port');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-device-operation-timeout-'));

function fixture(name) {
  const execDir = path.join(root, name);
  fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
  const binding = {
    platform: 'harmony', deviceId: 'timeout-device', appId: 'com.example.timeout', entry: 'EntryAbility',
  };
  const execution = {
    schemaVersion: 14,
    runtime: 'case-runtime',
    executionId: `execution-${name}`,
    platform: 'harmony',
    targetBinding: binding,
    targetBindingSha: bindingSha(binding),
    batchContractSha: 'batch-contract-timeout-fixture',
    startedAt: '2026-09-24T10:00:00.000Z',
  };
  writeJsonAtomic(path.join(execDir, 'execution.json'), execution);
  writeJsonAtomic(path.join(execDir, 'binding.snapshot.json'), {
    schemaVersion: 1,
    binding,
    bindingSha: execution.targetBindingSha,
    batchContractSha: execution.batchContractSha,
  });
  return { execDir, execution, binding };
}

function runner(binding, expectedTimeoutMs) {
  return (_command, args, options) => {
    assert.strictEqual(options.timeoutMs, expectedTimeoutMs);
    if (options.kind === 'ACTION') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schemaVersion: 2,
          type: 'actionResult',
          platform: 'harmony',
          action: 'wait',
          command: { status: 'ACCEPTED', transport: 'TEST', elapsedMs: 1 },
          deviceExecution: { status: 'UNVERIFIED', verification: 'REQUEST_ECHO', actualTouchPoint: null },
          device: { id: binding.deviceId },
          app: { appId: binding.appId },
        }),
      };
    }
    const out = args[args.indexOf('--out') + 1];
    const label = args[args.indexOf('--label') + 1];
    const screenshot = `screenshots/${label}.png`;
    fs.writeFileSync(path.join(out, screenshot), PNG);
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify({
        schemaVersion: 1,
        type: options.kind === 'CAPTURE' ? 'capture' : 'observation',
        platform: 'harmony',
        time: '2026-09-24T10:00:00.000Z',
        device: { id: binding.deviceId },
        app: { appId: binding.appId },
        artifacts: { screenshot, layout: null, logs: [] },
      }),
    };
  };
}

for (const [name, now, expectedTimeoutMs] of [
  ['requested-budget', '2026-09-24T10:00:01.000Z', 1200],
  ['execution-budget', '2026-09-24T10:29:59.400Z', 600],
]) {
  const { execDir, execution, binding } = fixture(name);
  const options = { now, timeoutMs: 1200, runner: runner(binding, expectedTimeoutMs) };
  invokeDeviceOperation(execDir, {
    context: { execution },
    operationId: `action-${name}`,
    action: { type: 'wait', ms: 1 },
    request: {},
  }, 'ACTION', options);
  invokeScreenshotCapture(execDir, {
    context: { execution },
    operationId: `capture-${name}`,
  }, options);
  invokeDeviceOperation(execDir, {
    context: { execution },
    operationId: `observation-${name}`,
    request: { purpose: 'CURRENT_SCENE' },
  }, 'OBSERVE', options);
}

const noBudget = fixture('no-budget');
let runnerInvoked = false;
assert.throws(() => invokeDeviceOperation(noBudget.execDir, {
  context: { execution: noBudget.execution },
  operationId: 'action-no-budget',
  action: { type: 'wait', ms: 1 },
  request: {},
}, 'ACTION', {
  now: '2026-09-24T10:00:01.000Z',
  timeoutMs: 0,
  runner() { runnerInvoked = true; },
}), (error) => error.code === 'DEVICE_OPERATION_TIMEOUT'
  && error.timeoutMs === 0 && error.callerTimeoutMs === 0);
assert.strictEqual(runnerInvoked, false);

const expiredExecution = fixture('expired-execution');
let expiredRunnerCalls = 0;
const expiredOptions = {
  now: '2026-09-24T10:30:00.000Z',
  timeoutMs: 1200,
  runner() { expiredRunnerCalls += 1; },
};
for (const invoke of [
  () => invokeDeviceOperation(expiredExecution.execDir, {
    context: { execution: expiredExecution.execution },
    operationId: 'action-expired-execution',
    action: { type: 'wait', ms: 1 },
    request: {},
  }, 'ACTION', expiredOptions),
  () => invokeScreenshotCapture(expiredExecution.execDir, {
    context: { execution: expiredExecution.execution },
    operationId: 'capture-expired-execution',
  }, expiredOptions),
  () => invokeDeviceOperation(expiredExecution.execDir, {
    context: { execution: expiredExecution.execution },
    operationId: 'observation-expired-execution',
    request: { purpose: 'CURRENT_SCENE' },
  }, 'OBSERVE', expiredOptions),
]) {
  assert.throws(invoke, (error) => error.code === 'DEVICE_OPERATION_TIMEOUT'
    && error.timeoutMs === 0 && error.callerTimeoutMs === 1200);
}
assert.strictEqual(expiredRunnerCalls, 0);

console.log('device operation timeout passed');
