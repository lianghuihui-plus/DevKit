#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { executeAgentRequest } = require('./runtime-broker');
const { assertActiveDispatch } = require('../lib/dispatch-lease');

function parseRequest(argv, stdin = '', requestPath = null) {
  if (argv.length) throw Object.assign(new Error('run the bound Runtime command without arguments'), { code: 'CASE_RUNTIME_REQUEST_INVALID' });
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
  throw Object.assign(new Error('write one RuntimeRequest JSON object to the bound requestPath before running the command'), { code: 'CASE_RUNTIME_REQUEST_INVALID' });
}

function run(execDir, request, options = {}) {
  return executeAgentRequest(path.resolve(execDir), request, options);
}

function main(argv = process.argv.slice(2), options = {}) {
  const execIndex = argv.indexOf('--execution');
  const boundExecDir = options.execDir || process.env.MAVT_EXECUTION_DIR;
  const execDir = boundExecDir || (execIndex >= 0 ? argv[execIndex + 1] : null);
  let requestArgs = execIndex >= 0 ? [...argv.slice(0, execIndex), ...argv.slice(execIndex + 2)] : [...argv];
  let response;
  try {
    if (!execDir) throw Object.assign(new Error('execution binding is missing'), { code: 'CASE_RUNTIME_BINDING_MISSING' });
    const dispatchIndex = requestArgs.indexOf('--dispatch-sequence');
    const dispatchSequence = dispatchIndex >= 0 ? Number(requestArgs[dispatchIndex + 1]) : null;
    if (dispatchIndex >= 0) requestArgs = [...requestArgs.slice(0, dispatchIndex), ...requestArgs.slice(dispatchIndex + 2)];
    const runtime = JSON.parse(fs.readFileSync(path.join(path.resolve(execDir), 'runtime.json'), 'utf8'));
    const execution = JSON.parse(fs.readFileSync(path.join(path.resolve(execDir), 'execution.json'), 'utf8'));
    const dispatchDirectory = execution.batchId && runtime.sessionRef?.statePath
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
      ? path.join(path.resolve(execDir), `runtime-request.dispatch-${dispatchSequence}.json`)
      : path.join(path.resolve(execDir), 'runtime-request.json');
    const request = parseRequest(requestArgs, stdin, requestPath);
    response = run(execDir, request, options);
  } catch (error) {
    const invalid = ['CASE_RUNTIME_REQUEST_INVALID', 'SyntaxError'].includes(error.code || error.name);
    response = {
      status: invalid ? 'REQUEST_INVALID' : 'TECHNICAL',
      code: error.code || (invalid ? 'CASE_RUNTIME_REQUEST_INVALID' : 'CASE_RUNTIME_CLIENT_ERROR'),
      message: error.message || String(error),
      scene: null,
      ...(invalid ? { expected: 'Write one RuntimeRequest JSON object to the bound requestPath, then run the command without arguments.' } : {}),
    };
    if (execDir) {
      try {
        const telemetry = require('./telemetry');
        const invocation = telemetry.beginInvocation(path.resolve(execDir), 'invalid', { clientError: response.code }, options);
        telemetry.endInvocation(path.resolve(execDir), invocation, response, options);
      } catch {
        // The JSON response remains available even when execution telemetry cannot be written.
      }
    }
  }
  const output = `${JSON.stringify(response, null, 2)}\n`;
  if (options.returnOnly) return response;
  process.stdout.write(output);
  return response;
}

if (require.main === module) main();

module.exports = { main, parseRequest, run };
