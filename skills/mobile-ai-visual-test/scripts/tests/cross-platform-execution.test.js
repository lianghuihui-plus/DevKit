#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bootstrapBatch,
  initializeBatch,
  loadBatch,
  reconcileBatch,
  recordFinalizationStep,
  startCurrentCase,
} = require('../batch/core');
const { commitWithDashboard } = require('../batch');
const { run } = require('../case-runtime/agent-facing-client');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { refreshBatchIndex, renderIndexForRoot } = require('../report/report-service');
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');

process.env.MAVT_SELF_TEST = '1';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function adapterFor(binding) {
  return {
    restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
    probeSession: () => ({ ok: true, binding }),
  };
}

function runWorker([workspaceRoot, batchId, outputPath]) {
  const contract = readJson(path.join(workspaceRoot, 'runs', batchId, 'contract.json'));
  const result = reconcileBatch({
    workspaceRoot,
    batchId,
    adapter: adapterFor(contract.binding),
  });
  writeJsonAtomic(outputPath, result);
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv.slice(3));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-cross-platform-execution-'));

  function createBatchFixture({ batchId, caseNo, platform, suffix }) {
    const sourceText = `验证 ${platform} 跨平台并行执行结果 ${suffix}`;
    const caseKey = `ck-${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`;
    const caseDir = path.join(root, 'cases', `${caseNo}-${suffix}__${caseKey}`);
    const caseJson = createCaseContract({
      caseKey,
      caseNo,
      title: `${platform} 跨平台并行`,
      sourceText,
      importPath: `/fixture/${suffix}.md`,
    });
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
    writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
    const binding = {
      platform,
      deviceId: `${platform}-concurrent-device`,
      appId: `com.example.${suffix}`,
      entry: platform === 'android' ? '.MainActivity' : 'EntryAbility',
    };
    createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }]);
    initializeBatch({ workspaceRoot: root, batchId });
    const adapter = adapterFor(binding);
    bootstrapBatch({ workspaceRoot: root, batchId, adapter });
    const started = startCurrentCase({ workspaceRoot: root, batchId });
    assert.strictEqual(started.action, 'DELEGATE_CASE_AGENT');
    return {
      adapter,
      batchId,
      binding,
      caseDir,
      execDir: path.join(caseDir, 'platforms', platform, 'executions', started.executionId),
      platform,
    };
  }

  function spawnReconcileWorker(fixture) {
    const outputPath = path.join(root, `${fixture.batchId}-worker-result.json`);
    const child = childProcess.spawn(process.execPath, [
      __filename,
      '--worker',
      root,
      fixture.batchId,
      outputPath,
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, MAVT_SELF_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code !== 0) {
          reject(new Error(`reconcile worker failed (${code ?? signal}): ${stderr || stdout}`));
          return;
        }
        resolve(readJson(outputPath));
      });
    });
  }

  function finishExecution(fixture, ordinal) {
    const startedAt = Date.now() + (ordinal * 1000);
    const now = (offset) => new Date(startedAt + offset).toISOString();
    const runner = (_command, args, options) => {
      assert.strictEqual(options.kind, 'OBSERVE');
      const out = args[args.indexOf('--out') + 1];
      const label = args[args.indexOf('--label') + 1];
      const screenshot = `screenshots/${label}.png`;
      fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
      fs.writeFileSync(path.join(out, screenshot), PNG);
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schemaVersion: 1,
          type: 'observation',
          platform: fixture.platform,
          device: { id: fixture.binding.deviceId },
          app: { appId: fixture.binding.appId, inTargetApp: true },
          artifacts: { screenshot, layout: null, logs: [] },
        }),
      };
    };
    assert.strictEqual(run(fixture.execDir, {
      operation: 'plan', input: {
        caseFlow: simpleCaseFlow(`${fixture.platform} 并行执行验证`, `${fixture.platform} 页面结果正常显示`),
      },
    }, { now: now(100) }).result.outcome, 'CASE_FLOW_RECORDED');
    const observed = run(fixture.execDir, {
      operation: 'observe', input: {
        purpose: '采集当前页面现场',
      },
    }, { runner, now: now(200) });
    assert.strictEqual(observed.status, 'SUCCEEDED');
    assert.strictEqual(run(fixture.execDir, {
      operation: 'inspect', input: {
        sceneRef: observed.data.ref,
        mode: 'visual',
        observation: `${fixture.platform} 页面结果清晰可见`,
        checkNodeRefs: ['N2'],
      },
    }, { now: now(300) }).result.outcome, 'VISUAL_OBSERVATION_RECORDED');
    assert.strictEqual(run(fixture.execDir, {
      operation: 'recordResult', input: {
        results: [{
          checkNodeRef: 'N2',
          status: 'PASS',
          actual: `${fixture.platform} 页面结果正常显示`,
          evidence: { sceneRefs: [observed.data.ref] },
        }],
      },
    }, { now: now(400) }).result.outcome, 'RESULTS_RECORDED');
    const finishInput = {
      operation: 'finish', input: { mode: 'complete',
        summary: `${fixture.platform} 并行验证完成`,
        uncertainties: [],
      },
    };
    const review = run(fixture.execDir, finishInput, { now: now(500) });
    assert.strictEqual(review.error.code, 'CASE_FINAL_REVIEW_REQUIRED');
    assert.strictEqual(run(fixture.execDir, finishInput, { now: now(600) }).result.outcome, 'COMPLETED');
  }

  function finalizeBatch(fixture) {
    const committed = commitWithDashboard({ workspaceRoot: root, batchId: fixture.batchId });
    assert.strictEqual(committed.completion.verdict, 'PASS');
    assert.strictEqual(
      committed.dashboardRefresh.status,
      'UPDATED',
      JSON.stringify(committed.dashboardRefresh),
    );
    assert.strictEqual(reconcileBatch({
      workspaceRoot: root,
      batchId: fixture.batchId,
      adapter: fixture.adapter,
    }).action, 'SETTLE_EXECUTIONS');
    recordFinalizationStep({
      workspaceRoot: root,
      batchId: fixture.batchId,
      step: 'executionsSettled',
      result: { ok: true },
    });
    assert.strictEqual(reconcileBatch({
      workspaceRoot: root,
      batchId: fixture.batchId,
      adapter: fixture.adapter,
    }).action, 'RELEASE_PLATFORM');
    recordFinalizationStep({
      workspaceRoot: root,
      batchId: fixture.batchId,
      step: 'platformReleased',
      result: { ok: true, status: 'RELEASED' },
    });
    const terminal = reconcileBatch({
      workspaceRoot: root,
      batchId: fixture.batchId,
      adapter: fixture.adapter,
    });
    assert.strictEqual(terminal.action, 'BATCH_COMPLETE');
    assert.strictEqual(terminal.state.status, 'COMPLETED');
  }

  async function main() {
    createTestWorkspace(root);
    const android = createBatchFixture({
      batchId: 'batch-concurrent-android',
      caseNo: '001',
      platform: 'android',
      suffix: 'concurrent-android',
    });
    const harmony = createBatchFixture({
      batchId: 'batch-concurrent-harmony',
      caseNo: '002',
      platform: 'harmony',
      suffix: 'concurrent-harmony',
    });
    renderIndexForRoot(root);

    const [androidReconcile, harmonyReconcile] = await Promise.all([
      spawnReconcileWorker(android),
      spawnReconcileWorker(harmony),
    ]);
    for (const result of [androidReconcile, harmonyReconcile]) {
      assert.ok(['NEED_CASE_AGENT', 'WAIT_EXECUTION_RESULT'].includes(result.action));
      assert.notStrictEqual(result.state?.failureCode, 'BATCH_ACTIVE_EXECUTION_CONFLICT');
    }
    for (const fixture of [android, harmony]) {
      const loaded = loadBatch(root, fixture.batchId);
      assert.strictEqual(loaded.state.status, 'RUNNING');
      const events = fs.readFileSync(loaded.paths.events, 'utf8');
      assert.strictEqual(events.includes('BATCH_ACTIVE_EXECUTION_CONFLICT'), false);
    }

    finishExecution(android, 1);
    finishExecution(harmony, 2);
    finalizeBatch(android);
    finalizeBatch(harmony);

    const indexPath = refreshBatchIndex(root, [android.caseDir, harmony.caseDir]);
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    assert.match(indexHtml, /data-platform-run="android"/);
    assert.match(indexHtml, /data-platform-run="harmony"/);
    assert.strictEqual(loadBatch(root, android.batchId).state.status, 'COMPLETED');
    assert.strictEqual(loadBatch(root, harmony.batchId).state.status, 'COMPLETED');
    console.log('cross-platform concurrent execution passed');
  }

  main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
