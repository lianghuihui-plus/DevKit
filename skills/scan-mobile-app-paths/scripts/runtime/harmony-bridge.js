#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { now } = require('../lib/common');
const { detectDeviceType, normalizeDeviceType } = require('../lib/device-detection');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]; if (!token.startsWith('--')) { out._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function run(command, args, { timeout = 15000, allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, { encoding, timeout, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (allowFailure) return { ok: false, status: result.status, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '' };
    const error = new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || result.error?.message || '').trim()}`);
    error.code = result.error?.code === 'ETIMEDOUT' ? 'BRIDGE_TIMEOUT' : 'BRIDGE_COMMAND_FAILED'; throw error;
  }
  return { ok: true, status: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function commandExists(command) {
  return run('/usr/bin/env', ['sh', '-c', 'command -v "$1"', 'sh', command], { allowFailure: true }).ok;
}

function hdcPrefix(args) {
  const hdc = process.env.SMAP_HDC || 'hdc';
  return { command: hdc, prefix: args.device ? ['-t', String(args.device)] : [] };
}

function hdc(args, words, options) {
  const target = hdcPrefix(args); return run(target.command, [...target.prefix, ...words], options);
}

function wait(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function boundedInteger(value, fallback, { min = 0, max = 10000 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function firstMatch(text, pattern) { const match = String(text || '').match(pattern); return match ? match[1] : null; }
function parseForegroundAbility(text) {
  for (const block of String(text || '').split(/AbilityRecord ID #/).slice(1)) {
    if (!/(?:^|\s)(?:state|app state) #FOREGROUND\b/.test(block) || !/ability type \[PAGE\]/.test(block)) continue;
    return { bundleName: firstMatch(block, /bundle name \[([^\]]+)\]/), abilityName: firstMatch(block, /main name \[([^\]]+)\]/), recordId: firstMatch(block, /^(\d+)/), line: block.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 8).join(' | ') };
  }
  return null;
}
function parseForegroundProcess(text, bundleName) {
  const blocks = String(text || '').split(/AppRunningRecord ID #/).slice(1);
  const block = blocks.find(x => bundleName && x.includes(`process name [${bundleName}]`) && /state #FOREGROUND\b/.test(x)) || blocks.find(x => /state #FOREGROUND\b/.test(x) && !/com\.ohos\.sceneboard/.test(x));
  return block ? { processName: firstMatch(block, /process name \[([^\]]+)\]/), pid: firstMatch(block, /pid #(\d+)/), line: block.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 5).join(' | ') } : null;
}

function foreground(args) {
  const aa = hdc(args, ['shell', 'aa', 'dump', '-l'], { allowFailure: true, timeout: 10000 });
  const window = hdc(args, ['shell', 'hidumper', '-s', 'WindowManagerService', '-a', '-a'], { allowFailure: true, timeout: 10000 });
  const ability = parseForegroundAbility(aa.stdout); const processInfo = parseForegroundProcess(aa.stdout, ability?.bundleName);
  return { schemaVersion: 1, ok: Boolean(ability || processInfo), foreground: { bundleName: ability?.bundleName || processInfo?.processName || null, ability: ability?.abilityName || null, processId: processInfo?.pid || null }, raw: { aaDumpAvailable: aa.ok, windowDumpAvailable: window.ok } };
}

function probe(args) {
  const deveco = process.env.SMAP_DEVECOCLI || 'devecocli';
  const deviceList = run(deveco, ['device', 'list'], { allowFailure: true, timeout: 15000 });
  const hdcName = process.env.SMAP_HDC || 'hdc'; const hasHdc = commandExists(hdcName);
  let uitest = { ok: false }, shot = false, layout = false, fg = false;
  if (hasHdc) {
    uitest = hdc(args, ['shell', 'uitest', '--version'], { allowFailure: true, timeout: 8000 });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-probe-'));
    try {
      const remotePng = `/data/local/tmp/smap-probe-${process.pid}.png`;
      shot = hdc(args, ['shell', 'uitest', 'screenCap', '-p', remotePng], { allowFailure: true, timeout: 10000 }).ok && hdc(args, ['file', 'recv', remotePng, path.join(temp, 'probe.png')], { allowFailure: true }).ok;
      const remoteJson = `/data/local/tmp/smap-probe-${process.pid}.json`;
      layout = hdc(args, ['shell', 'uitest', 'dumpLayout', '-p', remoteJson], { allowFailure: true, timeout: 10000 }).ok && hdc(args, ['file', 'recv', remoteJson, path.join(temp, 'probe.json')], { allowFailure: true }).ok;
      fg = foreground(args).ok;
      hdc(args, ['shell', 'rm', '-f', remotePng, remoteJson], { allowFailure: true });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const capabilities = { deviceEnumeration: deviceList.ok, hdc: hasHdc, uitest: uitest.ok, screenshot: shot, layout, foreground: fg, restart: hasHdc, action: Boolean(hasHdc && uitest.ok), logs: deviceList.ok };
  return { schemaVersion: 1, type: 'probeResult', platform: 'harmony', ok: capabilities.deviceEnumeration && capabilities.screenshot && capabilities.layout && capabilities.foreground, device: args.device || null, devicesRaw: String(deviceList.stdout || '').trim(), capabilities,
    diagnostics: Object.entries(capabilities).filter(([, value]) => !value).map(([name]) => ({ severity: ['logs', 'deviceEnumeration'].includes(name) ? 'WARN' : 'ERROR', reasonCode: `CAPABILITY_${name.toUpperCase()}_UNAVAILABLE` })) };
}

function coldStartOrientationPolicy(args) {
  const policy = String(args.coldStartOrientation || process.env.SMAP_COLD_START_ORIENTATION || 'portrait').trim().toLowerCase();
  if (!['portrait', 'preserve'].includes(policy)) {
    const error = new Error('SMAP_COLD_START_ORIENTATION must be portrait or preserve'); error.code = 'COLD_START_ORIENTATION_POLICY_INVALID'; throw error;
  }
  return policy;
}

function resolveDeviceType(args) {
  const explicit = normalizeDeviceType(args.deviceType);
  if (explicit) return { deviceType: explicit, source: 'explicit' };
  return detectDeviceType({ deviceId: args.device });
}

function currentDisplayOrientation(args) {
  const result = hdc(args, ['shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-a'], { allowFailure: true, timeout: 10000 });
  if (!result.ok) return { orientation: null, rotation: null, width: null, height: null, source: 'DisplayManagerService', ok: false };
  const text = String(result.stdout || '');
  const lastNumber = (name) => {
    const matches = [...text.matchAll(new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*$`, 'gmi'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  const rotation = lastNumber('Rotation') ?? lastNumber('ScreenRotation');
  const width = lastNumber('Width');
  const height = lastNumber('Height');
  let orientation = null;
  if (Number.isFinite(width) && Number.isFinite(height) && width !== height) orientation = width > height ? 'landscape' : 'portrait';
  else if (rotation === 0 || rotation === 180) orientation = 'portrait';
  else if (rotation === 90 || rotation === 270) orientation = 'landscape';
  return { orientation, rotation, width, height, source: 'DisplayManagerService', ok: true };
}

function resetPortraitBeforeStart(args) {
  const policy = coldStartOrientationPolicy(args);
  const device = resolveDeviceType(args);
  const state = { policy, requestedOrientation: policy === 'portrait' ? 'portrait' : null, deviceType: device.deviceType || null, deviceTypeSource: device.source || null, currentOrientation: null, currentRotation: null, currentDisplay: null, applied: false, skippedReason: null, command: null };
  if (policy === 'preserve') { state.skippedReason = 'PRESERVE'; return state; }
  if (device.deviceType !== 'phone') {
    state.skippedReason = device.deviceType ? 'NON_PHONE_DEVICE' : 'UNKNOWN_DEVICE_TYPE';
    return state;
  }
  const current = currentDisplayOrientation(args);
  state.currentOrientation = current.orientation;
  state.currentRotation = current.rotation;
  state.currentDisplay = { width: current.width, height: current.height, source: current.source, ok: current.ok };
  if (current.orientation === 'portrait') {
    state.skippedReason = 'ALREADY_PORTRAIT';
    return state;
  }
  const result = hdc(args, ['shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-motion,0'], { allowFailure: true, timeout: 10000 });
  state.command = "hidumper -s DisplayManagerService -a '-motion,0'";
  if (!result.ok) {
    const error = new Error(`Cold start portrait reset failed: ${String(result.stderr || result.stdout || '').trim() || 'DisplayManagerService command failed'}`);
    error.code = 'COLD_START_ORIENTATION_RESET_FAILED';
    throw error;
  }
  state.applied = true;
  wait(boundedInteger(args.orientationSettleMs ?? process.env.SMAP_ORIENTATION_SETTLE_MS, 500, { min: 0, max: 3000 }));
  return state;
}

function dumpLayout(args, remote, local, log) {
  const variants = args.bundleName ? [['-m', 'true', '-b', args.bundleName], ['-m', 'true'], ['-b', args.bundleName], []] : [['-m', 'true'], []];
  for (const extra of variants) {
    hdc(args, ['shell', 'rm', '-f', remote], { allowFailure: true });
    const result = hdc(args, ['shell', 'uitest', 'dumpLayout', '-p', remote, ...extra], { allowFailure: true, timeout: 15000 });
    fs.appendFileSync(log, `[layout] ${extra.join(' ') || 'default'}: ${result.ok ? 'ok' : 'failed'}\n${result.stderr || ''}`);
    if (result.ok && hdc(args, ['file', 'recv', remote, local], { allowFailure: true, timeout: 15000 }).ok && fs.existsSync(local) && fs.statSync(local).size > 0) return extra.length ? extra.join(' ') : 'default';
  }
  const error = new Error('HarmonyOS dumpLayout failed'); error.code = 'LAYOUT_CAPTURE_FAILED'; throw error;
}

function observe(args) {
  if (!args.outDir) throw Object.assign(new Error('--out-dir is required'), { code: 'ARG_REQUIRED' });
  fs.mkdirSync(args.outDir, { recursive: true }); const log = path.join(args.outDir, 'bridge.log'); fs.writeFileSync(log, '');
  const token = String(args.remoteToken || `smap-${process.pid}`).replace(/[^a-zA-Z0-9-]/g, '-');
  const remotePng = `/data/local/tmp/${token}.png`; const remoteJson = `/data/local/tmp/${token}.json`;
  const screenshot = path.join(args.outDir, 'screenshot.png'); const layout = path.join(args.outDir, 'layout.json'); const startedAt = now(); const startedMs = Date.now(); const foregroundBefore = foreground(args).foreground;
  hdc(args, ['shell', 'uitest', 'screenCap', '-p', remotePng], { timeout: 15000 });
  hdc(args, ['file', 'recv', remotePng, screenshot], { timeout: 15000 }); const screenshotCapturedAt = now();
  const layoutVariant = dumpLayout(args, remoteJson, layout, log); const layoutCapturedAt = now(); const fg = foreground(args); const finishedAt = now();
  hdc(args, ['shell', 'rm', '-f', remotePng, remoteJson], { allowFailure: true });
  if (!fs.existsSync(screenshot) || fs.statSync(screenshot).size === 0 || !fs.existsSync(layout) || fs.statSync(layout).size === 0) throw Object.assign(new Error('Observation evidence is incomplete'), { code: 'OBSERVATION_INCOMPLETE' });
  try { JSON.parse(fs.readFileSync(layout, 'utf8')); } catch (error) { throw Object.assign(new Error(`Layout JSON invalid: ${error.message}`), { code: 'LAYOUT_INVALID' }); }
  const coherent = foregroundBefore.bundleName === fg.foreground.bundleName && foregroundBefore.ability === fg.foreground.ability;
  return { schemaVersion: 1, type: 'bridgeObservation', ok: true, foreground: fg.foreground, layoutVariant, screenshot, layout, log, capture: { startedAt, screenshotCapturedAt, layoutCapturedAt, finishedAt, durationMs: Date.now() - startedMs, foregroundBefore, foregroundAfter: fg.foreground, coherent } };
}

function action(args) {
  const type = args.actionType; let result;
  const int = (name) => { const value = Number(args[name]); if (!Number.isFinite(value)) throw Object.assign(new Error(`--${name} is required`), { code: 'ARG_REQUIRED' }); return Math.round(value); };
  const optionalInt = (name, fallback) => args[name] === undefined ? fallback : int(name);
  if (type === 'tap') result = hdc(args, ['shell', 'uitest', 'uiInput', 'click', String(int('x')), String(int('y'))]);
  else if (type === 'longPress') result = hdc(args, ['shell', 'uitest', 'uiInput', 'swipe', String(int('x')), String(int('y')), String(int('x')), String(int('y')), String(optionalInt('durationMs', 800))]);
  else if (type === 'swipe') result = hdc(args, ['shell', 'uitest', 'uiInput', 'swipe', String(int('fromX')), String(int('fromY')), String(int('toX')), String(int('toY')), String(optionalInt('velocity', 600))]);
  else if (type === 'inputText') result = hdc(args, ['shell', 'uitest', 'uiInput', 'inputText', String(int('x')), String(int('y')), String(args.value || '')]);
  else if (type === 'keyEvent') result = hdc(args, ['shell', 'uitest', 'uiInput', 'keyEvent', String(args.key || 'BACK')]);
  else if (type === 'wait') { const ms = Math.min(10000, Math.max(0, Number(args.durationMs || 500))); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); result = { stdout: '' }; }
  else throw Object.assign(new Error(`Unsupported action type: ${type}`), { code: 'ACTION_UNSUPPORTED' });
  return { schemaVersion: 1, type: 'bridgeActionResult', ok: true, actionType: type, deviceOutput: String(result.stdout || '').trim() };
}

