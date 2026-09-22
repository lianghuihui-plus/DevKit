#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertActiveDispatch } = require('../lib/dispatch-lease');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { executeFacadeRequest } = require('./runtime-broker');
const {
  projectAgentFacingResponse,
  projectAgentFacingError,
  translateAgentFacingRequest,
} = require('./agent-facing-translator');
const { PUBLIC_CONTRACT, validateAgentFacingRequest } = require('./agent-facing-contract');
const telemetry = require('./telemetry');

const STATE_FILE = 'agent-facing-state.json';

function metricClock(options) {
  return typeof options.agentFacingMetricClock === 'function' ? options.agentFacingMetricClock() : Date.now();
}

function measureMetric(options, field, operation) {
  const startedMs = metricClock(options);
  try {
    return operation();
  } finally {
    const endedMs = metricClock(options);
    options.agentFacingMetrics[field] += Math.max(0, endedMs - startedMs);
  }
}

function parseRequest(argv, stdin = '') {
  if (argv.length) throw Object.assign(new Error('原样执行预绑定 command，不要增加参数'), { code: 'AGENT_INPUT_INVALID' });
  if (stdin.trim()) return JSON.parse(stdin);
  throw Object.assign(new Error('stdin 没有提供 JSON 请求'), { code: 'AGENT_INPUT_INVALID' });
}

function statePath(execDir) {
  return path.join(execDir, STATE_FILE);
}

function fingerprint(request, issues) {
  return JSON.stringify({
    operation: request?.operation || 'unknown',
    issues: issues.map((item) => `${item.code}:${item.field}`).sort(),
  });
}

function clearInvalidState(execDir) {
  writeJsonAtomic(statePath(execDir), { type: 'agentFacingInputState', lastInvalid: null });
}

function invalidResponse(execDir, request, issues, code = 'AGENT_INPUT_INVALID') {
  const current = readJson(statePath(execDir), { type: 'agentFacingInputState', lastInvalid: null });
  const currentFingerprint = fingerprint(request, issues);
  if (current.lastInvalid?.fingerprint === currentFingerprint) {
    writeJsonAtomic(statePath(execDir), {
      type: 'agentFacingInputState',
      lastInvalid: { fingerprint: currentFingerprint, count: Number(current.lastInvalid.count || 1) + 1 },
    });
    return projectAgentFacingError({
      status: 'REJECTED',
      code: 'AGENT_INPUT_STALLED',
      message: '同一种输入错误已连续出现两次；停止自动重试并保留当前现场',
      retryable: false,
      issues,
    }, request);
  }
  writeJsonAtomic(statePath(execDir), {
    type: 'agentFacingInputState',
    lastInvalid: { fingerprint: currentFingerprint, count: 1 },
  });
  return projectAgentFacingError({
    status: 'REJECTED',
    code,
    message: '请求字段不符合当前方法签名或上下文约束',
    retryable: true,
    issues,
  }, request);
}

function executeRun(execDir, request, options = {}) {
  const resolved = path.resolve(execDir);
  const execution = readJson(path.join(resolved, 'execution.json'), null);
  if (execution?.schemaVersion !== 13) {
    return projectAgentFacingError({
      status: 'REJECTED',
      code: 'PROTOCOL_MISMATCH',
      message: `当前执行格式无效：期望 schema 13，实际为 ${execution?.schemaVersion || 'unknown'}`,
      retryable: false,
    }, request);
  }
  const structural = validateAgentFacingRequest(request);
  if (structural.length) return invalidResponse(resolved, request, structural);
  if ((execution.finalized || execution.lifecycle === 'FINALIZED') && request.operation !== 'read') {
    return projectAgentFacingError({ status: 'REJECTED', code: 'CASE_RUNTIME_FINALIZED' }, request);
  }
  if (request.operation === 'read') {
    try {
      const resource = (options.readResource || ((ref) => require('./agent-resource-store').readPublishedResource(resolved, ref)))(request.input.ref);
      if (!resource) return projectAgentFacingError({ status: 'REJECTED', code: 'RESOURCE_UNKNOWN' }, request);
      return projectAgentFacingResponse(resolved, {
        status: 'RESOURCE_READ', ...resource,
        result: { ...resource.result, resourceRef: resource.data?.ref, resourceType: resource.data?.type },
      }, request, { ...options, resourceProvider: () => resource });
    } catch (error) {
      return projectAgentFacingError({ status: ['RESOURCE_UNKNOWN', 'RESOURCE_SCOPE_MISMATCH'].includes(error.code) ? 'REJECTED' : 'FAILED', code: error.code || 'CASE_RUNTIME_TECHNICAL' }, request);
    }
  }
  let internal;
  try {
    internal = request.operation === 'finish'
      ? measureMetric(options, 'ledgerProjectionMs', () => translateAgentFacingRequest(resolved, request))
      : translateAgentFacingRequest(resolved, request);
  } catch (error) {
    if (['RESOURCE_UNKNOWN', 'RESOURCE_SCOPE_MISMATCH', 'RESOURCE_INTEGRITY_INVALID'].includes(error.code)) {
      return projectAgentFacingError({ status: error.code === 'RESOURCE_INTEGRITY_INVALID' ? 'FAILED' : 'REJECTED', code: error.code }, request);
    }
    if (error.code === 'AGENT_INPUT_INVALID' || error.code === 'CASE_RESULT_INCOMPLETE') {
      const issues = error.issues || error.readiness?.unresolved || [{ field: 'effect', code: error.code, message: error.message }];
      const firstCode = error.code === 'CASE_RESULT_INCOMPLETE' ? 'CASE_RESULT_INCOMPLETE'
        : issues.find((item) => [
          'SCENE_CHANGED', 'ACTION_NOT_AVAILABLE', 'ACTION_INPUT_INVALID', 'VISUAL_INSPECTION_REQUIRED',
          'EXPECTATION_UNKNOWN', 'EVIDENCE_REFERENCE_INVALID', 'RECORD_RESULT_INVALID',
        ].includes(item.code))?.code
          || 'AGENT_INPUT_INVALID';
      return invalidResponse(resolved, request, issues, firstCode);
    }
    return projectAgentFacingError({
      status: 'FAILED',
      code: 'CASE_RUNTIME_TECHNICAL',
      message: error.message || String(error),
      retryable: false,
    }, request);
  }
  clearInvalidState(resolved);
  const executeRequest = options.executeRequest || executeFacadeRequest;
  let response;
  try {
    response = executeRequest(resolved, internal, options);
  } catch (error) {
    return projectAgentFacingError({ status: 'FAILED', code: error.code || 'CASE_RUNTIME_TECHNICAL' }, request);
  }
  if (response?.status === 'REQUEST_INVALID') {
    if (PUBLIC_CONTRACT.errors[response.code]) {
      return invalidResponse(resolved, request, response.issues || [{
        field: request.operation === 'plan' ? 'input.caseFlow' : 'request',
        code: response.code,
        message: response.message || response.code,
      }], response.code);
    }
    return projectAgentFacingError({
      status: 'FAILED',
      code: 'CASE_RUNTIME_TECHNICAL',
      message: `Facade 生成的内部请求未通过 Runtime：${response.message || response.code || 'unknown error'}`,
      retryable: false,
    }, request);
  }
  try {
    return projectAgentFacingResponse(resolved, response, request, options);
  } catch (error) {
    // Preserve the authoritative delivery outcome if resource publication fails.
    return projectAgentFacingError({ ...response, status: 'FAILED', code: error.code || 'CASE_RUNTIME_TECHNICAL' }, request);
  }
}

