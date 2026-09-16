#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { attachTechnicalContext } = require('./lib/technical-context');
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
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw inputError(`无效参数：${flag}`);
    }
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
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

function commandHelp(command = 'prepare') {
  if (command === 'prepare') {
    return {
      usage: 'node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>',
      example: ['node', 'scripts/coordinator-agent.js', 'prepare', '--workspace', '<workspace>', '--case-nos', '014,015'],
    };
  }
  return {
    usage: `原样执行 Facade 响应中的 commands.${command === 'advance' ? 'advance' : `${command}.command`}`,
    example: ['use-current-response-command'],
  };
}

function errorResponse(error, command, retryWith = null, stalled = false, confirmChoices = null) {
  if (stalled) {
    return {
      status: 'AGENT_INPUT_STALLED',
      code: 'AGENT_INPUT_STALLED',
      command: `scripts/coordinator-agent.js ${command}`,
      message: '同一种输入错误已连续出现两次；停止自动重试并保留当前运行状态',
      issues: error.issues?.length ? error.issues : [{ field: 'request', message: error.message || String(error), code: error.code || 'INVALID_ARGUMENT' }],
    };
  }
  const inputInvalid = error.code === 'COORDINATOR_INPUT_INVALID' || error.name === 'SyntaxError';
  const diagnostic = error.diagnostic || {
    code: error.code || 'COORDINATOR_AGENT_FAILED',
    stage: 'COORDINATOR',
    summary: error.message || String(error),
    retryable: false,
  };
  return attachTechnicalContext({
    status: inputInvalid ? 'REQUEST_INVALID' : 'TECHNICAL',
    code: error.code || 'COORDINATOR_AGENT_FAILED',
    command: `scripts/coordinator-agent.js ${COMMANDS.has(command) ? command : 'prepare'}`,
    message: error.message || String(error),
    issues: error.issues?.length ? error.issues : [{ field: 'arguments', message: error.message || String(error), code: error.code || 'INVALID_ARGUMENT' }],
    ...(!inputInvalid ? { diagnostic } : {}),
    ...(inputInvalid && retryWith ? { retryWith } : {}),
    ...(inputInvalid && confirmChoices?.length ? { confirmChoices } : {}),
    ...commandHelp(COMMANDS.has(command) ? command : 'prepare'),
  }, 'COORDINATOR', error.resume || retryWith || { capability: command === 'advance' ? 'advanceRun' : 'prepareRun' });
}

function retryWithFor(argv) {
  return recoveryFor(argv).retryWith || null;
}

function recoveryFor(argv) {
  const command = argv[0];
  if (command === 'cancel') return { retryWith: { capability: 'cancelRun', reason: '说明取消原因' } };
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
      message: '命令正在执行；若宿主返回进程句柄，请继续等待同一进程，不要重复调用',
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
      recovery.retryWith,
      stalled,
      recovery.confirmChoices,
    ), null, 2)}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = { consumeRequest, errorResponse, execute, main, parseArgs, recordInputFailureFor, recoveryFor, retryWithFor };
