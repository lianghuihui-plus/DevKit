#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  bindAgentRuntime,
  changePhase,
  createExecution,
  finalizeExecution,
  recordKnowledgeQuery,
} = require('../execution/core');

const COMMANDS = new Set(['create', 'bind-runtime', 'phase', 'knowledge-query', 'finalize']);
const OPTION_KEYS = new Set([
  'workspaceRoot', 'runtimeDir', 'execDir', 'caseJson', 'sourceText', 'executionId',
  'batchId', 'platform', 'implementationSha', 'json', 'to', 'reason',
]);

function fail(message) {
  const error = new Error(`CURRENT_CORE_CLI_INVALID: ${message}`);
  error.code = 'CURRENT_CORE_CLI_INVALID';
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) fail(`unknown command: ${command || 'missing'}`);
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) fail(`unexpected argument: ${name}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`missing value for ${name}`);
    const key = name.slice(2).replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    if (!OPTION_KEYS.has(key)) fail(`unknown option: ${name}`);
    options[key] = argv[++index];
  }
  return options;
}

function json(value, label) {
  if (!value) fail(`${label} is required`);
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function requireValue(options, key) {
  if (!options[key]) fail(`--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
  return options[key];
}

function main(argv = process.argv.slice(2)) {
  if (process.env.MAVT_SELF_TEST !== '1') fail('MAVT_SELF_TEST=1 is required');
  const options = parseArgs(argv);
  const implementation = options.implementationSha ? { implementationSha: options.implementationSha } : {};
  let result;
  switch (options.command) {
    case 'create':
      result = createExecution({
        workspaceRoot: path.resolve(requireValue(options, 'workspaceRoot')),
        runtimeDir: path.resolve(requireValue(options, 'runtimeDir')),
        caseJson: json(options.caseJson, '--case-json'),
        sourceText: requireValue(options, 'sourceText'),
        executionId: options.executionId,
        batchId: requireValue(options, 'batchId'),
        platform: requireValue(options, 'platform'),
        implementationSha: requireValue(options, 'implementationSha'),
      });
      break;
    case 'bind-runtime': result = bindAgentRuntime(path.resolve(requireValue(options, 'execDir')), implementation); break;
    case 'phase': result = changePhase(path.resolve(requireValue(options, 'execDir')), requireValue(options, 'to'), requireValue(options, 'reason'), implementation); break;
    case 'knowledge-query': result = recordKnowledgeQuery(path.resolve(requireValue(options, 'execDir')), json(options.json, '--json'), implementation); break;
    case 'finalize': result = finalizeExecution(path.resolve(requireValue(options, 'execDir')), json(options.json, '--json'), implementation); break;
    default: fail('unsupported command');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = { main, parseArgs };
