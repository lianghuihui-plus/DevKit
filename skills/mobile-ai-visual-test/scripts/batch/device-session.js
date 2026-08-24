'use strict';

const childProcess = require('child_process');
const path = require('path');
const { environmentAdapterArgs } = require('../lib/execution-environment');

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

function restartApp(request) {
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/action.sh'), [
    ...environmentAdapterArgs(request.binding, 'action'),
    '--type', 'restartApp',
  ], 60000);
  if (!result.value) return { ok: false, coldStartVerified: false, startupDisplayVerified: false, reason: result.reason };
  const value = result.value;
  return {
    ...value,
    coldStartVerified: value.ok === true,
    startupDisplayVerified: value.startupDisplay?.status === 'VERIFIED' || value.startupDisplay?.status === 'SKIPPED',
    reason: value.error || result.stderr || undefined,
  };
}

function probeSession(request) {
  const args = ['--platform', request.binding.platform, '--device', request.binding.deviceId];
  if (request.binding.deviceFormFactor) args.push('--device-form-factor', request.binding.deviceFormFactor);
  const result = run(path.join(SKILL_ROOT, 'scripts/platform/probe-env.sh'), args, 60000);
  const probe = result.value;
  const selected = probe?.devices?.some((device) => device.id === request.binding.deviceId || device.serial === request.binding.deviceId);
  return {
    ok: result.status === 0 && probe?.ready === true && selected === true,
    binding: { ...request.binding },
    probe,
    reason: result.reason || result.stderr || undefined,
  };
}

function createDeviceSessionAdapter() {
  return { probeSession, restartApp };
}

module.exports = {
  createDeviceSessionAdapter,
  probeSession,
  restartApp,
};
