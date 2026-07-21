#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { caseRuntimeDir, ensureDir, nowIso, readJson, readJsonl, writeJson } = require('./common');
const { normalizeProviderId, validateRuntimeOperation, validateRuntimeOperationResult } = require('./lib/agent-runtime-contract');

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED', 'TIMED_OUT', 'RELEASE_FAILED']);
const HOST_OPERATIONS = new Set(['OPEN_SESSION', 'AWAIT_RESULT', 'INTERRUPT_SESSION', 'RELEASE_SESSION']);

function usage() {
  console.error('Usage: agent-runtime.js <init|next|apply|status|interrupt> <case-dir> --platform <platform> --execution-id <id> [options]');
  process.exit(2);
}

function parseArgs(args) {
  if (args.length < 2) usage();
  const options = { command: args[0], caseDir: path.resolve(args[1]), provider: 'codex', workspaceCwd: process.cwd() };
  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': options.platform = args[++i]; break;
      case '--execution-id': options.executionId = args[++i]; break;
      case '--provider': options.provider = args[++i]; break;
      case '--workspace-cwd': options.workspaceCwd = path.resolve(args[++i]); break;
      case '--confirmed-preconditions-json': options.confirmedPreconditionsJson = args[++i]; break;
      case '--operation-result-json': options.operationResult = JSON.parse(args[++i]); break;
      case '--reason': options.reason = args[++i]; break;
      default: usage();
    }
  }
  if (!['init', 'next', 'apply', 'status', 'interrupt'].includes(options.command) || !['harmony', 'android', 'ios'].includes(options.platform) || !options.executionId) usage();
  options.provider = normalizeProviderId(options.provider);
  return options;
}

function execDirFor(options) {
  return path.join(caseRuntimeDir(options.caseDir, options.platform), 'executions', options.executionId);
}

function agentPaths(options) {
  const execDir = execDirFor(options);
  const agentDir = path.join(execDir, 'agent');
  return {
    execDir,
    agentDir,
    contract: path.join(agentDir, 'contract.json'),
    request: path.join(agentDir, 'request.json'),
    response: path.join(agentDir, 'response.json'),
    runtime: path.join(agentDir, 'runtime.json'),
    validation: path.join(agentDir, 'validation.json'),
  };
}

function runJson(script, args, env = process.env) {
  return JSON.parse(childProcess.execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  }));
}

function loadRuntime(paths) {
  const runtime = readJson(paths.runtime);
  if (!runtime) throw new Error(`Agent Runtime is not initialized: ${paths.runtime}`);
  return runtime;
}

function saveRuntime(paths, runtime) {
  runtime.updatedAt = nowIso();
  writeJson(paths.runtime, runtime);
  return runtime;
}

function assertRuntimeContract(paths) {
  const persisted = readJson(paths.contract);
  if (!persisted) throw new Error('AGENT_PROTOCOL_MISMATCH: Agent Runtime contract.json is missing');
  const current = runJson('build-agent-contract.js', ['--role', 'case-executor']);
  if (persisted.protocolSha !== current.protocolSha || persisted.implementationSha !== current.implementationSha) {
    throw new Error('AGENT_PROTOCOL_MISMATCH: case-executor contract changed after Runtime initialization');
  }
}

function remainingMs(runtime) {
  return Math.max(0, new Date(runtime.deadlineAt).getTime() - Date.now());
}

function providerTaskName(executionId) {
  return `mavt_case_${crypto.createHash('sha256').update(executionId).digest('hex').slice(0, 16)}`;
}

function operation(runtime, kind, payload = {}) {
  if (runtime.pendingOperation) return runtime.pendingOperation;
  const seq = (runtime.operationSeq || 0) + 1;
  runtime.operationSeq = seq;
  runtime.pendingOperation = {
    schemaVersion: 1,
    operationId: `runtime-operation-${String(seq).padStart(3, '0')}`,
    kind,
    provider: runtime.provider,
    executionId: runtime.executionId,
    createdAt: nowIso(),
    ...payload,
  };
  return runtime.pendingOperation;
}

