'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');
const {
  PUBLIC_CONTRACT,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const { parseRequest } = require('../case-runtime/agent-facing-client');
const {
  createToolDefinitions,
  handleMessage,
  invokeTool,
  requestForToolCall,
  validateToolCall,
} = require('../case-runtime/mcp-server');

const definitions = createToolDefinitions();
assert.strictEqual(definitions.length, Object.keys(PUBLIC_CONTRACT.methods).length);
assert.deepStrictEqual(definitions.map((item) => item.name), Object.keys(PUBLIC_CONTRACT.methods));

const forbidden = ['executionId', 'dispatchSequence', 'dispatchLease', 'capabilityId', 'operation', 'token', 'requestPath'];
for (const definition of definitions) {
  const encoded = JSON.stringify(definition.inputSchema);
  for (const field of forbidden) assert.strictEqual(encoded.includes(field), false, `${definition.name} schema leaks ${field}`);
  assert.strictEqual(encoded.includes('capability'), false, `${definition.name} capability is bound by its MCP tool name`);
  const method = PUBLIC_CONTRACT.methods[definition.name];
  assert.deepStrictEqual(requestForToolCall(definition.name, method.minimalExample), method.minimalExample);
  const invalidArguments = { unexpected: true };
  assert.deepStrictEqual(
    validateToolCall(definition.name, invalidArguments),
    validateAgentFacingRequest({ capability: definition.name, ...invalidArguments }),
  );
}

const calls = [];
for (const method of Object.values(PUBLIC_CONTRACT.methods)) {
  const shellRequest = parseRequest([], JSON.stringify(method.minimalExample));
  const { capability, ...args } = method.minimalExample;
  const mcpResponse = invokeTool({
    execDir: '/bound/execution',
    options: { marker: 'preserved' },
    runFacade: (execDir, request, options) => {
      calls.push({ execDir, request, options });
      return { protocol: 'agent-facing', status: 'READY', capability: request.capability };
    },
  }, method.name, args);
  assert.deepStrictEqual(calls.at(-1), {
    execDir: '/bound/execution',
    request: shellRequest,
    options: { marker: 'preserved', hostTransport: 'mcp' },
  });
  assert.deepStrictEqual(mcpResponse, {
    protocol: 'agent-facing', status: 'READY', capability,
  });
}
assert.strictEqual(calls.length, Object.keys(PUBLIC_CONTRACT.methods).length);

const initialized = handleMessage({}, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
assert.deepStrictEqual(initialized.result.serverInfo, { name: 'mavt-case-runtime', version: 'current' });

assert.throws(() => invokeTool({ execDir: '/bound/execution' }, 'missing', {}), (error) => error.code === 'MCP_METHOD_NOT_FOUND');

const specialRequest = {
  capability: 'observe',
  purpose: '引号\'、中文、$HOME、`date` 和换行\n保持原样',
};
const parserPath = path.resolve(__dirname, '../case-runtime/agent-facing-client.js');
const parserScript = `const { parseRequest } = require(${JSON.stringify(parserPath)}); process.stdout.write(JSON.stringify(parseRequest([], require('fs').readFileSync(0, 'utf8'))));`;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const heredoc = [
  `${shellQuote(process.execPath)} -e ${shellQuote(parserScript)} <<'MAVT_REQUEST'`,
  JSON.stringify(specialRequest),
  'MAVT_REQUEST',
].join('\n');
const heredocResult = childProcess.spawnSync('/bin/sh', ['-c', heredoc], { encoding: 'utf8' });
assert.strictEqual(heredocResult.status, 0, heredocResult.stderr);
assert.deepStrictEqual(JSON.parse(heredocResult.stdout), specialRequest);

console.log('agent-facing transport parity passed');
