'use strict';

const ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const ABILITY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const DEVICE = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]*$/;
const diagnostic = (id, message) => ({ id, severity: 'ERROR', message });
function failure(id, message) {
  return { status: 'NEED_USER_ACTION', actions: [{ id, message }], diagnostics: [diagnostic(id, message)] };
}
function assessProbe(probe, binding) {
  const diagnostics = Array.isArray(probe?.diagnostics) ? probe.diagnostics : [];
  const blocked = diagnostics.some((item) => item?.level === 'ERROR' || item?.severity === 'ERROR');
  if (!blocked && (probe?.ready === true || probe?.confirmationReady === true)) return null;
  const result = failure('HARMONY_DEVICE_NOT_READY', '请确认 HarmonyOS 设备已连接、解锁并允许调试，完成环境检查后重试。');
  return { ...result, diagnostics: diagnostics.length ? diagnostics : result.diagnostics };
}
const getRun = (options) => options.run || require('../../environment/command').run;
const detail = (result) => String(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 1000);
function invalid(binding, requireApp = true) {
  if (!binding || !DEVICE.test(binding.deviceId || '')) return '请选择有效的 HarmonyOS 设备。';
  if (requireApp && !ID.test(binding.appId || '')) return '请提供有效的 HarmonyOS 应用 ID。';
  if (binding.entry && !ABILITY.test(binding.entry)) return 'HarmonyOS 启动入口格式无效。';
  return null;
}
function parseJson(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}
function records(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['bundleInfos', 'bundles']) if (Array.isArray(value[key])) return value[key];
  return [value];
}
function bundleId(value) { return value && (value.bundleName || value.name || value.applicationInfo?.bundleName || value.appInfo?.bundleName); }
const hasError = (text) => /^\s*(?:error[:\s]|exception[:\s]|failed[:\s]|failure[:\s])/im.test(text);

function discoverApps({ binding }, options = {}) {
  const error = invalid(binding, false);
  if (error) return { apps: [], coverage: 'limited', ...failure('HARMONY_DEVICE_INVALID', error) };
  const result = getRun(options)('hdc', ['-t', binding.deviceId, 'shell', 'bm', 'dump', '-a'], { timeout: 30000 });
  const text = String(result.stdout || '').trim();
  const parsed = parseJson(text);
  let apps = [];
  let recognized = false;
  if (parsed) {
    const entries = records(parsed);
    recognized = (Array.isArray(parsed) || Array.isArray(parsed.bundleInfos) || Array.isArray(parsed.bundles) || entries.length > 0) && entries.every((item) => ID.test(bundleId(item) || ''));
    apps = entries.filter((item) => ID.test(bundleId(item) || '')).map((item) => ({
      id: bundleId(item), name: item.applicationInfo?.label || item.appInfo?.label || item.label || bundleId(item),
      ...((item.isSystemApp ?? item.applicationInfo?.isSystemApp ?? item.appInfo?.isSystemApp) === true ? { system: true } : {}),
    }));
  } else if (text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const ids = lines.map((line) => line.replace(/^bundle\s*name\s*(?:[:=]\s*)?/i, '').replace(/^\[|\]$/g, ''));
    recognized = ids.every((id) => ID.test(id));
    if (recognized) apps = ids.map((id) => ({ id, name: id }));
  }
  if (!result.ok || hasError(text) || !recognized) return { apps: [], coverage: 'limited', ...failure('HARMONY_APP_ENUMERATION_UNAVAILABLE', `当前设备无法完整列出应用，请提供精确应用 ID 后验证，或检查 bm dump 支持情况。${detail(result)}`) };
  return { apps: [...new Map(apps.map((app) => [app.id, app])).values()], coverage: 'all', diagnostics: [{ id: 'HARMONY_APP_ENUMERATION_SCOPE', severity: 'INFO', message: '应用列表包含系统应用；未提供标签时显示应用 ID。' }] };
}

function launchable(ability) {
  if (!ABILITY.test(ability.name || ability.abilityName || '') || ability.visible === false || ability.exported === false || ability.enabled === false) return false;
  if (['service', 'data', 'extension'].includes(String(ability.type).toLowerCase())) return false;
  return Array.isArray(ability.skills) && ability.skills.some((skill) => {
    const actions = skill.actions || [];
    const entities = skill.entities || [];
    return Array.isArray(actions) && Array.isArray(entities) && actions.some((item) => ['ohos.want.action.home', 'action.system.home'].includes(item)) && entities.includes('entity.system.home');
  });
}
function entriesFor(info, binding) {
  const modules = info.hapModuleInfos || info.moduleInfos || info.modules || [];
  const entries = [];
  const add = (ability, module) => {
    if (!launchable(ability)) return;
    const name = ability.name || ability.abilityName;
    const moduleName = ability.moduleName || module.name || module.moduleName || '';
    entries.push({ id: `ability:${moduleName}:${name}`, label: `${ability.label || name}${moduleName ? ` (${moduleName} / ${name})` : ''}`, binding: { ...binding, entry: name } });
  };
  for (const module of modules) for (const ability of module.abilityInfos || module.abilities || []) add(ability, module);
  for (const ability of info.abilityInfos || info.abilities || []) add(ability, {});
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function resolve({ binding, optionId }, options = {}) {
  const error = invalid(binding);
  if (error) return failure('HARMONY_BINDING_INVALID', error);
  const result = getRun(options)('hdc', ['-t', binding.deviceId, 'shell', 'bm', 'dump', '-n', binding.appId], { timeout: 30000 });
  if (!result.ok || hasError(result.stdout || '')) return failure('HARMONY_ENTRY_QUERY_FAILED', `无法验证 HarmonyOS 应用，请检查设备连接与应用安装状态后重试。${detail(result)}`);
  const infos = records(parseJson(String(result.stdout || '')));
  const matches = infos.filter((info) => bundleId(info) === binding.appId);
  if (matches.length !== 1) return failure('HARMONY_APP_UNVERIFIED', '无法从应用元数据验证目标应用；请确认应用 ID 和安装状态。');
  const candidates = entriesFor(matches[0], binding);
  if (!candidates.length) return failure('HARMONY_LAUNCHER_UNVERIFIED', '应用元数据未包含可验证的桌面启动 Ability，请确认已安装可启动的应用。');
  // Existing action.sh passes only -a to aa start. Duplicate names across
  // modules cannot be represented safely by the current execution binding.
  if (new Set(candidates.map((candidate) => candidate.binding.entry)).size !== candidates.length) return failure('HARMONY_MODULE_SELECTION_UNSUPPORTED', '应用多个模块具有同名启动页面，当前执行入口无法指定模块，请提供具有唯一启动页面的应用。');
  if (optionId != null) {
    const selected = candidates.find((candidate) => candidate.id === optionId);
    if (!selected) return failure('HARMONY_OPTION_STALE', '所选启动页面已失效，请重新选择应用启动页面。');
    return { status: 'READY', binding: selected.binding, diagnostics: [] };
  }
  if (binding.entry) {
    const selected = candidates.find((candidate) => candidate.binding.entry === binding.entry);
    if (!selected) return failure('HARMONY_ENTRY_STALE', '已配置的 HarmonyOS 启动页面已失效，请重新选择应用。');
    return { status: 'READY', binding: selected.binding, diagnostics: [] };
  }
  if (candidates.length > 1) return { status: 'NEED_SELECTION', selectionKind: 'entry', candidates, diagnostics: [] };
  return { status: 'READY', binding: candidates[0].binding, diagnostics: [] };
}

function prepare({ binding }, options = {}) {
  const result = resolve({ binding }, options);
  return { schemaVersion: 1, type: 'environmentPrepare', platform: 'harmony', time: new Date().toISOString(), ok: result.status === 'READY', dependencies: [], diagnostics: result.diagnostics || [] };
}

function resetBinding(binding, failure) {
  if (failure && !failure.diagnostics?.some(item => item.id === 'HARMONY_ENTRY_STALE')) return { ...binding };
  const { entry, ...target } = binding;
  return target;
}

module.exports = { discoverApps, resolve, prepare, assessProbe, resetBinding, canValidateAppWithoutInventory: true };
