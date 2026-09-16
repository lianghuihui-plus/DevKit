#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertActiveDispatch } = require('../lib/dispatch-lease');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { executeFacadeRequest } = require('./runtime-broker');
const {
  projectAgentFacingResponse,
  translateAgentFacingRequest,
} = require('./agent-facing-translator');
const { AGENT_FACING_PROTOCOL, documentationRefFor, validateAgentFacingRequest } = require('./agent-facing-contract');
const decisionTransaction = require('./decision-transaction');
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

function technicalFacts(code, stage) {
  return { technical: { code, ...(stage ? { stage } : {}) } };
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
    capability: request?.capability || 'unknown',
    issues: issues.map((item) => `${item.code}:${item.field}`).sort(),
  });
}

function clearInvalidState(execDir) {
  writeJsonAtomic(statePath(execDir), { type: 'agentFacingInputState', lastInvalid: null });
}

function invalidResponse(execDir, request, issues) {
  const current = readJson(statePath(execDir), { type: 'agentFacingInputState', lastInvalid: null });
  const currentFingerprint = fingerprint(request, issues);
  if (current.lastInvalid?.fingerprint === currentFingerprint) {
    writeJsonAtomic(statePath(execDir), {
      type: 'agentFacingInputState',
      lastInvalid: { fingerprint: currentFingerprint, count: Number(current.lastInvalid.count || 1) + 1 },
    });
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'AGENT_INPUT_STALLED',
      code: 'AGENT_INPUT_STALLED',
      message: '同一种输入错误已连续出现两次；停止自动重试并保留当前现场',
      retryable: false,
      issues,
      scene: projectAgentFacingResponse(execDir, { status: 'READY' }).scene,
      documentationRef: documentationRefFor('AGENT_INPUT_STALLED'),
    };
  }
  writeJsonAtomic(statePath(execDir), {
    type: 'agentFacingInputState',
    lastInvalid: { fingerprint: currentFingerprint, count: 1 },
  });
  return {
    protocol: AGENT_FACING_PROTOCOL,
    status: 'INPUT_INVALID',
    code: 'AGENT_INPUT_INVALID',
    message: '请求字段不符合当前方法签名或上下文约束',
    retryable: true,
    issues,
    scene: projectAgentFacingResponse(execDir, { status: 'READY' }).scene,
    documentationRef: documentationRefFor('AGENT_INPUT_INVALID'),
  };
}

