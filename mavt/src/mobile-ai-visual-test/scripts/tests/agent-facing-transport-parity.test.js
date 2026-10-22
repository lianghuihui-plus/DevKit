'use strict';
const assert = require('assert');
const { PUBLIC_CONTRACT } = require('../case-runtime/agent-facing-contract');
const { definitions, validate } = require('../mcp/contract');

const tools = definitions().filter(tool => tool.name.startsWith('mavt_case_') && tool.name !== 'mavt_case_image');
assert.strictEqual(tools.length, Object.keys(PUBLIC_CONTRACT.methods).length);
assert.deepStrictEqual(tools.map(tool => tool.name), Object.keys(PUBLIC_CONTRACT.methods).map(name => 'mavt_case_' + name));
for (const method of Object.values(PUBLIC_CONTRACT.methods)) {
  const tool = tools.find(tool => tool.name === 'mavt_case_' + method.name);
  assert.strictEqual(tool.inputSchema.properties.input, method.inputSchema,
    'Case MCP exposes the authoritative method input schema without copying');
  assert.deepStrictEqual(tool.inputSchema.required, ['contextRef', 'input']);
  const args = { contextRef: 'mavt-context:loader-issued', input: method.minimalExample.input };
  assert.doesNotThrow(() => validate(tool.name, args), tool.name);
  assert.throws(() => validate(tool.name, { ...args, executionId: 'untrusted-execution' }),
    error => error.code === 'MAVT_MCP_INPUT_INVALID');
  assert.throws(() => validate(tool.name, { contextRef: args.contextRef, input: { unexpected: true } }),
    error => error.code === 'MAVT_MCP_INPUT_INVALID');
  assert.throws(() => validate(tool.name, { input: args.input }),
    error => error.code === 'MAVT_MCP_INPUT_INVALID');
}
assert.throws(() => validate('mavt_case_missing', {}),
  error => error.code === 'MAVT_MCP_TOOL_UNKNOWN');
console.log('agent-facing MCP contract parity passed');
