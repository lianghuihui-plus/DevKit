'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execute: executeBatch } = require('../batch');
const { execute: executeCaseDefinition } = require('../case-definition');
const { assertWorkspace } = require('../lib/workspace');
const { resolveCaseNo } = require('../lib/case-numbering');
const {
  confirmEnvironment,
  createExecutionRequest,
  loadEnvironmentConfirmation,
} = require('../lib/run-control');
const { readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateCoordinatorRequest } = require('./agent-facing-contract');

const SKILL_ROOT = path.resolve(__dirname, '../..');
const COMPILER_PROMPT = '你是独立 Case Definition Compiler。执行给定的 loaderCommand，只处理其返回的单个用例原文；按照 Compiler Prompt 生成候选定义，并使用返回的 Publisher 接口发布。不要访问设备、Scene、Batch、历史执行或报告。';
const CASE_AGENT_PROMPT = '你是独立 Case Agent。执行给定的 loaderCommand，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。';

function coordinatorError(message, issues = [], code = 'COORDINATOR_INPUT_INVALID') {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.issues = issues;
  error.exitCode = 2;
  return error;
}

function assertRequest(request, expectedCapability) {
  const issues = validateCoordinatorRequest(request);
  if (request?.capability !== expectedCapability && !issues.some((item) => item.field === 'capability')) {
    issues.unshift({ field: 'capability', message: `必须为 ${expectedCapability}`, code: 'CAPABILITY_MISMATCH' });
  }
  if (issues.length) throw coordinatorError('请求字段不符合当前能力', issues);
}

function quote(value) {
  return JSON.stringify(String(value));
}

function pathsFor(workspace, batchId) {
  const batchDir = path.join(workspace, 'runs', batchId);
  return {
    batchDir,
    state: path.join(batchDir, 'coordinator-state.json'),
    lock: path.join(batchDir, '.coordinator.lock'),
    confirmRequest: path.join(batchDir, 'coordinator-confirm-request.json'),
    cancelRequest: path.join(batchDir, 'coordinator-cancel-request.json'),
  };
}

function commandsFor(paths) {
  const entry = path.join(SKILL_ROOT, 'scripts/coordinator-agent.js');
  return {
    advance: `${quote(process.execPath)} ${quote(entry)} advance --state ${quote(paths.state)}`,
    confirm: {
      requestPath: paths.confirmRequest,
      command: `${quote(process.execPath)} ${quote(entry)} confirm --state ${quote(paths.state)}`,
    },
    cancel: {
      requestPath: paths.cancelRequest,
      command: `${quote(process.execPath)} ${quote(entry)} cancel --state ${quote(paths.state)}`,
    },
  };
}

