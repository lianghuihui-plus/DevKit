#!/usr/bin/env node
'use strict';
const path = require('node:path');
const RUNTIME = path.resolve(__dirname, '../runtime/mobile-ai-visual-test');
const { createServer: managementServer } = require(path.join(RUNTIME, 'scripts/mcp/management-service'));
const { createProtocol, main: protocolMain } = require(path.join(RUNTIME, 'scripts/mcp/protocol'));
function createServer({ pluginRoot = path.resolve(__dirname, '..'), workerPool = false } = {}) {
  const server = managementServer({ pluginRoot });
  const pool = workerPool ? require(path.join(RUNTIME, 'scripts/mcp/worker-pool')).createPool({ pluginRoot, ...workerPool }) : null;
  const routed = pool ? { listTools: server.listTools, callTool: pool.callTool, close: pool.close, workerStats: pool.stats } : server;
  return { ...routed, handleMessage: createProtocol(routed) };
}
function main(options = {}) { return protocolMain(createServer({ ...options, workerPool: options.workerPool === undefined ? {} : options.workerPool }), options); }
if (require.main === module) main();
module.exports = { createServer, main };
