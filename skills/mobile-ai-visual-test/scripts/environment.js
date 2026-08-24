#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  confirmEnvironment,
  loadEnvironmentConfirmation,
} = require('./lib/run-control');

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

function json(value, label) {
  if (!value) fail(`${label} is required`);
  try { return JSON.parse(value); } catch (error) { fail(`${label} is invalid JSON: ${error.message}`); }
}

function execute(options) {
  if (options.command === 'status') return loadEnvironmentConfirmation(options.workspace);
  return confirmEnvironment({
    workspaceRoot: options.workspace,
    binding: json(options.bindingJson, '--binding-json'),
    probe: json(options.probeJson, '--probe-json'),
    userConfirmation: options.userConfirmation || fail('--user-confirmation is required'),
  });
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };
