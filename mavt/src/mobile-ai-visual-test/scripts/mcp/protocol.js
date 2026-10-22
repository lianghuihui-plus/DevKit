'use strict';
const readline = require('node:readline');
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function createProtocol(server) {
  let initialized = false;
  return function handleMessage(message) {
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method ||
      Object.hasOwn(message, 'id') && !(message.id === null || typeof message.id === 'string' || Number.isFinite(message.id)) ||
      message.params !== undefined && !object(message.params)) return error(object(message) && (typeof message.id === 'string' || Number.isFinite(message.id)) ? message.id : null, -32600, 'Invalid Request');
    const notification = !Object.hasOwn(message, 'id');
    if (notification) return null; // Notifications never receive responses or perform tool effects.
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) return error(id, -32602, 'Invalid initialize parameters');
      initialized = true;
      return response(id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mavt', version: '1' } });
    }
    if (method === 'ping') return response(id, {});
    if (!initialized) return error(id, -32002, 'Server not initialized');
    if (method === 'tools/list') return response(id, { tools: server.listTools() });
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !server.listTools().some(tool => tool.name === params.name) ||
        params.arguments !== undefined && !object(params.arguments) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) return error(id, -32602, 'Invalid tool call');
      try {
        const result = server.callTool(params.name, params.arguments || {});
        return result && typeof result.then === 'function' ? result.then(value => response(id, value), failure => error(id, -32603, failure.message)) : response(id, result);
      } catch (failure) { return error(id, -32603, failure.message); }
    }
    return error(id, -32601, `Method not found: ${method}`);
  };
}
function main(server, options = {}) {
  const handleMessage = createProtocol(server);
  const input = readline.createInterface({ input: options.input || process.stdin, crlfDelay: Infinity });
  const output = options.output || process.stdout;
  input.on('line', line => {
    if (!line.trim()) return;
    let result;
    try { result = handleMessage(JSON.parse(line)); }
    catch (failure) { result = failure instanceof SyntaxError ? error(null, -32700, 'Parse error') : error(null, -32603, failure.message); }
    if (result && typeof result.then === 'function') result.then(value => { if (value) output.write(JSON.stringify(value) + '\n'); }, failure => output.write(JSON.stringify(error(null, -32603, failure.message)) + '\n'));
    else if (result) output.write(JSON.stringify(result) + '\n');
  });
}
module.exports = { createProtocol, main, VERSIONS };