function restart(args) {
  if (!args.bundleName || !args.entryAbility) throw Object.assign(new Error('--bundle-name and --entry-ability are required'), { code: 'ARG_REQUIRED' });
  hdc(args, ['shell', 'aa', 'force-stop', args.bundleName], { timeout: 15000 });
  const orientation = resetPortraitBeforeStart(args);
  hdc(args, ['shell', 'aa', 'start', '-b', args.bundleName, '-a', args.entryAbility], { timeout: 20000 });
  wait(Math.min(10000, Number(args.settleMs || 1200)));
  const fg = foreground(args);
  if (fg.foreground.bundleName && fg.foreground.bundleName !== args.bundleName) throw Object.assign(new Error(`Cold start foreground mismatch: ${fg.foreground.bundleName}`), { code: 'APP_NOT_FOREGROUND' });
  return { schemaVersion: 1, type: 'bridgeRestartResult', ok: true, coldStartVerified: fg.foreground.bundleName === args.bundleName, foreground: fg.foreground, stopMethod: 'aa-force-stop', launchMethod: 'aa-start', orientation };
}

function logs(args) {
  const deveco = process.env.SMAP_DEVECOCLI || 'devecocli'; const words = ['log'];
  if (args.device) words.push('--device', args.device); if (args.bundleName) words.push('--bundle-name', args.bundleName);
  words.push('--from', args.from || '5m', '--tail', args.tail || '300');
  const result = run(deveco, words, { allowFailure: true, timeout: 30000 });
  return { schemaVersion: 1, type: 'bridgeLogsResult', ok: result.ok, logs: String(result.stdout || ''), error: String(result.stderr || '') };
}

function main() {
  const args = parseArgs(); const command = args._[0] || 'probe';
  const fn = { probe, foreground, observe, action, restart, logs }[command];
  if (!fn) throw Object.assign(new Error(`Unknown bridge command: ${command}`), { code: 'COMMAND_INVALID' });
  process.stdout.write(`${JSON.stringify(fn(args), null, 2)}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error.code || 'BRIDGE_ERROR', message: error.message } })}\n`); process.exitCode = 2; }
