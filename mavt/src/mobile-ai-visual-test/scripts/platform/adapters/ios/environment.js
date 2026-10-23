'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { parseXmlPlist } = require('./lib/environment-plist');
const { queryRealDeviceApps } = require('./lib/real-device-apps');

function runner(options) {
  return options.run || require('../../environment/command').run;
}

function fakeEnabled(options) {
  return (options.env || process.env).MAVT_IOS_FAKE === '1';
}

function diagnostic(id, level, message) {
  return { id, level, message };
}

function commandMessage(result, fallback) {
  return String(result.stderr || fallback).trim().slice(0, 1000);
}

function validTarget(binding) {
  return typeof binding?.deviceId === 'string' && binding.deviceId.trim()
    && ['simulator', 'realDevice'].includes(binding.deviceType);
}

function discoveryFailure(message) {
  return {
    apps: [], coverage: 'limited',
    diagnostics: [diagnostic('iosAppsUnavailable', 'ERROR', message)],
    actions: [{ id: 'iosUnlockDevice', message: '解锁目标设备，确认已信任这台 Mac；iOS 16 及以上还需启用 Developer Mode。确认 Appium XCUITest 驱动安装完整，模拟器需保持启动，然后重试。' }],
  };
}

function assessProbe(probe, binding) {
  const diagnostics = Array.isArray(probe?.diagnostics) ? probe.diagnostics : [];
  const signingDiagnostic = (item) => item?.id === 'iosRealDeviceSigningIncomplete'
    && binding?.deviceType === 'realDevice';
  const errors = diagnostics.filter((item) => item?.level === 'ERROR' && !signingDiagnostic(item));
  const signingCanResolve = diagnostics.some(signingDiagnostic);
  if (!errors.length && (probe?.ready === true || signingCanResolve)) return null;
  const ids = new Set(errors.map((item) => item.id));
  const actions = [];
  if (ids.has('iosXcodeMissing') || ids.has('iosSimctlMissing')) actions.push({
    id: 'iosSetupXcode', message: '安装并打开完整的 Xcode，在 Xcode → Settings → Locations 选择 Command Line Tools，并完成首次启动设置后重试。',
  });
  if (ids.has('iosAppiumMissing')) actions.push({ id: 'iosInstallAppium', message: '安装 Appium CLI（npm install -g appium），确认 appium -v 可用后重试。' });
  if (ids.has('iosXcuitestDriverMissing')) actions.push({ id: 'iosInstallXcuitest', message: '执行 appium driver install xcuitest 安装 iOS 自动化驱动，再重新检查环境。' });
  if ([...ids].some((id) => /^iosDevice/.test(id))) actions.push({ id: 'iosCheckTargetDevice', message: '启动并选择目标 iOS 模拟器，或连接、解锁并信任目标 iPhone/iPad；iOS 16 及以上需启用 Developer Mode，再重新选择设备。' });
  if (!actions.length) actions.push({ id: 'iosCheckXcodeEnvironment', message: '在 Xcode 中确认目标设备可用并完成首次启动设置，确认 Appium 及 XCUITest 驱动可用后重新检查环境。' });
  return { status: 'NEED_USER_ACTION', actions, diagnostics: errors.length ? errors : [diagnostic('iosProbeNotReady', 'ERROR', 'iOS 环境探测尚未就绪，无法进入应用发现。')] };
}