function executeRun(execDir, request, options = {}) {
  const resolved = path.resolve(execDir);
  const execution = readJson(path.join(resolved, 'execution.json'), null);
  if (execution?.schemaVersion !== 12) {
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'TECHNICAL',
      code: 'PROTOCOL_MISMATCH',
      message: `当前执行格式无效：期望 schema 12，实际为 ${execution?.schemaVersion || 'unknown'}`,
      retryable: false,
      facts: {
        executionRef: execution?.executionId || path.basename(resolved),
        executionSchemaVersion: execution?.schemaVersion || null,
        requiredSchemaVersion: 12,
      },
      documentationRef: documentationRefFor('PROTOCOL_MISMATCH'),
    };
  }
  const structural = validateAgentFacingRequest(request);
  if (structural.length) return invalidResponse(resolved, request, structural);
  let submission = null;
  try {
    submission = request.updates && Object.keys(request.updates).length
      ? measureMetric(options, 'updatesApplyMs', () => decisionTransaction.applyUpdates(resolved, request, options))
      : null;
  } catch (error) {
    const inputCodes = ['CASE_MODEL_INVALID', 'CASE_MODEL_REASON_REQUIRED', 'CASE_MODEL_REVISION_CONFLICT',
      'CASE_MODEL_VERIFICATION_REF_INVALID', 'EXPECTATION_RESULT_INVALID', 'EXPECTATION_UNKNOWN',
      'EVIDENCE_REFERENCE_INVALID', 'SCENE_REQUIRED', 'VISUAL_EVIDENCE_UNAVAILABLE', 'VISUAL_EVIDENCE_INVALID',
      'OBSERVATION_SCREENSHOT_MISSING', 'OBSERVATION_SCREENSHOT_INVALID', 'EXECUTION_ARTIFACT_CHANGED'];
    if (inputCodes.includes(error.code)) {
      return invalidResponse(resolved, request, [{ field: 'updates', code: error.code, message: error.message }]);
    }
    throw error;
  }
  if (submission?.status === 'EFFECT_STARTED' && request.capability === 'act') {
    const unknown = projectAgentFacingResponse(resolved, {
      status: 'TECHNICAL',
      code: 'ACTION_OUTCOME_UNKNOWN',
      message: '该请求的设备 effect 已开始，但投递结果未能确认；禁止自动重放',
      retryable: false,
    }, request);
    unknown.updatesApplied = submission.updatesApplied;
    if (submission.caseModelChange) unknown.caseModelChange = submission.caseModelChange;
    unknown.effect = { type: request.capability, status: 'OUTCOME_UNKNOWN' };
    return unknown;
  }
  if (submission?.status === 'EFFECT_COMPLETED' && submission.effectResponse) {
    const completed = projectAgentFacingResponse(resolved, submission.effectResponse, request);
    completed.updatesApplied = submission.updatesApplied;
    if (submission.caseModelChange) completed.caseModelChange = submission.caseModelChange;
    return completed;
  }
  let internal;
  try {
    internal = request.capability === 'finish'
      ? measureMetric(options, 'ledgerProjectionMs', () => translateAgentFacingRequest(resolved, request))
      : translateAgentFacingRequest(resolved, request);
  } catch (error) {
    if (error.code === 'AGENT_INPUT_INVALID' || error.code === 'CASE_RESULT_INCOMPLETE') {
      const issues = error.issues || error.readiness?.unresolved || [{ field: 'effect', code: error.code, message: error.message }];
      const firstCode = error.code === 'CASE_RESULT_INCOMPLETE' ? 'CASE_RESULT_INCOMPLETE'
        : issues.find((item) => ['SCENE_CHANGED', 'ACTION_NOT_AVAILABLE', 'ACTION_INPUT_INVALID', 'VISUAL_INSPECTION_REQUIRED'].includes(item.code))?.code
          || 'AGENT_INPUT_INVALID';
      if (submission) decisionTransaction.rejectEffect(resolved, submission.submissionId, firstCode);
      const rejected = invalidResponse(resolved, request, issues);
      if (firstCode !== 'AGENT_INPUT_INVALID' && rejected.status !== 'AGENT_INPUT_STALLED') {
        rejected.code = firstCode;
        rejected.status = firstCode === 'SCENE_CHANGED' ? 'SCENE_CHANGED'
          : firstCode === 'CASE_RESULT_INCOMPLETE' ? 'RESULT_INCOMPLETE' : 'INPUT_INVALID';
        rejected.documentationRef = documentationRefFor(firstCode);
      }
      if (error.readiness) rejected.readiness = error.readiness;
      if (submission) {
        rejected.updatesApplied = submission.updatesApplied;
        rejected.caseModelChange = submission.caseModelChange;
        rejected.effect = { type: request.capability, status: 'REJECTED' };
      }
      return rejected;
    }
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'TECHNICAL',
      code: 'CASE_RUNTIME_TECHNICAL',
      message: error.message || String(error),
      retryable: false,
      scene: projectAgentFacingResponse(resolved, { status: 'READY' }).scene,
      facts: technicalFacts(error.code || 'FACADE_TRANSLATION_ERROR', 'FACADE_TRANSLATION'),
      documentationRef: documentationRefFor('CASE_RUNTIME_TECHNICAL'),
    };
  }
  clearInvalidState(resolved);
  if (submission && submission.status !== 'EFFECT_STARTED') {
    decisionTransaction.startEffect(resolved, submission.submissionId);
  }
  const executeRequest = options.executeRequest || executeFacadeRequest;
  const response = executeRequest(resolved, internal, options);
  if (response?.status === 'REQUEST_INVALID') {
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'TECHNICAL',
      code: 'CASE_RUNTIME_TECHNICAL',
      message: `Facade 生成的内部请求未通过 Runtime：${response.message || response.code || 'unknown error'}`,
      retryable: false,
      scene: projectAgentFacingResponse(resolved, { status: 'READY' }).scene,
      facts: technicalFacts(response.code || 'FACADE_TRANSLATION_ERROR', 'FACADE_TRANSLATION'),
      documentationRef: documentationRefFor('CASE_RUNTIME_TECHNICAL'),
    };
  }
  if (submission) {
    if (['REQUEST_INVALID', 'SCENE_CHANGED', 'RESULT_INCOMPLETE'].includes(response?.status)) {
      decisionTransaction.rejectEffect(resolved, submission.submissionId, response.code || response.status);
    } else decisionTransaction.completeEffect(resolved, submission.submissionId, response);
  }
  const projected = projectAgentFacingResponse(resolved, response, request);
  if (submission) {
    projected.updatesApplied = submission.updatesApplied;
    if (submission.caseModelChange) projected.caseModelChange = submission.caseModelChange;
  }
  return projected;
}

function run(execDir, request, options = {}) {
  const runOptions = {
    ...options,
    agentFacingMetrics: options.agentFacingMetrics || { updatesApplyMs: 0, ledgerProjectionMs: 0 },
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
    let request;
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
    response = {
      protocol: AGENT_FACING_PROTOCOL,
      status: inputInvalid ? 'INPUT_INVALID' : 'TECHNICAL',
      code: publicCode,
      message: error.message || String(error),
      retryable: inputInvalid,
      issues: inputInvalid ? [{ field: error.name === 'SyntaxError' ? 'request' : 'transport', message: error.message, code: error.name === 'SyntaxError' ? 'JSON_INVALID' : 'TRANSPORT_INVALID' }] : undefined,
      facts: inputInvalid ? undefined : technicalFacts(error.code || 'AGENT_FACING_CLIENT_ERROR', 'TRANSPORT'),
      documentationRef: documentationRefFor(publicCode),
    };
  }
  if (options.returnOnly) return response;
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

if (require.main === module) main();

module.exports = { main, parseRequest, run };
