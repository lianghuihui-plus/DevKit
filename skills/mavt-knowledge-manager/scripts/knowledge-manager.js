#!/usr/bin/env node
'use strict';

const path = require('path');
const { managerError } = require('./lib/errors');
const { inspectKnowledge, listKnowledge, showKnowledge } = require('./lib/knowledge-store');
const { applyTransaction, prepareTransaction } = require('./lib/knowledge-transaction');

const COMMAND_FLAGS = Object.freeze({
  inspect: ['workspace'],
  list: ['workspace'],
  show: ['workspace', 'entry-id'],
  validate: ['workspace'],
  prepare: ['workspace', 'request'],
  apply: ['workspace', 'request', 'plan-hash'],
});
const COMMANDS = new Set(Object.keys(COMMAND_FLAGS));

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!COMMANDS.has(command)) {
    throw managerError('COMMAND_INVALID', `command must be one of: ${[...COMMANDS].join(', ')}`);
  }
  const allowed = new Set(COMMAND_FLAGS[command]);
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) {
      throw managerError('ARGUMENT_UNKNOWN', `unexpected argument: ${flag ?? ''}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw managerError('ARGUMENT_UNKNOWN', `unsupported argument for ${command}: ${flag}`);
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw managerError('ARGUMENT_DUPLICATE', `argument must not be repeated: ${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw managerError('ARGUMENT_REQUIRED', `argument value is required: ${flag}`);
    }
    values[name] = value;
  }
  for (const name of allowed) {
    if (!values[name]) throw managerError('ARGUMENT_REQUIRED', `--${name} is required for ${command}`);
  }
  return {
    command,
    workspace: path.resolve(values.workspace),
    ...(values['entry-id'] ? { entryId: values['entry-id'] } : {}),
    ...(values.request ? { requestPath: path.resolve(values.request) } : {}),
    ...(values['plan-hash'] ? { planHash: values['plan-hash'] } : {}),
  };
}

function execute(options) {
  if (options.command === 'inspect' || options.command === 'validate') return inspectKnowledge(options.workspace);
  if (options.command === 'list') return listKnowledge(options.workspace);
  if (options.command === 'show') return showKnowledge(options.workspace, options.entryId);
  if (options.command === 'prepare') return prepareTransaction(options.workspace, options.requestPath);
  return applyTransaction(options.workspace, options.requestPath, options.planHash);
}

function main(argv = process.argv.slice(2)) {
  const result = execute(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function failureResponse(error) {
  return {
    schemaVersion: 1,
    status: ['COMMAND_INVALID', 'ARGUMENT_UNKNOWN', 'ARGUMENT_DUPLICATE', 'ARGUMENT_REQUIRED'].includes(error?.code)
      ? 'REQUEST_INVALID'
      : 'FAILED',
    code: error?.code || 'KNOWLEDGE_MANAGER_FAILED',
    message: error?.message || String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureResponse(error), null, 2)}\n`);
    process.exit(error?.exitCode || 2);
  }
}

module.exports = { COMMANDS, COMMAND_FLAGS, execute, failureResponse, main, parseArgs };
