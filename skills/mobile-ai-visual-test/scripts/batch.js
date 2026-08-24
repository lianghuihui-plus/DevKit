#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  bootstrapBatch,
  commitCurrentCase,
  initializeBatch,
  loadBatch,
  reconcileBatch,
  recoverApp,
  startCurrentCase,
} = require('./batch/core');
const { createDeviceSessionAdapter } = require('./batch/device-session');
const { loadExecutionRequest } = require('./lib/run-control');

const SKILL_ROOT = path.resolve(__dirname, '..');
const COMMANDS = new Set(['init', 'bootstrap', 'reconcile', 'start', 'commit', 'recover', 'status']);

function fail(message) {
  const error = new Error(`BATCH_CLI_INVALID: ${message}`);
  error.exitCode = 2;
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) fail(`unknown command: ${command || 'missing'}`);
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

function json(value, label) {
  if (!value) fail(`${label} is required`);
  try { return JSON.parse(value); } catch (error) { fail(`${label} is invalid JSON: ${error.message}`); }
}

function buildRoleContract(role, platform) {
  const output = childProcess.execFileSync(process.execPath, [
    path.join(SKILL_ROOT, 'scripts/build-agent-contract.js'),
    '--role', role, '--platform', platform,
  ], { cwd: SKILL_ROOT, encoding: 'utf8' });
  return JSON.parse(output);
}

function existingPlatform(options) {
  const contractPath = path.join(options.workspace, 'runs', options.batchId, 'contract.json');
  if (!fs.existsSync(contractPath)) fail(`batch contract is missing: ${options.batchId}`);
  return JSON.parse(fs.readFileSync(contractPath, 'utf8')).binding?.platform;
}

function context(options) {
  const platform = options.platform || existingPlatform(options);
  const skillContract = buildRoleContract('case-executor', platform);
  const coordinatorContract = buildRoleContract('batch-coordinator', platform);
  return {
    skillContract,
    coordinatorContract,
    implementationSha: skillContract.implementationSha,
    caseExecutorProtocolSha: skillContract.protocolSha,
    coordinatorProtocolSha: coordinatorContract.protocolSha,
    adapter: createDeviceSessionAdapter(),
  };
}

function execute(options) {
  if (options.command === 'init') {
    if (options.bindingJson !== undefined || options.targetsJson !== undefined) {
      fail('init no longer accepts --binding-json or --targets-json; create an explicit execution request first');
    }
    const executionRequest = loadExecutionRequest(options.workspace, options.batchId);
    const current = context({ ...options, platform: executionRequest.binding.platform });
    return initializeBatch({
      workspaceRoot: options.workspace,
      batchId: options.batchId,
      implementationSha: current.implementationSha,
      caseExecutorProtocolSha: current.caseExecutorProtocolSha,
      coordinatorProtocolSha: current.coordinatorProtocolSha,
    });
  }
  const current = context(options);
  const common = {
    workspaceRoot: options.workspace,
    batchId: options.batchId,
    implementationSha: current.implementationSha,
    caseExecutorProtocolSha: current.caseExecutorProtocolSha,
    coordinatorProtocolSha: current.coordinatorProtocolSha,
  };
  switch (options.command) {
    case 'bootstrap': return bootstrapBatch({ ...common, adapter: current.adapter });
    case 'reconcile': return reconcileBatch({ ...common, adapter: current.adapter });
    case 'start': {
      return startCurrentCase({ ...common, skillContract: current.skillContract });
    }
    case 'commit': return commitCurrentCase(common);
    case 'recover': return recoverApp({ ...common, adapter: current.adapter, request: json(options.requestJson, '--request-json') });
    case 'status': return loadBatch(options.workspace, options.batchId, current.implementationSha);
    default: fail('unsupported command');
  }
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(execute(parseArgs(argv)), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(error.exitCode || 2); }
}

module.exports = { buildContract: (platform) => buildRoleContract('case-executor', platform), buildRoleContract, execute, main, parseArgs };
