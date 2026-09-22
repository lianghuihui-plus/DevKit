#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');
const { assertActiveDispatch } = require('../lib/dispatch-lease');
const { readJson } = require('../lib/execution-lifecycle');
const { PUBLIC_CONTRACT, validateAgentFacingRequest } = require('./agent-facing-contract');
const { run } = require('./agent-facing-client');

function methodNotFound(name) {
  const error = new Error(`Unknown Case Runtime MCP method: ${name}`);
  error.code = 'MCP_METHOD_NOT_FOUND';
  return error;
}

function createToolDefinitions() {
  return Object.values(PUBLIC_CONTRACT.methods).map((method) => ({
    name: method.name,
    description: method.summary,
    inputSchema: method.inputSchema,
  }));
}

function requestForToolCall(name, args = {}) {
  if (!PUBLIC_CONTRACT.methods[name]) throw methodNotFound(name);
  return { operation: name, input: args };
}

function validateToolCall(name, args = {}) {
  try {
    return validateAgentFacingRequest(requestForToolCall(name, args));
  } catch (error) {
    return [{ field: 'method', message: error.message, code: error.code || 'MCP_METHOD_NOT_FOUND' }];
  }
}

function invokeTool(context, name, args = {}) {
  const request = requestForToolCall(name, args);
  const execute = context.runFacade || run;
  return execute(path.resolve(context.execDir), request, { ...(context.options || {}), hostTransport: 'mcp' });
}

function boundContextFromEnvironment(env = process.env) {
  if (!env.MAVT_EXECUTION_DIR) throw Object.assign(new Error('MAVT_EXECUTION_DIR is required'), { code: 'CASE_RUNTIME_BINDING_MISSING' });
  const execDir = path.resolve(env.MAVT_EXECUTION_DIR);
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const sequence = Number(env.MAVT_DISPATCH_SEQUENCE);
  const dispatchDirectory = execution?.batchId && runtime?.sessionRef?.statePath
    ? path.join(path.dirname(runtime.sessionRef.statePath), 'handoffs', execution.executionId)
    : null;
  if (dispatchDirectory) {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw Object.assign(new Error('MAVT_DISPATCH_SEQUENCE is required for this execution'), { code: 'HANDOFF_BINDING_INVALID' });
    }
    assertActiveDispatch(dispatchDirectory, execution.executionId, sequence);
  }
  return { execDir };
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, error) {
  return {
    jsonrpc: '2.0', id,
    error: { code: error.code === 'MCP_METHOD_NOT_FOUND' ? -32601 : -32603, message: error.message || String(error) },
  };
}

function handleMessage(context, message) {
  if (message.method === 'initialize') {
    return response(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mavt-case-runtime', version: 'current' },
    });
  }
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'tools/list') return response(message.id, { tools: createToolDefinitions() });
  if (message.method === 'tools/call') {
    const value = invokeTool(context, message.params?.name, message.params?.arguments === undefined ? {} : message.params.arguments);
    return response(message.id, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: value?.status !== 'SUCCEEDED',
    });
  }
  throw methodNotFound(message.method);
}

function main(options = {}) {
  const context = options.context || boundContextFromEnvironment(options.env || process.env);
  const input = readline.createInterface({ input: options.input || process.stdin, crlfDelay: Infinity });
  const output = options.output || process.stdout;
  input.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
      const value = handleMessage(context, message);
      if (value) output.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      output.write(`${JSON.stringify(errorResponse(message?.id || null, error))}\n`);
    }
  });
}

if (require.main === module) main();

module.exports = {
  boundContextFromEnvironment,
  createToolDefinitions,
  handleMessage,
  invokeTool,
  main,
  requestForToolCall,
  validateToolCall,
};
