#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const {
  classifyRuntimeDisplay,
  normalizeDeviceFormFactor,
  normalizeStartupDisplayPolicy,
  startupDisplayRequirement,
} = require('../../../../lib/startup-display');
const { parseDeviceList, parseDisplayState, selectDeviceProfile } = require('./display-state');

function usage(message) {
  if (message) console.error(message);
  console.error('restart-app 需要 --bundle/--app、--ability/--entry，并接受 --device、--device-form-factor、--startup-orientation。');
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--device': options.device = argv[++i]; break;
      case '--app':
      case '--bundle': options.bundle = argv[++i]; break;
      case '--entry':
      case '--ability': options.ability = argv[++i]; break;
      case '--device-form-factor': options.deviceFormFactor = argv[++i]; break;
      case '--startup-orientation': options.startupOrientation = argv[++i]; break;
      case '--startup-orientation-enforcement': options.startupOrientationEnforcement = argv[++i]; break;
      case '--startup-orientation-applies-to': options.startupOrientationAppliesTo = argv[++i]; break;
      default: usage(`未知参数: ${argv[i]}`);
    }
  }
  if (!options.bundle || !options.ability) usage();
  return options;
}

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function wait(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function run(command, args, { allowFailure = false, timeout = 15000 } = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 });
  const output = String(result.stderr || result.stdout || result.error?.message || '').trim();
  if (result.error || result.status !== 0) {
    if (allowFailure) return { ok: false, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '', status: result.status };
    throw new Error(output || `${command} failed`);
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', status: 0 };
}

function hdc(options, words, runOptions) {
  const command = process.env.MAVT_HDC || 'hdc';
  const prefix = options.device ? ['-t', options.device] : [];
  return run(command, [...prefix, ...words], runOptions);
}

function commandFailed(output) {
  return /failed|Error Code|not installed|Missing parameter|Invalid parameters|Please confirm|unrecognized option|Illegal argument|USAGE/i.test(String(output || ''));
}

function resolveDeviceFormFactor(options) {
  const explicit = normalizeDeviceFormFactor(options.deviceFormFactor);
  if (options.deviceFormFactor && !explicit) throw new Error(`无效 --device-form-factor: ${options.deviceFormFactor}`);
  if (explicit) return { value: explicit, source: 'environment' };
  const deveco = process.env.MAVT_DEVECOCLI || 'devecocli';
  const result = run(deveco, ['device', 'list'], { allowFailure: true, timeout: 10000 });
  if (!result.ok) return { value: null, source: 'devecocli-unavailable' };
  const profile = selectDeviceProfile(parseDeviceList(result.stdout), options.device);
  return { value: profile?.deviceFormFactor || null, source: profile ? 'devecocli-device-list' : 'devecocli-device-unmatched' };
}

function readDisplay(options) {
  const result = hdc(options, ['shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-a'], { allowFailure: true, timeout: 10000 });
  if (!result.ok || commandFailed(result.stderr || result.stdout)) {
    return { orientation: null, rotation: null, width: null, height: null, source: 'DisplayManagerService', readable: false };
  }
  return parseDisplayState(result.stdout);
}

function resetPortrait(options) {
  const result = hdc(options, ['shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-motion,0'], { allowFailure: true, timeout: 10000 });
  return { ok: result.ok && !commandFailed(result.stderr || result.stdout), output: String(result.stderr || result.stdout || '').trim() };
}

function pollOrientation(options, expected, timeoutMs) {
  const intervalMs = 100;
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let state = readDisplay(options);
  for (let attempt = 1; attempt < attempts && state.orientation !== expected; attempt += 1) {
    wait(intervalMs);
    state = readDisplay(options);
  }
  return state;
}

function pidof(options) {
  const result = hdc(options, ['shell', 'pidof', options.bundle], { allowFailure: true, timeout: 5000 });
  if (!result.ok) return null;
  return String(result.stdout || '').trim().split(/\s+/).find(Boolean) || null;
}

function policyFrom(options) {
  const value = options.startupOrientation ? {
    orientation: options.startupOrientation,
    enforcement: options.startupOrientationEnforcement,
    appliesTo: options.startupOrientationAppliesTo
      ? String(options.startupOrientationAppliesTo).split(',').map((item) => item.trim()).filter(Boolean)
      : undefined,
  } : undefined;
  return normalizeStartupDisplayPolicy(value, { platform: 'harmony' });
}

function resultBase(options, startupDisplay, extra = {}) {
  return {
    schemaVersion: 1,
    type: 'actionResult',
    platform: 'harmony',
    time: localIso(),
    action: 'restartApp',
    restart: true,
    startupDisplay,
    ...extra,
  };
}

