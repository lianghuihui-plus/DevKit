'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { bindingSha, validateBinding } = require('../lib/batch-contract');
const { environmentAdapterArgs } = require('../lib/execution-environment');
const { inspectPng } = require('../lib/image-evidence');
const { isSafeRelativeArtifact, resolveArtifact, sha256File } = require('../lib/execution-evidence');
const { createActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { validateAdapterActionResult } = require('../lib/action-result');
const { startupDisplayVerified } = require('../lib/startup-display');
const { normalizeDeviceBinding } = require('../lib/target-binding');
const {
  failureText,
  isIosSessionOrTransportFailure,
  withCurrentIosSession,
} = require('../session/ios-session-service');

const ACTION_ARGUMENTS = Object.freeze({
  type: '--type',
  x: '--x',
  y: '--y',
  text: '--text',
  mode: '--mode',
  fromX: '--from-x',
  fromY: '--from-y',
  toX: '--to-x',
  toY: '--to-y',
  durationMs: '--duration-ms',
  intervalMs: '--interval-ms',
  ms: '--ms',
  velocity: '--velocity',
  coordinateSource: '--coordinate-source',
});

function resolveTargetBinding(execDir, execution) {
  validateBinding(execution.targetBinding);
  if (bindingSha(execution.targetBinding) !== execution.targetBindingSha) {
    throw contractError('DEVICE_BINDING_CHANGED', 'execution target binding hash does not match');
  }
  const snapshotPath = path.join(path.resolve(execDir), 'binding.snapshot.json');
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    throw contractError('DEVICE_BINDING_UNCONFIRMED', `execution binding snapshot is unavailable: ${error.message}`);
  }
  if (snapshot?.schemaVersion !== 1 || snapshot.bindingSha !== execution.targetBindingSha
    || snapshot.batchContractSha !== execution.batchContractSha
    || bindingSha(validateBinding(snapshot.binding)) !== execution.targetBindingSha) {
    throw contractError('DEVICE_BINDING_MISMATCH', 'execution target does not match its frozen binding snapshot');
  }
  return { ...execution.targetBinding };
}

function actionAdapterArgs(binding, action, options = {}) {
  const args = environmentAdapterArgs(binding, 'action');
  for (const [field, flag] of Object.entries(ACTION_ARGUMENTS)) {
    // Only iOS uses the source to translate screenshot pixels into its Appium viewport.
    if (field === 'coordinateSource' && binding.platform !== 'ios') continue;
    if (action[field] !== undefined && action[field] !== null) args.push(flag, String(action[field]));
  }
  if (options.captureOut && options.captureLabel && Number.isInteger(options.captureAtMs)) {
    args.push('--capture-out', options.captureOut, '--capture-label', options.captureLabel, '--capture-at-ms', String(options.captureAtMs));
  }
  return args;
}

function observationAdapterArgs(binding, execDir, operationId) {
  return [...environmentAdapterArgs(binding, 'observe'), '--out', path.resolve(execDir), '--label', operationId];
}

function captureAdapterArgs(binding, execDir, operationId) {
  return [...environmentAdapterArgs(binding, 'observe'), '--out', path.resolve(execDir), '--label', operationId];
}

function defaultRunner(command, args, options = {}) {
  const preAdapterDelayMs = Number.isInteger(options.preAdapterDelayMs) && options.preAdapterDelayMs > 0
    ? options.preAdapterDelayMs : 0;
  if (preAdapterDelayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, preAdapterDelayMs);
  }
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, options.timeoutMs - preAdapterDelayMs),
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function operationTimeoutMs(execution, now = new Date()) {
  const deadline = Date.parse(execution.startedAt) + (30 * 60 * 1000);
  return Math.max(1, deadline - new Date(now).getTime());
}

function parseAdapterOutput(result, kind) {
  if (result?.error) {
    const outcomeUnknown = kind === 'PREPARATION'
      && (result.error.code === 'ETIMEDOUT' || !!result.signal || /timed out/i.test(result.error.message || ''));
    throw contractError(
      outcomeUnknown ? 'APP_PREPARATION_OUTCOME_UNKNOWN' : 'DEVICE_ADAPTER_FAILED',
      `${kind} adapter could not run: ${result.error.message || result.error}`,
      {
        adapterDiagnostics: {
          status: result.status ?? null,
          signal: result.signal || null,
          stderr: String(result.stderr || '').trim().slice(0, 4000),
        },
      },
    );
  }
  let value;
  try {
    value = JSON.parse(String(result?.stdout || '').trim());
  } catch (error) {
    if (result?.status !== 0) {
      const stderr = String(result?.stderr || '').trim();
      throw contractError('DEVICE_ADAPTER_FAILED', `${kind} adapter exited with ${result.status}${stderr ? `: ${stderr.slice(0, 1000)}` : ''}`, {
        adapterDiagnostics: {
          status: result.status ?? null,
          signal: result.signal || null,
          stderr: stderr.slice(0, 4000),
        },
      });
    }
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${kind} adapter did not return one JSON result`);
  }
  const expectedType = { ACTION: 'actionResult', OBSERVE: 'observation', CAPTURE: 'capture', PREPARATION: 'appPreparationResult' }[kind];
  if (result.status !== 0 && value?.type !== expectedType) {
    throw contractError('DEVICE_ADAPTER_FAILED', String(result.stderr || `${kind} adapter exited with ${result.status}`).trim());
  }
  return value;
}

function assertResultBinding(result, binding, kind) {
  const expectedType = kind === 'ACTION' ? 'actionResult' : kind === 'CAPTURE' ? 'capture' : 'observation';
  const expectedSchemaVersion = kind === 'ACTION' ? 2 : 1;
  if (!result || result.schemaVersion !== expectedSchemaVersion || result.type !== expectedType || result.platform !== binding.platform) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${kind} adapter result identity is invalid`);
  }
  if (kind === 'ACTION') validateAdapterActionResult(result);
  const label = kind === 'ACTION' ? 'action result' : kind === 'CAPTURE' ? 'capture result' : 'observation';
  const expectedDevice = binding.deviceId;
  if (result.device?.id !== expectedDevice) throw contractError('DEVICE_RESULT_BINDING_MISMATCH', `${label} does not confirm the frozen device`);
  if (result.app?.appId !== binding.appId) throw contractError('DEVICE_RESULT_BINDING_MISMATCH', `${label} does not confirm the frozen App`);
  return result;
}

function invokeScreenshotCapture(execDir, validated, options = {}) {
  const { execution } = validated.context;
  const frozenBinding = resolveTargetBinding(execDir, execution);
  const invoke = (binding) => {
    const command = path.join(path.resolve(__dirname, '../..'), 'scripts', 'platform', 'capture.sh');
    const args = captureAdapterArgs(binding, execDir, validated.operationId);
    const runner = options.runner || defaultRunner;
    const timeoutMs = Math.max(1, Math.min(
      operationTimeoutMs(execution, options.now),
      Number.isInteger(options.timeoutMs) ? options.timeoutMs : Number.MAX_SAFE_INTEGER,
    ));
    const raw = runner(command, args, { timeoutMs, kind: 'CAPTURE', binding, preAdapterDelayMs: 0 });
    const adapterResult = parseAdapterOutput(raw, 'CAPTURE');
    assertResultBinding(adapterResult, binding, 'CAPTURE');
    return { binding, adapterResult, evidence: validateObservationArtifacts(execDir, adapterResult) };
  };
  if (frozenBinding.platform !== 'ios') return invoke(frozenBinding);
  const runtime = JSON.parse(fs.readFileSync(path.join(execDir, 'runtime.json'), 'utf8'));
  return withCurrentIosSession(runtime.sessionRef, 'OBSERVE', (session) => invoke({
    ...frozenBinding,
    appiumSessionId: session.sessionId,
    appiumSessionCapabilities: session.capabilities || {},
  }), {
    binding: frozenBinding,
    runner: options.runner || defaultRunner,
    timeoutMs: Number.isInteger(options.timeoutMs) ? options.timeoutMs : operationTimeoutMs(execution, options.now),
    now: options.now,
    operationId: validated.operationId,
  });
}

function validateObservationArtifacts(execDir, result) {
  const screenshot = result.artifacts?.screenshot || result.screenshot;
  if (!isSafeRelativeArtifact(screenshot)) throw contractError('OBSERVATION_SCREENSHOT_INVALID', 'observation requires a safe screenshot path');
  const screenshotPath = resolveArtifact(execDir, screenshot);
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) {
    throw contractError('OBSERVATION_SCREENSHOT_MISSING', `observation screenshot is missing: ${screenshot}`);
  }
  const metadata = inspectPng(screenshotPath);
  if (metadata.decodeStatus !== 'VALID') throw contractError('OBSERVATION_SCREENSHOT_INVALID', `observation screenshot is not a valid PNG: ${screenshot}`);
  for (const ref of [result.artifacts?.layout, ...(result.artifacts?.logs || [])].filter(Boolean)) {
    if (!isSafeRelativeArtifact(ref)) throw contractError('OBSERVATION_ARTIFACT_INVALID', `unsafe observation artifact path: ${ref}`);
    const file = resolveArtifact(execDir, ref);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw contractError('OBSERVATION_ARTIFACT_MISSING', `observation artifact is missing: ${ref}`);
  }
  return {
    ref: screenshot,
    sha256: sha256File(screenshotPath),
    width: metadata.width,
    height: metadata.height,
    // Foreground App identity is context, not an evidence-validity gate. External
    // system pages remain actionable as long as the frozen device and artifacts validate.
    usable: true,
  };
}

