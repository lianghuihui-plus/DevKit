#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { actionResult, atomResult, dependency, localIso } = require('./output');
const appium = require('./appium-client');
const {
  prepareAppium,
} = require('./service-lifecycle');
const { acquireIosRuntime, releaseIosRuntime } = require('./runtime-lifecycle');
const { acquireWda, releaseWda } = require('./wda-lifecycle');
const {
  buildTarget,
  commandExists,
  listAvailableRealDevices,
  listBootedSimulators,
  parseArgs,
  run,
  validateRestArgs,
} = require('./device-target');
const { swipeDurationMs } = require('../../../../lib/action-contract');
const { pngSizeFromBase64, scaleVisualPoint, sourceViewport } = require('./screen-space');

const ATOM_OPTIONS = Object.freeze({
  'screenshot': ['--out'],
  'dump-tree': ['--out'],
  'foreground': [],
  'logs': ['--out-dir', '--label'],
  'launch-app': [],
  'restart-app': [],
  'tap': ['--x', '--y', '--coordinate-source'],
  'double-tap': ['--x', '--y', '--interval-ms', '--coordinate-source'],
  'long-press': ['--x', '--y', '--duration-ms', '--coordinate-source', '--capture-out', '--capture-ref', '--capture-at-ms'],
  'swipe': ['--from-x', '--from-y', '--to-x', '--to-y', '--velocity', '--coordinate-source'],
  'input-text': ['--x', '--y', '--text', '--mode'],
  'dismiss-keyboard': [],
  'keyevent': ['--key'],
});

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeLabel(raw) {
  return String(raw || 'observe').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'observe';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rel(root, file) {
  return file && fs.existsSync(file) ? path.relative(root, file) : null;
}

function decodeBase64Png(value, out) {
  fs.writeFileSync(out, Buffer.from(value || '', 'base64'));
}

function fakeEnabled() {
  return process.env.MAVT_IOS_FAKE === '1';
}

function skippedStartupDisplay() {
  return {
    status: 'SKIPPED',
    verified: false,
    requestedOrientation: 'preserve',
    enforcement: 'none',
    appliesTo: [],
    required: false,
    skippedReason: 'POLICY_PRESERVE',
  };
}

async function runProbe(argv) {
  const parsed = parseArgs(argv);
  validateRestArgs(parsed.rest, [], 'iOS probe');
  const target = buildTarget(parsed);
  const devices = fakeEnabled()
    ? [{ name: 'Fake iPhone', udid: target.device || 'FAKE-IOS-SIMULATOR', state: 'Available', deviceType: target.deviceType }]
    : [...listBootedSimulators(), ...listAvailableRealDevices()];
  if (!target.device && devices.length === 1) target.device = devices[0].udid;
  target.deviceType = target.deviceType || 'simulator';
  const xcode = fakeEnabled() || commandExists('xcodebuild');
  const simctl = fakeEnabled() || commandExists('xcrun');
  const appiumCli = fakeEnabled() || commandExists('appium');
  const tidevice = !fakeEnabled() && commandExists('tidevice');

  let xcodeVersion = fakeEnabled() ? 'Fake Xcode' : '';
  if (!fakeEnabled() && xcode) xcodeVersion = run('xcodebuild', ['-version'], { timeout: 10000 }).stdout.trim();

  let appiumVersion = fakeEnabled() ? 'fake-appium' : '';
  if (!fakeEnabled() && appiumCli) appiumVersion = run('appium', ['-v'], { timeout: 10000 }).stdout.trim();

  let xcuitestDriver = fakeEnabled();
  let xcuitestVersion = fakeEnabled() ? 'fake-xcuitest' : '';
  if (!fakeEnabled() && appiumCli) {
    const driver = run('appium', ['driver', 'list', '--installed', '--json'], { timeout: 20000 });
    if (driver.ok) {
      try {
        const installed = JSON.parse(driver.stdout);
        xcuitestDriver = !!installed.xcuitest?.installed;
        xcuitestVersion = installed.xcuitest?.version || '';
      } catch {
        xcuitestDriver = driver.stdout.includes('"xcuitest"');
      }
    }
  }

  let appiumServer = fakeEnabled();
  let wda = fakeEnabled();
  if (fakeEnabled()) {
    appiumServer = true;
    wda = true;
  } else {
    try {
      await appium.status(target.appiumServer, 3000);
      appiumServer = true;
      wda = false;
    } catch {
      appiumServer = false;
      wda = false;
    }
  }

  const hasTarget = !!target.device && devices.some((item) => item.udid === target.device && item.deviceType === target.deviceType);
  const implemented = xcode && simctl && appiumCli && xcuitestDriver && hasTarget;
  const logsImplemented = implemented && target.deviceType === 'simulator';
  const diagnostics = [];
  const addDiagnostic = (id, level, message, howToFix, check) => {
    diagnostics.push({ id, level, message, howToFix, check });
  };
  if (!xcode) {
    addDiagnostic('iosXcodeMissing', 'ERROR', '未找到 Xcode', '安装 Xcode 并确认 xcodebuild -version 可执行；详见 references/installation.md#ios-模拟器', 'xcodebuild -version');
  }
  if (!simctl) {
    addDiagnostic('iosSimctlMissing', 'ERROR', '未找到 xcrun/simctl', '安装 Xcode Command Line Tools，并确认 xcrun simctl list 可执行', 'xcrun simctl list devices');
  }
  if (!appiumCli) {
    addDiagnostic('iosAppiumMissing', 'ERROR', '未找到 Appium CLI', '执行 npm install -g appium 安装 Appium；详见 references/installation.md#ios-模拟器', 'appium -v');
  }
  if (appiumCli && !xcuitestDriver) {
    addDiagnostic('iosXcuitestDriverMissing', 'ERROR', '未安装 Appium XCUITest Driver', '执行 appium driver install xcuitest；详见 references/installation.md#ios-模拟器', 'appium driver list --installed');
  }
  if (!target.device) {
    addDiagnostic('iosDeviceMissing', 'ERROR', '未发现可用 iOS 设备', '启动一个 iOS 模拟器，或为真机传入 --device <udid> --device-type realDevice；详见 references/installation.md#ios-真机', 'xcrun simctl list devices booted');
  } else if (!hasTarget) {
    addDiagnostic('iosDeviceUnavailable', 'ERROR', '指定的 iOS 设备当前不可用', '确认设备已解锁、通过 USB 连接并启用 Developer Mode；模拟器需处于 Booted 状态', 'xcrun xcdevice list --timeout 10');
  }
  if (target.deviceType === 'realDevice') {
    if (!fakeEnabled() && (!target.xcodeOrgId || !target.xcodeSigningId || !target.updatedWDABundleId)) {
      addDiagnostic('iosRealDeviceSigningIncomplete', 'ERROR', 'iOS 真机 WDA 签名参数不完整', '正式真机执行前请在环境确认 binding 中固定 Team ID、Signing ID 和 WDA bundle id；详见 references/installation.md#ios-真机', 'scripts/environment.js confirm --binding-json <json> ...');
    }
    if (!logsImplemented) {
      addDiagnostic('iosRealDeviceLogsUnavailable', 'WARN', 'iOS 真机日志暂不作为可用能力', '这是当前适配限制，不影响截图、控件树和动作能力', 'scripts/probe-env.sh --platform ios --device <udid> --device-type realDevice');
    }
  }
  if (appiumCli && !appiumServer) {
    addDiagnostic('iosAppiumServerNotReady', 'WARN', 'Appium server 当前不可连接', 'prepare-env 会尝试启动 Appium server；也可以手动执行 appium --address 127.0.0.1 --port 4723', 'curl http://127.0.0.1:4723/status');
  }
  if (appiumServer && !wda) {
    addDiagnostic('iosWdaNotReady', 'WARN', 'WDA 当前不可确认', 'prepare-env 会创建 Appium session 验证 WDA；真机首次运行可能需要信任开发者证书', 'scripts/prepare-env.sh --platform ios');
  }
  writeJson({
    schemaVersion: 1,
    type: 'environmentProbe',
    platform: 'ios',
    device: target.device || null,
    devices: devices.map((item) => ({ id: item.udid, serial: item.udid, name: item.name || item.udid, deviceType: item.deviceType })),
    targets: devices.map((item) => item.udid),
    ready: !diagnostics.some((item) => item.level === 'ERROR'),
    diagnostics,
    capabilities: {
      connector: 'appium-xcuitest',
      deviceType: target.deviceType,
      xcode,
      xcodeVersion,
      simctl,
      appium: appiumCli,
      appiumVersion,
      appiumServer,
      xcuitestDriver,
      xcuitestVersion,
      tidevice,
      wda,
      screenshot: implemented,
      layout: implemented,
      foregroundApp: implemented,
      logs: logsImplemented,
      launchApp: implemented,
      actions: implemented ? ['launchApp', 'restartApp', 'tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard', 'wait'] : [],
      screenCap: implemented,
      dumpLayout: implemented,
      implemented,
    },
  });
}

async function runPrepare(argv) {
  const parsed = parseArgs(argv);
  validateRestArgs(parsed.rest, [], 'iOS prepare');
  const target = buildTarget(parsed);
  const deps = [];
  const xcodeVersion = fakeEnabled() ? 'Fake Xcode' : (commandExists('xcodebuild') ? run('xcodebuild', ['-version'], { timeout: 10000 }).stdout.trim() : '');
  deps.push(dependency('xcode', !!xcodeVersion, { name: 'Xcode', version: xcodeVersion }));
  deps.push(dependency('simctl', fakeEnabled() || commandExists('xcrun'), { name: 'xcrun simctl' }));
  const appiumAvailable = fakeEnabled() || commandExists('appium');
  const appiumVersion = fakeEnabled() ? 'fake-appium' : (appiumAvailable ? run('appium', ['-v'], { timeout: 10000 }).stdout.trim() : '');
  deps.push(dependency('appium', appiumAvailable, { name: 'Appium', version: appiumVersion, server: target.appiumServer }));

  let xcuitestOk = fakeEnabled();
  let xcuitestVersion = fakeEnabled() ? 'fake-xcuitest' : '';
  if (!fakeEnabled() && appiumAvailable) {
    const driver = run('appium', ['driver', 'list', '--installed', '--json'], { timeout: 20000 });
    if (driver.ok) {
      try {
        const installed = JSON.parse(driver.stdout);
        xcuitestOk = !!installed.xcuitest?.installed;
        xcuitestVersion = installed.xcuitest?.version || '';
      } catch {
        xcuitestOk = driver.stdout.includes('"xcuitest"');
      }
    }
  }
  deps.push(dependency('xcuitestDriver', xcuitestOk, { name: 'Appium XCUITest Driver', version: xcuitestVersion }));

  let serverReady = false;
  let appiumRuntime = null;
  if (fakeEnabled()) {
    serverReady = true;
  } else if (appiumAvailable) {
    appiumRuntime = await prepareAppium(target);
    serverReady = appiumRuntime.ok === true;
  }
  deps.push(dependency('appiumServer', serverReady, {
    name: 'Appium Server',
    server: target.appiumServer,
    ownership: appiumRuntime?.ownership,
    pid: appiumRuntime?.resource?.pid,
    logPath: appiumRuntime?.resource?.logPath,
    error: appiumRuntime?.reason,
  }));

  let wdaOk = false;
  let wdaError = '';
  if (fakeEnabled()) {
    wdaOk = true;
  } else if (serverReady && target.device && target.appId) {
    const prepareOwnerKey = `environment-prepare-${process.pid}-${Date.now()}`;
    const preparedWda = acquireWda(target, prepareOwnerKey);
    try {
      await appium.withSession(target, async () => {}, { timeoutMs: 180000 });
      wdaOk = true;
    } catch (error) {
      wdaError = error.message;
    } finally {
      const releasedWda = await releaseWda(preparedWda.resource, prepareOwnerKey);
      if (!releasedWda.ok) {
        wdaOk = false;
        wdaError = [wdaError, releasedWda.reason].filter(Boolean).join('; ');
      }
    }
  } else {
    wdaError = 'missing device or appId';
  }
  deps.push(dependency('iosAutomation', wdaOk, { name: 'iOS Appium/WDA automation', server: target.appiumServer, device: target.device || null, appId: target.appId || null, error: wdaError || undefined }));

  writeJson({
    schemaVersion: 1,
    type: 'environmentPrepare',
    platform: 'ios',
    time: localIso(),
    ok: deps.every((item) => item.ok),
    dependencies: deps,
  });
}

async function runRuntime(argv) {
  const parsed = parseArgs(argv);
  validateRestArgs(parsed.rest, ['--operation', '--owner-key', '--runtime-json'], 'iOS runtime');
  const operation = optionValue(parsed.rest, '--operation');
  const target = buildTarget(parsed);
  let result;
  if (operation === 'acquire') {
    const ownerKey = optionValue(parsed.rest, '--owner-key');
    if (!ownerKey) throw new Error('iOS runtime acquire 需要 --owner-key');
    result = await acquireIosRuntime(target, ownerKey);
  } else if (operation === 'release') {
    const raw = optionValue(parsed.rest, '--runtime-json');
    if (!raw) throw new Error('iOS runtime release 需要 --runtime-json');
    let runtime;
    try {
      runtime = JSON.parse(raw);
    } catch (error) {
      throw new Error(`iOS runtime release 的 --runtime-json 无效: ${error.message}`);
    }
    result = await releaseIosRuntime(runtime);
  } else {
    throw new Error(`iOS runtime 不支持的 operation: ${operation || 'missing'}`);
  }
  writeJson({
    schemaVersion: 1,
    type: 'platformRuntimeResult',
    platform: 'ios',
    operation,
    time: localIso(),
    ...result,
  });
}

async function runObserve(argv) {
  const parsed = parseArgs(argv);
  validateRestArgs(parsed.rest, ['--out', '--label'], 'iOS observe');
  const target = buildTarget(parsed);
  const out = optionValue(parsed.rest, '--out');
  const label = safeLabel(optionValue(parsed.rest, '--label', 'observe'));
  if (!out) throw new Error('缺少 --out');
  ensureDir(path.join(out, 'screenshots'));
  ensureDir(path.join(out, 'layouts'));
  ensureDir(path.join(out, 'logs'));
  const screenshotPath = path.join(out, 'screenshots', `${label}.png`);
  const sourcePath = path.join(out, 'layouts', `${label}.xml`);
  const logPath = path.join(out, 'logs', `${label}-ios-log.txt`);
  const errorPath = path.join(out, 'logs', `${label}-errors.txt`);
  const errors = [];
  let foreground = null;
  let screen = null;
  let keyboardShown;
  let windowRect = null;

  if (fakeEnabled()) {
    if (process.env.MAVT_TEST_PNG && fs.existsSync(process.env.MAVT_TEST_PNG)) fs.copyFileSync(process.env.MAVT_TEST_PNG, screenshotPath);
    else fs.writeFileSync(screenshotPath, 'fake-ios-png');
    fs.writeFileSync(sourcePath, `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT><XCUIElementTypeApplication bundleId="${target.appId || 'com.example.demo'}" name="Demo" x="0" y="0" width="393" height="852"/></AppiumAUT>`);
    fs.writeFileSync(logPath, 'fake ios log\n');
    foreground = { bundleId: target.appId || 'com.example.demo', pid: 1234, name: 'Demo' };
    screen = '393x852';
    keyboardShown = process.env.MAVT_IOS_FAKE_KEYBOARD_SHOWN === '1';
    windowRect = { x: 0, y: 0, width: 393, height: 852 };
  } else {
    await appium.withSession(target, async ({ sessionId }) => {
      try {
        const shot = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/screenshot`);
        decodeBase64Png(shot.value, screenshotPath);
      } catch (error) {
        errors.push(`[screenshot] ${error.message}`);
      }
      try {
        const source = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/source`);
        fs.writeFileSync(sourcePath, source.value || '');
        const appMatch = String(source.value || '').match(/<XCUIElementTypeApplication[^>]*bundleId="([^"]+)"/);
        if (appMatch && !foreground) foreground = { bundleId: appMatch[1] };
        const viewport = sourceViewport(source.value);
        if (viewport) screen = `${viewport.width}x${viewport.height}`;
      } catch (error) {
        errors.push(`[layout] ${error.message}`);
      }
      try {
        const active = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: activeAppInfo', args: [] });
        if (active.value) foreground = active.value;
      } catch (error) {
        errors.push(`[foreground] ${error.message}`);
      }
      try {
        const keyboard = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: isKeyboardShown', args: [] });
        keyboardShown = keyboard.value === true;
      } catch (error) {
        errors.push(`[keyboard] ${error.message}`);
      }
      try {
        const rect = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/window/rect`);
        windowRect = rect.value || null;
      } catch (error) {
        errors.push(`[windowRect] ${error.message}`);
      }
    }, { autoLaunch: false });
    if (target.deviceType === 'simulator' && target.device) {
      const logs = run('xcrun', ['simctl', 'spawn', target.device, 'log', 'show', '--last', '30s', '--style', 'compact'], { timeout: 15000 });
      fs.writeFileSync(logPath, logs.ok ? logs.stdout : logs.stderr);
      if (!logs.ok) errors.push(`[logs] ${logs.stderr}`);
    }
  }

  if (errors.length) fs.writeFileSync(errorPath, `${errors.join('\n')}\n`);
  const logs = [logPath, errorPath].map((file) => rel(out, file)).filter(Boolean);
  const screenshotRel = rel(out, screenshotPath);
  const layoutRel = rel(out, sourcePath);
  const foregroundApp = foreground?.bundleId || null;
  writeJson({
    schemaVersion: 1,
    type: 'observation',
    platform: 'ios',
    time: localIso(),
    label,
    artifacts: {
      screenshot: screenshotRel,
      layout: layoutRel,
      logs,
    },
    device: {
      id: target.device || null,
      screen,
    },
    app: {
      appId: target.appId || null,
      foregroundApp,
      entry: null,
      inTargetApp: target.appId && foregroundApp ? target.appId === foregroundApp : null,
      processId: foreground?.pid || null,
    },
    capabilities: {
      screenshot: !!screenshotRel,
      layout: !!layoutRel,
      foregroundApp: !!foregroundApp,
      logs: logs.length > 0,
    },
    technicalSignals: {
      ...(keyboardShown !== undefined ? { keyboardShown } : {}),
      ...(windowRect ? { windowRect } : {}),
    },
    raw: {
      foreground,
      errors,
      logFiles: logs,
    },
    screenshot: screenshotRel,
    layout: layoutRel,
  });
}

function pointerAction(x, y, holdMs = 80) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: Number(holdMs) },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function doubleTapAction(x, y, intervalMs = 100) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: Number(intervalMs) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function pointerDownAction(x, y, pointerId) {
  return {
    actions: [{
      type: 'pointer',
      id: pointerId,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
      ],
    }],
  };
}

function pointerUpAction(pointerId) {
  return {
    actions: [{
      type: 'pointer',
      id: pointerId,
      parameters: { pointerType: 'touch' },
      actions: [{ type: 'pointerUp', button: 0 }],
    }],
  };
}

function swipeAction(fromX, fromY, toX, toY, durationMs = 350) {
  return {
    actions: [{
      type: 'pointer',
      id: `finger-${Date.now()}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Number(fromX), y: Number(fromY), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: Number(durationMs), x: Number(toX), y: Number(toY), origin: 'viewport' },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function truthyAttribute(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function falseyAttribute(value) {
  return value === false || String(value).toLowerCase() === 'false' || String(value) === '0';
}

function appiumElementId(value) {
  return value?.['element-6066-11e4-a52e-4f735466cecf'] || value?.ELEMENT || null;
}

async function getElementAttribute(target, sessionId, elementId, name) {
  try {
    const response = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/element/${elementId}/attribute/${name}`);
    return response.value;
  } catch {
    return null;
  }
}

async function findEditableElement(target, sessionId) {
  let activeElementId = null;
  try {
    const active = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/element/active`);
    activeElementId = appiumElementId(active.value);
  } catch {
    activeElementId = null;
  }
  const candidates = [];
  for (const cls of ['XCUIElementTypeTextField', 'XCUIElementTypeSearchField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView']) {
    const response = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/elements`, { using: 'class name', value: cls });
    const elements = response.value || [];
    for (const element of elements) {
      const elementId = appiumElementId(element);
      if (!elementId) continue;
      candidates.push({
        elementId,
        className: cls,
        focused: await getElementAttribute(target, sessionId, elementId, 'focused'),
        visible: await getElementAttribute(target, sessionId, elementId, 'visible'),
        enabled: await getElementAttribute(target, sessionId, elementId, 'enabled'),
      });
    }
  }
  if (!candidates.length) {
    throw new Error('No editable XCUI element found. Tap/focus an input field before inputText.');
  }
  const active = candidates.filter((item) => item.elementId === activeElementId && !falseyAttribute(item.enabled));
  if (active.length === 1) return { elementId: active[0].elementId, className: active[0].className, selection: 'active-element' };
  const focused = candidates.filter((item) => truthyAttribute(item.focused) && !falseyAttribute(item.enabled));
  if (focused.length === 1) return { elementId: focused[0].elementId, className: focused[0].className, selection: 'focused' };
  const visible = candidates.filter((item) => !falseyAttribute(item.visible) && !falseyAttribute(item.enabled));
  if (visible.length === 1) return { elementId: visible[0].elementId, className: visible[0].className, selection: 'single-visible-editable' };
  if (candidates.length === 1) return { elementId: candidates[0].elementId, className: candidates[0].className, selection: 'single-editable' };
  throw new Error(`Multiple editable XCUI elements found (${candidates.length}). Tap/focus the target input before inputText.`);
}

function conciseError(error) {
  return String(error?.message || error || 'unknown input error').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function normalizedInputValue(value, placeholder) {
  if (value === null || value === undefined) return null;
  return placeholder !== null && placeholder !== undefined && String(value) === String(placeholder) ? '' : String(value);
}

function inputEffectFor(editable, expectedText, actualValue, placeholder) {
  const actualText = normalizedInputValue(actualValue, placeholder);
  if (editable.className === 'XCUIElementTypeSecureTextField') {
    if (actualText === null) {
      return { status: 'UNVERIFIABLE', expectedLength: expectedText.length, reason: 'secure field value is unavailable' };
    }
    if (actualText.length === 0) {
      return { status: 'MISMATCH', expectedLength: expectedText.length, observedLength: 0, reason: 'secure field is still empty' };
    }
    if (actualText.length !== expectedText.length) {
      return {
        status: 'MISMATCH', expectedLength: expectedText.length, observedLength: actualText.length,
        reason: 'secure field mask length does not match the requested text length',
      };
    }
    return { status: 'MASKED', expectedLength: expectedText.length, observedLength: actualText.length };
  }
  if (actualText === null) {
    return { status: 'UNVERIFIABLE', expectedText, reason: 'field value is unavailable' };
  }
  return {
    status: actualText === expectedText ? 'VERIFIED' : 'MISMATCH',
    expectedText,
    actualText,
  };
}

async function readInputEffect(target, sessionId, editable, expectedText, placeholder) {
  const actualValue = await getElementAttribute(target, sessionId, editable.elementId, 'value');
  return inputEffectFor(editable, expectedText, actualValue, placeholder);
}

function inputEffectSucceeded(effect) {
  return ['VERIFIED', 'MASKED', 'UNVERIFIABLE'].includes(effect?.status);
}

async function inputTextWithFallback(target, sessionId, editable, text, mode) {
  const startedAt = Date.now();
  const placeholder = await getElementAttribute(target, sessionId, editable.elementId, 'placeholderValue');
  const beforeValue = await getElementAttribute(target, sessionId, editable.elementId, 'value');
  const beforeText = normalizedInputValue(beforeValue, placeholder);
  const expectedText = mode === 'append' && beforeText !== null ? `${beforeText}${text}` : text;
  const writeText = expectedText;
  const attempts = [];
  const methods = [
    {
      name: 'wda-element-value',
      send: () => appium.request(target.appiumServer, 'POST', `/session/${sessionId}/element/${editable.elementId}/value`, {
        text: writeText,
        value: Array.from(writeText),
      }),
    },
    {
      name: 'wda-session-keys',
      send: () => appium.request(target.appiumServer, 'POST', `/session/${sessionId}/keys`, {
        text: writeText,
        value: Array.from(writeText),
      }),
    },
  ];
  let lastEffect = null;
  for (const method of methods) {
    const attempt = { method: method.name, ok: false };
    try {
      if (mode === 'replace' || beforeText !== null) {
        try {
          await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/element/${editable.elementId}/clear`, {});
        } catch (error) {
          attempt.clearError = conciseError(error);
        }
      }
      await method.send();
      lastEffect = await readInputEffect(target, sessionId, editable, expectedText, placeholder);
      attempt.effectStatus = lastEffect.status;
      attempt.ok = inputEffectSucceeded(lastEffect);
      attempts.push(attempt);
      if (attempt.ok) {
        return {
          ok: true,
          inputMethod: method.name,
          inputMode: mode,
          inputTarget: editable.selection,
          inputAttempts: attempts,
          inputEffect: { ...lastEffect, attempts: attempts.length, settledMs: Date.now() - startedAt },
        };
      }
    } catch (error) {
      attempt.error = conciseError(error);
      try {
        lastEffect = await readInputEffect(target, sessionId, editable, expectedText, placeholder);
        attempt.effectStatus = lastEffect.status;
        if (['VERIFIED', 'MASKED'].includes(lastEffect.status)) {
          attempt.ok = true;
          attempts.push(attempt);
          return {
            ok: true,
            inputMethod: method.name,
            inputMode: mode,
            inputTarget: editable.selection,
            inputAttempts: attempts,
            inputEffect: { ...lastEffect, attempts: attempts.length, settledMs: Date.now() - startedAt },
          };
        }
      } catch (verificationError) {
        attempt.verificationError = conciseError(verificationError);
      }
      attempts.push(attempt);
    }
  }
  return {
    ok: false,
    failureCode: 'IOS_INPUT_TEXT_FAILED',
    message: 'iOS whole-string input failed after bounded adapter fallback',
    inputMethod: 'bounded-fallback-exhausted',
    inputMode: mode,
    inputTarget: editable.selection,
    inputAttempts: attempts,
    inputEffect: {
      ...(lastEffect || { status: 'UNVERIFIABLE', reason: 'input effect could not be read' }),
      attempts: attempts.length,
      settledMs: Date.now() - startedAt,
    },
  };
}

async function queryAppState(target, sessionId) {
  const response = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/appium/device/app_state`, { bundleId: target.appId });
  return response.value;
}

async function waitForAppState(target, sessionId, predicate, label, timeoutMs = 6000) {
  const started = Date.now();
  let lastState = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastState = await queryAppState(target, sessionId);
      if (predicate(lastState)) {
        return { ok: true, state: lastState };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  const detail = lastError ? lastError.message : `last state=${lastState}`;
  throw new Error(`iOS app state did not become ${label}: ${detail}`);
}

function resolveSwipeExecution(rest) {
  const action = {
    type: 'swipe',
    fromX: optionValue(rest, '--from-x'),
    fromY: optionValue(rest, '--from-y'),
    toX: optionValue(rest, '--to-x'),
    toY: optionValue(rest, '--to-y'),
    velocity: optionValue(rest, '--velocity', '600'),
  };
  return {
    ...action,
    velocity: Number(action.velocity),
    durationMs: swipeDurationMs(action),
  };
}

function resolveLongPressExecution(rest) {
  const x = optionValue(rest, '--x');
  const y = optionValue(rest, '--y');
  const durationValue = optionValue(rest, '--duration-ms');
  const durationMs = Number(durationValue);
  const coordinateSource = optionValue(rest, '--coordinate-source', 'layout');
  const captureOut = optionValue(rest, '--capture-out');
  const captureRef = optionValue(rest, '--capture-ref');
  const captureAtMs = Number(optionValue(rest, '--capture-at-ms', '0'));
  if (x === '' || y === '' || durationValue === '' || !Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('longPress 需要 --x、--y 和正整数 --duration-ms');
  }
  if (captureOut && (!captureRef || !Number.isInteger(captureAtMs) || captureAtMs < 20 || captureAtMs >= durationMs)) {
    throw new Error('longPress 过程截图需要有效的 --capture-ref，且 --capture-at-ms 必须位于按压时长内');
  }
  return { x, y, durationMs, coordinateSource, captureOut, captureRef, captureAtMs };
}

async function executablePoint(target, sessionId, point, coordinateSource) {
  const raw = { x: Number(point.x), y: Number(point.y) };
  const rectRequest = appium.request(target.appiumServer, 'GET', `/session/${sessionId}/window/rect`);
  if (coordinateSource !== 'visual') {
    const rect = await rectRequest;
    return {
      ...raw,
      viewport: { width: Number(rect.value?.width), height: Number(rect.value?.height) },
      coordinateSource,
    };
  }
  const [shot, rect] = await Promise.all([
    appium.request(target.appiumServer, 'GET', `/session/${sessionId}/screenshot`),
    rectRequest,
  ]);
  return { ...scaleVisualPoint(raw, pngSizeFromBase64(shot.value), rect.value), coordinateSource };
}

async function runAtom(atom, argv) {
  const parsed = parseArgs(argv);
  if (!Object.prototype.hasOwnProperty.call(ATOM_OPTIONS, atom)) {
    throw new Error(`unsupported ios atom: ${atom}`);
  }
  validateRestArgs(parsed.rest, ATOM_OPTIONS[atom], `iOS ${atom}`);
  const target = buildTarget(parsed);
  const rest = parsed.rest;
  const sessionOptions = { autoLaunch: false };
  const swipeExecution = atom === 'swipe' ? resolveSwipeExecution(rest) : null;
  const longPressExecution = atom === 'long-press' ? resolveLongPressExecution(rest) : null;
  if (atom === 'input-text' && (optionValue(rest, '--x') || optionValue(rest, '--y'))) {
    throw new Error('iOS inputText 只向已聚焦输入框输入文本，不接受 --x/--y；请先调用 tap 聚焦目标输入框。');
  }
  if (fakeEnabled()) {
    if (['screenshot', 'dump-tree'].includes(atom)) {
      const out = optionValue(rest, '--out');
      if (!out) throw new Error(`${atom} 需要 --out`);
      ensureDir(path.dirname(out));
      fs.writeFileSync(out, atom === 'screenshot' ? 'fake-ios-png' : '<AppiumAUT/>');
      writeJson(atomResult(atom, { path: path.resolve(out) }));
      return;
    }
    if (atom === 'foreground') {
      writeJson(atomResult('foreground', { foreground: { bundleId: target.appId || 'com.example.demo', pid: 1234 } }));
      return;
    }
    if (atom === 'logs') {
      const outDir = optionValue(rest, '--out-dir');
      const label = safeLabel(optionValue(rest, '--label', 'observe'));
      if (!outDir) throw new Error('logs 需要 --out-dir');
      ensureDir(outDir);
      const outFile = path.join(outDir, `${label}-ios-log.txt`);
      fs.writeFileSync(outFile, 'fake ios log\n');
      writeJson(atomResult('logs', { files: [path.resolve(outFile)] }));
      return;
    }
    const fakeInputMode = atom === 'input-text' ? optionValue(rest, '--mode', 'replace') : undefined;
    const fakeInputText = atom === 'input-text' ? optionValue(rest, '--text') : undefined;
    const fakeInputExpected = fakeInputMode === 'append' ? `${process.env.MAVT_IOS_FAKE_INPUT_VALUE || ''}${fakeInputText}` : fakeInputText;
    const fakeCoordinateSource = optionValue(rest, '--coordinate-source', 'layout');
    const fakeViewport = { width: 393, height: 852 };
    const fakePoint = ['tap', 'double-tap', 'long-press'].includes(atom)
      ? {
        x: Number(optionValue(rest, '--x')),
        y: Number(optionValue(rest, '--y')),
        viewport: fakeViewport,
        coordinateSource: fakeCoordinateSource,
      }
      : undefined;
    const fakeCaptureOut = longPressExecution?.captureOut || '';
    const fakeCaptureRef = longPressExecution?.captureRef || '';
    const fakeCaptureAtMs = longPressExecution?.captureAtMs || 0;
    if (fakeCaptureOut) {
      ensureDir(path.dirname(fakeCaptureOut));
      fs.writeFileSync(fakeCaptureOut, 'fake-ios-png');
    }
    writeJson(actionResult(atom === 'launch-app' ? 'launchApp' : atom === 'restart-app' ? 'restartApp' : atom === 'double-tap' ? 'doubleTap' : atom === 'long-press' ? 'longPress' : atom === 'input-text' ? 'inputText' : atom === 'dismiss-keyboard' ? 'dismissKeyboard' : atom === 'keyevent' ? optionValue(rest, '--key', 'keyevent') : atom, {
      inputMethod: atom === 'input-text' ? (fakeInputMode === 'replace' ? 'wda-clear-set-value' : 'wda-read-compose-set-value') : undefined,
      inputMode: fakeInputMode,
      inputEffect: atom === 'input-text' ? { status: 'VERIFIED', expectedText: fakeInputExpected, actualText: fakeInputExpected } : undefined,
      restart: atom === 'restart-app' ? true : undefined,
      coldStartVerified: atom === 'restart-app' ? true : undefined,
      startupDisplay: atom === 'restart-app' ? skippedStartupDisplay() : undefined,
      verification: atom === 'restart-app' ? 'fake-appium-app-state' : undefined,
      stateAfterTerminate: atom === 'restart-app' ? 1 : undefined,
      stateAfterActivate: atom === 'restart-app' ? 4 : undefined,
      stopMethod: atom === 'restart-app' ? 'appium-terminate-app' : undefined,
      launchMethod: atom === 'restart-app' ? 'appium-terminate-activate' : undefined,
      velocity: swipeExecution?.velocity,
      durationMs: longPressExecution?.durationMs ?? swipeExecution?.durationMs,
      intervalMs: atom === 'double-tap' ? Number(optionValue(rest, '--interval-ms', '100')) : undefined,
      executedPoint: fakePoint,
      duringActionCapture: fakeCaptureOut ? { capturedAtMs: fakeCaptureAtMs, artifacts: { screenshot: fakeCaptureRef } } : undefined,
      executedFrom: swipeExecution ? {
        x: swipeExecution.fromX, y: swipeExecution.fromY, viewport: fakeViewport, coordinateSource: fakeCoordinateSource,
      } : undefined,
      executedTo: swipeExecution ? {
        x: swipeExecution.toX, y: swipeExecution.toY, viewport: fakeViewport, coordinateSource: fakeCoordinateSource,
      } : undefined,
    }));
    return;
  }
  if (atom === 'screenshot') {
    const out = optionValue(rest, '--out');
    if (!out) throw new Error('screenshot 需要 --out');
    ensureDir(path.dirname(out));
    await appium.withSession(target, async ({ sessionId }) => {
      const shot = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/screenshot`);
      decodeBase64Png(shot.value, out);
    }, sessionOptions);
    writeJson(atomResult('screenshot', { path: path.resolve(out) }));
    return;
  }
  if (atom === 'dump-tree') {
    const out = optionValue(rest, '--out');
    if (!out) throw new Error('dump-tree 需要 --out');
    ensureDir(path.dirname(out));
    await appium.withSession(target, async ({ sessionId }) => {
      const source = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/source`);
      fs.writeFileSync(out, source.value || '');
    }, sessionOptions);
    writeJson(atomResult('dump-tree', { path: path.resolve(out) }));
    return;
  }
  if (atom === 'foreground') {
    await appium.withSession(target, async ({ sessionId }) => {
      const active = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: activeAppInfo', args: [] });
      writeJson(atomResult('foreground', { foreground: active.value || null }));
    }, sessionOptions);
    return;
  }
  if (atom === 'logs') {
    const outDir = optionValue(rest, '--out-dir');
    const label = safeLabel(optionValue(rest, '--label', 'observe'));
    if (!outDir) throw new Error('logs 需要 --out-dir');
    ensureDir(outDir);
    const outFile = path.join(outDir, `${label}-ios-log.txt`);
    if (target.deviceType === 'simulator' && target.device) {
      const logs = run('xcrun', ['simctl', 'spawn', target.device, 'log', 'show', '--last', '30s', '--style', 'compact'], { timeout: 15000 });
      fs.writeFileSync(outFile, logs.ok ? logs.stdout : logs.stderr);
    } else {
      fs.writeFileSync(outFile, 'iOS real-device logs are not implemented yet.\n');
    }
    writeJson(atomResult('logs', { files: [path.resolve(outFile)] }));
    return;
  }
  if (atom === 'launch-app') {
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/appium/device/activate_app`, { bundleId: target.appId });
    }, sessionOptions);
    writeJson(actionResult('launchApp', { launchMethod: 'appium-activate-app' }));
    return;
  }
  if (atom === 'restart-app') {
    if (!target.appId) throw new Error('restart-app 需要 --app 或 --bundle');
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/appium/device/terminate_app`, { bundleId: target.appId });
      const stopped = await waitForAppState(target, sessionId, (state) => Number(state) <= 1, 'not running after terminate_app');
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/appium/device/activate_app`, { bundleId: target.appId });
      const foreground = await waitForAppState(target, sessionId, (state) => Number(state) === 4, 'foreground after activate_app');
      writeJson(actionResult('restartApp', {
        restart: true,
        coldStartVerified: true,
        startupDisplay: skippedStartupDisplay(),
        verification: 'appium-app-state',
        stateAfterTerminate: stopped.state,
        stateAfterActivate: foreground.state,
        stopMethod: 'appium-terminate-app',
        launchMethod: 'appium-terminate-activate',
      }));
    }, sessionOptions);
    return;
  }
  if (atom === 'tap') {
    const x = optionValue(rest, '--x');
    const y = optionValue(rest, '--y');
    const coordinateSource = optionValue(rest, '--coordinate-source', 'layout');
    if (x === '' || y === '') throw new Error('tap 需要 --x 和 --y');
    let executed;
    await appium.withSession(target, async ({ sessionId }) => {
      executed = await executablePoint(target, sessionId, { x, y }, coordinateSource);
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerAction(executed.x, executed.y));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    }, sessionOptions);
    writeJson(actionResult('tap', { executedPoint: executed }));
    return;
  }
  if (atom === 'double-tap') {
    const x = optionValue(rest, '--x');
    const y = optionValue(rest, '--y');
    const intervalMs = Number(optionValue(rest, '--interval-ms', '100'));
    const coordinateSource = optionValue(rest, '--coordinate-source', 'layout');
    if (x === '' || y === '') throw new Error('doubleTap 需要 --x 和 --y');
    if (!Number.isInteger(intervalMs) || intervalMs < 20 || intervalMs > 1000) throw new Error('doubleTap --interval-ms 必须为 20..1000 的整数');
    let executed;
    await appium.withSession(target, async ({ sessionId }) => {
      executed = await executablePoint(target, sessionId, { x, y }, coordinateSource);
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, doubleTapAction(executed.x, executed.y, intervalMs));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    }, sessionOptions);
    writeJson(actionResult('doubleTap', { intervalMs, executedPoint: executed }));
    return;
  }
  if (atom === 'long-press') {
    const { x, y, durationMs, coordinateSource, captureOut, captureRef, captureAtMs } = longPressExecution;
    let executed;
    let capturedAtMs = null;
    await appium.withSession(target, async ({ sessionId }) => {
      executed = await executablePoint(target, sessionId, { x, y }, coordinateSource);
      if (!captureOut) {
        await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerAction(executed.x, executed.y, durationMs));
        await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
        return;
      }
      ensureDir(path.dirname(captureOut));
      const pointerId = `finger-${Date.now()}`;
      const pressedAt = Date.now();
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerDownAction(executed.x, executed.y, pointerId));
      try {
        await sleep(captureAtMs);
        const shot = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/screenshot`);
        decodeBase64Png(shot.value, captureOut);
        capturedAtMs = Date.now() - pressedAt;
        await sleep(durationMs - captureAtMs);
        await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerUpAction(pointerId));
      } finally {
        await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {}).catch(() => {});
      }
    }, sessionOptions);
    writeJson(actionResult('longPress', {
      durationMs,
      executedPoint: executed,
      duringActionCapture: captureOut ? { capturedAtMs, artifacts: { screenshot: captureRef } } : undefined,
    }));
    return;
  }
  if (atom === 'swipe') {
    const coordinateSource = optionValue(rest, '--coordinate-source', 'layout');
    let executedFrom;
    let executedTo;
    await appium.withSession(target, async ({ sessionId }) => {
      executedFrom = await executablePoint(target, sessionId, { x: swipeExecution.fromX, y: swipeExecution.fromY }, coordinateSource);
      executedTo = coordinateSource === 'visual'
        ? scaleVisualPoint({ x: swipeExecution.toX, y: swipeExecution.toY }, executedFrom.screenshot, executedFrom.viewport)
        : {
          x: swipeExecution.toX,
          y: swipeExecution.toY,
          viewport: executedFrom.viewport,
          coordinateSource,
        };
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, swipeAction(
        executedFrom.x,
        executedFrom.y,
        executedTo.x,
        executedTo.y,
        swipeExecution.durationMs,
      ));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    }, sessionOptions);
    writeJson(actionResult('swipe', {
      velocity: swipeExecution.velocity,
      durationMs: swipeExecution.durationMs,
      executedFrom,
      executedTo,
    }));
    return;
  }
  if (atom === 'input-text') {
    const text = optionValue(rest, '--text');
    const mode = optionValue(rest, '--mode', 'replace');
    if (!text) throw new Error('inputText 需要 --text');
    if (!['replace', 'append'].includes(mode)) throw new Error('inputText --mode 仅支持 replace/append');
    let event;
    try {
      await appium.withSession(target, async ({ sessionId }) => {
        const editable = await findEditableElement(target, sessionId);
        event = actionResult('inputText', await inputTextWithFallback(target, sessionId, editable, text, mode));
      }, sessionOptions);
    } catch (error) {
      event = actionResult('inputText', {
        ok: false,
        failureCode: 'IOS_INPUT_TEXT_FAILED',
        message: conciseError(error),
        adapterError: { stage: 'inputText', message: conciseError(error) },
        inputEffect: { status: 'UNVERIFIABLE', attempts: 0, settledMs: 0, reason: 'input adapter did not reach effect verification' },
      });
    }
    writeJson(event);
    return;
  }
  if (atom === 'dismiss-keyboard') {
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: hideKeyboard', args: [] });
    }, sessionOptions);
    writeJson(actionResult('dismissKeyboard', { method: 'appium-mobile-hideKeyboard' }));
    return;
  }
  if (atom === 'keyevent') {
    const key = optionValue(rest, '--key');
    if (!key) throw new Error('keyevent 需要 --key');
    await appium.withSession(target, async ({ sessionId }) => {
      if (key === 'home') {
        await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: pressButton', args: [{ name: 'home' }] });
      } else if (key === 'back') {
        await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/back`, {});
      } else {
        throw new Error(`unsupported iOS keyevent: ${key}`);
      }
    }, sessionOptions);
    writeJson(actionResult(key));
    return;
  }
  throw new Error(`unsupported ios atom: ${atom}`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'probe') return runProbe(argv);
  if (command === 'prepare') return runPrepare(argv);
  if (command === 'runtime') return runRuntime(argv);
  if (command === 'observe') return runObserve(argv);
  if (command === 'atom') return runAtom(argv[0], argv.slice(1));
  throw new Error(`unknown ios command: ${command || ''}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(error.exitCode || 1);
  });
}

module.exports = {
  appiumElementId,
  findEditableElement,
  inputEffectFor,
  inputTextWithFallback,
  normalizedInputValue,
  runRuntime,
};