function discoverApps({ binding }, options = {}) {
  if (!validTarget(binding)) return discoveryFailure('iOS 设备尚未确认，无法查询已安装应用。');
  if (fakeEnabled(options)) return {
    apps: [{ id: binding.appId || (options.env || process.env).MAVT_IOS_APP || 'com.example.ios', name: 'Fake App' }],
    coverage: 'limited', diagnostics: [],
  };
  const run = runner(options);
  let data;
  let coverage = 'all';
  if (binding.deviceType === 'simulator') {
    const listed = run('xcrun', ['simctl', 'listapps', binding.deviceId], { timeout: 20000 });
    if (!listed.ok) return discoveryFailure(commandMessage(listed, 'simctl 查询应用失败。'));
    try { data = JSON.parse(listed.stdout); } catch {
      const converted = run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: listed.stdout, timeout: 10000 });
      if (!converted.ok) return discoveryFailure(commandMessage(converted, '无法解析 simctl 应用列表。'));
      try { data = JSON.parse(converted.stdout); } catch { return discoveryFailure('simctl 返回了无法识别的应用列表。'); }
    }
    if (!data || Array.isArray(data) || typeof data !== 'object') return discoveryFailure('simctl 应用列表结构无法识别。');
  } else {
    const listed = queryRealDeviceApps({ device: binding.deviceId }, { ...options, run });
    if (!listed.ok) return discoveryFailure(listed.detail);
    data = listed.apps;
    coverage = listed.coverage;
  }
  const records = Array.isArray(data) ? data.map((app) => [app?.bundleIdentifier, app]) : Object.entries(data);
  const apps = [];
  let malformed = 0;
  const seen = new Set();
  for (const [key, app] of records) {
    const id = app?.CFBundleIdentifier || app?.bundleIdentifier || key;
    if (!app || typeof app !== 'object' || Array.isArray(app) || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$/.test(id)) {
      malformed += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const name = [app.CFBundleDisplayName, app.CFBundleName, app.name].find((value) => typeof value === 'string' && value.trim()) || id;
    const applicationType = app.ApplicationType || app.applicationType || app.appType;
    const appUrl = typeof app.url === 'string' ? app.url : '';
    const system = typeof app.isSystem === 'boolean' ? app.isSystem
      : typeof app.isSystemApp === 'boolean' ? app.isSystemApp
        : typeof app.builtIn === 'boolean' ? app.builtIn
          : applicationType ? String(applicationType).toLowerCase() === 'system'
            : /^(?:file:\/\/)?\/(?:System\/)?Applications\//.test(appUrl) ? true : undefined;
    const wdaHelper = /(?:^|\.)WebDriverAgentRunner(?:\.xctrunner)?$/.test(id)
      || (binding.updatedWDABundleId && [binding.updatedWDABundleId, `${binding.updatedWDABundleId}.xctrunner`].includes(id));
    apps.push({ id, name, ...(system === undefined ? {} : { system }),
      ...((app.CFBundlePackageType && app.CFBundlePackageType !== 'APPL') || app.appClip === true || app.isAppClip === true || id.endsWith('.xctrunner') || wdaHelper ? { helper: true } : {}) });
  }
  apps.sort((a, b) => a.id.localeCompare(b.id));
  return {
    apps, coverage: malformed ? 'limited' : coverage,
    diagnostics: malformed || coverage === 'limited' ? [diagnostic('iosAppsPartial', 'WARN', '部分应用记录无法识别，应用枚举范围不完整。')] : [],
  };
}

function parseIdentities(output) {
  const identities = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([A-Fa-f\d]{40})\s+"([^"]+)"\s*$/.exec(line);
    if (match && /^(Apple Development|iPhone Developer):/.test(match[2])) {
      identities.push({ hash: match[1].toUpperCase(), name: match[2] });
    }
  }
  return identities;
}

function configuredProfilePaths(options, diagnostics) {
  if (Object.hasOwn(options, 'profilePaths')) return options.profilePaths;
  const directories = options.profileDirectories || [
    path.join(os.homedir(), 'Library/MobileDevice/Provisioning Profiles'),
    path.join(os.homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
  ];
  const paths = [];
  for (const directory of directories) {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && /\.mobileprovision$/.test(entry.name)) paths.push(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') diagnostics.push(diagnostic('iosProfilesPartial', 'WARN', `无法读取 Xcode provisioning 目录：${error.code || error.message}`));
    }
  }
  return paths.sort();
}

function readProfiles(options, run, diagnostics) {
  if (Object.hasOwn(options, 'profiles')) return Array.isArray(options.profiles) ? options.profiles : [];
  const profiles = [];
  for (const file of configuredProfilePaths(options, diagnostics)) {
    const decoded = run('security', ['cms', '-D', '-i', file], { timeout: 10000 });
    if (!decoded.ok) {
      diagnostics.push(diagnostic('iosProfileUnreadable', 'WARN', `Xcode provisioning profile 无法解码：${path.basename(file)}`));
      continue;
    }
    try { profiles.push(parseXmlPlist(decoded.stdout)); } catch {
      diagnostics.push(diagnostic('iosProfileMalformed', 'WARN', `Xcode provisioning profile 格式无法识别：${path.basename(file)}`));
    }
  }
  return profiles;
}

