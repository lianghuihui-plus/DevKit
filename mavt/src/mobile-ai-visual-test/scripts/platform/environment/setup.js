'use strict';

const STATES = new Set(['READY', 'NEED_SELECTION', 'NEED_USER_ACTION', 'FAILED']);
const ADAPTERS = Object.freeze({
  android: () => require('../adapters/android/environment'),
  harmony: () => require('../adapters/harmony/environment'),
  ios: () => require('../adapters/ios/environment'),
});

function adapterFor(platform, options = {}) {
  if (!ADAPTERS[platform]) throw new Error('不支持的平台');
  return options.adapter || ADAPTERS[platform]();
}

function failed(error) {
  return { status: 'FAILED', diagnostics: [{ code: 'ENVIRONMENT_SETUP_FAILED', message: String(error?.message || error).slice(0, 2000) }] };
}

function visibleApps(discovery, explicitId) {
  const ids = new Set();
  return discovery.apps.filter(app => {
    if (!app || typeof app.id !== 'string' || !app.id || ids.has(app.id)) return false;
    ids.add(app.id);
    return app.id === explicitId || (!app.system && !app.helper);
  }).map(app => ({ ...app, name: app.name || app.id }));
}

function resolveEnvironment(input, options = {}) {
  try {
    const binding = { ...input.binding };
    const adapter = adapterFor(binding.platform, options);
    if (input.probe) {
      const readiness = adapter.assessProbe ? adapter.assessProbe(input.probe, binding)
        : input.probe.ready === true || input.probe.confirmationReady === true ? null
          : { status: 'NEED_USER_ACTION', actions: [{ id: 'RESTORE_DEVICE_ENVIRONMENT', message: '请检查设备连接和开发工具，完成后重试。' }], diagnostics: input.probe.diagnostics || [] };
      if (readiness) return readiness;
    }
    const discovery = adapter.discoverApps({ binding }, options);
    if (!discovery || !Array.isArray(discovery.apps) || !['user', 'all', 'limited'].includes(discovery.coverage)) {
      throw new Error('应用发现返回了无效结果');
    }
    if (discovery.diagnostics?.some(item => (item.level || item.severity) === 'ERROR')
      && adapter.canValidateAppWithoutInventory !== true) {
      return { status: discovery.actions?.length ? 'NEED_USER_ACTION' : 'FAILED',
        ...(discovery.actions?.length ? { actions: discovery.actions } : {}), diagnostics: discovery.diagnostics };
    }
    const apps = visibleApps(discovery, binding.appId);
    let matches = apps;
    if (binding.appId) matches = apps.filter(app => app.id === binding.appId);
    else if (input.appName) {
      const name = input.appName.trim().toLocaleLowerCase();
      const exact = apps.filter(app => app.name.toLocaleLowerCase() === name || app.id.toLowerCase() === name);
      matches = exact.length ? exact : apps.filter(app => app.name.toLocaleLowerCase().includes(name) || app.id.toLowerCase().includes(name));
    }
    if (binding.appId && !matches.length && adapter.canValidateAppWithoutInventory !== true) {
      return { status: 'NEED_USER_ACTION', actions: [{ id: 'VERIFY_TARGET_APP', message: `未能确认目标应用 ${binding.appId}；请检查所选设备的应用安装情况，完成后重试。` }], diagnostics: discovery.diagnostics || [] };
    }
    if (!binding.appId && (!input.appName || matches.length !== 1)) {
      return {
        status: 'NEED_SELECTION', selectionKind: 'APP', coverage: discovery.coverage,
        allowTargetInput: discovery.coverage === 'limited' || matches.length === 0,
        candidates: matches.map(app => ({ id: app.id, label: app.name })),
        ...(discovery.actions?.length ? { actions: discovery.actions } : {}),
        diagnostics: discovery.diagnostics || [],
      };
    }
    const app = matches[0] || { id: binding.appId, name: binding.appId };
    binding.appId = app.id;
    const resolved = adapter.resolve({ binding, probe: input.probe, previousBinding: input.previousBinding, optionId: input.optionId }, options);
    if (!resolved || !STATES.has(resolved.status)) throw new Error('平台适配器返回了无效状态');
    const candidates = resolved.status === 'READY' ? [resolved] : resolved.status === 'NEED_SELECTION' ? resolved.candidates : [];
    if (!Array.isArray(candidates)) throw new Error('平台适配器未提供可选配置');
    for (const candidate of candidates) {
      if (!candidate.binding || ['platform', 'deviceId', 'appId'].some(key => candidate.binding[key] !== binding[key])) {
        throw new Error('平台适配器改变了已选择的设备或应用');
      }
    }
    return { ...resolved, app: { id: app.id, name: app.name }, coverage: discovery.coverage,
      diagnostics: [...(discovery.diagnostics || []), ...(resolved.diagnostics || [])] };
  } catch (error) { return failed(error); }
}

function prepareEnvironment(input, options = {}) {
  try {
    return adapterFor(input.binding.platform, options).prepare(input, options);
  } catch (error) {
    return { schemaVersion: 1, type: 'environmentPrepare', platform: input.binding.platform, ok: false,
      diagnostics: failed(error).diagnostics };
  }
}

function resetBindingForRetry(binding, options = {}, failure) {
  const adapter = adapterFor(binding.platform, options);
  return adapter.resetBinding ? adapter.resetBinding(binding, failure) : { ...binding };
}

module.exports = { adapterFor, prepareEnvironment, resolveEnvironment, resetBindingForRetry };
