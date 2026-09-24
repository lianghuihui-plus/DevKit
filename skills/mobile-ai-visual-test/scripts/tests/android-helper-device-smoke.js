#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimPath } = require('../platform/adapters/android/lib/android-helper-ownership');

const ANDROID_DIR = path.resolve(__dirname, '../platform/adapters/android');
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
const SETTINGS_PACKAGE = 'com.android.settings';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseArgs(argv) {
  const values = { backend: 'helper', mode: 'smoke', iterations: 10, warmups: 2 };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`invalid argument: ${flag || 'missing'}`);
    if (flag === '--device') values.device = value;
    else if (flag === '--backend') values.backend = value;
    else if (flag === '--mode') values.mode = value;
    else if (flag === '--iterations') values.iterations = Number(value);
    else if (flag === '--warmups') values.warmups = Number(value);
    else throw new Error(`invalid argument: ${flag}`);
  }
  if (!values.device) throw new Error('missing --device');
  if (!['auto', 'helper', 'uiautomator'].includes(values.backend)) throw new Error('invalid --backend');
  if (!['smoke', 'benchmark'].includes(values.mode)) throw new Error('invalid --mode');
  if (!Number.isInteger(values.iterations) || values.iterations <= 0) throw new Error('invalid --iterations');
  if (!Number.isInteger(values.warmups) || values.warmups < 0) throw new Error('invalid --warmups');
  return values;
}

function parseBounds(value) {
  const match = String(value || '').match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return {
    left, top, right, bottom,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function metricSummary(samples, field) {
  const values = samples.map((sample) => Number(sample[field])).filter(Number.isFinite);
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

function summarizeSamples(samples) {
  return {
    count: samples.length,
    adapterElapsedMs: metricSummary(samples, 'adapterElapsedMs'),
    deviceElapsedMs: metricSummary(samples, 'deviceElapsedMs'),
    pngBytes: metricSummary(samples, 'pngBytes'),
  };
}

function validateObservationArtifacts(root, observation) {
  const screenshotPath = path.resolve(root, String(observation?.artifacts?.screenshot || ''));
  const layoutPath = path.resolve(root, String(observation?.artifacts?.layout || ''));
  if (!observation?.artifacts?.screenshot || !screenshotPath.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('observation screenshot path is invalid');
  }
  if (!observation?.artifacts?.layout || !layoutPath.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('observation layout path is invalid');
  }
  const png = fs.readFileSync(screenshotPath);
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`observation PNG is invalid: ${screenshotPath}`);
  }
  const xml = fs.readFileSync(layoutPath, 'utf8');
  if (!/<hierarchy\b/.test(xml) || !/<node\b/.test(xml)) {
    throw new Error(`observation XML is invalid: ${layoutPath}`);
  }
  return { screenshotPath, layoutPath, pngBytes: png.length, xmlBytes: Buffer.byteLength(xml) };
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmlNodes(xml) {
  return [...String(xml).matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[match[1]] = decodeXml(match[2]);
    return { ...attributes, parsedBounds: parseBounds(attributes.bounds) };
  });
}

function layoutContainsText(layoutPath, expected) {
  return xmlNodes(fs.readFileSync(layoutPath, 'utf8')).some((node) => node.text === expected);
}

function screenSize(value) {
  const matches = [...String(value).matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const match = matches.at(-1);
  if (!match) throw new Error(`could not parse screen size: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    timeout: options.timeoutMs || 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${path.basename(command)} failed (${result.status}): ${detail}`);
  }
  return { stdout: String(result.stdout || ''), elapsedMs: Date.now() - startedAt };
}

function runJson(command, args, options = {}) {
  const result = run(command, args, options);
  return { value: JSON.parse(result.stdout), elapsedMs: result.elapsedMs };
}

function adb(device, args, options = {}) {
  return run('adb', ['-s', device, ...args], options).stdout.trim();
}

function accessibilityState(device) {
  const services = adb(device, ['shell', 'settings', 'get', 'secure', 'enabled_accessibility_services']);
  const enabled = adb(device, ['shell', 'settings', 'get', 'secure', 'accessibility_enabled']) || '0';
  return {
    services: String(services || '').split(':').map((item) => item.trim()).filter((item) => item && item !== 'null').sort(),
    enabled,
  };
}

function helperForwards(device) {
  return adb(device, ['forward', '--list']).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => line.startsWith(`${device} `) && /\stcp:18888$/.test(line)).sort();
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actionArgs(action) {
  const args = ['--type', action.type];
  const fields = [
    ['x', '--x'], ['y', '--y'], ['text', '--text'], ['mode', '--mode'],
    ['fromX', '--from-x'], ['fromY', '--from-y'], ['toX', '--to-x'], ['toY', '--to-y'],
    ['durationMs', '--duration-ms'], ['intervalMs', '--interval-ms'], ['velocity', '--velocity'],
  ];
  for (const [field, flag] of fields) {
    if (action[field] !== undefined && action[field] !== null) args.push(flag, String(action[field]));
  }
  return args;
}

function chooseSearchPoint(layoutPath, size) {
  const nodes = xmlNodes(fs.readFileSync(layoutPath, 'utf8'));
  const search = nodes.find((node) => node.parsedBounds && (
    /search/i.test(`${node['resource-id'] || ''} ${node['content-desc'] || ''} ${node.text || ''}`)
    || /搜索/.test(`${node['content-desc'] || ''} ${node.text || ''}`)
  ));
  return search?.parsedBounds || {
    left: size.width - 220, right: size.width - 20, top: 60, bottom: 240,
    x: size.width - 100, y: 150,
  };
}

function chooseEditorPoint(layoutPath, size) {
  const nodes = xmlNodes(fs.readFileSync(layoutPath, 'utf8'));
  const editor = nodes.find((node) => node.parsedBounds
    && /(EditText|AutoCompleteTextView)$/.test(node.class || ''))
    || nodes.find((node) => node.parsedBounds && /search_(src_)?text/i.test(node['resource-id'] || ''));
  return editor?.parsedBounds || {
    left: 80, right: size.width - 80, top: 60, bottom: 260,
    x: Math.round(size.width / 2), y: 160,
  };
}

function createContext(options) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-android-helper-${options.mode}-`));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-state-'));
  const ownerKey = `device-smoke-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const env = {
    ...process.env,
    MAVT_ANDROID_HELPER_STATE_DIR: stateRoot,
    MAVT_ANDROID_HELPER_WORKSPACE_ROOT: WORKSPACE_ROOT,
  };
  return {
    ...options, outputDir, stateRoot, ownerKey, env, runtime: null,
    initialAccessibility: accessibilityState(options.device),
    initialForwards: helperForwards(options.device),
    observations: [], actions: [],
  };
}