function allocateBatchId(now = null) {
  const stamp = String(now || new Date().toISOString()).replace(/\D/g, '').slice(0, 17);
  return `batch-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function saveCoordinatorState(state) {
  writeJsonAtomic(state.statePath, { ...state, updatedAt: state.updatedAt || new Date().toISOString() });
  return state;
}

function loadCoordinatorState(statePath) {
  const resolved = path.resolve(statePath);
  const state = readJson(resolved, null);
  if (!state || state.type !== 'coordinatorRun') {
    throw coordinatorError('Coordinator 状态不存在或不受支持', [{ field: 'state', message: resolved, code: 'STATE_INVALID' }], 'COORDINATOR_STATE_INVALID');
  }
  if (path.resolve(state.statePath) !== resolved) {
    throw coordinatorError('Coordinator 状态路径绑定不一致', [{ field: 'state', message: resolved, code: 'STATE_BINDING_MISMATCH' }], 'COORDINATOR_STATE_INVALID');
  }
  return state;
}

function recordCoordinatorInputFailure(statePath, command, error) {
  const initial = loadCoordinatorState(statePath);
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    const fingerprint = JSON.stringify({
      command,
      code: error.code || error.name || 'COORDINATOR_INPUT_INVALID',
      fields: (error.issues || []).map((item) => item.field || item.fieldPath || 'request').sort(),
    });
    const count = state.lastInvalid?.fingerprint === fingerprint
      ? Number(state.lastInvalid.count || 1) + 1 : 1;
    state.lastInvalid = { fingerprint, count };
    saveCoordinatorState(state);
    return count >= 2;
  });
}

function publicBase(state) {
  return { statePath: state.statePath, commands: state.commands };
}

function completedResponse(state, outcome) {
  return {
    status: 'COMPLETE',
    outcome,
    reportPath: path.join(state.workspace, 'index.html'),
    ...publicBase(state),
  };
}

function definitionStatus(target) {
  return executeCaseDefinition({ command: 'status', caseDir: target.caseDir });
}

function nextDefinitionResponse(state) {
  for (const target of state.targets) {
    const status = definitionStatus(target);
    if (status.status === 'CASE_DEFINITION_REQUIRED') {
      state.phase = 'WAITING_FOR_COMPILER';
      saveCoordinatorState(state);
      return {
        status: 'NEED_COMPILER',
        caseNo: target.caseNo,
        loaderCommand: status.compilerHandoff.loaderCommand,
        delegationPrompt: COMPILER_PROMPT,
        ...publicBase(state),
      };
    }
    target.definitionRef = status.definitionRef;
  }
  return null;
}

function confirmationResponse(state) {
  let environment = null;
  try {
    environment = loadEnvironmentConfirmation(state.workspace);
  } catch (error) {
    if (error.code !== 'ENVIRONMENT_NOT_CONFIRMED') throw error;
  }
  state.environmentConfirmed = Boolean(environment);
  state.phase = 'WAITING_FOR_CONFIRMATION';
  if (!environment) {
    const confirmTemplate = { capability: 'confirmRun', platform: 'harmony' };
    state.pendingConfirmation = confirmTemplate;
    saveCoordinatorState(state);
    return {
      status: 'NEED_USER_CONFIRMATION',
      reason: 'SELECT_PLATFORM',
      confirmTemplate,
      ...publicBase(state),
    };
  }
  const confirmTemplate = {
    capability: 'confirmRun',
    userInstruction: `确认在当前设备和 App 上执行用例 ${state.targets.map((item) => item.caseNo).join(', ')}`,
  };
  state.pendingConfirmation = confirmTemplate;
  saveCoordinatorState(state);
  return {
    status: 'NEED_USER_CONFIRMATION',
    reason: 'CONFIRM_RUN',
    binding: environment.binding,
    confirmTemplate,
    ...publicBase(state),
  };
}

function prepareRun(request, options = {}) {
  assertRequest(request, 'prepareRun');
  const workspace = assertWorkspace(request.workspace, { allowTest: true }).root;
  const issues = [];
  const seen = new Set();
  const targets = request.caseNos.map((caseNo, index) => {
    const resolved = resolveCaseNo(workspace, caseNo);
    if (!resolved) {
      issues.push({ field: `caseNos[${index}]`, message: `工作空间中不存在用例 ${caseNo}`, code: 'CASE_NOT_FOUND' });
      return null;
    }
    if (seen.has(resolved.caseKey)) {
      issues.push({ field: `caseNos[${index}]`, message: `用例 ${caseNo} 重复`, code: 'CASE_DUPLICATE' });
      return null;
    }
    seen.add(resolved.caseKey);
    return { caseNo: resolved.caseNo, caseKey: resolved.caseKey, caseDir: resolved.caseDir, definitionRef: null };
  }).filter(Boolean);
  if (issues.length) throw coordinatorError('用例选择无效', issues);

  const batchId = options.batchId || allocateBatchId(options.now);
  const paths = pathsFor(workspace, batchId);
  if (fs.existsSync(paths.state)) throw coordinatorError('Coordinator run 已存在', [{ field: 'run', message: '请继续已有运行', code: 'RUN_EXISTS' }]);
  fs.mkdirSync(paths.batchDir, { recursive: true });
  const state = {
    type: 'coordinatorRun',
    phase: 'PREPARING',
    workspace,
    batchId,
    targets,
    selectedProbe: null,
    environmentConfirmed: false,
    statePath: paths.state,
    commands: commandsFor(paths),
    createdAt: options.now || new Date().toISOString(),
    updatedAt: options.now || new Date().toISOString(),
  };
  saveCoordinatorState(state);
  return nextDefinitionResponse(state) || confirmationResponse(state);
}

function defaultProbeEnvironment(platform) {
  const output = childProcess.execFileSync(path.join(SKILL_ROOT, 'scripts/probe-env.sh'), ['--platform', platform], {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function deviceId(device) {
  return device?.id || device?.serial || device?.udid || device?.name || null;
}

function bindingTemplate(platform, device) {
  return {
    platform,
    deviceId: deviceId(device) || '<device-id>',
    appId: '<target-app-id>',
    entry: '<entry-ability>',
    ...(device?.deviceType ? { deviceType: device.deviceType } : {}),
    ...(device?.deviceFormFactor ? { deviceFormFactor: device.deviceFormFactor } : {}),
  };
}

function confirmRun(statePath, request, options = {}) {
  assertRequest(request, 'confirmRun');
  const initial = loadCoordinatorState(statePath);
  const lockPath = pathsFor(initial.workspace, initial.batchId).lock;
  return withFileLock(lockPath, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
    if (request.platform) {
      const probe = (options.probeEnvironment || defaultProbeEnvironment)(request.platform);
      state.selectedProbe = probe;
      state.phase = 'WAITING_FOR_CONFIRMATION';
      state.updatedAt = options.now || new Date().toISOString();
      if (probe?.ready !== true || !Array.isArray(probe.devices) || !probe.devices.length) {
        state.pendingConfirmation = { capability: 'confirmRun', platform: request.platform };
        saveCoordinatorState(state);
        return {
          status: 'BLOCKED',
          code: 'ENVIRONMENT_NOT_READY',
          reason: probe?.diagnostics?.map((item) => item.message || item.reason || String(item)).join('; ') || '未找到可用设备',
          ...publicBase(state),
        };
      }
      const confirmTemplate = {
        capability: 'confirmRun',
        userInstruction: `确认在所选设备和 App 上执行用例 ${state.targets.map((item) => item.caseNo).join(', ')}`,
        binding: bindingTemplate(request.platform, probe.devices[0]),
      };
      state.pendingConfirmation = confirmTemplate;
      saveCoordinatorState(state);
      return {
        status: 'NEED_USER_CONFIRMATION',
        reason: 'CONFIRM_ENVIRONMENT_AND_RUN',
        devices: probe.devices,
        confirmTemplate,
        ...publicBase(state),
      };
    }

    let environment;
    if (request.binding) {
      if (!state.selectedProbe) {
        throw coordinatorError('请先使用平台确认模板完成环境探测', [{ field: 'binding', message: '缺少当前平台探测结果', code: 'PROBE_REQUIRED' }]);
      }
      environment = confirmEnvironment({
        workspaceRoot: state.workspace,
        binding: request.binding,
        probe: state.selectedProbe,
        userConfirmation: request.userInstruction,
        now: options.now,
      });
    } else {
      environment = loadEnvironmentConfirmation(state.workspace);
    }
    state.environmentConfirmed = true;
    state.pendingConfirmation = null;
    const createRequest = options.createExecutionRequest || createExecutionRequest;
    createRequest({
      workspaceRoot: state.workspace,
      batchId: state.batchId,
      mode: state.targets.length === 1 ? 'SINGLE' : 'BATCH',
      targets: state.targets.map((target) => ({ caseNo: target.caseNo, definitionRef: target.definitionRef })),
      userInstruction: request.userInstruction,
      now: options.now,
    });
    const batchExecute = options.batchExecute || executeBatch;
    batchExecute({ command: 'init', workspace: state.workspace, batchId: state.batchId, platform: environment.binding.platform });
    state.phase = 'BATCH_READY';
    state.updatedAt = options.now || new Date().toISOString();
    saveCoordinatorState(state);
    return { status: 'CONFIRMED', next: 'advanceRun', ...publicBase(state) };
  }, { now: options.now });
}

function terminalResponse(state, response) {
  if (response.action === 'BATCH_COMPLETE') {
    state.phase = 'COMPLETE';
    state.outcome = 'COMPLETED';
    saveCoordinatorState(state);
    return completedResponse(state, 'COMPLETED');
  }
  if (response.action === 'BATCH_CANCELLED') {
    state.phase = 'COMPLETE';
    state.outcome = 'CANCELLED';
    saveCoordinatorState(state);
    return completedResponse(state, 'CANCELLED');
  }
  if (response.action === 'BATCH_BLOCKED') {
    state.phase = 'BLOCKED';
    state.outcome = 'BLOCKED';
    saveCoordinatorState(state);
    return {
      status: 'BLOCKED',
      code: response.failureCode || response.code || 'BATCH_BLOCKED',
      reason: response.reason || response.message || '批次因技术问题阻塞',
      reportPath: path.join(state.workspace, 'index.html'),
      ...publicBase(state),
    };
  }
  return null;
}

function advanceBatch(state, options = {}) {
  const batchExecute = options.batchExecute || executeBatch;
  for (let transition = 0; transition < 32; transition += 1) {
    const response = batchExecute({ command: 'reconcile', workspace: state.workspace, batchId: state.batchId });
    const terminal = terminalResponse(state, response);
    if (terminal) return terminal;
    if (response.action === 'BOOTSTRAP') {
      const bootstrapped = batchExecute({ command: 'bootstrap', workspace: state.workspace, batchId: state.batchId });
      const bootstrapTerminal = terminalResponse(state, bootstrapped);
      if (bootstrapTerminal) return bootstrapTerminal;
      continue;
    }
    if (response.action === 'NEED_CASE_AGENT') {
      const started = batchExecute({ command: 'start', workspace: state.workspace, batchId: state.batchId });
      const startTerminal = terminalResponse(state, started);
      if (startTerminal) return startTerminal;
      if (started.agentRequired === false) continue;
      if (started.agentRequired === true && started.handoff?.loaderCommand) {
        state.phase = 'WAITING_FOR_CASE_AGENT';
        saveCoordinatorState(state);
        return {
          status: 'NEED_CASE_AGENT',
          caseNo: state.targets.find((item) => item.caseKey === started.caseKey)?.caseNo,
          loaderCommand: started.handoff.loaderCommand,
          delegationPrompt: CASE_AGENT_PROMPT,
          ...publicBase(state),
        };
      }
      throw coordinatorError('Batch start 未返回有效 Case Agent Loader', [], 'COORDINATOR_ADVANCE_INVALID');
    }
    if (response.action === 'WAIT_CASE_AGENT') {
      state.phase = 'WAITING_FOR_CASE_AGENT';
      saveCoordinatorState(state);
      return { status: 'WAITING', reason: 'CASE_AGENT_RUNNING', ...publicBase(state) };
    }
    if (response.action === 'PUBLISH_REPORTS' && response.retryable === true) {
      return { status: 'WAITING', reason: 'REPORT_PUBLICATION_RETRY', ...publicBase(state) };
    }
    throw coordinatorError(`无法处理 Batch 动作 ${response.action || response.status || 'unknown'}`, [], 'COORDINATOR_ADVANCE_INVALID');
  }
  throw coordinatorError('Coordinator 推进超过确定性上限', [], 'COORDINATOR_ADVANCE_LIMIT');
}

function advanceUnlocked(state, options = {}) {
  if (state.phase === 'COMPLETE') return completedResponse(state, state.outcome);
  if (state.phase === 'BLOCKED') return { status: 'BLOCKED', code: 'BATCH_BLOCKED', reason: '批次已经阻塞', ...publicBase(state) };
  if (!['BATCH_READY', 'WAITING_FOR_CASE_AGENT'].includes(state.phase)) {
    const definition = nextDefinitionResponse(state);
    if (definition) return definition;
    return confirmationResponse(state);
  }
  return advanceBatch(state, options);
}

function advanceRun(statePath, options = {}) {
  const initial = loadCoordinatorState(statePath);
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
    state.updatedAt = options.now || new Date().toISOString();
    return advanceUnlocked(state, options);
  }, { now: options.now });
}

function cancelRun(statePath, request, options = {}) {
  assertRequest(request, 'cancelRun');
  const initial = loadCoordinatorState(statePath);
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
    if (state.phase === 'COMPLETE') return completedResponse(state, state.outcome);
    if (!['BATCH_READY', 'WAITING_FOR_CASE_AGENT', 'CANCELLING'].includes(state.phase)) {
      state.phase = 'COMPLETE';
      state.outcome = 'CANCELLED';
      state.updatedAt = options.now || new Date().toISOString();
      saveCoordinatorState(state);
      return completedResponse(state, 'CANCELLED');
    }
    const batchExecute = options.batchExecute || executeBatch;
    batchExecute({ command: 'cancel', workspace: state.workspace, batchId: state.batchId, reason: request.reason });
    state.phase = 'CANCELLING';
    saveCoordinatorState(state);
    return advanceBatch(state, options);
  }, { now: options.now });
}

module.exports = {
  advanceRun,
  cancelRun,
  confirmRun,
  loadCoordinatorState,
  prepareRun,
  recordCoordinatorInputFailure,
};