function certificateHash(value) {
  const base64 = typeof value === 'string' ? value.replace(/\s/g, '') : '';
  if (!base64 || !/^[A-Za-z\d+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return '';
  return createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex').toUpperCase();
}

function signingIdMatches(requested, identity) {
  return !requested || requested === identity.name || requested.toUpperCase() === identity.hash
    || (['Apple Development', 'iPhone Developer'].includes(requested) && identity.name.startsWith(`${requested}:`));
}

function matchingBundle(profile, binding, team) {
  const applicationId = profile.Entitlements?.['application-identifier'];
  // Older developer accounts may use an App ID Prefix independent of Team ID.
  // Team membership is checked separately by usableConfiguration.
  const prefixes = profile.ApplicationIdentifierPrefix === undefined ? [team] : profile.ApplicationIdentifierPrefix;
  if (typeof applicationId !== 'string' || !Array.isArray(prefixes)) return null;
  const appPrefix = prefixes.find(value => typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value) && applicationId.startsWith(`${value}.`));
  if (!appPrefix) return null;
  const pattern = applicationId.slice(appPrefix.length + 1);
  if (!/^[A-Za-z0-9.*-]+$/.test(pattern) || (pattern.includes('*') && !(pattern === '*' || /^[A-Za-z0-9.-]+\.\*$/.test(pattern)))) return null;
  const wildcard = pattern.endsWith('*');
  const prefix = wildcard ? pattern.slice(0, -1) : pattern;
  // Appium/Xcode signs and installs <updatedWDABundleId>.xctrunner. An
  // explicit profile for the unsuffixed test bundle cannot sign that runner.
  const bundle = binding.updatedWDABundleId || (wildcard ? `${prefix || 'com.'}mavt.WebDriverAgentRunner`
    : pattern.endsWith('.xctrunner') ? pattern.slice(0, -'.xctrunner'.length) : '');
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle)) return null;
  const runnerBundle = `${bundle}.xctrunner`;
  if (wildcard ? !runnerBundle.startsWith(prefix) : runnerBundle !== pattern) return null;
  return bundle;
}

function usableConfiguration(profile, identity, binding, now) {
  const team = Array.isArray(profile.TeamIdentifier) ? profile.TeamIdentifier[0] : '';
  if (typeof team !== 'string' || !team || (binding.xcodeOrgId && binding.xcodeOrgId !== team)) return null;
  const entitlements = profile.Entitlements || {};
  if (entitlements['com.apple.developer.team-identifier'] && entitlements['com.apple.developer.team-identifier'] !== team) return null;
  const expiry = Date.parse(profile.ExpirationDate);
  if (!Number.isFinite(expiry) || expiry <= now || entitlements['get-task-allow'] !== true) return null;
  if (Array.isArray(profile.Platform) && !profile.Platform.includes('iOS')) return null;
  if (!Array.isArray(profile.ProvisionedDevices) || !profile.ProvisionedDevices.some((device) => String(device).toLowerCase() === binding.deviceId.toLowerCase())) return null;
  if (!Array.isArray(profile.DeveloperCertificates) || !profile.DeveloperCertificates.some((cert) => certificateHash(cert) === identity.hash)) return null;
  if (!signingIdMatches(binding.xcodeSigningId, identity)) return null;
  const bundle = matchingBundle(profile, binding, team);
  if (!bundle) return null;
  return { team, expiry, profile, identity, bundle };
}

function signingAction(diagnostics) {
  return {
    status: 'NEED_USER_ACTION',
    actions: [{ id: 'iosConfigureXcodeSigning', message: '在 Xcode → Settings → Accounts 登录开发者账号并创建 Apple Development 证书；连接并信任目标 iPhone，在 Xcode 的 WebDriverAgentRunner Signing & Capabilities 选择你的团队、启用 Automatically manage signing，并完成一次设备构建以生成匹配该设备的开发 provisioning profile，然后重试。' }],
    diagnostics,
  };
}

