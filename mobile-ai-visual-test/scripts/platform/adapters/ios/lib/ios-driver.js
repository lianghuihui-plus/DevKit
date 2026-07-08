#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { actionResult, atomResult, dependency, localIso } = require('./output');
const appium = require('./appium-client');
const {
  buildTarget,
  commandExists,
  listBootedSimulators,
  parseArgs,
  run,
} = require('./device-target');

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

async function runProbe(argv) {
  const parsed = parseArgs(argv);
  const target = buildTarget(parsed);
  const booted = fakeEnabled()
    ? [{ name: 'Fake iPhone', udid: target.device || 'FAKE-IOS-SIMULATOR', state: 'Booted', deviceType: 'simulator' }]
    : listBootedSimulators();
  if (!target.device && booted.length === 1) target.device = booted[0].udid;
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
      wda = true;
    } catch {
      appiumServer = false;
      wda = false;
    }
  }

  const hasTarget = !!target.device && (target.deviceType === 'simulator' ? simctl : true);
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
  }
  if (target.deviceType === 'realDevice') {
    if (!target.xcodeOrgId || !target.xcodeSigningId || !target.updatedWDABundleId) {
      addDiagnostic('iosRealDeviceSigningIncomplete', 'WARN', 'iOS 真机 WDA 签名参数不完整', '正式真机执行前请通过 update-env.js 固化 Team ID、Signing ID 和 WDA bundle id；详见 references/installation.md#ios-真机', 'scripts/update-env.js <case-dir> --platform ios --device-type realDevice ...');
    }
    if (!logsImplemented) {
      addDiagnostic('iosRealDeviceLogsUnavailable', 'WARN', 'iOS 真机日志暂不作为可用能力', '这是当前适配限制，不影响截图、控件树和动作能力', 'scripts/probe-env.sh --platform ios --device <udid> --device-type realDevice');
    }
  }
  if (appiumCli && !appiumServer) {
    addDiagnostic('iosAppiumServerNotReady', 'WARN', 'Appium server 当前不可连接', 'prepare-env 会尝试启动 Appium server；也可以手动执行 appium --address 127.0.0.1 --port 4723', 'curl http://127.0.0.1:4723/status');
  }
  if (appiumServer && !wda) {
    addDiagnostic('iosWdaNotReady', 'WARN', 'WDA 当前不可确认', 'prepare-env 会创建 Appium session 验证 WDA；真机首次运行可能需要信任开发者证书', 'scripts/prepare-env.sh --case-dir <case-dir> --platform ios');
  }
  writeJson({
    schemaVersion: 1,
    type: 'environmentProbe',
    platform: 'ios',
    device: target.device || null,
    targets: booted.map((item) => item.udid),
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
      actions: implemented ? ['launchApp', 'restartApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait'] : [],
      screenCap: implemented,
      dumpLayout: implemented,
      implemented,
    },
  });
}