function invokeDeviceOperation(execDir, validated, kind, options = {}) {
  const { execution } = validated.context;
  const frozenBinding = resolveTargetBinding(execDir, execution);
  const invoke = (binding) => {
    const skillRoot = path.resolve(__dirname, '../..');
    const command = path.join(skillRoot, 'scripts', 'platform', kind === 'ACTION' ? 'action.sh' : 'observe.sh');
    const args = kind === 'ACTION'
      ? actionAdapterArgs(binding, validated.action, validated.request?.observationPolicy?.duringActionAtMs !== undefined ? {
        captureOut: path.resolve(execDir),
        captureLabel: `${validated.operationId}-during`,
        captureAtMs: Number(validated.request.observationPolicy.duringActionAtMs),
      } : {})
      : observationAdapterArgs(binding, execDir, validated.operationId);
    const runner = options.runner || defaultRunner;
    const preAdapterDelayMs = kind === 'OBSERVE' && validated.request?.purpose === 'POST_ACTION'
      ? Math.max(0, Number(options.preAdapterDelayMs) || 0) : 0;
    const adapterStartedAt = Date.now();
    let rawResult;
    try {
      rawResult = runner(command, args, {
        timeoutMs: operationTimeoutMs(execution, options.now),
        kind,
        binding,
        preAdapterDelayMs,
      });
    } finally {
      if (typeof options.onAdapterSpan === 'function') {
        options.onAdapterSpan({
          name: 'adapter',
          kind,
          purpose: validated.request?.purpose || null,
          action: validated.action?.type || null,
          durationMs: Date.now() - adapterStartedAt,
          postActionSettleMs: preAdapterDelayMs,
          explicitWaitMs: validated.action?.type === 'wait' ? Number(validated.action.ms) || 0 : 0,
        });
      }
    }
    const adapterResult = parseAdapterOutput(rawResult, kind);
    assertResultBinding(adapterResult, binding, kind);
    if (kind === 'ACTION' && adapterResult.action !== validated.action.type) {
      throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action adapter result does not match the requested action');
    }
    if (kind === 'ACTION' && binding.platform === 'ios' && isIosSessionOrTransportFailure(adapterResult)) {
      throw contractError('IOS_ACTION_OUTCOME_UNKNOWN', failureText(adapterResult) || 'iOS action transport outcome is unknown', {
        actionOutcomeUnknown: true,
        adapterResult,
      });
    }
    let duringActionEvidence = null;
    if (kind === 'ACTION' && validated.request?.observationPolicy?.duringActionAtMs !== undefined) {
      const capture = adapterResult.duringActionCapture;
      if (!capture?.artifacts?.screenshot) {
        throw contractError('DURING_ACTION_OBSERVATION_MISSING', 'adapter did not return the requested during-action screenshot');
      }
      duringActionEvidence = validateObservationArtifacts(execDir, {
        artifacts: { screenshot: capture.artifacts.screenshot, layout: null, logs: [] },
        app: adapterResult.app,
      });
    }
    const spatialEvidenceRef = kind === 'ACTION'
      ? createActionSpatialEvidence(execDir, validated, adapterResult)
      : null;
    return {
      binding,
      adapterResult,
      ...(spatialEvidenceRef ? { spatialEvidenceRef } : {}),
      ...(duringActionEvidence ? { duringActionEvidence } : {}),
      postActionSettleMs: preAdapterDelayMs,
      ...(kind === 'OBSERVE' ? { evidence: validateObservationArtifacts(execDir, adapterResult) } : {}),
    };
  };
  if (frozenBinding.platform !== 'ios') return invoke(frozenBinding);
  const runtime = JSON.parse(fs.readFileSync(path.join(execDir, 'runtime.json'), 'utf8'));
  return withCurrentIosSession(runtime.sessionRef, kind, (session) => invoke({
    ...frozenBinding,
    appiumSessionId: session.sessionId,
    appiumSessionCapabilities: session.capabilities || {},
  }), {
    binding: frozenBinding,
    runner: options.runner || defaultRunner,
    timeoutMs: operationTimeoutMs(execution, options.now),
    now: options.now,
    operationId: validated.operationId,
  });
}