function resolve({ binding, probe, previousBinding, optionId }, options = {}) {
  const target = { ...(previousBinding || {}), ...(binding || {}) };
  const selected = probe?.devices?.find(device => device.id === target.deviceId);
  if (selected?.platformVersion) target.platformVersion = selected.platformVersion;
  const env = options.env || process.env;
  if (!validTarget(target) || !target.appId) return {
    status: 'FAILED', diagnostics: [diagnostic('iosTargetMissing', 'ERROR', '请先确认 iOS 目标设备、设备类型和应用。')],
  };
  // Preserve the existing explicit external-WDA path. Freeze an environment
  // preference into binding so the batch cannot silently pick up a later URL.
  // No endpoint is discovered or adopted, and real-device signing is still
  // validated below through the same local certificate/profile checks.
  if (!target.webDriverAgentUrl && env.MAVT_IOS_WDA_URL) target.webDriverAgentUrl = env.MAVT_IOS_WDA_URL;
  if (fakeEnabled(options)) return { status: 'READY', binding: target };
  if (target.deviceType === 'simulator') {
    if (optionId) return { status: 'FAILED', diagnostics: [diagnostic('iosSigningOptionInvalid', 'ERROR', '模拟器没有需要选择的签名配置。')] };
    return { status: 'READY', binding: target };
  }
  for (const [key, envKey] of [
    ['xcodeOrgId', 'MAVT_IOS_XCODE_ORG_ID'],
    ['xcodeSigningId', 'MAVT_IOS_XCODE_SIGNING_ID'],
    ['updatedWDABundleId', 'MAVT_IOS_UPDATED_WDA_BUNDLE_ID'],
  ]) {
    if (!target[key] && env[envKey]) target[key] = env[envKey];
  }
  const run = runner(options);
  const diagnostics = [];
  // find-identity enumerates valid certificate/private-key pairs, rather than
  // trusting certificate names or profiles that lack the private signing key.
  const discovered = run('security', ['find-identity', '-v', '-p', 'codesigning'], { timeout: 10000 });
  if (!discovered.ok) return signingAction([diagnostic('iosSigningIdentitiesUnavailable', 'ERROR', commandMessage(discovered, '无法读取有效的开发签名身份。'))]);
  const identities = parseIdentities(discovered.stdout);
  if (!identities.length) return signingAction([diagnostic('iosSigningIdentityMissing', 'ERROR', '未发现可用于开发签名的有效证书和私钥。')]);
  const profiles = readProfiles(options, run, diagnostics);
  const now = new Date(options.now || Date.now()).getTime();
  if (!Number.isFinite(now)) return { status: 'FAILED', diagnostics: [diagnostic('iosSigningTimeInvalid', 'ERROR', '无法确定签名有效期检查时间。')] };
  const configurations = [];
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    for (const identity of identities) {
      const configuration = usableConfiguration(profile, identity, target, now);
      if (configuration) configurations.push(configuration);
    }
  }
  if (!configurations.length) return signingAction([...diagnostics, diagnostic('iosSigningProfileMissing', 'ERROR', '没有同时匹配开发证书、团队、目标设备、有效期及 WDA 应用标识的开发 provisioning profile。')]);
  // A team may have several equivalent renewed profiles/certificates. Prefer
  // the newest valid profile; ask the user only to choose between teams.
  configurations.sort((a, b) => b.expiry - a.expiry || String(a.profile.UUID || '').localeCompare(String(b.profile.UUID || '')) || a.identity.hash.localeCompare(b.identity.hash));
  const teams = new Map();
  for (const configuration of configurations) if (!teams.has(configuration.team)) teams.set(configuration.team, configuration);
  const candidates = [...teams.values()].sort((a, b) => a.team.localeCompare(b.team)).map((configuration) => ({
    id: `ios-signing-${createHash('sha256').update([configuration.team, configuration.identity.hash, configuration.bundle].join('\n')).digest('hex').slice(0, 24)}`,
    label: `${configuration.profile.TeamName || configuration.identity.name} · ${configuration.profile.Name || 'Development'}`,
    // Match the concrete certificate above, but automatic signing requires the
    // certificate class rather than its common name or SHA-1 fingerprint.
    binding: { ...target, xcodeOrgId: configuration.team, xcodeSigningId: configuration.identity.name.split(':')[0], updatedWDABundleId: configuration.bundle },
  }));
  if (optionId) {
    const selected = candidates.find((candidate) => candidate.id === optionId);
    if (!selected) return { status: 'FAILED', diagnostics: [diagnostic('iosSigningOptionInvalid', 'ERROR', '所选签名配置已失效，请重新检查环境并选择。')] };
    return { status: 'READY', binding: selected.binding, diagnostics };
  }
  if (candidates.length === 1) return { status: 'READY', binding: candidates[0].binding, diagnostics };
  return { status: 'NEED_SELECTION', selectionKind: 'signing', candidates, diagnostics };
}

