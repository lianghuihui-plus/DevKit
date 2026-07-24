#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, commitEvent, withRunLock } = require('../lib/common');
const { queueUpsertOp, loadVerificationQueue } = require('../lib/verification-store');

const scripts = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-protocol-self-test-')); let tests = 0;
function check(actual, expected) { assert.deepStrictEqual(actual, expected); tests += 1; }
function run(script, args) { const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`${script}: ${result.stderr || result.stdout}`); return JSON.parse(result.stdout); }
function child(code, env) { const result = spawnSync(process.execPath, ['-e', code], { cwd: __dirname, env: { ...process.env, ...env }, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return result.stdout.trim(); }
function bridgeRestartLog(deviceType, displayDump = '') {
  const dir = fs.mkdtempSync(path.join(temp, `bridge-${deviceType}-`)); const logFile = path.join(dir, 'hdc.log'); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'hdc.js'), `const fs=require('fs');const a=process.argv.slice(2);const i=a[0]==='-t'?2:0;const c=a.slice(i);fs.appendFileSync(${JSON.stringify(logFile)},c.join(' ')+'\\n');if(c[0]==='shell'&&c[1]==='aa'&&c[2]==='dump'){console.log('AbilityRecord ID #1\\n state #FOREGROUND\\n ability type [PAGE]\\n bundle name [com.example.protocol]\\n main name [EntryAbility]');process.exit(0)}if(c[0]==='shell'&&c[1]==='hidumper'&&c[3]==='DisplayManagerService'&&c.includes('-a')&&c.includes('-a')){process.stdout.write(${JSON.stringify(displayDump)});process.exit(0)}process.exit(0);`, { mode: 0o644 });
  fs.writeFileSync(path.join(bin, 'hdc'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'hdc.js'))} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'devecocli.js'), `console.log('Name        Serial       Kind    Device Type');console.log('----------  -----------  ------  -----------');console.log('Demo        fake-device  device  ${deviceType}');\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(bin, 'devecocli'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'devecocli.js'))} "$@"\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(scripts, 'runtime', 'harmony-bridge.js'), 'restart', '--device', 'fake-device', '--bundle-name', 'com.example.protocol', '--entry-ability', 'EntryAbility', '--settle-ms', '0'], { encoding: 'utf8', env: { ...process.env, SMAP_HDC: path.join(bin, 'hdc'), SMAP_DEVECOCLI: path.join(bin, 'devecocli'), SMAP_ORIENTATION_SETTLE_MS: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return { restart: JSON.parse(result.stdout), log: fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/) };
}

try {
  const root = path.join(temp, 'app-map'); run('init-app-root.js', ['--app-map-root', root, '--bundle-name', 'com.example.protocol', '--entry-ability', 'EntryAbility', '--environment', 'test']);
  const scanDir = run('init-scan.js', ['--app-map-root', root, '--scan-id', 'scan-protocol', '--device', 'fake-device', '--context', 'guest']).scanDir;
  const target = readJson(path.join(scanDir, 'target.json')); check(target.deviceType, null);
  const phoneRun = run('init-scan.js', ['--app-map-root', root, '--scan-id', 'scan-protocol-phone', '--device', 'fake-device', '--device-type', 'phone', '--context', 'guest']); check(phoneRun.scan.target.deviceType, 'phone');
  const summary = run('summarize-run.js', ['--scan-dir', scanDir]); check(summary.structuredResult.scan.scanId, 'scan-protocol'); check(summary.agentSupplementContract.title, 'Agent 补充内容');
  const phoneRestart = bridgeRestartLog('phone', 'Rotation: 270\nWidth: 2720\nHeight: 1260\n'); check(phoneRestart.restart.orientation.applied, true); check(phoneRestart.log.indexOf('shell hidumper -s DisplayManagerService -a -motion,0') < phoneRestart.log.indexOf('shell aa start -b com.example.protocol -a EntryAbility'), true);
  const portraitRestart = bridgeRestartLog('phone', 'Rotation: 0\nWidth: 1260\nHeight: 2720\n'); check(portraitRestart.restart.orientation.applied, false); check(portraitRestart.restart.orientation.skippedReason, 'ALREADY_PORTRAIT'); check(portraitRestart.log.some(line => line.includes('-motion,0')), false);
  const tabletRestart = bridgeRestartLog('tablet'); check(tabletRestart.restart.orientation.applied, false); check(tabletRestart.restart.orientation.skippedReason, 'NON_PHONE_DEVICE'); check(tabletRestart.log.some(line => line.includes('DisplayManagerService')), false);

  const graphOp = { path: 'contexts/guest/graph.json', op: 'UPSERT', collection: 'logicalScreens', keyFields: ['id'], value: { id: 'fault-injected', name: 'Fault injected', description: '', visualStateIds: [], firstSeenRunId: 'scan-protocol' }, recompute: 'GRAPH' };
  const store = require('../lib/event-store'); const scan = readJson(path.join(scanDir, 'scan.json')); store.append(scanDir, { type: 'faultInjectionEventBeforeProjection', at: new Date().toISOString(), scanId: scan.scanId, contextId: 'guest', projectionOps: [graphOp] });
  check(readJson(path.join(scanDir, 'contexts', 'guest', 'graph.json')).logicalScreens.length, 0);
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(path.join(scanDir, 'contexts', 'guest', 'graph.json')).logicalScreens[0].id, 'fault-injected');

  const graphFile = path.join(scanDir, 'contexts', 'guest', 'graph.json'); const damaged = readJson(graphFile); damaged.logicalScreens = []; fs.writeFileSync(graphFile, `${JSON.stringify(damaged, null, 2)}\n`);
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(graphFile).logicalScreens[0].id, 'fault-injected');

  const attempt = { schemaVersion: 3, attemptId: 'attempt-fault', contextId: 'guest', frontierId: 'frontier-fault', status: 'READY_FOR_ACTION', updatedAt: new Date().toISOString() };
  const attemptFile = path.join(scanDir, 'attempts', `${attempt.attemptId}.json`); commitEvent(scanDir, 'faultInjectionAttemptProjected', { contextId: 'guest', attemptId: attempt.attemptId, attempt }, [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }]);
  fs.writeFileSync(attemptFile, `${JSON.stringify({ ...attempt, status: 'CORRUPTED' }, null, 2)}\n`);
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(attemptFile).status, 'READY_FOR_ACTION');

  const contextFile = path.join(scanDir, 'contexts', 'guest', 'context.json'); const context = readJson(contextFile); context.verification.status = 'FAULT_PROJECTED';
  const metricsFile = path.join(scanDir, 'contexts', 'guest', 'metrics.json'); const metrics = readJson(metricsFile); metrics.observations = 42;
  commitEvent(scanDir, 'faultInjectionControlProjection', { contextId: 'guest' }, [{ path: 'contexts/guest/context.json', op: 'REPLACE', value: context }, { path: 'contexts/guest/metrics.json', op: 'REPLACE', value: metrics }]);
  fs.writeFileSync(contextFile, `${JSON.stringify({ ...context, verification: { status: 'CORRUPTED' } }, null, 2)}\n`);
  fs.writeFileSync(metricsFile, `${JSON.stringify({ ...metrics, observations: -1 }, null, 2)}\n`);
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(contextFile).verification.status, 'FAULT_PROJECTED'); check(readJson(metricsFile).observations, 42);

  const task = { schemaVersion: 2, verificationId: 'verify-fault', taskKey: 'fault-key', contextId: 'guest', logicalScreenKey: 'fault-injected', terminalReachableStateId: 'missing-by-design', edgeIds: [], transitionFingerprints: [], reason: 'CANONICAL_SCREEN_PATH', status: 'PENDING', attemptCount: 0, activeExecutionId: null, executionIds: [], executions: [], createdAt: new Date().toISOString() };
  commitEvent(scanDir, 'verificationScheduled', { contextId: 'guest', verification: task }, [queueUpsertOp('guest', task)]);
  child(`require('../lib/verification-store').startVerificationExecution(process.env.SCAN_DIR,'guest','verify-fault')`, { SCAN_DIR: scanDir });
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  const recoveredTask = loadVerificationQueue(scanDir, 'guest').items.find(item => item.verificationId === 'verify-fault'); check(recoveredTask.status, 'PENDING'); check(recoveredTask.executions[0].status, 'ABANDONED');

  const operationId = child(`process.stdout.write(require('../lib/operation-journal').startDeviceOperation(process.env.SCAN_DIR,'guest',{kind:'FAULT_INJECTION',owner:{type:'SELF_TEST',id:'fault'},idempotency:'UNKNOWN'}).operationId)`, { SCAN_DIR: scanDir });
  withRunLock(scanDir, () => require('../lib/recovery').recoverCommittedEvents(scanDir));
  check(readJson(path.join(scanDir, 'operations', `${operationId}.json`)).status, 'UNKNOWN_OUTCOME'); check(readJson(path.join(scanDir, 'scan.json')).status, 'PAUSED');

  const rebuilt = run('rebuild-run.js', ['--scan-dir', scanDir, '--output-dir', path.join(temp, 'rebuilt')]); check(rebuilt.ok, true); check(rebuilt.comparisons['scan.json'].equivalent, true); check(rebuilt.comparisons['contexts/guest/context.json'].equivalent, true); check(rebuilt.comparisons['contexts/guest/metrics.json'].equivalent, true);
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'protocol-fault-injection', tests }, null, 2));
} finally { if (!process.env.SMAP_KEEP_SELF_TEST) fs.rmSync(temp, { recursive: true, force: true }); }