function acquire(context) {
  const result = runJson(path.join(ANDROID_DIR, 'runtime.sh'), [
    '--operation', 'acquire', '--owner-key', context.ownerKey,
    '--device', context.device, '--android-ui-backend', context.backend,
  ], { env: context.env });
  context.runtime = result.value;
  const selected = result.value?.resource?.androidHelper?.backend;
  if (!result.value?.ok || !['helper', 'uiautomator'].includes(selected)) {
    throw new Error(`runtime acquire failed: ${result.value?.failureCode || result.value?.status || 'unknown'}`);
  }
  if (context.backend === 'helper' && selected !== 'helper') throw new Error('strict helper did not select Helper');
  if (context.backend === 'auto' && selected !== 'helper') throw new Error('auto did not select Helper on the smoke device');
  if (selected === 'helper') {
    context.env.MAVT_ANDROID_HELPER_SESSION_STATE = result.value.resource.androidHelper.sessionStatePath;
  }
  return selected;
}

function release(context) {
  if (!context.runtime) return null;
  const result = runJson(path.join(ANDROID_DIR, 'runtime.sh'), [
    '--operation', 'release', '--owner-key', context.ownerKey,
    '--device', context.device, '--android-ui-backend', context.backend,
    '--runtime-json', JSON.stringify(context.runtime),
  ], { env: context.env });
  if (!result.value?.ok) throw new Error(`runtime release failed: ${result.value?.failureCode || 'unknown'}`);
  return result.value;
}

function prepareSettings(context, action = 'android.settings.SETTINGS', dependencies = {}) {
  const runAdb = dependencies.adb || adb;
  runAdb(context.device, ['shell', 'input', 'keyevent', 'WAKEUP']);
  runAdb(context.device, ['shell', 'wm', 'dismiss-keyguard']);
  runAdb(context.device, ['shell', 'am', 'start', '-W', '-a', action]);
  runAdb(context.device, ['shell', 'sleep', '0.5']);
}

function observe(context, backend, label) {
  const directory = path.join(context.outputDir, backend);
  let result;
  let artifacts;
  let lastError;
  const attempts = backend === 'uiautomator' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = runJson(path.join(ANDROID_DIR, 'observe.sh'), [
      '--device', context.device, '--app', SETTINGS_PACKAGE,
      '--out', directory, '--label', label, '--android-ui-backend', backend,
    ], { env: context.env });
    try {
      artifacts = validateObservationArtifacts(directory, result.value);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) adb(context.device, ['shell', 'sleep', '0.5']);
    }
  }
  if (lastError) throw lastError;
  const selected = result.value?.technicalSignals?.androidUiBackend?.selected;
  if (selected !== backend) throw new Error(`${label} selected ${selected}, expected ${backend}`);
  const sample = {
    label,
    backend,
    selectedBackend: selected,
    adapterElapsedMs: result.elapsedMs,
    deviceElapsedMs: backend === 'helper'
      ? Number(result.value?.technicalSignals?.androidUiBackend?.atomicElapsedMs)
      : Number(result.value?.technicalSignals?.layoutCapture?.durationMs),
    requestElapsedMs: backend === 'helper'
      ? Number(result.value?.technicalSignals?.androidUiBackend?.requestElapsedMs) : null,
    pngBytes: artifacts.pngBytes,
    xmlBytes: artifacts.xmlBytes,
    screenshot: path.relative(context.outputDir, artifacts.screenshotPath),
    layout: path.relative(context.outputDir, artifacts.layoutPath),
  };
  context.observations.push(sample);
  return { observation: result.value, artifacts, sample };
}

function perform(context, label, action) {
  const attempts = context.backend === 'uiautomator' && action.type === 'inputText'
    && action.mode === 'replace' && action.x !== undefined ? 2 : 1;
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = runJson(path.join(ANDROID_DIR, 'action.sh'), [
      '--device', context.device, '--app', SETTINGS_PACKAGE,
      ...actionArgs(action), '--android-ui-backend', context.backend,
    ], { env: context.env });
    if (result.value?.command?.status === 'ACCEPTED') break;
    if (attempt < attempts) adb(context.device, ['shell', 'sleep', '0.8']);
  }
  if (result.value?.command?.status !== 'ACCEPTED') {
    throw new Error(`${label} was not accepted: ${result.value?.failureCode || result.value?.command?.status || 'unknown'}`);
  }
  context.actions.push({ label, type: action.type, transport: result.value.command.transport, status: result.value.command.status });
  run('adb', ['-s', context.device, 'shell', 'sleep', '0.5']);
  return observe(context, context.backend === 'auto' ? 'helper' : context.backend, `after-${label}`);
}

function scanCredentials(root) {
  const findings = [];
  const visit = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const file = path.join(target, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && fs.statSync(file).size <= 16 * 1024 * 1024) {
        const text = fs.readFileSync(file, 'utf8');
        if (/X-Artemis-Token|secret-token|"token"\s*:/.test(text)) findings.push(path.relative(root, file));
      }
    }
  };
  visit(root);
  return findings;
}

function verifyReleased(context) {
  const finalAccessibility = accessibilityState(context.device);
  const finalForwards = helperForwards(context.device);
  const claim = claimPath(context.device);
  const credentialFindings = scanCredentials(context.outputDir);
  return {
    accessibilityRestored: sameJson(finalAccessibility, context.initialAccessibility),
    forwardsRestored: sameJson(finalForwards, context.initialForwards),
    claimReleased: !fs.existsSync(claim),
    sessionStateReleased: !context.runtime?.resource?.androidHelper?.sessionStatePath
      || !fs.existsSync(context.runtime.resource.androidHelper.sessionStatePath),
    credentialFindings,
    initialAccessibility: context.initialAccessibility,
    finalAccessibility,
    initialForwards: context.initialForwards,
    finalForwards,
  };
}

async function runSmoke(context) {
  const selectedBackend = acquire(context);
  prepareSettings(context);
  const size = screenSize(adb(context.device, ['shell', 'wm', 'size']));
  const initial = observe(context, selectedBackend, 'settings-start');
  const search = chooseSearchPoint(initial.artifacts.layoutPath, size);
  const searchPage = perform(context, 'tap', { type: 'tap', x: search.x, y: search.y });
  const editor = chooseEditorPoint(searchPage.artifacts.layoutPath, size);
  perform(context, 'double-tap-default', { type: 'doubleTap', x: editor.x, y: editor.y });
  perform(context, 'double-tap-custom', { type: 'doubleTap', x: editor.x, y: editor.y, intervalMs: 180 });
  perform(context, 'long-press', { type: 'longPress', x: editor.x, y: editor.y, durationMs: 650 });
  const replaced = perform(context, 'input-replace', { type: 'inputText', text: 'mavt', mode: 'replace' });
  if (selectedBackend === 'helper' && !layoutContainsText(replaced.artifacts.layoutPath, 'mavt')) {
    throw new Error('Helper replace input effect was not visible in the layout');
  }
  const refreshedEditor = chooseEditorPoint(replaced.artifacts.layoutPath, size);
  perform(context, 'refocus-for-append', { type: 'tap', x: refreshedEditor.x, y: refreshedEditor.y });
  const appended = perform(context, 'input-append', { type: 'inputText', text: '-append', mode: 'append' });
  if (selectedBackend === 'helper' && !layoutContainsText(appended.artifacts.layoutPath, 'mavt-append')) {
    throw new Error('Helper append input effect was not visible in the layout');
  }
  const pointInput = perform(context, 'input-point', {
    type: 'inputText', x: refreshedEditor.x, y: refreshedEditor.y, text: 'mavt-point', mode: 'replace',
  });
  if (selectedBackend === 'helper' && !layoutContainsText(pointInput.artifacts.layoutPath, 'mavt-point')) {
    throw new Error('Helper point input effect was not visible in the layout');
  }
  prepareSettings(context, 'android.settings.APPLICATION_SETTINGS');
  observe(context, selectedBackend, 'settings-apps-before-swipe');
  perform(context, 'swipe', {
    type: 'swipe', fromX: Math.round(size.width / 2), fromY: Math.round(size.height * 0.72),
    toX: Math.round(size.width / 2), toY: Math.round(size.height * 0.32), velocity: 900,
  });
  perform(context, 'back', { type: 'back' });
  perform(context, 'home', { type: 'home' });
  return { selectedBackend, screen: size };
}

async function runBenchmark(context) {
  const selectedBackend = acquire(context);
  if (selectedBackend !== 'helper') throw new Error('benchmark requires an active Helper session');
  prepareSettings(context, 'android.settings.APPLICATION_SETTINGS');
  for (const backend of ['helper', 'uiautomator']) {
    for (let index = 0; index < context.warmups; index += 1) observe(context, backend, `warmup-${backend}-${index + 1}`);
  }
  const samples = { helper: [], uiautomator: [] };
  const counts = { helper: 0, uiautomator: 0 };
  const order = ['helper', 'uiautomator', 'uiautomator', 'helper'];
  while (counts.helper < context.iterations || counts.uiautomator < context.iterations) {
    for (const backend of order) {
      if (counts[backend] >= context.iterations) continue;
      counts[backend] += 1;
      const captured = observe(context, backend, `sample-${backend}-${counts[backend]}`);
      samples[backend].push(captured.sample);
    }
  }
  return {
    selectedBackend,
    order,
    warmups: context.warmups,
    iterations: context.iterations,
    samples,
    summary: {
      helper: summarizeSamples(samples.helper),
      uiautomator: summarizeSamples(samples.uiautomator),
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sdk = Number(adb(options.device, ['shell', 'getprop', 'ro.build.version.sdk']));
  if (!Number.isInteger(sdk) || sdk < 30) throw new Error(`Android API 30+ required, found ${sdk || 'unknown'}`);
  const context = createContext(options);
  let result;
  let releaseResult = null;
  let operationError = null;
  try {
    result = options.mode === 'benchmark' ? await runBenchmark(context) : await runSmoke(context);
  } catch (error) {
    operationError = error;
  } finally {
    try { releaseResult = release(context); } catch (error) { operationError ||= error; }
    try { prepareSettings(context); } catch (error) { operationError ||= error; }
  }
  const releaseChecks = verifyReleased(context);
  fs.rmSync(context.stateRoot, { recursive: true, force: true });
  if (!releaseChecks.accessibilityRestored || !releaseChecks.forwardsRestored
    || !releaseChecks.claimReleased || !releaseChecks.sessionStateReleased
    || releaseChecks.credentialFindings.length) {
    operationError ||= new Error('Helper release or credential checks failed');
  }
  if (operationError) throw operationError;
  const report = {
    schemaVersion: 1,
    type: 'androidHelperDeviceSmoke',
    mode: options.mode,
    device: options.device,
    sdk,
    requestedBackend: options.backend,
    outputDir: context.outputDir,
    result,
    actions: context.actions,
    observations: context.observations,
    release: releaseResult,
    releaseChecks,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  chooseEditorPoint,
  layoutContainsText,
  main,
  parseArgs,
  parseBounds,
  percentile,
  prepareSettings,
  summarizeSamples,
  validateObservationArtifacts,
};
