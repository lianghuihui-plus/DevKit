'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildPlugin } = require('../build-plugin');
test('null and fractional request IDs cannot initialize or enable tool calls', () => {
  const { createProtocol } = require('../src/mobile-ai-visual-test/scripts/mcp/protocol');
  for (const id of [null, 0.5]) {
    const handler = createProtocol({ listTools: () => [] });
    const rejected = handler({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(rejected.error?.code, -32600, JSON.stringify(rejected));
    assert.equal(handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32002);
    assert.equal(handler({ jsonrpc: '2.0', id, method: 'ping' }).error.code, -32600);
  }
});
test('malformed initialize clientInfo leaves discovery disabled until valid initialization with ID zero', () => {
  const { createProtocol } = require('../src/mobile-ai-visual-test/scripts/mcp/protocol');
  for (const clientInfo of [{}, { name: 'test' }, { version: '1' }, { name: 42, version: '1' }, { name: 'test', version: null }]) {
    const handler = createProtocol({ listTools: () => [] });
    const rejected = handler({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo } });
    assert.equal(rejected.error?.code, -32602, JSON.stringify(rejected));
    assert.equal(handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32002);
    assert.equal(handler({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }).id, 0);
    assert.deepEqual(handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result, { tools: [] });
  }
});
test('async tool results preserve UNKNOWN and are returned once without retry', async () => {
  const { createProtocol } = require('../src/mobile-ai-visual-test/scripts/mcp/protocol');
  const { toolResult } = require('../src/mobile-ai-visual-test/scripts/mcp/management-service');
  const unknown = { status: 'UNKNOWN', error: { code: 'ACTION_OUTCOME_UNKNOWN', retryable: false }, result: { actionId: 'pending-1' } };
  let calls = 0;
  const handler = createProtocol({ listTools: () => [{ name: 'pending' }], callTool: async () => { calls += 1; return toolResult(unknown); } });
  handler({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const result = await handler({ jsonrpc: '2.0', id: 'unknown', method: 'tools/call', params: { name: 'pending', arguments: {} } });
  assert.deepEqual(result.result.structuredContent, unknown);
  assert.equal(result.result.isError, true);
  assert.equal(JSON.parse(result.result.content[0].text).status, 'UNKNOWN');
  assert.equal(calls, 1, 'transport must never replay an uncertain action');
});
test('async tool rejection retains the original request ID', async () => {
  const { createProtocol } = require('../src/mobile-ai-visual-test/scripts/mcp/protocol');
  const handler = createProtocol({ listTools: () => [{ name: 'fails' }], callTool: async () => { throw new Error('asynchronous failure'); } });
  handler({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const result = await handler({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'fails', arguments: {} } });
  assert.equal(result.id, 0);
  assert.equal(result.error.code, -32603);
});
test('stdio negotiates, handles IDs and notifications, and emits only protocol', t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-mcp-protocol-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const built = buildPlugin({ outputRoot: path.join(temp, 'built') });
  const requests = [
    '{broken',
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 'unsupported', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'missing' }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing', arguments: {} } }),
    JSON.stringify({ id: 5, method: 'ping' }),
  ];
  const child = spawnSync(process.execPath, [path.join(built.pluginRoot, 'scripts/mavt-mcp.js')], { encoding: 'utf8', input: requests.join('\n') + '\n' });
  assert.equal(child.status, 0, child.stderr);
  const output = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(output.length, 7);
  assert.equal(output[0].error.code, -32700);
  assert.equal(output[1].id, 0); assert.equal(output[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(output[2], { jsonrpc: '2.0', id: 'ping', result: {} });
  assert.ok(output[3].result.tools.some(tool => tool.name === 'mavt_cases_import'));
  assert.equal(output[4].error.code, -32601);
  assert.equal(output[5].error.code, -32602);
  assert.equal(output[6].error.code, -32600);
});
