#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');
const { appendJsonl, caseRuntimeDir, ensureDir, nowIso, readJson, readJsonl, writeJson } = require('./common');
const { publishExecution } = require('./lib/execution-completion');

const COMMANDS = new Set(['init', 'next', 'reconcile-current', 'bind', 'commit-current', 'commit-start-result', 'fail', 'status']);

function usage() {
  console.error('Usage: batch-runtime.js <init|next|reconcile-current|bind|commit-current|commit-start-result|fail|status> --workspace-cwd <path> --batch-id <id> [options]');
  process.exit(2);
}

function parseArgs(args) {
  if (!args.length) usage();
  const options = { command: args[0] };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--workspace-cwd': options.workspaceCwd = path.resolve(args[++i]); break;
      case '--batch-id': options.batchId = args[++i]; break;
      case '--platform': options.platform = args[++i]; break;
      case '--provider': options.provider = args[++i]; break;
      case '--targets-json': options.targets = JSON.parse(args[++i]); break;
      case '--case-key': options.caseKey = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--runtime-path': options.runtimePath = path.resolve(args[++i]); break;
      case '--failure-code': options.failureCode = args[++i]; break;
      case '--reason': options.reason = args[++i]; break;
      default: usage();
    }
  }
  if (!COMMANDS.has(options.command) || !options.workspaceCwd || !options.batchId) usage();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.batchId) || ['.', '..'].includes(options.batchId)) throw new Error('batch-id contains unsafe characters');
  return options;
}

function batchPaths(options) {
  const runsDir = path.join(options.workspaceCwd, 'runs');
  const dir = path.resolve(runsDir, options.batchId);
  if (path.dirname(dir) !== path.resolve(runsDir)) throw new Error('batch-id escapes workspace runs directory');
  return { dir, state: path.join(dir, 'batch.json'), events: path.join(dir, 'events.jsonl'), contract: path.join(dir, 'contract.json'), operationDraft: path.join(dir, 'operation.draft.json') };
}