function fail(options, startupDisplay, failureStage, error, extra = {}) {
  const result = resultBase(options, {
    ...startupDisplay,
    status: 'FAILED',
    verified: false,
    failureStage,
  }, {
    ok: false,
    coldStartVerified: false,
    failureCode: 'TOOL_ERROR',
    failureStage,
    error,
    ...extra,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = policyFrom(options);
  const formFactor = options.deviceFormFactor
    ? resolveDeviceFormFactor(options)
    : { value: null, source: 'policy-independent' };
  const beforeDisplay = readDisplay(options);
  const runtimeDisplay = classifyRuntimeDisplay(beforeDisplay.width, beforeDisplay.height);
  const requirement = startupDisplayRequirement(policy, formFactor.value, {
    platform: 'harmony',
    runtimeDisplayClass: runtimeDisplay.displayClass,
  });
  let startupDisplay = {
    requestedOrientation: policy.orientation,
    enforcement: policy.enforcement,
    appliesTo: policy.appliesTo,
    deviceFormFactor: formFactor.value,
    deviceFormFactorSource: formFactor.source,
    staticDeviceFormFactor: formFactor.value,
    runtimeDisplay: {
      width: runtimeDisplay.width,
      height: runtimeDisplay.height,
      aspectRatio: runtimeDisplay.aspectRatio,
      threshold: runtimeDisplay.threshold,
    },
    runtimeDisplayClass: runtimeDisplay.displayClass,
    strategy: requirement.required ? 'NORMALIZE_PORTRAIT' : 'PRESERVE',
    required: requirement.required,
    before: beforeDisplay,
    afterNormalization: null,
    afterLaunch: null,
    normalizationApplied: false,
    retryApplied: false,
    verified: false,
    status: 'PENDING',
    skippedReason: null,
    failureStage: null,
  };

  if (policy.orientation !== 'preserve' && policy.enforcement === 'required'
    && runtimeDisplay.displayClass === 'UNKNOWN') {
    fail(options, startupDisplay, 'RUNTIME_DISPLAY_CLASS', '无法读取有效屏幕宽高，不能选择冷启动方向策略。');
    return;
  }

  const oldPid = pidof(options);
  const stop = hdc(options, ['shell', 'aa', 'force-stop', options.bundle], { allowFailure: true, timeout: 15000 });
  if (!stop.ok || commandFailed(stop.stderr || stop.stdout)) {
    fail(options, startupDisplay, 'APP_STOP', String(stop.stderr || stop.stdout || 'aa force-stop failed').trim(), { oldPid });
    return;
  }
  let stopped = false;
  let currentPid = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    currentPid = pidof(options);
    if (!currentPid) { stopped = true; break; }
    wait(200);
  }
  if (!stopped) {
    fail(options, startupDisplay, 'APP_STOP_VERIFY', `force-stop did not stop target process: ${options.bundle} pid=${currentPid || 'unknown'}`, { oldPid });
    return;
  }

  if (requirement.required) {
    if (!startupDisplay.before.readable) {
      fail(options, startupDisplay, 'ORIENTATION_READ', '无法读取冷启动前的屏幕方向。', { oldPid });
      return;
    }
    if (startupDisplay.before.orientation !== policy.orientation) {
      const reset = resetPortrait(options);
      startupDisplay.normalizationApplied = true;
      if (!reset.ok) {
        fail(options, startupDisplay, 'ORIENTATION_RESET', reset.output || 'DisplayManagerService portrait reset failed', { oldPid });
        return;
      }
    }
    const settleMs = boundedInteger(process.env.MAVT_ORIENTATION_SETTLE_MS, 800, 0, 5000);
    startupDisplay.afterNormalization = pollOrientation(options, policy.orientation, settleMs);
    if (startupDisplay.afterNormalization.orientation !== policy.orientation) {
      fail(options, startupDisplay, 'ORIENTATION_VERIFY_BEFORE_START', '启动 App 前未能确认设备已恢复竖屏。', { oldPid });
      return;
    }
  } else {
    startupDisplay.afterNormalization = startupDisplay.before;
    startupDisplay.skippedReason = requirement.reason;
  }

  const start = hdc(options, ['shell', 'aa', 'start', '-b', options.bundle, '-a', options.ability], { allowFailure: true, timeout: 20000 });
  if (!start.ok || commandFailed(start.stderr || start.stdout)) {
    fail(options, startupDisplay, 'APP_START', String(start.stderr || start.stdout || 'aa start failed').trim(), { oldPid });
    return;
  }

  let newPid = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    newPid = pidof(options);
    if (newPid) break;
    wait(300);
  }
  if (!newPid) {
    fail(options, startupDisplay, 'APP_START_VERIFY', `start did not create target process: ${options.bundle}`, { oldPid });
    return;
  }
  if (oldPid && newPid === oldPid) {
    fail(options, startupDisplay, 'APP_PROCESS_ISOLATION', `restart did not create a new process: ${options.bundle} pid=${newPid}`, { oldPid, newPid });
    return;
  }

  if (requirement.required) {
    const settleMs = boundedInteger(process.env.MAVT_ORIENTATION_AFTER_LAUNCH_SETTLE_MS, 800, 0, 5000);
    startupDisplay.afterLaunch = pollOrientation(options, policy.orientation, settleMs);
    if (startupDisplay.afterLaunch.orientation !== policy.orientation) {
      const retry = resetPortrait(options);
      startupDisplay.retryApplied = true;
      if (retry.ok) startupDisplay.afterLaunch = pollOrientation(options, policy.orientation, settleMs);
    }
    if (startupDisplay.afterLaunch.orientation !== policy.orientation) {
      fail(options, startupDisplay, 'ORIENTATION_VERIFY_AFTER_START', 'App 启动后未能保持竖屏。', { oldPid, newPid });
      return;
    }
    startupDisplay.verified = true;
    startupDisplay.status = 'VERIFIED';
  } else {
    startupDisplay.afterLaunch = readDisplay(options);
    startupDisplay.verified = false;
    startupDisplay.status = 'SKIPPED';
  }

  process.stdout.write(`${JSON.stringify(resultBase(options, startupDisplay, {
    ok: true,
    coldStartVerified: true,
    oldPid,
    newPid,
    stopMethod: 'aa-force-stop',
    launchMethod: 'cold-start-aa-start',
  }), null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
