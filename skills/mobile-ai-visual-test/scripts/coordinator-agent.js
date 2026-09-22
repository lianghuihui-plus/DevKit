#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCliArgs } = require('./lib/cli-args');
const { errorEnvelope } = require('./lib/agent-facing-envelope');
const { PUBLIC_CONTRACT, documentationRefFor, operationDocumentationRefFor } = require('./coordinator/agent-facing-contract');
const { executeRunRequest, prepareRun, recordCoordinatorInputFailure, failureResources, recordProtocolResponse } = require('./coordinator/agent-facing-service');

function inputError(message) {
  return Object.assign(new Error(message), { code: 'COORDINATOR_INPUT_INVALID', exitCode: 2,
    issues: [{ field: 'request', code: 'INVALID_ARGUMENT', message }] });
}
function parseArgs(argv) {
  let parsed;
  try { parsed = parseCliArgs(argv, { context: 'coordinator-agent', valueOptions: ['--workspace', '--state'], maxPositionals: 0 }); }
  catch { throw inputError('command 只接受预绑定的 workspace 或 state'); }
  const workspace = parsed.values['--workspace'];
  const state = parsed.values['--state'];
  if (Boolean(workspace) === Boolean(state)) throw inputError('command 必须且只能绑定一个作用域');
  return workspace ? { workspace: path.resolve(workspace) } : { statePath: path.resolve(state) };
}
function parseRequest(source) {
  try { return JSON.parse(source); } catch { throw inputError('stdin 必须包含一个有效 JSON 请求'); }
}
function execute(parsed, request, options = {}) {
  return parsed.workspace ? prepareRun(request, { ...options, workspace: parsed.workspace })
    : executeRunRequest(parsed.statePath, request, options);
}
function errorResponse(error, operation = null, stalled = false, resources = []) {
  const publicCode = stalled ? 'AGENT_INPUT_STALLED' : error.code;
  const code = PUBLIC_CONTRACT.errors[publicCode] ? publicCode : 'COORDINATOR_TECHNICAL';
  const rejected = ['COORDINATOR_INPUT_INVALID', 'AGENT_INPUT_STALLED', 'COORDINATOR_TERMINAL', 'DECISION_NOT_ALLOWED',
    'RESOURCE_UNKNOWN', 'RESOURCE_SCOPE_MISMATCH'].includes(code);
  return errorEnvelope({ operation: typeof operation === 'string' ? operation : null, status: rejected ? 'REJECTED' : 'FAILED',
    code, retryable: PUBLIC_CONTRACT.errors[code].retryable,
    resources: resources.filter((resource) => PUBLIC_CONTRACT.errors[code].resourceTypes.includes(resource.type)),
    ...(error.issues?.length ? { issues: error.issues } : {}),
    documentationRef: documentationRefFor(code),
    ...(['COORDINATOR_INPUT_INVALID', 'AGENT_INPUT_STALLED'].includes(code) && PUBLIC_CONTRACT.methods[operation]
      ? { operationDocumentationRef: operationDocumentationRefFor(operation) } : {}) });
}
function main(argv = process.argv.slice(2), options = {}) {
  const startedMs = Date.now();
  let parsed;
  let request;
  let response;
  try {
    parsed = parseArgs(argv);
    request = options.request === undefined ? parseRequest(options.stdin === undefined ? fs.readFileSync(0, 'utf8') : options.stdin) : options.request;
    response = execute(parsed, request, { ...options, hostTransport: 'stdin' });
  } catch (error) {
    let stalled = false;
    // Reads never change Coordinator business state, including invalid-input counters.
    if (parsed?.statePath && request?.operation !== 'read' && error.code === 'COORDINATOR_INPUT_INVALID') {
      try { stalled = recordCoordinatorInputFailure(parsed.statePath, request?.operation || 'request', error); } catch { /* State failure is reported by the envelope. */ }
    }
    let resources = [];
    if (parsed?.statePath && request?.operation !== 'read') {
      try { resources = failureResources(parsed.statePath, error); } catch { /* Preserve the original operation failure. */ }
    }
    response = errorResponse(error, request?.operation, stalled, resources);
    if (parsed?.statePath) recordProtocolResponse(parsed.statePath, response, Date.now() - startedMs, { ...options, hostTransport: 'stdin' });
  }
  if (options.returnOnly) return response;
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (response.status !== 'SUCCEEDED') process.exitCode = 2;
  return response;
}
if (require.main === module) main();
module.exports = { errorResponse, execute, main, parseArgs, parseRequest };
