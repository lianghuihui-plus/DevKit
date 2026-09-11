#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  confirmEnvironment,
  loadEnvironmentConfirmation,
} = require('./lib/run-control');
const { parseCoordinatorJson, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function fail(message) {
  const error = new Error(`ENVIRONMENT_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['confirm', 'status'].includes(command)) fail(`unknown command: ${command || 'missing'}`);
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`invalid option: ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  if (!options.workspace) fail('--workspace is required');
  options.workspace = path.resolve(options.workspace);
  return options;
}

function execute(options) {
  if (options.command === 'status') return loadEnvironmentConfirmation(options.workspace);
  return confirmEnvironment({
    workspaceRoot: options.workspace,
    binding: parseCoordinatorJson(options.bindingJson, 'scripts/environment.js', 'confirm', 'bindingJson'),
    probe: parseCoordinatorJson(options.probeJson, 'scripts/environment.js', 'confirm', 'probeJson'),
    appProvisioning: parseCoordinatorJson(options.appProvisioningJson, 'scripts/environment.js', 'confirm', 'appProvisioningJson', { required: false }),
    userConfirmation: options.userConfirmation || fail('--user-confirmation is required'),
  });
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/environment.js', process.argv[2]); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };
