'use strict';

const path = require('node:path');

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const CLASS = /^\.?[A-Za-z_$][A-Za-z0-9_.$]*$/;
const DEVICE = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]*$/;
const HELPERS = new Set(['com.artemis.helper', 'mavt.android.ime']);
const diagnostic = (id, message) => ({ id, severity: 'ERROR', message });
const action = (id, message) => ({ id, message });
function failure(id, message) {
  return { status: 'NEED_USER_ACTION', actions: [action(id, message)], diagnostics: [diagnostic(id, message)] };
}
function assessProbe(probe, binding) {
  const diagnostics = Array.isArray(probe?.diagnostics) ? probe.diagnostics : [];
  const blocked = diagnostics.some((item) => item?.level === 'ERROR' || item?.severity === 'ERROR');
  if (!blocked && (probe?.ready === true || probe?.confirmationReady === true)) return null;
  const result = failure('ANDROID_DEVICE_NOT_READY', '请确认 Android 设备已连接、解锁并允许调试，完成环境检查后重试。');
  return { ...result, diagnostics: diagnostics.length ? diagnostics : result.diagnostics };
}
function component(binding) {
  if (!binding.entry) return null;
  const parts = binding.entry.split('/');
  if (parts.length === 2) return parts[0] === binding.appId && CLASS.test(parts[1]) ? binding.entry : false;
  if (parts.length !== 1 || !CLASS.test(binding.entry)) return false;
  return `${binding.appId}/${binding.entry.includes('.') ? binding.entry : `.${binding.entry}`}`;
}
function invalid(binding, requireApp = true) {
  if (!binding || !DEVICE.test(binding.deviceId || '')) return '请选择有效的 Android 设备。';
  if (requireApp && !PACKAGE.test(binding.appId || '')) return '请提供有效的 Android 应用 ID。';
  if (binding.entry && component(binding) === false) return 'Android 启动入口格式无效或属于其他应用。';
  if (binding.androidUiBackend && !['auto', 'helper', 'uiautomator'].includes(binding.androidUiBackend)) return 'Android 控件后端配置无效。';
  return null;
}
const getRun = (options) => options.run || require('../../environment/command').run;
const detail = (result) => String(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 1000);

function discoverApps({ binding }, options = {}) {
  const error = invalid(binding, false);
  if (error) return { apps: [], coverage: 'limited', ...failure('ANDROID_DEVICE_INVALID', error) };
  const result = getRun(options)('adb', ['-s', binding.deviceId, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 30000 });
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!result.ok || lines.some((line) => !/^package:[A-Za-z][A-Za-z0-9_.]*$/.test(line))) {
    return { apps: [], coverage: 'limited', ...failure('ANDROID_APP_ENUMERATION_FAILED', `无法枚举 Android 用户应用，请检查设备连接后重试，或提供精确应用 ID。${detail(result)}`) };
  }
  return {
    apps: [...new Set(lines.map((line) => line.slice(8)))].map((id) => ({ id, name: id, ...(HELPERS.has(id) ? { helper: true } : {}) })),
    coverage: 'user',
    diagnostics: [{ id: 'ANDROID_APP_NAMES_UNAVAILABLE', severity: 'INFO', message: '仅枚举用户安装的应用；当前列表以应用 ID 显示名称。' }],
  };
}

const qualified = (binding, entry) => entry.startsWith('.') ? binding.appId + entry : entry;
function entriesFor(binding, stdout) {
  const entries = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const [pkg, entry, extra] = line.split('/');
    return pkg === binding.appId && entry && !extra && CLASS.test(entry);
  });
  const unique = new Map();
  for (const entry of entries) {
    const key = qualified(binding, entry.split('/')[1]);
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function resolve({ binding, optionId }, options = {}) {
  const error = invalid(binding);
  if (error) return failure('ANDROID_BINDING_INVALID', error);
  if (optionId != null && (typeof optionId !== 'string' || !optionId.startsWith('activity:')
    || !optionId.slice(9).includes('/') || !component({ ...binding, entry: optionId.slice(9) }))) {
    return failure('ANDROID_OPTION_INVALID', '所选启动入口无效，请重新选择应用启动页面。');
  }
  const query = (method, entry) => {
    const args = ['-s', binding.deviceId, 'shell', 'cmd', 'package', method, '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', binding.appId];
    if (entry) args.push('-n', entry);
    return getRun(options)('adb', args, { timeout: 30000 });
  };
  const queryFailure = (result) => !result.ok || /^\s*(?:error[:\s]|exception[:\s]|failure[:\s]|securityexception[:\s])/im.test(result.stdout || '')
    ? failure('ANDROID_ENTRY_QUERY_FAILED', `无法验证 Android 应用启动入口，请检查设备与应用安装状态后重试。${detail(result)}`) : null;
  let manual = component(binding);
  let result = query(optionId != null ? 'query-activities' : 'resolve-activity', optionId != null ? null : manual);
  let failed = queryFailure(result);
  if (failed) return failed;
  let unique = entriesFor(binding, result.stdout);
  if (optionId != null) {
    const selected = unique.find(entry => `activity:${entry}` === optionId);
    if (!selected) return failure('ANDROID_OPTION_STALE', '所选启动页面已失效，请重新选择应用启动页面。');
    manual = selected;
    result = query('resolve-activity', selected);
    failed = queryFailure(result);
    if (failed) return failed;
    unique = entriesFor(binding, result.stdout);
  } else if (!manual && (unique.length > 1 || /^\s*android\/(?:com\.android\.internal\.app\.|\.)(?:ResolverActivity)\s*$/m.test(result.stdout || ''))) {
    result = query('query-activities');
    failed = queryFailure(result);
    if (failed) return failed;
    unique = entriesFor(binding, result.stdout);
    if (unique.length > 1) return { status: 'NEED_SELECTION', selectionKind: 'entry',
      candidates: unique.map(entry => ({ id: `activity:${entry}`, label: entry.split('/')[1],
        binding: { ...binding, entry, androidUiBackend: binding.androidUiBackend || 'auto' } })), diagnostics: [] };
  }
  if (unique.length !== 1) return failure('ANDROID_LAUNCHER_UNVERIFIED', '未能验证该应用的唯一启动入口；请确认应用已安装且具有可启动页面。');
  if (manual && qualified(binding, manual.split('/')[1]) !== qualified(binding, unique[0].split('/')[1])) return failure('ANDROID_ENTRY_STALE', '已配置的 Android 启动入口已失效，请重新选择应用。');
  return { status: 'READY', binding: { ...binding, entry: unique[0], androidUiBackend: binding.androidUiBackend || 'auto' }, diagnostics: [] };
}

function prepareFailure(message) {
  return { schemaVersion: 1, type: 'environmentPrepare', platform: 'android', time: new Date().toISOString(), ok: false, dependencies: [], diagnostics: [diagnostic('ANDROID_PREPARE_FAILED', message)] };
}
function prepare({ binding }, options = {}) {
  const error = invalid(binding);
  if (error || !binding.entry) return prepareFailure(error || '请先验证 Android 启动入口。');
  const args = [path.join(__dirname, 'prepare-env.sh'), '--device', binding.deviceId, '--app', binding.appId, '--entry', binding.entry, '--android-ui-backend', binding.androidUiBackend || 'auto'];
  const result = getRun(options)('bash', args, { timeout: 180000 });
  if (!result.ok) return prepareFailure(`Android 环境准备失败。${detail(result)}`);
  let event;
  try { event = JSON.parse(result.stdout); } catch { return prepareFailure('Android 环境准备未返回有效结果。'); }
  if (event.type !== 'environmentPrepare' || event.platform !== 'android' || typeof event.ok !== 'boolean' || !Array.isArray(event.dependencies)) return prepareFailure('Android 环境准备结果格式无效。');
  if (event.dependencies.some((item) => !item || (item.required !== false && item.ok !== true))) return { ...event, ok: false };
  return event;
}

function resetBinding(binding, failure) {
  if (failure && !failure.diagnostics?.some(item => ['ANDROID_ENTRY_STALE', 'ANDROID_LAUNCHER_UNVERIFIED'].includes(item.id))) return { ...binding };
  const { entry, ...target } = binding;
  return target;
}

module.exports = { discoverApps, resolve, prepare, assessProbe, resetBinding, canValidateAppWithoutInventory: true };
