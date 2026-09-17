#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCliArgs } = require('./lib/cli-args');
const {
  AGENT_FACING_PROTOCOL,
  documentationRefFor,
} = require('./coordinator/agent-facing-contract');
const {
  advanceRun,
  cancelRun,
  confirmRun,
  coordinatorInputRecovery,
  loadCoordinatorState,
  prepareRun,
  recordCoordinatorInputFailure,
} = require('./coordinator/agent-facing-service');

const COMMANDS = new Set(['prepare', 'advance', 'confirm', 'cancel']);

function inputError(message, issues = []) {
  const error = new Error(message);
  error.code = 'COORDINATOR_INPUT_INVALID';
  error.issues = issues;
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw inputError(`未知命令：${command || 'missing'}`);
  const allowed = command === 'prepare' ? ['--workspace', '--case-nos'] : ['--state'];
  let parsed;
  try {
    parsed = parseCliArgs(argv.slice(1), { context: `coordinator-agent ${command}`, valueOptions: allowed, maxPositionals: 0 });
  } catch (error) {
    throw inputError(error.message, error.issues || []);
  }
  const values = Object.fromEntries(Object.entries(parsed.values).map(([flag, value]) => [
    flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value,
  ]));
  if (command === 'prepare') {
    if (!values.workspace || !values.caseNos) throw inputError('prepare 需要 --workspace 和 --case-nos');
    return {
      command,
      request: {
        capability: 'prepareRun',
        workspace: path.resolve(values.workspace),
        caseNos: values.caseNos.split(',').map((item) => item.trim()).filter(Boolean),
      },
    };
  }
  if (!values.state) throw inputError(`${command} 需要预绑定的 --state`);
  if (Object.keys(values).some((key) => key !== 'state')) throw inputError(`${command} 只接受预绑定的 --state`);
  return { command, statePath: path.resolve(values.state) };
}

function consumeRequest(requestPath) {
  if (!fs.existsSync(requestPath)) throw inputError(`先将确认内容写入 ${requestPath}，再原样执行 command`);
  const claimed = `${requestPath}.claimed-${process.pid}-${Date.now()}`;
  fs.renameSync(requestPath, claimed);
  try {
    return JSON.parse(fs.readFileSync(claimed, 'utf8'));
  } catch (error) {
    if (error.name === 'SyntaxError') throw inputError('requestPath 中的内容不是有效 JSON');
    throw error;
  } finally {
    if (fs.existsSync(claimed)) fs.unlinkSync(claimed);
  }
}

function execute(parsed, options = {}) {
  if (parsed.command === 'prepare') return prepareRun(parsed.request, options);
  if (parsed.command === 'advance') return advanceRun(parsed.statePath, options);
  const state = loadCoordinatorState(parsed.statePath);
  const requestPath = state.commands[parsed.command].requestPath;
  const request = consumeRequest(requestPath);
  return parsed.command === 'confirm'
    ? confirmRun(parsed.statePath, request, options)
    : cancelRun(parsed.statePath, request, options);
}

function errorResponse(error, command, recovery = {}, stalled = false) {
  const code = stalled ? 'AGENT_INPUT_STALLED' : (error.code || 'COORDINATOR_AGENT_FAILED');
  if (stalled) {
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'AGENT_INPUT_STALLED',
      code,
      message: '同一种输入错误已连续出现两次；停止自动重试并保留当前运行状态',
      retryable: false,
      issues: error.issues?.length ? error.issues : [{ field: 'request', message: error.message || String(error), code: error.code || 'INVALID_ARGUMENT' }],
      ...(Object.keys(recovery).length ? { facts: recovery } : {}),
      documentationRef: documentationRefFor(code),
    };
  }
  const inputInvalid = error.code === 'COORDINATOR_INPUT_INVALID' || error.name === 'SyntaxError';
  const diagnostic = error.diagnostic || {
    code: error.code || 'COORDINATOR_AGENT_FAILED',
    stage: 'COORDINATOR',
    summary: error.message || String(error),
    retryable: false,
  };
  return {
    protocol: AGENT_FACING_PROTOCOL,
    status: inputInvalid ? 'REQUEST_INVALID' : 'TECHNICAL',
    code,
    message: error.message || String(error),
    retryable: inputInvalid || diagnostic.retryable === true,
    issues: error.issues?.length ? error.issues : [{ field: 'arguments', message: error.message || String(error), code: error.code || 'INVALID_ARGUMENT' }],
    ...(!inputInvalid || Object.keys(recovery).length ? {
      facts: {
        ...recovery,
        ...(!inputInvalid ? {
          technical: {
            ...(diagnostic.code ? { code: diagnostic.code } : {}),
            ...(diagnostic.stage ? { stage: diagnostic.stage } : {}),
            ...(diagnostic.logRefs ? { logRefs: diagnostic.logRefs } : {}),
            ...(diagnostic.resourceFacts ? { resourceFacts: diagnostic.resourceFacts } : {}),
          },
        } : {}),
      },
    } : {}),
    documentationRef: documentationRefFor(code),
  };
}

function recoveryFor(argv) {
  const command = argv[0];
  if (command === 'cancel') return { phase: 'CANCEL_REQUEST' };
  if (command !== 'confirm') return {};
  const stateIndex = argv.indexOf('--state');
  if (stateIndex < 0 || !argv[stateIndex + 1]) return {};
  try {
    return coordinatorInputRecovery(path.resolve(argv[stateIndex + 1]), command);
  } catch {
    return {};
  }
}

function recordInputFailureFor(argv, error) {
  if (!['COORDINATOR_INPUT_INVALID', 'SyntaxError'].includes(error.code || error.name)) return false;
  const command = argv[0];
  if (!['confirm', 'cancel'].includes(command)) return false;
  const stateIndex = argv.indexOf('--state');
  if (stateIndex < 0 || !argv[stateIndex + 1]) return false;
  try {
    return recordCoordinatorInputFailure(path.resolve(argv[stateIndex + 1]), command, error);
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  if (!options.returnOnly && parsed.command === 'advance') {
    process.stderr.write(`${JSON.stringify({
      event: 'COORDINATOR_COMMAND_STARTED',
      capability: 'advanceRun',
      status: 'RUNNING',
    })}\n`);
  }
  const response = execute(parsed, options);
  if (options.returnOnly) return response;
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const argv = process.argv.slice(2);
    const recovery = recoveryFor(argv);
    const stalled = recordInputFailureFor(argv, error);
    process.stderr.write(`${JSON.stringify(errorResponse(
      error,
      process.argv[2],
      recovery,
      stalled,
    ), null, 2)}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = { consumeRequest, errorResponse, execute, main, parseArgs, recordInputFailureFor, recoveryFor };