function invokeAppRestart(rawBinding, options = {}) {
  const binding = normalizeDeviceBinding(rawBinding);
  const invoke = (activeBinding) => {
    const command = path.join(path.resolve(__dirname, '../..'), 'scripts', 'platform', 'action.sh');
    const runner = options.runner || defaultRunner;
    const adapterResult = parseAdapterOutput(runner(command, [
      ...environmentAdapterArgs(activeBinding, 'action'), '--type', 'restartApp',
    ], {
      timeoutMs: Number.isInteger(options.timeoutMs) ? options.timeoutMs : 60000,
      kind: 'ACTION',
      binding: activeBinding,
      preAdapterDelayMs: 0,
    }), 'ACTION');
    assertResultBinding(adapterResult, activeBinding, 'ACTION');
    if (adapterResult.action !== 'restartApp') throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'restart adapter result does not match restartApp');
    if (activeBinding.platform === 'ios' && isIosSessionOrTransportFailure(adapterResult)) {
      throw contractError('IOS_ACTION_OUTCOME_UNKNOWN', failureText(adapterResult) || 'iOS restart outcome is unknown', {
        actionOutcomeUnknown: true,
        adapterResult,
      });
    }
    const display = startupDisplayVerified(activeBinding.startupDisplayPolicy, adapterResult.startupDisplay, activeBinding.deviceFormFactor, { platform: activeBinding.platform });
    return {
      ...adapterResult,
      coldStartVerified: adapterResult.command?.status === 'ACCEPTED' && adapterResult.coldStartVerified === true,
      startupDisplayVerified: display.verified,
      startupDisplayValidation: { required: display.required, reason: display.reason, errors: display.validation.errors },
    };
  };
  if (binding.platform !== 'ios' || !options.sessionRef) return invoke(binding);
  return withCurrentIosSession(options.sessionRef, 'ACTION', (session) => invoke({
    ...binding,
    appiumSessionId: session.sessionId,
    appiumSessionCapabilities: session.capabilities || {},
  }), {
    binding,
    runner: options.runner || defaultRunner,
    timeoutMs: options.timeoutMs,
    now: options.now,
    operationId: options.operationId,
  });
}

function invokeAppPreparation(execDir, validated, options = {}) {
  const binding = resolveTargetBinding(execDir, validated.execution);
  const invoke = (activeBinding) => {
    const command = path.join(path.resolve(__dirname, '../..'), 'scripts', 'platform', 'prepare-app.sh');
    const args = [...environmentAdapterArgs(activeBinding, 'observe'), '--strategy', validated.strategy];
    if (validated.provisioning?.mode === 'ARTIFACT_MANAGED') args.push('--artifact', validated.provisioning.artifactPath);
    const runner = options.runner || defaultRunner;
    const raw = runner(command, args, {
      timeoutMs: Math.min(operationTimeoutMs(validated.execution, options.now), 5 * 60 * 1000),
      kind: 'PREPARATION',
      binding: activeBinding,
      preAdapterDelayMs: 0,
    });
    const result = parseAdapterOutput(raw, 'PREPARATION');
    if (!result || result.schemaVersion !== 1 || result.type !== 'appPreparationResult'
      || result.platform !== activeBinding.platform || result.strategy !== validated.strategy
      || result.device?.id !== activeBinding.deviceId || result.app?.appId !== activeBinding.appId) {
      throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'preparation adapter result identity is invalid');
    }
    return result;
  };
  if (binding.platform !== 'ios') return invoke(binding);
  const runtime = JSON.parse(fs.readFileSync(path.join(execDir, 'runtime.json'), 'utf8'));
  return withCurrentIosSession(runtime.sessionRef, 'ACTION', (session) => invoke({
    ...binding,
    appiumSessionId: session.sessionId,
    appiumSessionCapabilities: session.capabilities || {},
  }), {
    binding,
    runner: options.runner || defaultRunner,
    timeoutMs: Math.min(operationTimeoutMs(validated.execution, options.now), 5 * 60 * 1000),
    now: options.now,
    operationId: validated.operationId,
    replacementFromResult: (result) => result.platformSession || null,
  });
}

module.exports = {
  invokeAppPreparation,
  actionAdapterArgs,
  assertResultBinding,
  captureAdapterArgs,
  defaultRunner,
  invokeDeviceOperation,
  invokeScreenshotCapture,
  invokeAppRestart,
  observationAdapterArgs,
  operationTimeoutMs,
  parseAdapterOutput,
  resolveTargetBinding,
  validateObservationArtifacts,
};