function prepare({ binding }, options = {}) {
  if (fakeEnabled(options)) return { schemaVersion: 1, type: 'environmentPrepare', platform: 'ios', time: new Date().toISOString(), ok: true, dependencies: [] };
  const run = runner(options);
  const dependencies = [];
  const xcode = run('xcodebuild', ['-version'], { timeout: 10000 });
  dependencies.push({ id: 'xcode', name: 'Xcode', required: true, ok: xcode.ok && /^Xcode\s+\d/m.test(xcode.stdout), version: xcode.stdout.trim() });
  const tool = binding?.deviceType === 'realDevice' ? 'xcdevice' : 'simctl';
  const xcrun = run('xcrun', ['--find', tool], { timeout: 10000 });
  dependencies.push({ id: 'simctl', name: `xcrun ${tool}`, required: true, ok: xcrun.ok && !!xcrun.stdout.trim() });
  const appium = run('appium', ['-v'], { timeout: 10000 });
  dependencies.push({ id: 'appium', name: 'Appium', required: true, ok: appium.ok && /^\d+\.\d+\.\d+/.test(appium.stdout.trim()), version: appium.stdout.trim() });
  let driver = null;
  if (appium.ok) {
    const installed = run('appium', ['driver', 'list', '--installed', '--json'], { timeout: 20000 });
    if (installed.ok) {
      try { driver = JSON.parse(installed.stdout).xcuitest; } catch { /* Unknown output is not installation evidence. */ }
    }
  }
  dependencies.push({ id: 'xcuitestDriver', name: 'Appium XCUITest Driver', required: true, ok: driver?.installed === true, version: driver?.version || '' });
  const resolved = resolve({ binding }, options);
  const frozenSigningMatches = binding?.deviceType !== 'realDevice' || ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId']
    .every((key) => !!binding[key] && binding[key] === resolved.binding?.[key]);
  const signingChanged = resolved.status === 'READY' && !frozenSigningMatches;
  dependencies.push({ id: 'iosTarget', name: 'iOS target and signing', required: true, ok: resolved.status === 'READY' && frozenSigningMatches,
    diagnostics: [...(resolved.diagnostics || []), ...(signingChanged ? [diagnostic('iosSigningNotFrozen', 'ERROR', '签名配置尚未确认或与已冻结环境不一致，请重新检查并确认环境。')] : [])],
    ...(resolved.actions ? { actions: resolved.actions } : {}) });
  // Batch runtime acquisition owns the Appium server and WDA session lifecycle.
  // Environment preparation deliberately makes no server/session/bootstrap call.
  return { schemaVersion: 1, type: 'environmentPrepare', platform: 'ios', time: new Date().toISOString(), ok: dependencies.every((item) => item.ok), dependencies };
}

function resetBinding(binding, failure) {
  if (failure && !failure.diagnostics?.some(item => item.id === 'iosSigningProfileMissing')) return { ...binding };
  const { xcodeOrgId, xcodeSigningId, updatedWDABundleId, ...target } = binding;
  return target;
}

module.exports = { assessProbe, discoverApps, resolve, prepare, resetBinding };