function run(execDir, request, options = {}) {
  const runOptions = {
    resourceProvider: require('./agent-resource-store').provideOperationResources,
    ...options,
    agentFacingMetrics: options.agentFacingMetrics || { ledgerProjectionMs: 0 },
  };
  const startedMs = typeof runOptions.agentFacingClock === 'function' ? runOptions.agentFacingClock() : Date.now();
  const response = executeRun(execDir, request, runOptions);
  const endedMs = typeof runOptions.agentFacingClock === 'function' ? runOptions.agentFacingClock() : Date.now();
  telemetry.recordAgentFacing(path.resolve(execDir), request, response, Math.max(0, endedMs - startedMs), runOptions);
  return response;
}

function main(argv = process.argv.slice(2), options = {}) {
  const boundExecDir = options.execDir || process.env.MAVT_EXECUTION_DIR;
  let response;
  let request;
  try {
    if (!boundExecDir) throw Object.assign(new Error('execution binding is missing'), { code: 'CASE_RUNTIME_BINDING_MISSING' });
    const requestArgs = [...argv];
    const dispatchIndex = requestArgs.indexOf('--dispatch-sequence');
    const dispatchSequence = dispatchIndex >= 0 ? Number(requestArgs[dispatchIndex + 1]) : null;
    if (dispatchIndex >= 0) requestArgs.splice(dispatchIndex, 2);
    const execDir = path.resolve(boundExecDir);
    const runtime = readJson(path.join(execDir, 'runtime.json'), null);
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    const dispatchDirectory = execution?.batchId && runtime?.sessionRef?.statePath
      ? path.join(path.dirname(runtime.sessionRef.statePath), 'handoffs', execution.executionId)
      : null;
    if (dispatchDirectory) {
      if (!Number.isInteger(dispatchSequence) || dispatchSequence < 1) {
        throw Object.assign(new Error('Runtime dispatch binding is missing or invalid'), { code: 'HANDOFF_BINDING_INVALID' });
      }
      assertActiveDispatch(dispatchDirectory, execution.executionId, dispatchSequence);
    }
    const stdin = options.stdin !== undefined ? options.stdin : (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
    try {
      request = parseRequest(requestArgs, stdin);
    } catch (error) {
      if (!['AGENT_INPUT_INVALID', 'SyntaxError'].includes(error.code || error.name)) throw error;
      response = invalidResponse(execDir, {}, [{
        field: error.name === 'SyntaxError' ? 'request' : 'transport',
        message: error.message,
        code: error.name === 'SyntaxError' ? 'JSON_INVALID' : 'TRANSPORT_INVALID',
      }]);
    }
    if (!response) response = run(execDir, request, { ...options, hostTransport: 'stdin' });
  } catch (error) {
    const inputInvalid = ['AGENT_INPUT_INVALID', 'SyntaxError'].includes(error.code || error.name);
    const bindingInvalid = !inputInvalid && /(?:HANDOFF|BINDING)/.test(error.code || '');
    const publicCode = inputInvalid ? 'AGENT_INPUT_INVALID'
      : bindingInvalid ? 'BINDING_INVALID' : 'CASE_RUNTIME_TECHNICAL';
    response = projectAgentFacingError({
      status: inputInvalid || bindingInvalid ? 'REJECTED' : 'FAILED',
      code: publicCode,
      message: error.message || String(error),
      retryable: inputInvalid,
      issues: inputInvalid ? [{ field: error.name === 'SyntaxError' ? 'request' : 'transport', message: error.message, code: error.name === 'SyntaxError' ? 'JSON_INVALID' : 'TRANSPORT_INVALID' }] : undefined,
    }, request);
  }
  if (options.returnOnly) return response;
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return response;
}

if (require.main === module) main();

module.exports = { main, parseRequest, run };