function recordRuntime(options, event) {
  return runJson('record-agent-runtime.js', [options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--event-json', JSON.stringify(event)]);
}

function recordFailure(options, paths, runtime, status) {
  if (runtime.failureRecorded || readJson(path.join(paths.execDir, 'execution.json'))?.finalized) return;
  recordRuntime(options, {
    provider: runtime.provider,
    status,
    failureCode: runtime.failureCode,
    reason: runtime.reason,
    protocolSha: runtime.protocolSha,
    implementationSha: runtime.implementationSha,
    requestSha: runtime.requestSha,
    sessionScope: 'case',
    sessionId: runtime.sessionId || undefined,
  });
  runtime.failureRecorded = true;
}

function failRuntime(options, paths, runtime, { targetState, failureCode, reason, eventStatus = 'INTERRUPTED', record = true }) {
  runtime.terminalTarget = targetState;
  runtime.failureCode = failureCode;
  runtime.reason = reason;
  if (!fs.existsSync(paths.validation)) {
    writeJson(paths.validation, {
      schemaVersion: 1,
      valid: false,
      executionId: options.executionId,
      failureCode,
      reason,
      time: nowIso(),
    });
  }
  if (record) recordFailure(options, paths, runtime, eventStatus);
  if (runtime.sessionId) {
    runtime.state = 'INTERRUPT_REQUIRED';
  } else {
    runtime.state = targetState;
    runtime.completedAt = nowIso();
    runtime.releasedAt = runtime.completedAt;
  }
  return runtime;
}

function assertBootstrapOnlyBeforeRuntime(options, paths) {
  const events = readJsonl(path.join(paths.execDir, 'timeline.jsonl'));
  if (events[0]?.type !== 'executionStart' || events[0]?.executionId !== options.executionId) {
    throw new Error('EXECUTION_RECOVERY_CONTRACT_CHANGED: Agent Runtime init requires the matching executionStart fact');
  }
  const invalid = events.find((event) => {
    if (['executionStart', 'environmentProbe'].includes(event.type)) return false;
    return !(event.type === 'actionResult'
      && event.scope === 'execution-bootstrap'
      && event.source === 'action.sh'
      && event.action === 'restartApp'
      && !event.stepId
      && !event.preconditionId
      && !event.flowId
      && !event.flowStepId);
  });
  if (invalid) throw new Error(`AGENT_RESULT_INVALID: Agent Runtime init 前已有非启动事实 ${invalid.type}`);
}

function initialize(options, paths) {
  if (fs.existsSync(paths.runtime)) {
    assertRuntimeContract(paths);
    const existing = loadRuntime(paths);
    if (existing.provider !== options.provider) throw new Error('Agent Runtime already initialized with a different provider');
    return existing;
  }
  const execution = readJson(path.join(paths.execDir, 'execution.json'));
  if (!execution || execution.finalized || execution.lifecycle !== 'RUNNING') throw new Error('Execution must be RUNNING before Agent Runtime init');
  assertBootstrapOnlyBeforeRuntime(options, paths);
  ensureDir(paths.agentDir);
  const contract = runJson('build-agent-contract.js', ['--role', 'case-executor']);
  writeJson(paths.contract, contract);
  const requestArgs = [options.caseDir, '--platform', options.platform, '--execution-id', options.executionId, '--provider', options.provider, '--skill-contract-json', JSON.stringify(contract), '--workspace-cwd', options.workspaceCwd, '--output', paths.request];
  if (options.confirmedPreconditionsJson) requestArgs.push('--confirmed-preconditions-json', options.confirmedPreconditionsJson);
  const request = runJson('build-case-agent-request.js', requestArgs);
  const startedAt = new Date(execution.startedAt || nowIso()).getTime();
  const deadlineAt = new Date(startedAt + Number(request.executionPolicy.maxDurationMs)).toISOString();
  return saveRuntime(paths, {
    schemaVersion: 1,
    provider: options.provider,
    batchId: execution.batchId || null,
    platform: options.platform,
    executionId: options.executionId,
    requestSha: request.requestSha,
    protocolSha: contract.protocolSha,
    implementationSha: contract.implementationSha,
    deadlineAt,
    state: 'PREPARED',
    operationSeq: 0,
    pendingOperation: null,
    createdAt: nowIso(),
  });
}

function validateReceivedResult(options, paths, runtime) {
  runtime.state = 'VALIDATING';
  saveRuntime(paths, runtime);
  try {
    const request = readJson(paths.request);
    const result = readJson(paths.response);
    const validation = runJson('validate-case-agent-result.js', [options.caseDir, '--platform', options.platform, '--request-json', JSON.stringify(request), '--result-json', JSON.stringify(result)]);
    writeJson(paths.validation, validation);
    runtime.state = 'VALIDATED';
    runtime.validation = { valid: true, status: validation.status, failureCode: validation.failureCode || null };
  } catch (error) {
    const reason = error.stderr ? String(error.stderr).trim() : error.message || String(error);
    const validation = { schemaVersion: 1, valid: false, executionId: options.executionId, failureCode: 'AGENT_RESULT_INVALID', reason, time: nowIso() };
    writeJson(paths.validation, validation);
    runtime.validation = validation;
    failRuntime(options, paths, runtime, { targetState: 'FAILED', failureCode: 'AGENT_RESULT_INVALID', reason, record: false });
  }
  saveRuntime(paths, runtime);
}

function terminalResponse(runtime) {
  return { runtime, operation: null, terminal: true };
}

function operationResponse(runtime, operationValue) {
  if (operationValue) validateRuntimeOperation(operationValue);
  return { runtime, operation: operationValue, terminal: false };
}

function next(options, paths) {
  let runtime = loadRuntime(paths);
  if (['RESULT_RECEIVED', 'VALIDATING'].includes(runtime.state)) {
    validateReceivedResult(options, paths, runtime);
    runtime = loadRuntime(paths);
  }
  if (runtime.pendingOperation?.kind === 'AWAIT_RESULT' && remainingMs(runtime) === 0) {
    runtime.pendingOperation = null;
    failRuntime(options, paths, runtime, { targetState: 'TIMED_OUT', failureCode: 'CASE_TIMEOUT', reason: 'Case Agent exceeded its execution deadline.' });
    saveRuntime(paths, runtime);
  }
  if (runtime.pendingOperation?.kind === 'OPEN_SESSION' && remainingMs(runtime) === 0 && !runtime.cancelAfterOpen) {
    runtime.cancelAfterOpen = { reason: 'Case deadline elapsed while Agent session was opening.', requestedAt: nowIso() };
    saveRuntime(paths, runtime);
  }
  if (runtime.pendingOperation) return operationResponse(runtime, runtime.pendingOperation);
  if (TERMINAL_STATES.has(runtime.state)) return terminalResponse(runtime);

  let op = null;
  if (runtime.state === 'PREPARED') {
    if (remainingMs(runtime) === 0) {
      failRuntime(options, paths, runtime, { targetState: 'TIMED_OUT', failureCode: 'CASE_TIMEOUT', reason: 'Case deadline elapsed before Agent session opened.' });
    } else {
      runtime.state = 'SESSION_OPENING';
      op = operation(runtime, 'OPEN_SESSION', { requestPath: paths.request, contractPath: paths.contract, providerTaskName: providerTaskName(runtime.executionId), deadlineAt: runtime.deadlineAt, remainingMs: remainingMs(runtime) });
    }
  } else if (runtime.state === 'SESSION_RUNNING') {
    if (remainingMs(runtime) === 0) {
      failRuntime(options, paths, runtime, { targetState: 'TIMED_OUT', failureCode: 'CASE_TIMEOUT', reason: 'Case Agent exceeded its execution deadline.' });
    } else {
      runtime.state = 'AWAITING_RESULT';
      op = operation(runtime, 'AWAIT_RESULT', { sessionId: runtime.sessionId, deadlineAt: runtime.deadlineAt, remainingMs: remainingMs(runtime) });
    }
  } else if (runtime.state === 'VALIDATED') {
    runtime.state = 'RELEASING';
    op = operation(runtime, 'RELEASE_SESSION', { sessionId: runtime.sessionId });
  } else if (runtime.state === 'INTERRUPT_REQUIRED') {
    runtime.state = 'INTERRUPTING';
    op = operation(runtime, 'INTERRUPT_SESSION', { sessionId: runtime.sessionId, reason: runtime.reason });
  } else if (runtime.state === 'RELEASE_REQUIRED') {
    runtime.state = 'RELEASING';
    op = operation(runtime, 'RELEASE_SESSION', { sessionId: runtime.sessionId });
  } else {
    throw new Error(`Agent Runtime cannot derive operation from state ${runtime.state}`);
  }
  if (!op && runtime.state === 'INTERRUPT_REQUIRED') {
    runtime.state = 'INTERRUPTING';
    op = operation(runtime, 'INTERRUPT_SESSION', { sessionId: runtime.sessionId, reason: runtime.reason });
  }
  if (!op && runtime.state === 'RELEASE_REQUIRED') {
    runtime.state = 'RELEASING';
    op = operation(runtime, 'RELEASE_SESSION', { sessionId: runtime.sessionId });
  }
  saveRuntime(paths, runtime);
  if (TERMINAL_STATES.has(runtime.state)) return terminalResponse(runtime);
  return operationResponse(runtime, op || runtime.pendingOperation);
}

function applyOperation(options, paths) {
  const runtime = loadRuntime(paths);
  const result = validateRuntimeOperationResult(options.operationResult);
  const pending = runtime.pendingOperation;
  if (!pending) {
    if (runtime.lastOperation?.operationId === result.operationId) return runtime;
    throw new Error('Agent Runtime has no pending operation');
  }
  if (pending.operationId !== result.operationId) throw new Error('Operation result does not match pending operation');
  if (!HOST_OPERATIONS.has(pending.kind)) throw new Error(`Unsupported pending operation: ${pending.kind}`);
  runtime.lastOperation = { ...pending, completedAt: nowIso(), ok: result.ok === true };
  runtime.pendingOperation = null;

  if (pending.kind === 'OPEN_SESSION') {
    if (!result.ok || !String(result.sessionId || '').trim()) {
      failRuntime(options, paths, runtime, { targetState: 'FAILED', failureCode: 'AGENT_RUNTIME_UNAVAILABLE', reason: result.reason || 'Host failed to open case session.', eventStatus: 'FAILED' });
    } else {
      runtime.sessionId = result.sessionId;
      recordRuntime(options, { provider: runtime.provider, status: 'BOUND', protocolSha: runtime.protocolSha, implementationSha: runtime.implementationSha, requestSha: runtime.requestSha, sessionScope: 'case', sessionId: runtime.sessionId });
      if (runtime.cancelAfterOpen) {
        const cancellation = runtime.cancelAfterOpen;
        delete runtime.cancelAfterOpen;
        failRuntime(options, paths, runtime, { targetState: 'INTERRUPTED', failureCode: 'AGENT_RUNTIME_INTERRUPTED', reason: cancellation.reason });
      } else {
        runtime.state = 'SESSION_RUNNING';
      }
    }
  } else if (pending.kind === 'AWAIT_RESULT') {
    const timedOut = result.timedOut === true || remainingMs(runtime) === 0;
    if (timedOut) {
      failRuntime(options, paths, runtime, { targetState: 'TIMED_OUT', failureCode: 'CASE_TIMEOUT', reason: result.reason || 'Case Agent exceeded its execution deadline.' });
    } else if (!result.ok || !result.result) {
      failRuntime(options, paths, runtime, { targetState: 'INTERRUPTED', failureCode: 'AGENT_RUNTIME_INTERRUPTED', reason: result.reason || 'Case session did not return a valid result.' });
    } else {
      writeJson(paths.response, result.result);
      runtime.state = 'RESULT_RECEIVED';
    }
  } else if (pending.kind === 'INTERRUPT_SESSION') {
    if (!result.ok) runtime.releaseWarning = result.reason || 'Host could not confirm session interruption.';
    runtime.state = 'RELEASE_REQUIRED';
  } else if (pending.kind === 'RELEASE_SESSION') {
    if (!result.ok) {
      runtime.releaseWarning = result.reason || 'Host failed to release session.';
      runtime.releaseAttempts = (runtime.releaseAttempts || 0) + 1;
      if (runtime.releaseAttempts >= 3) {
        runtime.state = 'RELEASE_FAILED';
        runtime.failureCode = 'AGENT_RUNTIME_RELEASE_FAILED';
        runtime.reason = runtime.releaseWarning;
        runtime.completedAt = nowIso();
        runtime.validation = {
          schemaVersion: 1,
          valid: false,
          executionId: options.executionId,
          failureCode: runtime.failureCode,
          reason: runtime.reason,
          time: runtime.completedAt,
        };
        writeJson(paths.validation, runtime.validation);
      } else {
        runtime.state = 'RELEASE_REQUIRED';
      }
    } else {
      runtime.state = runtime.terminalTarget || 'COMPLETED';
      runtime.completedAt = nowIso();
      runtime.releasedAt = runtime.completedAt;
    }
  }
  return saveRuntime(paths, runtime);
}

function interrupt(options, paths) {
  const runtime = loadRuntime(paths);
  if (TERMINAL_STATES.has(runtime.state)) return runtime;
  if (runtime.pendingOperation?.kind === 'OPEN_SESSION' && !runtime.sessionId) {
    runtime.cancelAfterOpen = { reason: options.reason || 'Coordinator requested interrupt while opening session.', requestedAt: nowIso() };
    return saveRuntime(paths, runtime);
  }
  if (['INTERRUPT_SESSION', 'RELEASE_SESSION'].includes(runtime.pendingOperation?.kind)) return runtime;
  runtime.pendingOperation = null;
  failRuntime(options, paths, runtime, { targetState: 'INTERRUPTED', failureCode: 'AGENT_RUNTIME_INTERRUPTED', reason: options.reason || 'Coordinator requested interrupt.' });
  return saveRuntime(paths, runtime);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = agentPaths(options);
  if (['next', 'apply', 'interrupt'].includes(options.command)) assertRuntimeContract(paths);
  let value;
  if (options.command === 'init') value = initialize(options, paths);
  else if (options.command === 'next') value = next(options, paths);
  else if (options.command === 'apply') value = applyOperation(options, paths);
  else if (options.command === 'interrupt') value = interrupt(options, paths);
  else value = loadRuntime(paths);
  console.log(JSON.stringify(value, null, 2));
}

try { main(); } catch (error) { console.error(error.stderr ? String(error.stderr).trim() : error.message || String(error)); process.exit(error.status || 1); }
