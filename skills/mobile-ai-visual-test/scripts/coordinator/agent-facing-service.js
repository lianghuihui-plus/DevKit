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
const { readPublicationState, statePath: publicationStatePath } = require('../report/publication-state');
const {
  AGENT_FACING_PROTOCOL,
  PUBLIC_CONTRACT,
  documentationRefFor,
  validateCoordinatorRequest,
} = require('./agent-facing-contract');
const { successEnvelope } = require('../lib/agent-facing-envelope');
const resources = require('./agent-resource-store');

const SKILL_ROOT = path.resolve(__dirname, '../..');
const CASE_AGENT_PROMPT = '你是独立 Case Agent。原样执行给定的 loaderCommand，读取响应 data.content 中的 caseBrief 并遵循其中 casePrompt；只处理 Brief 绑定的 execution，完成后返回最终摘要。';
const PLATFORMS = Object.freeze(['harmony', 'android', 'ios']);

function coordinatorError(message, issues = [], code = 'COORDINATOR_INPUT_INVALID') {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.issues = issues;
  error.exitCode = 2;
  return error;
}

function assertRequest(request, expectedOperation) {
  const issues = validateCoordinatorRequest(request);
  if (request?.operation !== expectedOperation && !issues.some((item) => item.field === 'operation')) {
    issues.unshift({ field: 'operation', message: `必须为 ${expectedOperation}`, code: 'OPERATION_MISMATCH' });
  }
  if (issues.length) throw coordinatorError('请求字段不符合当前能力', issues);
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pathsFor(workspace, batchId) {
  const batchDir = path.join(workspace, 'runs', batchId);
  return {
    batchDir,
    state: path.join(batchDir, 'coordinator-state.json'),
    lock: path.join(batchDir, '.coordinator.lock'),
  };
}

function commandFor(paths) {
  const entry = path.join(SKILL_ROOT, 'scripts/coordinator-agent.js');
  return `${quote(process.execPath)} ${quote(entry)} --state ${quote(paths.state)}`;
}

function allocateBatchId(now = null) {
  const stamp = String(now || new Date().toISOString()).replace(/\D/g, '').slice(0, 17);
  return `batch-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function stateContent(value) {
  const { updatedAt, revision, ...content } = value || {};
  return content;
}

function saveCoordinatorState(state, now = null) {
  const previous = readJson(state.statePath, null);
  const changed = !previous
    || JSON.stringify(stateContent(previous)) !== JSON.stringify(stateContent(state));
  if (changed) {
    state.updatedAt = now || new Date().toISOString();
    state.revision = Number(previous?.revision || 0) + 1;
  }
  else if (previous?.updatedAt) state.updatedAt = previous.updatedAt;
  if (changed) writeJsonAtomic(state.statePath, state);
  return state;
}

function loadCoordinatorState(statePath) {
  const resolved = path.resolve(statePath);
  const state = readJson(resolved, null);
  if (!state || state.type !== 'coordinatorRun' || !['workspace', 'batchId', 'statePath', 'command'].every((key) => typeof state[key] === 'string' && state[key])
    || !Number.isInteger(state.revision) || state.revision < 1) {
    throw coordinatorError('Coordinator 状态不存在或不受支持', [{ field: 'command', message: '绑定运行状态不可用', code: 'STATE_INVALID' }], 'COORDINATOR_STATE_INVALID');
  }
  if (path.resolve(state.statePath) !== resolved || path.resolve(state.workspace, 'runs', state.batchId, 'coordinator-state.json') !== resolved) {
    throw coordinatorError('Coordinator 状态路径绑定不一致', [{ field: 'command', message: '绑定运行状态不一致', code: 'STATE_BINDING_MISMATCH' }], 'COORDINATOR_STATE_INVALID');
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
  return { protocol: AGENT_FACING_PROTOCOL, statePath: state.statePath };
}

function technicalFacts(diagnostic) {
  if (!diagnostic) return null;
  return {
    ...(diagnostic.code ? { code: diagnostic.code } : {}),
    ...(diagnostic.stage ? { stage: diagnostic.stage } : {}),
    ...(diagnostic.logRefs ? { logRefs: diagnostic.logRefs } : {}),
    ...(diagnostic.resourceFacts ? { resourceFacts: diagnostic.resourceFacts } : {}),
  };
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

function currentTerminalPublication(state, fallback = state.reportPublication) {
  const file = publicationStatePath(state.workspace, state.batchId);
  if (!fs.existsSync(file)) return fallback;
  try {
    return readPublicationState(state.workspace, state.batchId);
  } catch {
    return fallback;
  }
}

function completedResponse(state, outcome, publication = state.reportPublication) {
  const report = reportPublicationResponse(currentTerminalPublication(state, publication));
  return {
    status: 'COMPLETE',
    outcome,
    ...report,
    ...(report.reportStatus === 'PUBLISHED' ? { reportPath: path.join(state.workspace, 'index.html') } : {}),
    ...publicBase(state),
  };
}

function blockedResponse(state) {
  const report = reportPublicationResponse(currentTerminalPublication(state));
  const diagnostic = state.terminalFailure?.diagnostic;
  const code = state.terminalFailure?.code || 'BATCH_BLOCKED';
  return {
    status: 'BLOCKED',
    code,
    reason: state.terminalFailure?.reason || '批次已经阻塞',
    ...report,
    ...(report.reportStatus === 'PUBLISHED' ? { reportPath: path.join(state.workspace, 'index.html') } : {}),
    facts: {
      batchId: state.batchId,
      statePath: state.statePath,
      ...(diagnostic ? { technical: technicalFacts(diagnostic) } : {}),
    },
    documentationRef: documentationRefFor(code),
    ...publicBase(state),
  };
}

function selectPlatformChoice(platform) {
  return {
    id: `SELECT_${platform.toUpperCase()}`,
    decision: 'SELECT_PLATFORM',
    platform,
  };
}

function buildConfirmationChoices(state, environment) {
  const choices = [];
  if (environment) {
    choices.push({
      id: 'USE_CURRENT',
      decision: 'USE_CURRENT',
    });
  }
  choices.push(...PLATFORMS.map(selectPlatformChoice));
  return choices;
}

function confirmationChoicesForState(state) {
  let environment = null;
  let environmentError = null;
  try {
    environment = loadEnvironmentConfirmation(state.workspace);
  } catch (error) {
    environmentError = error;
  }
  return { choices: buildConfirmationChoices(state, environment), environment, environmentError };
}

function environmentDecisionResponse(state, options = {}, details = {}) {
  const { choices, environment, environmentError } = confirmationChoicesForState(state);
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
    choices,
    ...publicBase(state),
  };
}

function knownBindingFacts(binding) {
  return Object.fromEntries(Object.entries(binding || {}).filter(([, value]) => (
    typeof value !== 'string' || !/^<.*>$/.test(value)
  )));
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
    requiredUserFields: state.selectedProbe.platform === 'ios'
      ? ['binding.appId']
      : ['binding.appId', 'binding.entry'],
    binding: knownBindingFacts(state.bindingConfirmationTemplate.binding),
    ...publicBase(state),
  };
}

function assertCoordinatorPhase(state, expected, decision) {
  if (state.phase !== expected) {
    throw coordinatorError(`${decision} 不适用于当前运行阶段 ${state.phase}`, [{
      field: 'decision', message: `当前阶段要求 ${expected}`, code: 'DECISION_NOT_ALLOWED',
    }], 'DECISION_NOT_ALLOWED');
  }
}

function interruptInitialization(options, step) {
  if (options.interruptAfter !== step) return;
  const error = new Error(`MAVT_COORDINATOR_INTERRUPTED: ${step}`);
  error.code = 'MAVT_COORDINATOR_INTERRUPTED';
  throw error;
}

function inputCapabilityError() {
  const error = new Error('设备输入能力自动准备失败，当前运行尚未进入用例执行');
  error.code = 'INPUT_CAPABILITY_NOT_READY';
  error.diagnostic = {
    code: 'INPUT_CAPABILITY_NOT_READY',
    stage: 'ENVIRONMENT_PREPARE',
    summary: '设备输入能力未就绪',
    retryable: true,
  };
  return error;
}

function defaultPrepareEnvironment(input) {
  const binding = input.binding;
  if (binding.platform !== 'android') {
    return { schemaVersion: 1, type: 'environmentPrepare', platform: binding.platform, ok: true, dependencies: [] };
  }
  const args = ['--platform', binding.platform, '--device', binding.deviceId];
  try {
    const output = childProcess.execFileSync(path.join(SKILL_ROOT, 'scripts/prepare-env.sh'), args, {
      cwd: SKILL_ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(output);
  } catch (error) {
    return {
      schemaVersion: 1,
      type: 'environmentPrepare',
      platform: binding.platform,
      ok: false,
      internalError: String(error.stderr || error.stdout || error.message || error).trim().slice(0, 4000),
    };
  }
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

  if (environment.binding.platform === 'android' && !initialization.environmentPrepared) {
    const prepareEnvironment = options.prepareEnvironment || defaultPrepareEnvironment;
    let prepared;
    try {
      prepared = prepareEnvironment({ binding: { ...environment.binding } });
    } catch (error) {
      prepared = {
        schemaVersion: 1,
        type: 'environmentPrepare',
        platform: environment.binding.platform,
        ok: false,
        internalError: String(error?.message || error),
      };
    }
    if (prepared?.schemaVersion !== 1 || prepared?.type !== 'environmentPrepare'
      || prepared?.platform !== environment.binding.platform || prepared?.ok !== true) {
      initialization.environmentPrepareFailure = {
        platform: environment.binding.platform,
        status: 'FAILED',
        detail: prepared || null,
      };
      saveCoordinatorState(state, options.now);
      throw inputCapabilityError();
    }
    initialization.environmentPrepared = {
      platform: environment.binding.platform,
      status: 'READY',
    };
    delete initialization.environmentPrepareFailure;
    saveCoordinatorState(state, options.now);
    interruptInitialization(options, 'environmentPrepared');
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
  return { status: 'CONFIRMED', ...publicBase(state) };
}

function prepareCore(request, options = {}) {
  const workspace = assertWorkspace(options.workspace, { allowTest: true }).root;
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
    command: commandFor(paths),
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

function confirmCore(statePath, request, options = {}) {
  const initial = loadCoordinatorState(statePath);
  const lockPath = pathsFor(initial.workspace, initial.batchId).lock;
  return runLocked(lockPath, () => {
    const state = loadCoordinatorState(statePath);
    if (['COMPLETE', 'BLOCKED'].includes(state.phase)) throw coordinatorError('Coordinator 已终止', [], 'COORDINATOR_TERMINAL');
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
          choices: probe.devices.map((device) => ({
            id: `SELECT_DEVICE_${deviceId(device)}`,
            decision: 'SELECT_PLATFORM',
            platform: request.platform,
            deviceId: deviceId(device),
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
          binding: knownBindingFacts(state.bindingConfirmationTemplate.binding),
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
  }, options);
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
          ...(bootstrapped.technical ? { facts: { technical: technicalFacts(bootstrapped.technical) } } : {}),
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
          handoffAuthority: started.handoff,
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
        caseNo: state.targets.find((item) => item.caseKey === response.caseKey)?.caseNo,
        caseKey: response.caseKey,
        executionId: response.executionId,
        ...(response.progress ? { progress: response.progress } : {}),
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
  if (!['BATCH_READY', 'WAITING_FOR_CASE_AGENT', 'WAITING_FOR_PLATFORM_RUNTIME', 'CANCELLING'].includes(state.phase)) {
    throw coordinatorError(`Coordinator 状态不可推进：${state.phase || 'missing'}`, [], 'COORDINATOR_STATE_INVALID');
  }
  return advanceBatch(state, options);
}

function advanceCore(statePath, options = {}) {
  const initial = loadCoordinatorState(statePath);
  return runLocked(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
    return advanceUnlocked(state, options);
  }, options);
}

function cancelCore(statePath, request, options = {}) {
  const initial = loadCoordinatorState(statePath);
  return runLocked(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    state.lastInvalid = null;
    if (state.phase === 'COMPLETE') return completedResponse(state, state.outcome);
    if (state.phase === 'BLOCKED') return blockedResponse(state);
    state.cancelReason = request.reason;
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
  }, options);
}

function runLocked(lock, action, options) {
  return options.lockHeld ? action() : withFileLock(lock, action, { now: options.now });
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function projectResponse(state, operation, response) {
  const projection = PUBLIC_CONTRACT.methods[operation].responseProjection.outcomes[response.status];
  if (!projection) throw coordinatorError('Coordinator 返回未声明结果', [], 'COORDINATOR_STATE_INVALID');
  let resource = projection.primaryResourceType === 'runSummary' ? resources.terminalResource(state) : null;
  if (!resource) {
    const associated = [];
    const diagnostic = response.facts?.technical || (response.diagnostics?.length ? {
      code: response.code || response.reason,
      stage: state.selectedProbe ? 'ENVIRONMENT_PROBE' : 'ENVIRONMENT_CONFIRMATION',
      resourceFacts: { diagnostics: response.diagnostics },
    } : null);
    if (diagnostic && projection.associatedResourceTypes.includes('coordinatorDiagnostic')) {
      associated.push(resources.publishSnapshot(state, 'coordinatorDiagnostic', diagnostic).descriptor);
    }
    const diagnosticRefs = associated.map((item) => item.ref);
    if (projection.primaryResourceType === 'runDecision') {
      resource = resources.publishSnapshot(state, 'runDecision', {
        kind: response.reason === 'SELECT_DEVICE' ? 'DEVICE' : state.phase === 'NEED_BINDING_CONFIRMATION' ? 'BINDING' : 'ENVIRONMENT',
        ...pick(response, ['reason', 'code', 'choices', 'binding', 'devices', 'deviceDetected', 'executionReady', 'requiredBindingFields', 'requiredUserFields']),
        ...(diagnosticRefs.length ? { diagnosticRefs } : {}),
      }, associated);
    } else if (projection.primaryResourceType === 'caseDispatch') {
      resource = resources.publishDispatch(state, response.handoffAuthority, response.delegationPrompt, response.caseNo);
    } else if (projection.primaryResourceType === 'runProgress') {
      resource = resources.publishSnapshot(state, 'runProgress', {
        phase: state.phase, ...pick(response, ['waitFor', 'reason', 'caseNo', 'caseKey', 'executionId', 'progress']),
        ...(diagnosticRefs.length ? { diagnosticRefs } : {}),
      }, associated);
    } else if (projection.primaryResourceType === 'runSummary') {
      resource = resources.publishSnapshot(state, 'runSummary', {
        outcome: response.status, phase: state.phase,
        ...(response.outcome ? { runOutcome: response.outcome } : {}),
        ...pick(response, ['code', 'reason', 'reportStatus', 'reportErrorCode', 'reportReason', 'reportPath']),
        ...(state.cancelReason ? { cancelReason: state.cancelReason } : {}),
        ...(diagnosticRefs.length ? { diagnosticRefs } : {}),
      }, associated);
      resources.bindTerminalResource(state, resource);
    }
  }
  const facts = resource?.data.type === 'runSummary' ? resource.data.content : { ...response, outcome: response.status, phase: state.phase };
  return successEnvelope({ operation, result: pick({ ...facts, command: state.command }, projection.resultFields),
    ...(resource ? { data: resource.data, resources: resource.resources } : {}) });
}

function prepareRun(request, options = {}) {
  assertRequest(request, 'prepareRun');
  const response = prepareCore(request.input, options);
  const state = loadCoordinatorState(response.statePath);
  return withFileLock(pathsFor(state.workspace, state.batchId).lock, () => projectResponse(state, 'prepareRun', response));
}
function executeRunRequest(statePath, request, options = {}) {
  assertRequest(request, request?.operation);
  if (request.operation === 'prepareRun') throw coordinatorError('当前 command 已绑定 run，不能创建另一个 run');
  const initial = loadCoordinatorState(statePath);
  if (request.operation === 'read') {
    const resource = resources.readResource(initial, request.input.ref);
    return successEnvelope({ operation: 'read', result: { outcome: 'READ', resourceRef: resource.data.ref, resourceType: resource.data.type },
      data: resource.data, resources: resource.resources });
  }
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const boundOptions = { ...options, lockHeld: true };
    const response = request.operation === 'confirmRun' ? confirmCore(statePath, request.input, boundOptions)
      : request.operation === 'cancelRun' ? cancelCore(statePath, request.input, boundOptions) : advanceCore(statePath, boundOptions);
    return projectResponse(loadCoordinatorState(statePath), request.operation, response);
  }, { now: options.now });
}
function confirmRun(statePath, request, options = {}) { assertRequest(request, 'confirmRun'); return executeRunRequest(statePath, request, options); }
function cancelRun(statePath, request, options = {}) { assertRequest(request, 'cancelRun'); return executeRunRequest(statePath, request, options); }
function advanceRun(statePath, options = {}) { return executeRunRequest(statePath, { operation: 'advanceRun', input: {} }, options); }

function failureResources(statePath, error) {
  if (!error.diagnostic) return [];
  const initial = loadCoordinatorState(statePath);
  return withFileLock(pathsFor(initial.workspace, initial.batchId).lock, () => {
    const state = loadCoordinatorState(statePath);
    return [resources.publishSnapshot(state, 'coordinatorDiagnostic', technicalFacts(error.diagnostic)).descriptor];
  });
}

module.exports = {
  advanceRun,
  cancelRun,
  confirmRun,
  loadCoordinatorState,
  prepareRun,
  recordCoordinatorInputFailure,
  executeRunRequest,
  failureResources,
};
