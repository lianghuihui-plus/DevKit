#!/usr/bin/env node
'use strict';

const path = require('path');
const { registerAppArtifact } = require('./lib/app-provisioning');
const { assertWorkspace } = require('./lib/workspace');

function fail(message) {
  const error = new Error(`APP_ARTIFACT_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  if (argv[0] !== 'register') fail(`unknown command: ${argv[0] || 'missing'}`);
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`invalid option: ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  for (const field of ['workspace', 'path', 'platform', 'appId', 'version', 'build']) {
    if (!options[field]) fail(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
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
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { execute, main, parseArgs };
