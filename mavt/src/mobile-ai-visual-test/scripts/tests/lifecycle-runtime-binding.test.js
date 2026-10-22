'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const lifecycle = require('../case-runtime/lifecycle');

// Removing any public lifecycle guard must fail before a lock, event, resource,
// or execution state can be created for a managed Run with a missing binding.
for (const method of ['createExecution', 'establishInitialState', 'resumeExecution',
  'buildContinuationBrief', 'reconcileExecution', 'recordAgentContinuation',
  'recordTimingAnchor', 'commitExecution', 'withCompletionPublication', 'cancelExecution']) {
  test(`${method} refuses missing managed binding before side effects`, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-lifecycle-binding-'));
    const batchId = 'run-binding-test';
    const executionDir = path.join(workspace, 'cases/case-001/platforms/harmony/executions/exec-001');
    const runDir = path.join(workspace, 'runs', batchId);
    fs.mkdirSync(executionDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify({
      schemaVersion: 1, type: 'mobile-ai-visual-test-workspace', initializationState: 'READY',
    }));
    fs.writeFileSync(path.join(runDir, 'coordinator-state.json'), JSON.stringify({
      runtimeBindingRequired: true, command: '/workspace/.mavt/runtime-bundles/digest/runtime/entry',
    }));
    fs.writeFileSync(path.join(executionDir, 'execution.json'), JSON.stringify({
      schemaVersion: 14, runtime: 'case-runtime', executionId: 'exec-001', batchId,
      platform: 'harmony', status: 'RUNNING', finalized: false,
    }));
    function snapshot(directory) {
      return fs.readdirSync(directory).sort().flatMap(name => {
        const file = path.join(directory, name);
        return fs.statSync(file).isDirectory()
          ? [`dir:${file}`, ...snapshot(file)] : [`file:${file}:${fs.readFileSync(file, 'hex')}`];
      });
    }
    const before = snapshot(workspace);
    try {
      assert.throws(() => lifecycle[method]({
        workspaceRoot: workspace, batchId, executionDir, field: 'handoffReadyAt', reason: 'test',
      }, () => assert.fail('publication callback must not run')),
      error => error.code === 'MAVT_RUNTIME_BINDING_INVALID');
      assert.deepStrictEqual(snapshot(workspace), before);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}
