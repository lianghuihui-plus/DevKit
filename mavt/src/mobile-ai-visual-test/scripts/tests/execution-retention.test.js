#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneCompletedExecutions } = require('../lib/execution-retention');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createExecution(executionsRoot, executionId, options = {}) {
  const execDir = path.join(executionsRoot, executionId);
  writeJson(path.join(execDir, 'execution.json'), {
    schemaVersion: 14,
    runtime: 'case-runtime',
    executionId,
    platform: 'harmony',
    endedAt: options.endedAt || null,
    finalized: options.finalized === true,
  });
  if (options.completed === true) {
    writeJson(path.join(execDir, 'completion.json'), {
      executionId,
      platform: 'harmony',
      runtimeCompleted: true,
    });
  }
  return execDir;
}

function executionIds(executionsRoot) {
  return fs.readdirSync(executionsRoot)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-execution-retention-'));
const workspaceRoot = path.join(temp, 'workspace');
const executionsRoot = path.join(workspaceRoot, 'cases', '001-case', 'platforms', 'harmony', 'executions');

createExecution(executionsRoot, 'completed-1', { finalized: true, completed: true, endedAt: '2026-10-09T01:00:00.000Z' });
createExecution(executionsRoot, 'incomplete-finalized', { finalized: true, endedAt: '2026-10-09T02:00:00.000Z' });
createExecution(executionsRoot, 'completed-2', { finalized: true, completed: true, endedAt: '2026-10-09T03:00:00.000Z' });
createExecution(executionsRoot, 'completed-3', { finalized: true, completed: true, endedAt: '2026-10-09T04:00:00.000Z' });
createExecution(executionsRoot, 'active-newest', { endedAt: null });
createExecution(executionsRoot, 'completed-4', { finalized: true, completed: true, endedAt: '2026-10-09T05:00:00.000Z' });

const pruned = pruneCompletedExecutions({ workspaceRoot, executionsRoot });
assert.strictEqual(pruned.status, 'PRUNED');
assert.deepStrictEqual(pruned.removedExecutionIds, ['completed-1']);
assert.deepStrictEqual(executionIds(executionsRoot), [
  'active-newest',
  'completed-2',
  'completed-3',
  'completed-4',
  'incomplete-finalized',
]);
assert.strictEqual(pruneCompletedExecutions({ workspaceRoot, executionsRoot }).status, 'UNCHANGED');

const lockedRoot = path.join(workspaceRoot, 'cases', '002-case', 'platforms', 'harmony', 'executions');
for (let index = 1; index <= 4; index += 1) {
  createExecution(lockedRoot, `locked-${index}`, {
    finalized: true,
    completed: true,
    endedAt: `2026-10-09T0${index}:00:00.000Z`,
  });
}
writeJson(path.join(lockedRoot, '.retention.lock'), {
  pid: process.pid,
  acquiredAt: '2026-10-09T00:00:00.000Z',
});
let lockedResult;
assert.doesNotThrow(() => {
  lockedResult = pruneCompletedExecutions({ workspaceRoot, executionsRoot: lockedRoot });
});
assert.strictEqual(lockedResult.status, 'FAILED');
assert.deepStrictEqual(executionIds(lockedRoot), ['locked-1', 'locked-2', 'locked-3', 'locked-4']);

const outsideRoot = path.join(temp, 'outside', 'executions');
for (let index = 1; index <= 4; index += 1) {
  createExecution(outsideRoot, `outside-${index}`, {
    finalized: true,
    completed: true,
    endedAt: `2026-10-09T0${index}:00:00.000Z`,
  });
}
const outsideResult = pruneCompletedExecutions({ workspaceRoot, executionsRoot: outsideRoot });
assert.strictEqual(outsideResult.status, 'FAILED');
assert.deepStrictEqual(executionIds(outsideRoot), ['outside-1', 'outside-2', 'outside-3', 'outside-4']);

fs.rmSync(temp, { recursive: true, force: true });
console.log('execution retention passed');
