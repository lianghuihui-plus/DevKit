#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { invokeScreenshotCapture } = require('../platform/device-port');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-platform-capture-'));

function fixture(platform) {
  const execDir = path.join(root, platform);
  fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
  const binding = {
    platform, deviceId: `${platform}-device`, appId: `com.example.${platform}`,
    ...(platform === 'ios' ? {} : { entry: 'EntryAbility' }),
  };
  const execution = {
    schemaVersion: 14, runtime: 'case-runtime', executionId: `execution-${platform}`,
    platform, targetBinding: binding, targetBindingSha: bindingSha(binding),
    batchContractSha: 'batch-contract-fixture', startedAt: '2026-09-20T00:00:00.000Z',
  };
  writeJsonAtomic(path.join(execDir, 'execution.json'), execution);
  writeJsonAtomic(path.join(execDir, 'binding.snapshot.json'), {
    schemaVersion: 1, binding, bindingSha: execution.targetBindingSha, batchContractSha: execution.batchContractSha,
  });
  if (platform === 'ios') {
    const batchDir = path.join(root, 'ios-batch');
    fs.mkdirSync(batchDir, { recursive: true });
    const sessionRef = {
      schemaVersion: 2, batchId: 'batch-ios-capture',
      statePath: path.join(batchDir, 'batch.json'), lockPath: path.join(batchDir, 'batch.lock'),
      eventsPath: path.join(batchDir, 'events.jsonl'), platformRuntimePath: path.join(batchDir, 'platform-runtime.json'),
    };
    writeJsonAtomic(sessionRef.statePath, { batchId: sessionRef.batchId });
    writeJsonAtomic(sessionRef.platformRuntimePath, {
      schemaVersion: 1, type: 'batchPlatformRuntime', batchId: sessionRef.batchId, platform: 'ios',
      status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED',
      resource: { session: { sessionId: 'ios-session', generation: 1, capabilities: { platformName: 'iOS' } } },
    });
    writeJsonAtomic(path.join(execDir, 'runtime.json'), { schemaVersion: 1, sessionRef });
  }
  return { execDir, execution, binding };
}

for (const platform of ['android', 'harmony', 'ios']) {
  const { execDir, execution, binding } = fixture(platform);
  let timeoutMs = null;
  const result = invokeScreenshotCapture(execDir, {
    context: { execution }, operationId: `capture-${platform}`,
  }, {
    now: '2026-09-20T00:00:01.000Z',
    timeoutMs: 900,
    runner(command, args, options) {
      assert.ok(command.endsWith('/scripts/platform/capture.sh'));
      assert.ok(!args.includes('observe'));
      assert.ok(args.includes('--out'));
      assert.ok(args.includes('--label'));
      timeoutMs = options.timeoutMs;
      const out = args[args.indexOf('--out') + 1];
      const label = args[args.indexOf('--label') + 1];
      const ref = `screenshots/${label}.png`;
      fs.writeFileSync(path.join(out, ref), PNG);
      return {
        status: 0, stderr: '',
        stdout: JSON.stringify({
          schemaVersion: 1, type: 'capture', platform, time: '2026-09-20T08:00:01.100+08:00',
          artifacts: { screenshot: ref }, device: { id: binding.deviceId }, app: { appId: binding.appId },
          captureTiming: {
            order: ['screenshot'], captureStartedAt: '2026-09-20T08:00:01.000+08:00',
            screenshotCompletedAt: '2026-09-20T08:00:01.100+08:00', spanMs: 100,
          },
        }),
      };
    },
  });
  assert.strictEqual(timeoutMs, 900);
  assert.strictEqual(result.binding.platform, platform);
  assert.strictEqual(result.adapterResult.artifacts.layout, undefined);
  assert.strictEqual(result.evidence.width, 1);
  assert.strictEqual(result.evidence.height, 1);
  assert.match(result.evidence.sha256, /^[0-9a-f]{64}$/);
}

console.log('platform capture passed');
