#!/usr/bin/env node
'use strict';

const path = require('path');
const { registerAppArtifact } = require('./lib/app-provisioning');
const { assertWorkspace } = require('./lib/workspace');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function fail(message) {
  const error = new Error(`APP_ARTIFACT_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const options = parseCoordinatorCliArgs(argv, 'scripts/app-artifact.js');
  if (options.platform === 'ios' && !options.deviceType) fail('--device-type is required for ios');
  return options;
}

function execute(options) {
  const workspace = assertWorkspace(options.workspace, { allowTest: true });
  return registerAppArtifact({
    workspaceRoot: workspace.root,
    sourcePath: path.resolve(options.path),
    platform: options.platform,
    format: options.format,
    deviceType: options.deviceType,
    appId: options.appId,
    version: options.version,
    build: options.build,
  });
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { writeCoordinatorCliError(error, 'scripts/app-artifact.js', process.argv[2]); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };
