'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../lib/contract-utils');
const setup = require('../platform/environment/setup');

const identity = device => device?.id || device?.serial || device?.udid || device?.name;
const safeBinding = binding => Object.fromEntries(['platform', 'deviceId', 'appId'].filter(key => binding?.[key]).map(key => [key, binding[key]]));

function resolve(state, input, options = {}) {
  let result = (options.resolveEnvironment || setup.resolveEnvironment)({ ...input, probe: state.selectedProbe }, options.environmentOptions || {});
  const previous = state.environmentSetup;
  let prepared = null;
  if (result.status === 'READY') {
    if (previous?.prepared && canonicalJson(previous.binding) === canonicalJson(result.binding)) prepared = previous.prepared;
    else {
      let preparation;
      try {
        preparation = options.prepareEnvironment
          ? options.prepareEnvironment({ binding: { ...result.binding } })
          : setup.prepareEnvironment({ binding: { ...result.binding } }, options.environmentOptions || {});
      } catch (error) { preparation = { ok: false, diagnostics: [{ code: 'ENVIRONMENT_PREPARE_FAILED', message: String(error.message || error) }] }; }
      if (preparation?.schemaVersion === 1 && preparation.type === 'environmentPrepare'
        && preparation.platform === result.binding.platform && preparation.ok === true) {
        prepared = { platform: result.binding.platform, status: 'READY' };
      } else {
        const actions = preparation?.actions?.length ? preparation.actions
          : (preparation?.dependencies || []).flatMap(dependency => dependency.actions || []);
        result = { ...result, status: 'NEED_USER_ACTION',
          actions: actions.length ? actions : [{ id: 'COMPLETE_ENVIRONMENT_PREPARATION', message: '请连接并解锁所选设备，允许调试及自动化权限，完成后重试环境准备。' }],
          diagnostics: [...(result.diagnostics || []), ...(preparation?.diagnostics || []),
            ...(preparation?.dependencies || []).filter(dependency => dependency.ok !== true && dependency.required !== false)
              .flatMap(dependency => [{ code: dependency.failureCode || dependency.id || 'ENVIRONMENT_DEPENDENCY_FAILED',
                message: String(dependency.reason || dependency.error || `${dependency.name || dependency.id || '设备依赖'} 未准备完成`),
                ...(dependency.stage ? { stage: dependency.stage } : {}) }, ...(dependency.diagnostics || [])]),
            { code: 'ENVIRONMENT_PREPARE_FAILED', message: '设备环境自动准备未完成。' }],
          preparation: preparation || null,
        };
      }
    }
  }
  state.environmentSetup = {
    ...result, input: JSON.parse(JSON.stringify(input)),
    ...(prepared ? { prepared } : {}),
    ...(result.status === 'READY' ? { environmentRef: `environment-${crypto.randomBytes(16).toString('hex')}` } : {}),
  };
  state.phase = 'NEED_BINDING_CONFIRMATION';
  return result;
}

function probeBinding(state, binding, probe, input = state.environmentSetup?.input || { binding }) {
  state.selectedProbe = probe;
  const selected = probe?.devices?.find(device => String(identity(device)) === String(binding.deviceId));
  if (!selected || (probe.device && String(probe.device) !== String(binding.deviceId))) {
    state.environmentSetup = { status: 'NEED_USER_ACTION', input,
      actions: [{ id: 'CONNECT_SELECTED_DEVICE', message: '请连接并解锁已选择的设备，允许此电脑访问，然后重试。' }], diagnostics: probe?.diagnostics || [] };
    return false;
  }
  return true;
}

function refresh(state, options, probeEnvironment, retry = false) {
  const prior = state.environmentSetup;
  const input = { ...prior.input };
  if (retry) {
    state.environmentSetup = { ...prior, prepared: undefined };
    delete input.optionId;
  }
  const binding = input.binding;
  const probe = probeEnvironment(binding.platform, binding.deviceId);
  if (!probeBinding(state, binding, probe, input)) return false;
  let result = resolve(state, input, options);
  if (retry && input.previousBinding && result.status !== 'READY') {
    const reset = setup.resetBindingForRetry(input.binding, options.environmentOptions || {}, result);
    if (canonicalJson(reset) !== canonicalJson(input.binding)) {
      input.binding = reset;
      delete input.previousBinding;
      result = resolve(state, input, options);
    }
  }
  if (result.status !== 'READY' && input.optionId) {
    delete input.optionId;
    resolve(state, input, options);
    return false;
  }
  // Confirmation is valid only for the exact configuration the user saw.
  const unchanged = result.status === 'READY' && canonicalJson(result.binding) === canonicalJson(prior.binding);
  if (unchanged) state.environmentSetup.environmentRef = prior.environmentRef;
  return unchanged;
}

function response(state) {
  const current = state.environmentSetup;
  const reason = current.status === 'READY' ? 'CONFIRM_ENVIRONMENT_AND_RUN'
    : current.status === 'NEED_SELECTION' ? (current.selectionKind === 'APP' ? 'SELECT_APP' : 'SELECT_ENVIRONMENT_OPTION')
      : current.status === 'NEED_USER_ACTION' ? 'ENVIRONMENT_USER_ACTION' : 'ENVIRONMENT_NOT_READY';
  const choices = current.status === 'READY'
    ? [{ id: 'CONFIRM_ENVIRONMENT', decision: 'CONFIRM_ENVIRONMENT', environmentRef: current.environmentRef }]
    : (current.candidates || []).map(candidate => current.selectionKind === 'APP'
      ? { id: candidate.id, label: candidate.label, decision: 'SELECT_APP', appId: candidate.id }
      : { id: candidate.id, label: candidate.label, decision: 'SELECT_ENVIRONMENT_OPTION', optionId: candidate.id });
  const selectedDevice = state.selectedProbe?.devices?.find(device => String(identity(device)) === String(current.input.binding.deviceId));
  return {
    status: 'NEED_USER_CONFIRMATION', reason, environmentStatus: current.status,
    choices: [...choices, { id: 'RETRY_ENVIRONMENT', decision: 'RETRY_ENVIRONMENT' },
      ...['harmony', 'android', 'ios'].map(platform => ({ id: `SELECT_${platform.toUpperCase()}`, decision: 'SELECT_PLATFORM', platform }))],
    binding: safeBinding(current.binding || current.input.binding),
    deviceName: selectedDevice?.name || current.input.binding.deviceId,
    ...(current.app ? { app: current.app } : {}),
    ...(current.environmentRef ? { environmentRef: current.environmentRef } : {}),
    ...(current.coverage ? { coverage: current.coverage } : {}),
    ...(current.allowTargetInput ? { allowTargetInput: true } : {}),
    ...(current.actions?.length ? { actions: current.actions } : {}),
    ...(current.diagnostics?.length ? { diagnostics: current.diagnostics } : {}),
    devices: state.selectedProbe?.devices || [],
  };
}

module.exports = { identity, safeBinding, resolve, response, refresh, probeBinding };