function currentCoordinatorContract(provider = 'codex', platform) {
  return JSON.parse(childProcess.execFileSync(process.execPath, [path.join(__dirname, 'build-agent-contract.js'), '--role', 'batch-coordinator', '--provider', provider, '--platform', platform], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function assertBatchContract(paths, state = null) {
  const persisted = readJson(paths.contract);
  if (!persisted) throw new Error('AGENT_PROTOCOL_MISMATCH: batch contract.json is missing');
  const current = currentCoordinatorContract(state?.provider || persisted.provider || 'codex', state?.platform || persisted.platform);
  if (persisted.protocolSha !== current.protocolSha || persisted.implementationSha !== current.implementationSha) {
    throw new Error('AGENT_PROTOCOL_MISMATCH: batch coordinator contract changed after initialization');
  }
  return persisted;
}

function load(paths) {
  const value = readJson(paths.state);
  if (!value) throw new Error(`Batch is not initialized: ${paths.state}`);
  return value;
}

function batchEventId(operationId, event, index) {
  const binding = JSON.stringify([operationId, event.type, event.caseKey || null, event.executionId || null, index]);
  return `batch-event-${crypto.createHash('sha256').update(binding).digest('hex').slice(0, 16)}`;
}

function recoverBatchOperation(paths) {
  const draft = readJson(paths.operationDraft, null);
  if (!draft) return;
  const existingIds = new Set(readJsonl(paths.events).map((event) => event.eventId).filter(Boolean));
  for (const event of draft.events || []) {
    if (!existingIds.has(event.eventId)) appendJsonl(paths.events, event);
  }
  if (process.env.MAVT_SELF_TEST === '1' && process.env.MAVT_SELF_TEST_BATCH_INTERRUPT === 'after-events') {
    throw new Error('MAVT_SELF_TEST_BATCH_INTERRUPT: after-events');
  }
  writeJson(paths.state, draft.state);
  fs.unlinkSync(paths.operationDraft);
}

function commitBatchOperation(paths, state, events) {
  state.updatedAt = nowIso();
  const operationId = `batch-operation-${crypto.randomBytes(8).toString('hex')}`;
  const committedEvents = events.map((event, index) => ({ ...event, eventId: event.eventId || batchEventId(operationId, event, index) }));
  writeJson(paths.operationDraft, { schemaVersion: 1, operationId, state, events: committedEvents });
  recoverBatchOperation(paths);
  return state;
}

function safeCaseDir(workspaceCwd, value, label) {
  const absolute = path.resolve(value);
  const casesDir = path.join(workspaceCwd, 'cases');
  const relative = path.relative(casesDir, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} must be inside workspace-cwd`);
  return absolute;
}

function assertBatchCaseBinding(state, item, execDir, artifacts = {}) {
  const execution = artifacts.execution || readJson(path.join(execDir, 'execution.json'));
  const snapshot = artifacts.snapshot || readJson(path.join(execDir, 'case.snapshot.json'));
  if (!execution || !snapshot) throw new Error('Batch execution binding artifacts are missing');
  if (execution.batchId !== state.batchId || execution.executionId !== path.basename(execDir)) throw new Error('Batch execution identity mismatch');
  if (snapshot.identity?.caseKey !== item.caseKey) throw new Error('Batch case snapshot identity mismatch');
  if (execution.environmentSnapshot?.binding?.platform !== state.platform) throw new Error('Batch execution platform mismatch');
  for (const value of [artifacts.result, artifacts.metrics, artifacts.validation].filter(Boolean)) {
    if (value.executionId !== execution.executionId) throw new Error('Batch execution artifact identity mismatch');
  }
  if (artifacts.result?.caseKey !== undefined && artifacts.result.caseKey !== item.caseKey) throw new Error('Batch result caseKey mismatch');
  return execution;
}

function currentCase(state) {
  return state.cases[state.currentIndex] || null;
}

function assertCurrent(state, caseKey) {
  const item = currentCase(state);
  if (!item || item.caseKey !== caseKey) throw new Error(`Batch current case mismatch: expected ${item?.caseKey || '<none>'}`);
  return item;
}

function runtimeDirs(caseDir) {
  const values = [];
  const rootExecutions = path.join(caseDir, 'executions');
  if (fs.existsSync(rootExecutions)) values.push({ platform: null, runtimeDir: caseDir });
  const platformsDir = path.join(caseDir, 'platforms');
  if (!fs.existsSync(platformsDir)) return values;
  for (const platform of fs.readdirSync(platformsDir).sort()) {
    if (!['harmony', 'android', 'ios'].includes(platform)) continue;
    const runtimeDir = path.join(platformsDir, platform);
    if (fs.statSync(runtimeDir).isDirectory()) values.push({ platform, runtimeDir });
  }
  return values;
}

function candidateExecutions(workspaceCwd, state, item) {
  const casesDir = path.join(workspaceCwd, 'cases');
  if (!fs.existsSync(casesDir)) return [];
  const values = [];
  for (const name of fs.readdirSync(casesDir).sort()) {
    const caseDir = path.join(casesDir, name);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    for (const runtime of runtimeDirs(caseDir)) {
      const executionsDir = path.join(runtime.runtimeDir, 'executions');
      if (!fs.existsSync(executionsDir)) continue;
      for (const executionId of fs.readdirSync(executionsDir).sort()) {
        const execDir = path.join(executionsDir, executionId);
        if (!fs.statSync(execDir).isDirectory()) continue;
        const execution = readJson(path.join(execDir, 'execution.json'));
        const sameCurrent = execution?.batchId === state.batchId && caseDir === item.caseDir && runtime.platform === state.platform;
        const incompletePublication = execution?.finalized === true && sameCurrent && !fs.existsSync(path.join(execDir, 'completion.json'));
        if (execution?.finalized === false || incompletePublication) values.push({ caseDir, platform: runtime.platform, executionId, execDir, execution });
      }
    }
  }
  return values;
}

function isBootstrapEvent(event) {
  if (['executionStart', 'environmentProbe'].includes(event.type)) return true;
  return event.type === 'actionResult'
    && event.scope === 'execution-bootstrap'
    && event.source === 'action.sh'
    && event.action === 'restartApp'
    && !event.stepId
    && !event.preconditionId
    && !event.flowId
    && !event.flowStepId;
}

function reconcileCurrent(options, state) {
  if (state.status === 'COMPLETED') return { schemaVersion: 1, batchId: state.batchId, action: 'BATCH_COMPLETE', execution: null };
  const item = currentCase(state);
  if (!item) return { schemaVersion: 1, batchId: state.batchId, action: 'BATCH_COMPLETE', execution: null };
  if (state.status === 'BLOCKED' || item.status === 'BLOCKED') {
    return {
      schemaVersion: 1,
      batchId: state.batchId,
      action: 'BATCH_BLOCKED',
      caseKey: item.caseKey,
      executionId: item.executionId || null,
      failureCode: item.failureCode || null,
      reason: item.reason || '',
    };
  }
  if (item.executionId) {
    const execDir = path.join(caseRuntimeDir(item.caseDir, state.platform), 'executions', item.executionId);
    const execution = readJson(path.join(execDir, 'execution.json'));
    const runtimePath = path.join(execDir, 'agent', 'runtime.json');
    if (execution) assertBatchCaseBinding(state, item, execDir, { execution });
    if (execution?.finalized && !fs.existsSync(runtimePath)) return { schemaVersion: 1, batchId: state.batchId, action: 'COMMIT_START_RESULT', executionId: item.executionId, caseDir: item.caseDir, platform: state.platform };
    if (execution?.lifecycle === 'STARTING' || execution?.lifecycle === 'BLOCKED_START') return { schemaVersion: 1, batchId: state.batchId, action: 'RESUME_START', executionId: item.executionId, caseDir: item.caseDir, platform: state.platform };
    if (execution?.finalized === false && fs.existsSync(runtimePath)) {
      const runtime = readJson(runtimePath);
      const releasedFailure = runtime?.releasedAt && ['FAILED', 'INTERRUPTED', 'TIMED_OUT'].includes(runtime.state);
      if (releasedFailure) {
        return { schemaVersion: 1, batchId: state.batchId, action: 'RECOVER_RUNTIME_TERMINAL', executionId: item.executionId, caseDir: item.caseDir, platform: state.platform, runtimePath };
      }
    }
    if (execution?.finalized && fs.existsSync(runtimePath)) {
      const runtime = readJson(runtimePath);
      const validation = readJson(path.join(path.dirname(runtimePath), 'validation.json'));
      if (runtime?.state === 'RELEASE_FAILED') {
        return {
          schemaVersion: 1,
          batchId: state.batchId,
          action: 'BLOCK_RUNTIME_RELEASE',
          executionId: item.executionId,
          caseDir: item.caseDir,
          platform: state.platform,
          runtimePath,
          failureCode: runtime.failureCode || 'AGENT_RUNTIME_RELEASE_FAILED',
          reason: runtime.reason || 'Agent session release could not be confirmed.',
        };
      }
      const releasedTerminal = runtime?.releasedAt && ['COMPLETED', 'FAILED', 'INTERRUPTED', 'TIMED_OUT'].includes(runtime.state);
      const action = releasedTerminal && (validation || runtime.state !== 'COMPLETED') ? 'COMMIT_FINALIZED' : 'RESUME_RUNTIME';
      return { schemaVersion: 1, batchId: state.batchId, action, executionId: item.executionId, caseDir: item.caseDir, platform: state.platform, runtimePath };
    }
  }
  const activeList = candidateExecutions(options.workspaceCwd, state, item);
  if (activeList.length > 1) {
    return {
      schemaVersion: 1,
      batchId: state.batchId,
      action: 'CORRUPTED',
      reason: 'More than one unfinished execution exists; ownership cannot be reduced deterministically.',
      executions: activeList.map((entry) => ({
        caseDir: entry.caseDir,
        platform: entry.platform,
        executionId: entry.executionId,
        ownerBatchId: entry.execution.batchId || null,
      })),
    };
  }
  const active = activeList[0] || null;
  if (!active) return { schemaVersion: 1, batchId: state.batchId, action: 'START_NEW', caseDir: item.caseDir, platform: state.platform };
  const environmentBound = active.execution.environmentSnapshot
    && /^environment-[0-9a-f]{16}$/.test(active.execution.environmentSha || '');
  const preconditionInputsBound = Array.isArray(active.execution.preconditionInputs)
    && /^precondition-inputs-[0-9a-f]{16}$/.test(active.execution.preconditionInputsSha || '');
  if (!environmentBound || !preconditionInputsBound) {
    return {
      schemaVersion: 1,
      batchId: state.batchId,
      action: 'CORRUPTED',
      executionId: active.executionId,
      caseDir: active.caseDir,
      platform: active.platform,
      ownerBatchId: active.execution.batchId || null,
      failureCode: 'EXECUTION_ENVIRONMENT_UNBOUND',
      reason: 'Unfinished legacy execution has no immutable environment/precondition binding; it cannot be inferred from current state.',
    };
  }
  const events = readJsonl(path.join(active.execDir, 'timeline.jsonl'));
  const bootstrapOnly = events[0]?.type === 'executionStart' && events[0]?.executionId === active.executionId && events.every(isBootstrapEvent);
  const runtimePath = path.join(active.execDir, 'agent', 'runtime.json');
  const runtimeExists = fs.existsSync(runtimePath);
  const deadlineAt = new Date(new Date(active.execution.startedAt).getTime() + Number(active.execution.budget?.maxDurationMs || 30 * 60 * 1000));
  const expired = Number.isNaN(deadlineAt.getTime()) || deadlineAt.getTime() <= Date.now();
  const sameTarget = active.caseDir === item.caseDir && active.platform === state.platform;
  const sameBatch = active.execution.batchId === state.batchId;
  const base = { schemaVersion: 1, batchId: state.batchId, executionId: active.executionId, caseDir: active.caseDir, platform: active.platform, runtimePath: runtimeExists ? runtimePath : null, ownerBatchId: active.execution.batchId || null, deadlineAt: Number.isNaN(deadlineAt.getTime()) ? null : deadlineAt.toISOString() };
  if (sameTarget && sameBatch) {
    if (active.execution.finalized && !runtimeExists) return { ...base, action: 'COMMIT_START_RESULT' };
    if (['STARTING', 'BLOCKED_START'].includes(active.execution.lifecycle)) return { ...base, action: 'RESUME_START' };
    if (active.execution.lifecycle === 'FINALIZING' || fs.existsSync(path.join(active.execDir, 'result.draft.json'))) return { ...base, action: 'RECOVER_FINALIZING' };
    if (runtimeExists) return { ...base, action: item.executionId === active.executionId ? 'RESUME_RUNTIME' : 'BIND_RUNTIME' };
    if (bootstrapOnly) return { ...base, action: 'INIT_RUNTIME' };
    return { ...base, action: 'CORRUPTED', reason: 'Execution has case facts but no Agent Runtime binding.' };
  }
  if (!expired) return { ...base, action: 'BLOCK_CONCURRENT', reason: 'Another unexpired execution or batch owns the device execution slot.' };
  if (active.execution.lifecycle === 'FINALIZING' || fs.existsSync(path.join(active.execDir, 'result.draft.json'))) {
    return { ...base, action: 'CORRUPTED', reason: 'An expired finalizing execution belongs to another batch and cannot be adopted.' };
  }
  if (runtimeExists) return { ...base, action: 'CLOSE_EXPIRED' };
  if (bootstrapOnly) return { ...base, action: 'CLOSE_ORPHANED' };
  return { ...base, action: 'CORRUPTED', reason: 'Expired execution contains unbound case facts.' };
}

function initialize(options, paths) {
  const existing = readJson(paths.state);
  if (existing) {
    assertBatchContract(paths, existing);
    if (options.platform && existing.platform !== options.platform) throw new Error('Batch already initialized with a different platform');
    if (options.targets) {
      const requested = options.targets.map((item) => ({ caseKey: item.caseKey, caseDir: safeCaseDir(options.workspaceCwd, item.caseDir, 'target caseDir') }));
      const persisted = existing.cases.map((item) => ({ caseKey: item.caseKey, caseDir: item.caseDir }));
      if (JSON.stringify(requested) !== JSON.stringify(persisted)) throw new Error('Batch already initialized with different targets');
    }
    return { state: existing, events: [] };
  }
  if (!Array.isArray(options.targets) || !options.targets.length) throw new Error('--targets-json must be a non-empty array');
  if (!['harmony', 'android', 'ios'].includes(options.platform)) throw new Error('init requires a supported --platform');
  options.provider = (options.provider || 'codex').trim().toLowerCase();
  ensureDir(paths.dir);
  writeJson(paths.contract, currentCoordinatorContract(options.provider, options.platform));
  const seenCaseKeys = new Set();
  const seenCaseDirs = new Set();
  const cases = options.targets.map((target, index) => {
    if (!target.caseKey || !target.caseDir) throw new Error(`Target ${index} requires caseKey and caseDir`);
    const caseDir = safeCaseDir(options.workspaceCwd, target.caseDir, `target ${index} caseDir`);
    const caseJson = readJson(path.join(caseDir, 'case.json'));
    if (!caseJson) throw new Error(`Target ${index} is missing case.json`);
    if (caseJson.identity?.caseKey !== target.caseKey) throw new Error(`Target ${index} caseKey does not match case.json`);
    if (seenCaseKeys.has(target.caseKey) || seenCaseDirs.has(caseDir)) throw new Error(`Duplicate batch target: ${target.caseKey}`);
    seenCaseKeys.add(target.caseKey);
    seenCaseDirs.add(caseDir);
    return { caseKey: target.caseKey, caseDir, status: 'PENDING', executionId: null, runtimePath: null, validation: null };
  });
  const state = { schemaVersion: 1, batchId: options.batchId, provider: options.provider, platform: options.platform, status: 'RUNNING', currentIndex: 0, cases, createdAt: nowIso() };
  return { state, events: [{ time: nowIso(), type: 'BATCH_STARTED', batchId: options.batchId, caseCount: cases.length }] };
}

function advance(state, item, completion, events) {
  Object.assign(item, { status: 'COMPLETED', endedAt: nowIso(), ...completion });
  events.push({ time: nowIso(), type: 'CASE_COMPLETED', caseKey: item.caseKey, executionId: item.executionId, resultStatus: item.resultStatus, completionSource: item.completionSource });
  state.currentIndex += 1;
  if (state.currentIndex >= state.cases.length) {
    state.status = 'COMPLETED';
    state.completedAt = nowIso();
    events.push({ time: nowIso(), type: 'BATCH_COMPLETED', batchId: state.batchId });
  }
}

function findCompleted(state, caseKey, executionId) {
  return state.cases.find((item) => item.caseKey === caseKey && item.executionId === executionId && ['COMPLETED', 'BLOCKED'].includes(item.status)) || null;
}

function bind(options, state, events) {
  const item = assertCurrent(state, options.caseKey);
  if (!options.executionId || !options.runtimePath) throw new Error('bind requires executionId and runtimePath');
  const expectedRuntime = path.join(caseRuntimeDir(item.caseDir, state.platform), 'executions', options.executionId, 'agent', 'runtime.json');
  if (path.resolve(options.runtimePath) !== expectedRuntime) throw new Error('runtime-path does not match case execution');
  const execution = readJson(path.join(path.dirname(path.dirname(expectedRuntime)), 'execution.json'));
  if (!execution) throw new Error('Missing execution.json for Agent Runtime binding');
  if (execution.batchId !== state.batchId) throw new Error('Execution does not belong to the current batch');
  const runtime = readJson(expectedRuntime);
  if (!runtime || runtime.batchId !== state.batchId || runtime.executionId !== options.executionId) {
    throw new Error('Agent Runtime does not belong to the current batch execution');
  }
  if (runtime.provider !== state.provider) throw new Error('Agent Runtime provider does not match batch provider');
  assertBatchCaseBinding(state, item, path.dirname(path.dirname(expectedRuntime)), { execution });
  if (item.status !== 'PENDING' && !(item.executionId === options.executionId && item.runtimePath === options.runtimePath)) throw new Error('Batch case is already bound differently');
  if (item.status === 'RUNNING') return;
  Object.assign(item, { status: 'RUNNING', executionId: options.executionId, runtimePath: options.runtimePath, startedAt: execution.startedAt || nowIso(), completionSource: 'agent' });
  events.push({ time: nowIso(), type: 'CASE_BOUND', caseKey: item.caseKey, executionId: item.executionId, runtimePath: item.runtimePath });
}

function commitCurrent(options, state, events) {
  if (findCompleted(state, options.caseKey, options.executionId)) return;
  const item = assertCurrent(state, options.caseKey);
  if (item.status !== 'RUNNING' || !item.runtimePath) throw new Error('Current batch case is not bound to an Agent Runtime');
  const runtime = readJson(item.runtimePath);
  if (!runtime) throw new Error(`Missing runtime.json: ${item.runtimePath}`);
  const agentDir = path.dirname(item.runtimePath);
  const execDir = path.dirname(agentDir);
  const validation = readJson(path.join(agentDir, 'validation.json'));
  if (!validation) throw new Error('Missing Agent validation.json');
  if (runtime.executionId !== item.executionId || validation.executionId !== item.executionId) throw new Error('Agent Runtime or validation execution binding mismatch');
  if (runtime.batchId !== state.batchId) throw new Error('Agent Runtime does not belong to the current batch');
  const execution = readJson(path.join(execDir, 'execution.json'));
  const result = readJson(path.join(execDir, 'result.json'));
  const metrics = readJson(path.join(execDir, 'metrics.json'));
  if (!execution?.finalized || !result || !metrics) throw new Error('Execution result artifacts are incomplete');
  if (execution.batchId !== state.batchId) throw new Error('Execution does not belong to the current batch');
  if ([result.executionId, metrics.executionId, validation.executionId].some((value) => value !== item.executionId)) throw new Error('Execution artifact binding mismatch');
  assertBatchCaseBinding(state, item, execDir, { execution, result, metrics, validation });
  const completion = publishExecution({
    caseDir: item.caseDir,
    platform: state.platform,
    executionId: item.executionId,
    batchId: state.batchId,
    completionSource: 'agent',
  });
  if (!validation.valid) {
    if (!runtime.releasedAt || !['FAILED', 'INTERRUPTED', 'TIMED_OUT'].includes(runtime.state)) throw new Error('Invalid Agent result must release its session before batch commit');
    item.status = 'BLOCKED';
    item.failureCode = completion.failureCode;
    item.reason = completion.reason;
    item.validation = validation;
    item.endedAt = nowIso();
    state.status = 'BLOCKED';
    events.push({ time: nowIso(), type: 'CASE_CONTROL_BLOCKED', caseKey: item.caseKey, executionId: item.executionId, failureCode: item.failureCode, reason: item.reason });
    return;
  }
  if (runtime.state !== 'COMPLETED' || !runtime.releasedAt) throw new Error('Agent Runtime must be COMPLETED and released before batch commit');
  if (validation.status !== result.status || metrics.status !== result.status) throw new Error('Execution artifact status mismatch');
  advance(state, item, { resultStatus: completion.status, businessStatus: completion.businessStatus, failureCode: completion.failureCode, validation, completionSource: 'agent' }, events);
}

function commitStartResult(options, state, events) {
  if (findCompleted(state, options.caseKey, options.executionId)) return;
  const item = assertCurrent(state, options.caseKey);
  if (item.status !== 'PENDING') throw new Error('Framework start result can only complete a PENDING case');
  if (!options.executionId) throw new Error('commit-start-result requires executionId');
  const execDir = path.join(caseRuntimeDir(item.caseDir, state.platform), 'executions', options.executionId);
  const execution = readJson(path.join(execDir, 'execution.json'));
  const result = readJson(path.join(execDir, 'result.json'));
  const metrics = readJson(path.join(execDir, 'metrics.json'));
  if (!execution?.finalized || !result || !metrics) throw new Error('Framework start result is not finalized');
  if (execution.batchId !== state.batchId) throw new Error('Framework start result does not belong to the current batch');
  if (fs.existsSync(path.join(execDir, 'agent', 'runtime.json')) || result.failureCode !== 'CASE_RESTART_FAILED') {
    throw new Error('commit-start-result only accepts a framework-owned start failure without Agent Runtime');
  }
  assertBatchCaseBinding(state, item, execDir, { execution, result, metrics });
  const completion = publishExecution({
    caseDir: item.caseDir,
    platform: state.platform,
    executionId: options.executionId,
    batchId: state.batchId,
    completionSource: 'framework',
  });
  item.executionId = options.executionId;
  item.startedAt = execution.startedAt || nowIso();
  advance(state, item, { resultStatus: completion.status, businessStatus: completion.businessStatus, failureCode: completion.failureCode, completionSource: 'framework' }, events);
}

function fail(options, state, events) {
  const item = assertCurrent(state, options.caseKey);
  if (options.executionId && item.executionId && options.executionId !== item.executionId) throw new Error('Batch failure execution binding mismatch');
  if (item.status === 'BLOCKED' && state.status === 'BLOCKED') return;
  item.status = 'BLOCKED';
  item.failureCode = options.failureCode || 'AGENT_RESULT_INVALID';
  item.reason = options.reason || '';
  item.endedAt = nowIso();
  state.status = 'BLOCKED';
  events.push({ time: nowIso(), type: 'CASE_CONTROL_BLOCKED', caseKey: item.caseKey, executionId: item.executionId, failureCode: item.failureCode, reason: item.reason });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = batchPaths(options);
  recoverBatchOperation(paths);
  if (options.command === 'next') {
    const state = load(paths);
    assertBatchContract(paths, state);
    console.log(JSON.stringify({ schemaVersion: 1, batchId: state.batchId, status: state.status, nextCase: currentCase(state), remaining: state.cases.filter((entry) => entry.status === 'PENDING').length }, null, 2));
    return;
  }
  if (options.command === 'status') {
    const state = load(paths);
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (options.command === 'reconcile-current') {
    const state = load(paths);
    assertBatchContract(paths, state);
    console.log(JSON.stringify(reconcileCurrent(options, state), null, 2));
    return;
  }
  let state;
  let events = [];
  if (options.command === 'init') ({ state, events } = initialize(options, paths));
  else {
    state = load(paths);
    if (options.command !== 'fail') assertBatchContract(paths, state);
    if (options.command === 'bind') bind(options, state, events);
    else if (options.command === 'commit-current') commitCurrent(options, state, events);
    else if (options.command === 'commit-start-result') commitStartResult(options, state, events);
    else if (options.command === 'fail') fail(options, state, events);
  }
  commitBatchOperation(paths, state, events);
  console.log(JSON.stringify(state, null, 2));
}

try { main(); } catch (error) { console.error(error.message || String(error)); process.exit(1); }
