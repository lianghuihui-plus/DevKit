'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execute: executeBatch } = require('../batch');
const { assertWorkspace } = require('../lib/workspace');
const { resolveCaseNo } = require('../lib/case-numbering');
const {
  confirmEnvironment,
  createExecutionRequest,
  loadEnvironmentConfirmation,
  loadExecutionRequest,
  validateEnvironmentConfirmation,
} = require('../lib/run-control');
const { readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { attachTechnicalContext } = require('../lib/technical-context');
const { validateCoordinatorRequest } = require('./agent-facing-contract');

const SKILL_ROOT = path.resolve(__dirname, '../..');
const CASE_AGENT_PROMPT = '你是独立 Case Agent。执行给定的 loaderCommand，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。';
const PLATFORMS = Object.freeze(['harmony', 'android', 'ios']);

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

function stateContent(value) {
  const { updatedAt, ...content } = value || {};
  return content;
}

function saveCoordinatorState(state, now = null) {
  const previous = readJson(state.statePath, null);
  const changed = !previous
    || JSON.stringify(stateContent(previous)) !== JSON.stringify(stateContent(state));
  if (changed) state.updatedAt = now || new Date().toISOString();
  else if (previous?.updatedAt) state.updatedAt = previous.updatedAt;
  if (changed) writeJsonAtomic(state.statePath, state);
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

function reportPublicationResponse(publication = null) {
  const reportStatus = publication?.status || 'DEGRADED';
  return {
    reportStatus,
    ...(reportStatus === 'PUBLISHED' ? {} : {
      reportErrorCode: publication?.errorCode || 'REPORT_NOT_PUBLISHED',
      reportReason: publication?.reason || '本次运行未生成可发布报告',
    }),
  };
}

function completedResponse(state, outcome, publication = state.reportPublication) {
  const report = reportPublicationResponse(publication);
  return {
    status: 'COMPLETE',
    outcome,
    ...report,
    ...(report.reportStatus === 'PUBLISHED' ? { reportPath: path.join(state.workspace, 'index.html') } : {}),
    ...publicBase(state),
  };
}

function blockedResponse(state) {
  const report = reportPublicationResponse(state.reportPublication);
  const diagnostic = state.terminalFailure?.diagnostic;
  return attachTechnicalContext({
    status: 'BLOCKED',
    code: state.terminalFailure?.code || 'BATCH_BLOCKED',
    reason: state.terminalFailure?.reason || '批次已经阻塞',
    ...(diagnostic ? { diagnostic } : {}),
    ...report,
    ...(report.reportStatus === 'PUBLISHED' ? { reportPath: path.join(state.workspace, 'index.html') } : {}),
    ...publicBase(state),
  }, 'COORDINATOR', { capability: 'advanceRun' }, {
    resourceFacts: [`batch=${state.batchId}`, `state=${state.statePath}`],
  });
}

function selectPlatformChoice(platform) {
  return {
    id: `SELECT_${platform.toUpperCase()}`,
    template: { capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform },
  };
}

function buildConfirmationChoices(state, environment) {
  const confirmChoices = [];
  if (environment) {
    confirmChoices.push({
      id: 'USE_CURRENT',
      template: {
        capability: 'confirmRun',
        decision: 'USE_CURRENT',
        userInstruction: `确认在当前设备和 App 上执行用例 ${state.targets.map((item) => item.caseNo).join(', ')}`,
      },
    });
  }
  confirmChoices.push(...PLATFORMS.map(selectPlatformChoice));
  return confirmChoices;
}

function confirmationChoicesForState(state) {
  let environment = null;
  let environmentError = null;
  try {
    environment = loadEnvironmentConfirmation(state.workspace);
  } catch (error) {
    environmentError = error;
  }
  return { confirmChoices: buildConfirmationChoices(state, environment), environment, environmentError };
}

function environmentDecisionResponse(state, options = {}, details = {}) {
  const { confirmChoices, environment, environmentError } = confirmationChoicesForState(state);
  state.environmentConfirmed = Boolean(environment);
  state.currentEnvironmentOffer = environment ? JSON.parse(JSON.stringify(environment)) : null;
  state.phase = 'NEED_ENVIRONMENT_DECISION';
  state.bindingConfirmationTemplate = null;
  saveCoordinatorState(state, options.now);
  return {
    status: 'NEED_USER_CONFIRMATION',
    reason: details.reason || 'CHOOSE_ENVIRONMENT',
    ...(details.code ? { code: details.code } : {}),
    ...(environment ? { binding: environment.binding } : {}),
    ...(details.diagnostics?.length ? { diagnostics: details.diagnostics } : {}),
    ...(!details.diagnostics?.length && environmentError && environmentError.code !== 'ENVIRONMENT_NOT_CONFIRMED'
      ? { diagnostics: [{ code: environmentError.code || 'ENVIRONMENT_CONFIRMATION_INVALID', message: environmentError.message || String(environmentError) }] }
      : {}),
    confirmChoices,
    ...publicBase(state),
  };
}

function coordinatorInputRecovery(statePath, command) {
  if (command !== 'confirm') return {};
  const state = loadCoordinatorState(statePath);
  if (state.phase === 'NEED_BINDING_CONFIRMATION' && state.bindingConfirmationTemplate) {
    return { retryWith: state.bindingConfirmationTemplate };
  }
  if (state.phase === 'NEED_ENVIRONMENT_DECISION') {
    return { confirmChoices: buildConfirmationChoices(state, state.currentEnvironmentOffer) };
  }
  return {};
}

function bindingConfirmationResponse(state, options = {}) {
  if (!state.bindingConfirmationTemplate || !state.selectedProbe) {
    return environmentDecisionResponse(state, options, {
      reason: 'CHOOSE_ENVIRONMENT',
      code: 'PROBE_REQUIRED',
      diagnostics: [{ code: 'PROBE_REQUIRED', message: '平台探测结果不可用，请重新选择平台' }],
    });
  }
  saveCoordinatorState(state, options.now);
  return {
    status: 'NEED_USER_CONFIRMATION',
    reason: 'CONFIRM_ENVIRONMENT_AND_RUN',
    devices: state.selectedProbe.devices,
    ...(state.selectedProbe.deviceDetected !== undefined ? { deviceDetected: state.selectedProbe.deviceDetected } : {}),
    ...(state.selectedProbe.executionReady !== undefined ? { executionReady: state.selectedProbe.executionReady } : {}),
    ...(state.selectedProbe.diagnostics?.length ? { diagnostics: state.selectedProbe.diagnostics } : {}),
    ...(state.selectedProbe.executionReady === false && state.selectedProbe.platform === 'ios'
      && state.selectedProbe.diagnostics?.some((item) => item.id === 'iosRealDeviceSigningIncomplete')
      ? { requiredBindingFields: ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId'] } : {}),
    confirmTemplate: state.bindingConfirmationTemplate,
    ...publicBase(state),
  };
}

function assertCoordinatorPhase(state, expected, decision) {
  if (state.phase !== expected) {
    throw coordinatorError(`${decision} 不适用于当前运行阶段 ${state.phase}`, [{
      field: 'decision', message: `当前阶段要求 ${expected}`, code: 'DECISION_NOT_ALLOWED',
    }]);
  }
}

function interruptInitialization(options, step) {
  if (options.interruptAfter !== step) return;
  const error = new Error(`MAVT_COORDINATOR_INTERRUPTED: ${step}`);
  error.code = 'MAVT_COORDINATOR_INTERRUPTED';
  throw error;
}

function startInitialization(state, environment, userInstruction, options = {}) {
  const frozen = validateEnvironmentConfirmation(JSON.parse(JSON.stringify(environment)), {
    workspaceRoot: state.workspace,
  });
  state.phase = 'INITIALIZING_RUN';
  state.environmentConfirmed = true;
  state.currentEnvironmentOffer = null;
  state.bindingConfirmationTemplate = null;
  state.initialization = {
    userInstruction,
    environmentFrozen: {
      confirmationId: frozen.confirmationId,
      confirmationSha: frozen.confirmationSha,
      environment: frozen,
    },
    executionRequestCreated: null,
    batchInitialized: null,
    startedAt: options.now || new Date().toISOString(),
  };
  saveCoordinatorState(state, options.now);
  interruptInitialization(options, 'environmentFrozen');
  return resumeInitialization(state, options);
}

function resumeInitialization(state, options = {}) {
  const initialization = state.initialization;
  if (!initialization?.environmentFrozen?.environment || !initialization.userInstruction) {
    throw coordinatorError('运行初始化记录缺失或损坏', [], 'COORDINATOR_INITIALIZATION_INVALID');
  }
  const environment = validateEnvironmentConfirmation(
    JSON.parse(JSON.stringify(initialization.environmentFrozen.environment)),
    { workspaceRoot: state.workspace },
  );
  if (environment.confirmationId !== initialization.environmentFrozen.confirmationId
    || environment.confirmationSha !== initialization.environmentFrozen.confirmationSha) {
    throw coordinatorError('冻结环境引用与内容不一致', [], 'COORDINATOR_INITIALIZATION_INVALID');
  }

  let executionRequest;
  if (!initialization.executionRequestCreated) {
    const createRequest = options.createExecutionRequest || createExecutionRequest;
    executionRequest = createRequest({
      workspaceRoot: state.workspace,
      batchId: state.batchId,
      mode: state.targets.length === 1 ? 'SINGLE' : 'BATCH',
      targets: state.targets.map((target) => ({ caseNo: target.caseNo })),
      environmentConfirmation: environment,
      userInstruction: initialization.userInstruction,
      now: options.now,
    });
    initialization.executionRequestCreated = {
      requestId: executionRequest.requestId,
      requestSha: executionRequest.requestSha,
    };
    saveCoordinatorState(state, options.now);
    interruptInitialization(options, 'executionRequestCreated');
  } else {
    const loadRequest = options.loadExecutionRequest || loadExecutionRequest;
    executionRequest = loadRequest(state.workspace, state.batchId, { requireCurrentEnvironment: false });
    if (executionRequest.requestId !== initialization.executionRequestCreated.requestId
      || executionRequest.requestSha !== initialization.executionRequestCreated.requestSha) {
      throw coordinatorError('冻结 ExecutionRequest 与初始化记录不一致', [], 'COORDINATOR_INITIALIZATION_INVALID');
    }
  }

  const batchExecute = options.batchExecute || executeBatch;
  const initialized = batchExecute({
    command: 'init',
    workspace: state.workspace,
    batchId: state.batchId,
    platform: environment.binding.platform,
    now: options.now,
  });
  if (!initialization.batchInitialized) {
    initialization.batchInitialized = {
      status: initialized?.state?.status || 'INITIALIZED',
      contractSha: initialized?.contract?.contractSha || null,
    };
    saveCoordinatorState(state, options.now);
    interruptInitialization(options, 'batchInitialized');
  } else if (initialization.batchInitialized.contractSha && initialized?.contract?.contractSha
    && initialization.batchInitialized.contractSha !== initialized.contract.contractSha) {
    throw coordinatorError('Batch 初始化结果与冻结记录不一致', [], 'COORDINATOR_INITIALIZATION_INVALID');
  }

  state.phase = 'BATCH_READY';
  saveCoordinatorState(state, options.now);
  return { status: 'CONFIRMED', next: 'advanceRun', ...publicBase(state) };
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
    return { caseNo: resolved.caseNo, caseKey: resolved.caseKey, caseDir: resolved.caseDir };
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
  saveCoordinatorState(state, options.now);
  return environmentDecisionResponse(state, options);
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
    if (request.decision === 'SELECT_PLATFORM') {
      assertCoordinatorPhase(state, 'NEED_ENVIRONMENT_DECISION', request.decision);
      const probe = (options.probeEnvironment || defaultProbeEnvironment)(request.platform);
      state.selectedProbe = probe;
      if (!Array.isArray(probe?.devices) || !probe.devices.length) {
        return environmentDecisionResponse(state, options, {
          reason: 'ENVIRONMENT_NOT_READY',
          code: 'ENVIRONMENT_NOT_READY',
          diagnostics: probe?.diagnostics?.length
            ? probe.diagnostics
            : [{ code: 'DEVICE_NOT_FOUND', message: '未找到可用设备' }],
        });
      }
      const selectedDevice = request.deviceId
        ? probe.devices.find((device) => deviceId(device) === String(request.deviceId))
        : (probe.devices.length === 1 ? probe.devices[0] : null);
      if (!selectedDevice) {
        state.phase = 'NEED_ENVIRONMENT_DECISION';
        state.bindingConfirmationTemplate = null;
        saveCoordinatorState(state, options.now);
        return {
          status: 'NEED_USER_CONFIRMATION',
          reason: 'SELECT_DEVICE',
          code: request.deviceId ? 'DEVICE_NOT_FOUND' : 'DEVICE_SELECTION_REQUIRED',
          devices: probe.devices,
          deviceChoices: probe.devices.map((device) => ({
            id: `SELECT_DEVICE_${deviceId(device)}`,
            template: { capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: request.platform, deviceId: deviceId(device) },
          })),
          diagnostics: probe.diagnostics || [],
          ...publicBase(state),
        };
      }
      const confirmationReady = probe.ready === true || probe.confirmationReady === true;
      if (!confirmationReady) {
        return environmentDecisionResponse(state, options, {
          reason: 'ENVIRONMENT_NOT_READY',
          code: 'ENVIRONMENT_NOT_READY',
          diagnostics: probe?.diagnostics?.length
            ? probe.diagnostics
            : [{ code: 'ENVIRONMENT_NOT_READY', message: 'iOS 设备已发现，但执行环境尚未就绪' }],
        });
      }
      const confirmTemplate = {
        capability: 'confirmRun',
        decision: 'CONFIRM_BINDING',
        userInstruction: `确认在所选设备和 App 上执行用例 ${state.targets.map((item) => item.caseNo).join(', ')}`,
        binding: bindingTemplate(request.platform, selectedDevice),
      };
      state.phase = 'NEED_BINDING_CONFIRMATION';
      state.bindingConfirmationTemplate = confirmTemplate;
      saveCoordinatorState(state, options.now);
      return bindingConfirmationResponse(state, options);
    }

    if (request.decision === 'CONFIRM_BINDING') {
      assertCoordinatorPhase(state, 'NEED_BINDING_CONFIRMATION', request.decision);
      let environment;
      try {
        environment = confirmEnvironment({
          workspaceRoot: state.workspace,
          binding: request.binding,
          probe: state.selectedProbe,
          userConfirmation: request.userInstruction,
          now: options.now,
        });
      } catch (error) {
        if (error.code !== 'IOS_SIGNING_INCOMPLETE') throw error;
        return {
          status: 'NEED_USER_CONFIRMATION',
          reason: 'IOS_SIGNING_REQUIRED',
          code: error.code,
          requiredBindingFields: ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId'],
          diagnostics: [{ code: error.code, message: error.message }],
          devices: state.selectedProbe.devices,
          confirmTemplate: state.bindingConfirmationTemplate,
          ...publicBase(state),
        };
      }
      return startInitialization(state, environment, request.userInstruction, options);
    }

    assertCoordinatorPhase(state, 'NEED_ENVIRONMENT_DECISION', request.decision);
    let environment;
    try {
      if (!state.currentEnvironmentOffer) throw Object.assign(new Error('当前环境不可用，请重新选择平台'), { code: 'ENVIRONMENT_NOT_CONFIRMED' });
      environment = validateEnvironmentConfirmation(JSON.parse(JSON.stringify(state.currentEnvironmentOffer)), {
        workspaceRoot: state.workspace,
      });
    } catch (error) {
      return environmentDecisionResponse(state, options, {
        reason: 'CHOOSE_ENVIRONMENT',
        code: error.code || 'ENVIRONMENT_CONFIRMATION_INVALID',
        diagnostics: [{ code: error.code || 'ENVIRONMENT_CONFIRMATION_INVALID', message: error.message || String(error) }],
      });
    }
    return startInitialization(state, environment, request.userInstruction, options);
  }, { now: options.now });
}

function terminalResponse(state, response, options = {}) {
  if (response.action === 'BATCH_COMPLETE') {
    state.phase = 'COMPLETE';
    state.outcome = 'COMPLETED';
    state.reportPublication = response.publicationState || null;
    saveCoordinatorState(state, options.now);
    return completedResponse(state, 'COMPLETED', response.publicationState);
  }
  if (response.action === 'BATCH_CANCELLED') {
    state.phase = 'COMPLETE';
    state.outcome = 'CANCELLED';
    state.reportPublication = response.publicationState || null;
    saveCoordinatorState(state, options.now);
    return completedResponse(state, 'CANCELLED', response.publicationState);
  }
  if (response.action === 'BATCH_BLOCKED') {
    state.phase = 'BLOCKED';
    state.outcome = 'BLOCKED';
    state.reportPublication = response.publicationState || null;
    const code = response.failureCode || response.code || response.state?.failureCode || 'BATCH_BLOCKED';
    const reason = response.reason || response.message || response.state?.reason || '批次因技术问题阻塞';
    state.terminalFailure = {
      code,
      reason,
      diagnostic: response.diagnostic || response.state?.diagnostic || {
        code,
        stage: 'BATCH',
        summary: reason,
        retryable: false,
      },
    };
    saveCoordinatorState(state, options.now);
    return blockedResponse(state);
  }
  return null;
}

function advanceBatch(state, options = {}) {
  const batchExecute = options.batchExecute || executeBatch;
  for (let transition = 0; transition < 32; transition += 1) {
    const response = batchExecute({ command: 'reconcile', workspace: state.workspace, batchId: state.batchId });
    const terminal = terminalResponse(state, response, options);
    if (terminal) return terminal;
    if (response.action === 'BOOTSTRAP') {
      const bootstrapped = batchExecute({ command: 'bootstrap', workspace: state.workspace, batchId: state.batchId });
      const bootstrapTerminal = terminalResponse(state, bootstrapped, options);
      if (bootstrapTerminal) return bootstrapTerminal;
      if (bootstrapped.action === 'WAIT_PLATFORM_RUNTIME') {
        state.phase = 'WAITING_FOR_PLATFORM_RUNTIME';
        saveCoordinatorState(state, options.now);
        return {
          status: 'WAITING',
          waitFor: bootstrapped.waitFor,
          reason: bootstrapped.waitFor === 'OWNER_BATCH_TERMINAL'
            ? 'PLATFORM_RUNTIME_OWNER_ACTIVE'
            : 'PLATFORM_RUNTIME_INITIALIZING',
          diagnostic: bootstrapped.technical,
          ...(bootstrapped.technical?.recovery ? { recovery: bootstrapped.technical.recovery } : {}),
          ...publicBase(state),
        };
      }
      continue;
    }
    if (response.action === 'NEED_CASE_AGENT') {
      const started = batchExecute({ command: 'start', workspace: state.workspace, batchId: state.batchId });
      const startTerminal = terminalResponse(state, started, options);
      if (startTerminal) return startTerminal;
      if (started.agentRequired === false) continue;
      if (started.agentRequired === true && started.handoff?.loaderCommand) {
        state.phase = 'WAITING_FOR_CASE_AGENT';
        saveCoordinatorState(state, options.now);
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
    if (response.action === 'WAIT_EXECUTION_RESULT') {
      state.phase = 'WAITING_FOR_CASE_AGENT';
      saveCoordinatorState(state, options.now);
      return {
        status: 'WAITING',
        waitFor: 'EXECUTION_RESULT',
        reason: 'WAIT_EXECUTION_RESULT',
        ...publicBase(state),
      };
    }
    throw coordinatorError(`无法处理 Batch 动作 ${response.action || response.status || 'unknown'}`, [], 'COORDINATOR_ADVANCE_INVALID');
  }
  throw coordinatorError('Coordinator 推进超过确定性上限', [], 'COORDINATOR_ADVANCE_LIMIT');
}

function advanceUnlocked(state, options = {}) {
  if (state.phase === 'COMPLETE') return completedResponse(state, state.outcome);
  if (state.phase === 'BLOCKED') return blockedResponse(state);
  if (state.phase === 'INITIALIZING_RUN') return resumeInitialization(state, options);
  if (state.phase === 'NEED_BINDING_CONFIRMATION') return bindingConfirmationResponse(state, options);
  if (state.phase === 'NEED_ENVIRONMENT_DECISION') return environmentDecisionResponse(state, options);
  if (!['BATCH_READY', 'WAITING_FOR_CASE_AGENT', 'WAITING_FOR_PLATFORM_RUNTIME'].includes(state.phase)) {
    return environmentDecisionResponse(state, options);
  }
  return advanceBatch(state, options);
}

function advanceRun(statePath, options = {}) {
  const initial = loadCoordinatorState(statePath);
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
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
    if (!['BATCH_READY', 'WAITING_FOR_CASE_AGENT', 'WAITING_FOR_PLATFORM_RUNTIME', 'CANCELLING'].includes(state.phase)) {
      state.phase = 'COMPLETE';
      state.outcome = 'CANCELLED';
      state.reportPublication = null;
      saveCoordinatorState(state, options.now);
      return completedResponse(state, 'CANCELLED');
    }
    const batchExecute = options.batchExecute || executeBatch;
    batchExecute({ command: 'cancel', workspace: state.workspace, batchId: state.batchId, reason: request.reason });
    state.phase = 'CANCELLING';
    saveCoordinatorState(state, options.now);
    return advanceBatch(state, options);
  }, { now: options.now });
}

module.exports = {
  advanceRun,
  cancelRun,
  confirmRun,
  coordinatorInputRecovery,
  loadCoordinatorState,
  prepareRun,
  recordCoordinatorInputFailure,
};
