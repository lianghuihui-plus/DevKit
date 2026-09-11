#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  createExecutionRequest,
  loadExecutionRequest,
} = require('./lib/run-control');
const { parseCoordinatorJson, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function fail(message) {
  const error = new Error(`EXECUTION_REQUEST_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['create', 'status'].includes(command)) fail(`unknown command: ${command || 'missing'}`);
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`invalid option: ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  if (!options.workspace || !options.batchId) fail('--workspace and --batch-id are required');
  options.workspace = path.resolve(options.workspace);
  return options;
}

function targets(value) {
  return parseCoordinatorJson(value, 'scripts/execution-request.js', 'create', 'targetsJson');
}

function jsonOption(value, flag) {
  return parseCoordinatorJson(value, 'scripts/execution-request.js', 'create', flag
    .slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), { required: false });
}

function execute(options) {
  if (options.command === 'status') return loadExecutionRequest(options.workspace, options.batchId);
  if (!options.mode) fail('--mode is required');
  if (!options.userInstruction) fail('--user-instruction is required');
  return createExecutionRequest({
    workspaceRoot: options.workspace,
    batchId: options.batchId,
    mode: options.mode,
    targets: targets(options.targetsJson),
    bootstrapPolicy: jsonOption(options.bootstrapPolicyJson, '--bootstrap-policy-json'),
    userInstruction: options.userInstruction,
  });
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/execution-request.js', process.argv[2]); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };
