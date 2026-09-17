#!/usr/bin/env node
'use strict';

function cliArgumentError(message, issue = null) {
  const error = new Error(message);
  error.code = 'COORDINATOR_CLI_INVALID';
  error.errorKind = 'INPUT';
  error.exitCode = 2;
  if (issue) error.issues = [issue];
  return error;
}

function parseCliArgs(argv, options = {}) {
  const context = options.context || 'command';
  const valueOptions = new Set(options.valueOptions || []);
  const booleanOptions = new Set(options.booleanOptions || []);
  const maxPositionals = options.maxPositionals ?? Number.POSITIVE_INFINITY;
  const positionals = [];
  const values = {};
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && String(arg).startsWith('-')) {
      if (booleanOptions.has(arg)) {
        if (Object.prototype.hasOwnProperty.call(values, arg)) {
          throw cliArgumentError(`${context} 重复参数: ${arg}`, { fieldPath: arg.slice(2), code: 'DUPLICATE_ARGUMENT', expected: 'the option exactly once' });
        }
        values[arg] = true;
        continue;
      }
      if (!valueOptions.has(arg)) {
        throw cliArgumentError(`${context} 未知参数: ${arg}`, { fieldPath: arg.slice(2), code: 'UNKNOWN_ARGUMENT', expected: `one of ${[...valueOptions, ...booleanOptions].join(', ')}` });
      }
      const value = argv[i + 1];
      if (value === undefined || String(value).startsWith('-')) {
        throw cliArgumentError(`${context} 缺少参数值: ${arg}`, { fieldPath: arg.slice(2), code: 'REQUIRED_FIELD_MISSING', expected: 'a non-empty option value' });
      }
      if (Object.prototype.hasOwnProperty.call(values, arg)) {
        throw cliArgumentError(`${context} 重复参数: ${arg}`, { fieldPath: arg.slice(2), code: 'DUPLICATE_ARGUMENT', expected: 'the option exactly once' });
      }
      values[arg] = value;
      i += 1;
      continue;
    }
    positionals.push(arg);
    if (positionals.length > maxPositionals) {
      throw cliArgumentError(`${context} 不接受多余位置参数: ${arg}`, { fieldPath: 'arguments', code: 'POSITIONAL_ARGUMENT_INVALID', expected: `at most ${maxPositionals} positional arguments` });
    }
  }

  return { positionals, values };
}

function parseCliArgsOrExit(argv, options = {}) {
  try {
    return parseCliArgs(argv, options);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(error.exitCode || 2);
  }
}

module.exports = {
  cliArgumentError,
  parseCliArgs,
  parseCliArgsOrExit,
};
