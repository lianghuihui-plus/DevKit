#!/usr/bin/env node
'use strict';
const path = require('node:path');
const RUNTIME = path.resolve(__dirname, '../runtime/mobile-ai-visual-test');
const { createServer: managementServer } = require(path.join(RUNTIME, 'scripts/mcp/management-service'));
const { createProtocol, main: protocolMain } = require(path.join(RUNTIME, 'scripts/mcp/protocol'));
function createServer({ pluginRoot = path.resolve(__dirname, '..') } = {}) {
  const server = managementServer({ pluginRoot });
  return { ...server, handleMessage: createProtocol(server) };
}
function main(options = {}) { return protocolMain(createServer(options), options); }
if (require.main === module) main();
module.exports = { createServer, main };