function spawnAppium(target) {
  const url = new URL(target.appiumServer);
  const port = url.port || '4723';
  const address = url.hostname || '127.0.0.1';
  const child = childProcess.spawn('appium', ['--address', address, '--port', port], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

async function waitForAppium(target, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      await appium.status(target.appiumServer, 2000);
      return { ok: true };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return { ok: false, error: lastError?.message || 'Appium server is not available' };
}

async function runPrepare(argv) {
  const parsed = parseArgs(argv);
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

  let appiumPid = null;
  let serverReady = false;
  if (fakeEnabled()) {
    serverReady = true;
  } else if (appiumAvailable) {
    const existing = await waitForAppium(target, 2000);
    if (existing.ok) {
      serverReady = true;
    } else {
      try {
        appiumPid = spawnAppium(target);
        serverReady = (await waitForAppium(target, 20000)).ok;
      } catch {
        serverReady = false;
      }
    }
  }
  deps.push(dependency('appiumServer', serverReady, { name: 'Appium Server', server: target.appiumServer, pid: appiumPid || undefined }));

  let wdaOk = false;
  let wdaError = '';
  if (fakeEnabled()) {
    wdaOk = true;
  } else if (serverReady && target.device && target.appId) {
    try {
      await appium.withSession(target, async () => {}, { timeoutMs: 180000 });
      wdaOk = true;
    } catch (error) {
      wdaError = error.message;
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

async function runObserve(argv) {
  const parsed = parseArgs(argv);
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

  if (fakeEnabled()) {
    fs.writeFileSync(screenshotPath, 'fake-ios-png');
    fs.writeFileSync(sourcePath, `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT><XCUIElementTypeApplication bundleId="${target.appId || 'com.example.demo'}" name="Demo" x="0" y="0" width="393" height="852"/></AppiumAUT>`);
    fs.writeFileSync(logPath, 'fake ios log\n');
    foreground = { bundleId: target.appId || 'com.example.demo', pid: 1234, name: 'Demo' };
    screen = '393x852';
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
        const sizeMatch = String(source.value || '').match(/<XCUIElementTypeApplication[^>]*width="([^"]+)"[^>]*height="([^"]+)"/);
        if (sizeMatch) screen = `${sizeMatch[1]}x${sizeMatch[2]}`;
      } catch (error) {
        errors.push(`[layout] ${error.message}`);
      }
      try {
        const active = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: activeAppInfo', args: [] });
        if (active.value) foreground = active.value;
      } catch (error) {
        errors.push(`[foreground] ${error.message}`);
      }
    });
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

async function getElementAttribute(target, sessionId, elementId, name) {
  try {
    const response = await appium.request(target.appiumServer, 'GET', `/session/${sessionId}/element/${elementId}/attribute/${name}`);
    return response.value;
  } catch {
    return null;
  }
}

async function findEditableElement(target, sessionId) {
  const candidates = [];
  for (const cls of ['XCUIElementTypeTextField', 'XCUIElementTypeSearchField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView']) {
    const response = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/elements`, { using: 'class name', value: cls });
    const elements = response.value || [];
    for (const element of elements) {
      const elementId = element['element-6066-11e4-a52e-4f735466cecf'] || element.ELEMENT;
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
  const focused = candidates.filter((item) => truthyAttribute(item.focused) && !falseyAttribute(item.enabled));
  if (focused.length === 1) return { elementId: focused[0].elementId, selection: 'focused' };
  const visible = candidates.filter((item) => !falseyAttribute(item.visible) && !falseyAttribute(item.enabled));
  if (visible.length === 1) return { elementId: visible[0].elementId, selection: 'single-visible-editable' };
  if (candidates.length === 1) return { elementId: candidates[0].elementId, selection: 'single-editable' };
  throw new Error(`Multiple editable XCUI elements found (${candidates.length}). Tap/focus the target input before inputText.`);
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

async function runAtom(atom, argv) {
  const parsed = parseArgs(argv);
  const target = buildTarget(parsed);
  const rest = parsed.rest;
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
    writeJson(actionResult(atom === 'launch-app' ? 'launchApp' : atom === 'restart-app' ? 'restartApp' : atom === 'long-press' ? 'longPress' : atom === 'input-text' ? 'inputText' : atom === 'keyevent' ? optionValue(rest, '--key', 'keyevent') : atom, {
      inputMethod: atom === 'input-text' ? 'wda-set-value' : undefined,
      restart: atom === 'restart-app' ? true : undefined,
      coldStartVerified: atom === 'restart-app' ? true : undefined,
      verification: atom === 'restart-app' ? 'fake-appium-app-state' : undefined,
      stateAfterTerminate: atom === 'restart-app' ? 1 : undefined,
      stateAfterActivate: atom === 'restart-app' ? 4 : undefined,
      stopMethod: atom === 'restart-app' ? 'appium-terminate-app' : undefined,
      launchMethod: atom === 'restart-app' ? 'appium-terminate-activate' : undefined,
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
    });
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
    });
    writeJson(atomResult('dump-tree', { path: path.resolve(out) }));
    return;
  }
  if (atom === 'foreground') {
    await appium.withSession(target, async ({ sessionId }) => {
      const active = await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/execute/sync`, { script: 'mobile: activeAppInfo', args: [] });
      writeJson(atomResult('foreground', { foreground: active.value || null }));
    });
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
    });
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
        verification: 'appium-app-state',
        stateAfterTerminate: stopped.state,
        stateAfterActivate: foreground.state,
        stopMethod: 'appium-terminate-app',
        launchMethod: 'appium-terminate-activate',
      }));
    });
    return;
  }
  if (atom === 'tap') {
    const x = optionValue(rest, '--x');
    const y = optionValue(rest, '--y');
    if (!x || !y) throw new Error('tap 需要 --x 和 --y');
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerAction(x, y));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    });
    writeJson(actionResult('tap'));
    return;
  }
  if (atom === 'long-press') {
    const x = optionValue(rest, '--x');
    const y = optionValue(rest, '--y');
    const durationMs = Number(optionValue(rest, '--duration-ms', '800'));
    if (!x || !y) throw new Error('longPress 需要 --x 和 --y');
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, pointerAction(x, y, durationMs));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    });
    writeJson(actionResult('longPress', { durationMs }));
    return;
  }
  if (atom === 'swipe') {
    const fromX = optionValue(rest, '--from-x');
    const fromY = optionValue(rest, '--from-y');
    const toX = optionValue(rest, '--to-x');
    const toY = optionValue(rest, '--to-y');
    const durationMs = Number(optionValue(rest, '--duration-ms', '350'));
    if (!fromX || !fromY || !toX || !toY) throw new Error('swipe 需要 --from-x --from-y --to-x --to-y');
    await appium.withSession(target, async ({ sessionId }) => {
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/actions`, swipeAction(fromX, fromY, toX, toY, durationMs));
      await appium.request(target.appiumServer, 'DELETE', `/session/${sessionId}/actions`, {});
    });
    writeJson(actionResult('swipe'));
    return;
  }
  if (atom === 'input-text') {
    const text = optionValue(rest, '--text');
    if (!text) throw new Error('inputText 需要 --text');
    await appium.withSession(target, async ({ sessionId }) => {
      const editable = await findEditableElement(target, sessionId);
      const elementId = editable.elementId;
      await appium.request(target.appiumServer, 'POST', `/session/${sessionId}/element/${elementId}/value`, { text, value: Array.from(text) });
      writeJson(actionResult('inputText', { inputMethod: 'wda-set-value', inputTarget: editable.selection }));
    });
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
    });
    writeJson(actionResult(key));
    return;
  }
  throw new Error(`unsupported ios atom: ${atom}`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'probe') return runProbe(argv);
  if (command === 'prepare') return runPrepare(argv);
  if (command === 'observe') return runObserve(argv);
  if (command === 'atom') return runAtom(argv[0], argv.slice(1));
  throw new Error(`unknown ios command: ${command || ''}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
