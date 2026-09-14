#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertActiveDispatch } = require('../lib/dispatch-lease');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { attachTechnicalFallback } = require('../lib/technical-fallback');
const { executeFacadeRequest } = require('./runtime-broker');
const {
  projectAgentFacingResponse,
  retryExample,
  translateAgentFacingRequest,
} = require('./agent-facing-translator');

const STATE_FILE = 'agent-facing-state.json';

function parseRequest(argv, stdin = '', requestPath = null) {
  if (argv.length) throw Object.assign(new Error('原样执行预绑定 command，不要增加参数'), { code: 'AGENT_INPUT_INVALID' });
  if (stdin.trim()) return JSON.parse(stdin);
  if (requestPath && fs.existsSync(requestPath)) {
    const claimedPath = `${requestPath}.claimed-${process.pid}-${Date.now()}`;
    fs.renameSync(requestPath, claimedPath);
    try {
      return JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
    } finally {
      if (fs.existsSync(claimedPath)) fs.unlinkSync(claimedPath);
    }
  }
  throw Object.assign(new Error('请求文件是一次性的；请为本次调用重新创建简化请求 JSON 到 requestPath，再原样执行 command'), { code: 'AGENT_INPUT_INVALID' });
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
      status: 'AGENT_INPUT_STALLED',
      code: 'AGENT_INPUT_STALLED',
      message: '同一种输入错误已连续出现两次；停止自动重试并保留当前现场',
      issues,
      scene: projectAgentFacingResponse(execDir, { status: 'READY' }).scene,
    };
  }
  let retryWith = retryExample(execDir, request);
  try {
    translateAgentFacingRequest(execDir, retryWith);
  } catch {
    retryWith = { capability: 'observe' };
  }
  writeJsonAtomic(statePath(execDir), {
    type: 'agentFacingInputState',
    lastInvalid: { fingerprint: currentFingerprint, count: 1 },
  });
  return {
    status: 'INPUT_INVALID',
    code: 'AGENT_INPUT_INVALID',
    message: '请求字段不符合当前能力；只按 retryWith 修正一次',
    issues,
    retryWith,
    scene: projectAgentFacingResponse(execDir, { status: 'READY' }).scene,
  };
}

function run(execDir, request, options = {}) {
  const resolved = path.resolve(execDir);
  let internal;
  try {
    internal = translateAgentFacingRequest(resolved, request);
  } catch (error) {
    if (error.code === 'AGENT_INPUT_INVALID') return invalidResponse(resolved, request, error.issues || []);
    return attachTechnicalFallback({
      status: 'TECHNICAL',
      code: error.code || 'FACADE_TRANSLATION_ERROR',
      message: error.message || String(error),
      diagnostic: error.diagnostic || {
        code: error.code || 'FACADE_TRANSLATION_ERROR',
        stage: 'FACADE_TRANSLATION',
        summary: error.message || String(error),
        retryable: false,
      },
      scene: projectAgentFacingResponse(resolved, { status: 'READY' }).scene,
    }, 'EXECUTION', 'USE_CURRENT_RUNTIME');
  }
  clearInvalidState(resolved);
  const executeRequest = options.executeRequest || executeFacadeRequest;
  const response = executeRequest(resolved, internal, options);
  if (response?.status === 'REQUEST_INVALID') {
    return attachTechnicalFallback({
      status: 'TECHNICAL',
      code: 'FACADE_TRANSLATION_ERROR',
      message: `Facade 生成的内部请求未通过 Runtime：${response.message || response.code || 'unknown error'}`,
      diagnostic: response.diagnostic || {
        code: 'FACADE_TRANSLATION_ERROR',
        stage: 'FACADE_TRANSLATION',
        summary: response.message || response.code || 'unknown error',
        retryable: false,
      },
      scene: projectAgentFacingResponse(resolved, { status: 'READY' }).scene,
    }, 'EXECUTION', 'USE_CURRENT_RUNTIME');
  }
  return projectAgentFacingResponse(resolved, response, request);
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
    const requestPath = dispatchSequence
      ? path.join(execDir, `agent-request.dispatch-${dispatchSequence}.json`)
      : path.join(execDir, 'agent-request.json');
    let request;
    try {
      request = parseRequest(requestArgs, stdin, requestPath);
    } catch (error) {
      if (!['AGENT_INPUT_INVALID', 'SyntaxError'].includes(error.code || error.name)) throw error;
      response = invalidResponse(execDir, {}, [{
        field: error.name === 'SyntaxError' ? 'requestFile' : 'transport',
        message: error.message,
        code: error.name === 'SyntaxError' ? 'JSON_INVALID' : 'TRANSPORT_INVALID',
      }]);
    }
    if (!response) response = run(execDir, request, options);
  } catch (error) {
    const inputInvalid = ['AGENT_INPUT_INVALID', 'SyntaxError'].includes(error.code || error.name);
    response = attachTechnicalFallback({
      status: inputInvalid ? 'INPUT_INVALID' : 'TECHNICAL',
      code: inputInvalid ? 'AGENT_INPUT_INVALID' : (error.code || 'AGENT_FACING_CLIENT_ERROR'),
      message: error.message || String(error),
      issues: inputInvalid ? [{ field: error.name === 'SyntaxError' ? 'requestFile' : 'transport', message: error.message, code: error.name === 'SyntaxError' ? 'JSON_INVALID' : 'TRANSPORT_INVALID' }] : undefined,
    }, 'EXECUTION', 'USE_CURRENT_RUNTIME');
  }
  if (options.returnOnly) return response;
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

if (require.main === module) main();

module.exports = { main, parseRequest, run };
