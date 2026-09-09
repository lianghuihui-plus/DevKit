'use strict';

const childProcess = require('child_process');
const path = require('path');
const { environmentAdapterArgs } = require('../lib/execution-environment');
const { startupDisplayVerified } = require('../lib/startup-display');
const { normalizeDeviceBinding } = require('../lib/target-binding');
const { validateInstalledAppIdentity } = require('../lib/app-provisioning');

const SKILL_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_ADAPTER_TIMEOUT_MS = 60000;
const IOS_RESTART_OVERHEAD_MS = 15000;

function run(command, args, timeout) {
  const result = childProcess.spawnSync(command, args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.error?.code === 'ETIMEDOUT') {
    return { ok: false, reason: `DEVICE_ADAPTER_TIMEOUT: adapter did not finish within ${timeout}ms${stderr ? `; ${stderr}` : ''}` };
  }
  if (result.error) {
    return { ok: false, reason: `DEVICE_ADAPTER_EXECUTION_FAILED: ${stderr || result.error.message}` };
  }
  if (!stdout) {
    const termination = result.signal ? `; signal=${result.signal}` : '';
    const status = result.status === null || result.status === undefined ? '' : `; status=${result.status}`;
    return { ok: false, reason: `DEVICE_ADAPTER_OUTPUT_EMPTY: adapter returned no JSON result${status}${termination}${stderr ? `; ${stderr}` : ''}` };
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: `DEVICE_ADAPTER_OUTPUT_INVALID: adapter did not return one JSON result${stderr ? `; ${stderr}` : ''}` };
  }
  return { status: result.status, stderr, value };
}

function restartTimeoutMs(binding) {
  if (binding?.platform !== 'ios') return DEFAULT_ADAPTER_TIMEOUT_MS;
  const configured = Number(binding.wdaLaunchTimeout);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_ADAPTER_TIMEOUT_MS;
  return Math.max(DEFAULT_ADAPTER_TIMEOUT_MS, Math.ceil(configured) + IOS_RESTART_OVERHEAD_MS);
}

function normalizeRestartResult(value, binding, stderr = '') {
  const platform = binding?.platform || value?.platform;
  const display = startupDisplayVerified(
    binding?.startupDisplayPolicy,
    value?.startupDisplay,
    binding?.deviceFormFactor,
    { platform },
  );
  const coldStartVerified = value?.command?.status === 'ACCEPTED' && value?.coldStartVerified === true;
  const displayReason = display.validation.errors.length
    ? `startup display verification failed: ${display.validation.errors.join('; ')}`
    : '';
  return {
    ...value,
    ok: coldStartVerified && display.verified,
    coldStartVerified,
    startupDisplayVerified: display.verified,
    startupDisplayValidation: {
      required: display.required,
      reason: display.reason,
      errors: display.validation.errors,
    },
    reason: value?.error || stderr || (!coldStartVerified ? 'adapter did not verify a cold App restart' : displayReason) || undefined,
  };
}

function restartApp(request) {
  const binding = normalizeDeviceBinding({ ...request.binding });
  const platformSessionId = request.platformRuntime?.resource?.session?.sessionId;
  if (binding.platform === 'ios' && platformSessionId) binding.appiumSessionId = platformSessionId;
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/action.sh'), [
    ...environmentAdapterArgs(binding, 'action'),
    '--type', 'restartApp',
  ], restartTimeoutMs(binding));
  if (!result.value) return { ok: false, coldStartVerified: false, startupDisplayVerified: false, reason: result.reason };
  return normalizeRestartResult(result.value, binding, result.stderr);
}

function prepareApp(request) {
  const binding = normalizeDeviceBinding({ ...request.binding });
  const platformSessionId = request.platformRuntime?.resource?.session?.sessionId;
  if (binding.platform === 'ios' && platformSessionId) binding.appiumSessionId = platformSessionId;
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/prepare-app.sh'), [
    ...environmentAdapterArgs(binding, 'observe'),
    '--strategy', 'REINSTALL_APP',
    '--artifact', request.provisioning.artifactPath,
  ], 5 * 60 * 1000);
  if (!result.value) {
    return {
      ok: false,
      status: 'FAILED',
      failureCode: 'APP_ARTIFACT_BOOTSTRAP_FAILED',
      reason: result.reason || result.stderr || 'artifact-managed bootstrap failed',
    };
  }
  const value = result.value;
  if (value.schemaVersion !== 1 || value.type !== 'appPreparationResult'
    || value.platform !== binding.platform || value.strategy !== 'REINSTALL_APP'
    || value.device?.id !== binding.deviceId || value.app?.appId !== binding.appId) {
    return {
      ok: false,
      status: 'FAILED',
      failureCode: 'DEVICE_ADAPTER_OUTPUT_INVALID',
      reason: 'artifact-managed bootstrap returned an invalid preparation result',
    };
  }
  return validateInstalledAppIdentity(value, request.provisioning);
}

function probeSession(request) {
  const binding = normalizeDeviceBinding(request.binding);
  const args = environmentAdapterArgs(binding, 'probe');
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/probe-env.sh'), args, 60000);
  const probe = result.value;
  const selected = probe?.devices?.some((device) => device.id === binding.deviceId || device.serial === binding.deviceId);
  return {
    ok: result.status === 0 && probe?.ready === true && selected === true,
    binding: { ...request.binding },
    probe,
    reason: result.reason || result.stderr || undefined,
  };
}

function runPlatformRuntime(operation, request) {
  const binding = normalizeDeviceBinding(request.binding);
  const args = [
    ...environmentAdapterArgs(binding, 'runtime'),
    '--operation', operation,
  ];
  if (operation === 'acquire') args.push('--owner-key', request.ownerKey);
  if (operation === 'release') args.push('--runtime-json', JSON.stringify(request.runtime));
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/runtime.sh'), args, 30000);
  if (!result.value) {
    return {
      ok: false,
      status: operation === 'acquire' ? 'ACQUIRE_FAILED' : 'RELEASE_FAILED',
      ownership: request.runtime?.ownership || 'NONE',
      failureCode: operation === 'acquire' ? 'PLATFORM_RUNTIME_ACQUIRE_FAILED' : 'PLATFORM_RUNTIME_RELEASE_FAILED',
      reason: result.reason || result.stderr || `platform runtime ${operation} failed`,
    };
  }
  return result.value;
}

function acquirePlatformRuntime(request) {
  return runPlatformRuntime('acquire', request);
}

function releasePlatformRuntime(request) {
  return runPlatformRuntime('release', request);
}

function createDeviceSessionAdapter() {
  return { acquirePlatformRuntime, prepareApp, probeSession, releasePlatformRuntime, restartApp };
}

module.exports = {
  acquirePlatformRuntime,
  createDeviceSessionAdapter,
  normalizeRestartResult,
  prepareApp,
  probeSession,
  releasePlatformRuntime,
  restartApp,
  restartTimeoutMs,
  run,
};
