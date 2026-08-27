'use strict';

const childProcess = require('child_process');
const path = require('path');
const { environmentAdapterArgs } = require('../lib/execution-environment');
const { startupDisplayVerified } = require('../lib/startup-display');
const { normalizeDeviceBinding } = require('../lib/target-binding');

const SKILL_ROOT = path.resolve(__dirname, '../..');

function run(command, args, timeout) {
  const result = childProcess.spawnSync(command, args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  let value;
  try {
    value = JSON.parse(String(result.stdout || '').trim());
  } catch (error) {
    return { ok: false, reason: String(result.stderr || error.message).trim() };
  }
  return { status: result.status, stderr: String(result.stderr || '').trim(), value };
}

function normalizeRestartResult(value, binding, stderr = '') {
  const platform = binding?.platform || value?.platform;
  const display = startupDisplayVerified(
    binding?.startupDisplayPolicy,
    value?.startupDisplay,
    binding?.deviceFormFactor,
    { platform },
  );
  const coldStartVerified = value?.ok === true && value?.coldStartVerified === true;
  const displayReason = display.validation.errors.length
    ? `startup display verification failed: ${display.validation.errors.join('; ')}`
    : '';
  return {
    ...value,
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
  const binding = normalizeDeviceBinding(request.binding);
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/action.sh'), [
    ...environmentAdapterArgs(binding, 'action'),
    '--type', 'restartApp',
  ], 60000);
  if (!result.value) return { ok: false, coldStartVerified: false, startupDisplayVerified: false, reason: result.reason };
  return normalizeRestartResult(result.value, binding, result.stderr);
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
  return { acquirePlatformRuntime, probeSession, releasePlatformRuntime, restartApp };
}

module.exports = {
  acquirePlatformRuntime,
  createDeviceSessionAdapter,
  normalizeRestartResult,
  probeSession,
  releasePlatformRuntime,
  restartApp,
};
