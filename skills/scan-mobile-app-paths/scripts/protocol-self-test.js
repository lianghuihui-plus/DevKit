#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, commitEvent, withRunLock } = require('./lib/common');
const { queueUpsertOp, loadVerificationQueue } = require('./lib/verification-store');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-protocol-self-test-')); let tests = 0;
function check(actual, expected) { assert.deepStrictEqual(actual, expected); tests += 1; }
function run(script, args) { const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`${script}: ${result.stderr || result.stdout}`); return JSON.parse(result.stdout); }
function child(code, env) { const result = spawnSync(process.execPath, ['-e', code], { cwd: __dirname, env: { ...process.env, ...env }, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return result.stdout.trim(); }

try {
  const root = path.join(temp, 'app-map'); run('init-app-root.js', ['--app-map-root', root, '--bundle-name', 'com.example.protocol', '--entry-ability', 'EntryAbility', '--environment', 'test']);
  const scanDir = run('init-scan.js', ['--app-map-root', root, '--scan-id', 'scan-protocol', '--device', 'fake-device', '--context', 'guest']).scanDir;

  const graphOp = { path: 'contexts/guest/graph.json', op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: { id: 'fault-injected', name: 'Fault injected', description: '', visualStateIds: [], firstSeenRunId: 'scan-protocol' }, recompute: 'GRAPH' };
  const store = require('./lib/event-store'); const scan = readJson(path.join(scanDir, 'scan.json')); store.append(scanDir, { type: 'faultInjectionEventBeforeProjection', at: new Date().toISOString(), scanId: scan.scanId, contextId: 'guest', projectionOps: [graphOp] });
  check(readJson(path.join(scanDir, 'contexts', 'guest', 'graph.json')).logicalScreens.length, 0);
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(path.join(scanDir, 'contexts', 'guest', 'graph.json')).logicalScreens[0].id, 'fault-injected');

  const graphFile = path.join(scanDir, 'contexts', 'guest', 'graph.json'); const damaged = readJson(graphFile); damaged.logicalScreens = []; fs.writeFileSync(graphFile, `${JSON.stringify(damaged, null, 2)}\n`);
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(graphFile).logicalScreens[0].id, 'fault-injected');

  const attempt = { schemaVersion: 3, attemptId: 'attempt-fault', contextId: 'guest', frontierId: 'frontier-fault', status: 'READY_FOR_ACTION', updatedAt: new Date().toISOString() };
  const attemptFile = path.join(scanDir, 'attempts', `${attempt.attemptId}.json`); commitEvent(scanDir, 'faultInjectionAttemptProjected', { contextId: 'guest', attemptId: attempt.attemptId, attempt }, [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }]);
  fs.writeFileSync(attemptFile, `${JSON.stringify({ ...attempt, status: 'CORRUPTED' }, null, 2)}\n`);
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(attemptFile).status, 'READY_FOR_ACTION');

  const contextFile = path.join(scanDir, 'contexts', 'guest', 'context.json'); const context = readJson(contextFile); context.verification.status = 'FAULT_PROJECTED';
  const metricsFile = path.join(scanDir, 'contexts', 'guest', 'metrics.json'); const metrics = readJson(metricsFile); metrics.observations = 42;
  commitEvent(scanDir, 'faultInjectionControlProjection', { contextId: 'guest' }, [{ path: 'contexts/guest/context.json', op: 'REPLACE', value: context }, { path: 'contexts/guest/metrics.json', op: 'REPLACE', value: metrics }]);
  fs.writeFileSync(contextFile, `${JSON.stringify({ ...context, verification: { status: 'CORRUPTED' } }, null, 2)}\n`);
  fs.writeFileSync(metricsFile, `${JSON.stringify({ ...metrics, observations: -1 }, null, 2)}\n`);
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(contextFile).verification.status, 'FAULT_PROJECTED'); check(readJson(metricsFile).observations, 42);

  const task = { schemaVersion: 2, verificationId: 'verify-fault', taskKey: 'fault-key', contextId: 'guest', logicalScreenKey: 'fault-injected', terminalReachableStateId: 'missing-by-design', edgeIds: [], transitionFingerprints: [], reason: 'CANONICAL_SCREEN_PATH', status: 'PENDING', attemptCount: 0, activeExecutionId: null, executionIds: [], executions: [], createdAt: new Date().toISOString() };
  commitEvent(scanDir, 'verificationScheduled', { contextId: 'guest', verification: task }, [queueUpsertOp('guest', task)]);
  child(`require('./lib/verification-store').startVerificationExecution(process.env.SCAN_DIR,'guest','verify-fault')`, { SCAN_DIR: scanDir });
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  const recoveredTask = loadVerificationQueue(scanDir, 'guest').items.find(item => item.verificationId === 'verify-fault'); check(recoveredTask.status, 'PENDING'); check(recoveredTask.executions[0].status, 'ABANDONED');

  const operationId = child(`process.stdout.write(require('./lib/operation-journal').startDeviceOperation(process.env.SCAN_DIR,'guest',{kind:'FAULT_INJECTION',owner:{type:'SELF_TEST',id:'fault'},idempotency:'UNKNOWN'}).operationId)`, { SCAN_DIR: scanDir });
  withRunLock(scanDir, () => require('./lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(path.join(scanDir, 'operations', `${operationId}.json`)).status, 'UNKNOWN_OUTCOME'); check(readJson(path.join(scanDir, 'scan.json')).status, 'PAUSED');

  const rebuilt = run('rebuild-run.js', ['--scan-dir', scanDir, '--output-dir', path.join(temp, 'rebuilt')]); check(rebuilt.ok, true); check(rebuilt.comparisons['scan.json'].equivalent, true); check(rebuilt.comparisons['contexts/guest/context.json'].equivalent, true); check(rebuilt.comparisons['contexts/guest/metrics.json'].equivalent, true);
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'protocol-fault-injection', tests }, null, 2));
} finally { if (!process.env.SMAP_KEEP_SELF_TEST) fs.rmSync(temp, { recursive: true, force: true }); }
