#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { normalizeStartupDisplayPolicy, normalizeDeviceFormFactor } = require('./startup-display');
const { normalizeDeviceBinding } = require('./target-binding');

const IOS_ONLY_FIELDS = new Set([
  'deviceType',
  'appiumServer',
  'wdaLocalPort',
  'webDriverAgentUrl',
  'xcodeOrgId',
  'xcodeSigningId',
  'updatedWDABundleId',
  'showXcodeLog',
  'showIOSLog',
  'useNewWDA',
  'allowProvisioningDeviceRegistration',
  'wdaLaunchTimeout',
  'derivedDataPath',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function requiredEnvironmentFields(platform) {
  return platform === 'ios' ? ['platform', 'deviceId', 'appId'] : ['platform', 'deviceId', 'appId', 'entry'];
}

function normalizeEnvironmentBinding(value, platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ENV_UNCONFIRMED: environment must be an object');
  let binding;
  try {
    binding = normalizeDeviceBinding(cloneJson(value, {}));
  } catch (error) {
    throw new Error(`ENVIRONMENT_BINDING_MISMATCH: ${error.message}`);
  }
  binding.platform = String(binding.platform || platform || '').trim().toLowerCase();
  if (!['harmony', 'android', 'ios'].includes(binding.platform) || binding.platform !== platform) {
    throw new Error('ENVIRONMENT_BINDING_MISMATCH: environment platform does not match execution platform');
  }
  if (binding.bundleName !== undefined || binding.abilityName !== undefined) {
    throw new Error('ENVIRONMENT_BINDING_MISMATCH: use appId and entry in the current environment contract');
  }
  const missing = requiredEnvironmentFields(platform).filter((field) => !String(binding[field] || '').trim());
  if (missing.length) throw new Error(`ENV_UNCONFIRMED: missing environment fields: ${missing.join(', ')}`);
  if (platform !== 'ios') {
    const invalid = [...IOS_ONLY_FIELDS].filter((field) => binding[field] !== undefined);
    if (invalid.length) throw new Error(`ENVIRONMENT_OPTION_OWNERSHIP: ${invalid.join(', ')} only belong to ios`);
  }
  if (platform !== 'harmony' && binding.deviceFormFactor !== undefined) {
    throw new Error('ENVIRONMENT_OPTION_OWNERSHIP: deviceFormFactor currently belongs to harmony');
  }
  if (binding.deviceFormFactor !== undefined) {
    const normalized = normalizeDeviceFormFactor(binding.deviceFormFactor);
    if (!normalized) throw new Error(`ENVIRONMENT_BINDING_MISMATCH: invalid deviceFormFactor ${binding.deviceFormFactor}`);
    binding.deviceFormFactor = normalized;
  }
  binding.startupDisplayPolicy = normalizeStartupDisplayPolicy(binding.startupDisplayPolicy, { platform });
  if (platform === 'harmony'
    && binding.startupDisplayPolicy.orientation !== 'preserve'
    && binding.startupDisplayPolicy.enforcement === 'required'
    && binding.startupDisplayPolicy.appliesTo.length > 0
    && !binding.deviceFormFactor) {
    throw new Error('ENV_UNCONFIRMED: HarmonyOS form-dependent startup display policy requires deviceFormFactor');
  }
  return binding;
}

function buildExecutionEnvironment(state, platform) {
  if (!state?.environmentConfirmedAt) throw new Error('ENV_UNCONFIRMED: environmentConfirmedAt is missing');
  const snapshot = {
    binding: normalizeEnvironmentBinding(state.environment, platform),
    probe: cloneJson(state.environmentProbe, null),
    dependencies: cloneJson(state.dependencies, {}),
    confirmedAt: state.environmentConfirmedAt,
  };
  return { snapshot, environmentSha: executionEnvironmentSha(snapshot) };
}

function executionEnvironmentSha(snapshot) {
  return `environment-${crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex').slice(0, 16)}`;
}

function validateExecutionEnvironment(execution, platform) {
  if (!execution?.environmentSnapshot || !/^environment-[0-9a-f]{16}$/.test(execution.environmentSha || '')) {
    throw new Error('EXECUTION_ENVIRONMENT_UNBOUND: execution does not contain a frozen environment');
  }
  const frozenSnapshot = cloneJson(execution.environmentSnapshot, {});
  const frozenShaMatches = executionEnvironmentSha(frozenSnapshot) === execution.environmentSha;
  const binding = normalizeEnvironmentBinding(frozenSnapshot.binding, platform);
  const snapshot = { ...frozenSnapshot, binding };
  if (!frozenShaMatches && executionEnvironmentSha(snapshot) !== execution.environmentSha) {
    throw new Error('EXECUTION_ENVIRONMENT_CHANGED: environment snapshot hash mismatch');
  }
  return snapshot;
}

function safeEnvironmentSummary(snapshot) {
  const binding = snapshot?.binding || {};
  return {
    platform: binding.platform || null,
    deviceId: binding.deviceId || null,
    appId: binding.appId || null,
    entry: binding.entry || null,
    deviceFormFactor: binding.deviceFormFactor || null,
    deviceFormFactorSource: binding.deviceFormFactorSource || null,
    startupDisplayPolicy: binding.startupDisplayPolicy || null,
    probeSha1: snapshot?.probe?.sha1 || null,
    dependenciesPrepared: Object.values(snapshot?.dependencies || {}).every((item) => item?.ok !== false),
  };
}

function environmentAdapterArgs(binding, purpose = 'observe') {
  const args = [];
  const add = (flag, value) => {
    if (value !== undefined && value !== null && String(value) !== '') args.push(flag, String(value));
  };
  add('--platform', binding.platform);
  add('--device', binding.deviceId);
  if (purpose !== 'probe') add('--app', binding.appId);
  if (purpose === 'action') add('--entry', binding.entry);
  if (['action', 'probe'].includes(purpose) && binding.platform === 'harmony') {
    add('--device-form-factor', binding.deviceFormFactor);
  }
  if (purpose === 'action' && binding.platform === 'harmony') {
    const policy = binding.startupDisplayPolicy || {};
    add('--startup-orientation', policy.orientation);
    add('--startup-orientation-enforcement', policy.enforcement);
    if (Array.isArray(policy.appliesTo) && policy.appliesTo.length) add('--startup-orientation-applies-to', policy.appliesTo.join(','));
  }
  if (binding.platform === 'ios') {
    add('--device-type', binding.deviceType);
    add('--appium-server', binding.appiumServer);
    add('--wda-local-port', binding.wdaLocalPort);
    add('--web-driver-agent-url', binding.webDriverAgentUrl);
    add('--xcode-org-id', binding.xcodeOrgId);
    add('--xcode-signing-id', binding.xcodeSigningId);
    add('--updated-wda-bundle-id', binding.updatedWDABundleId);
    add('--show-xcode-log', binding.showXcodeLog);
    add('--show-ios-log', binding.showIOSLog);
    add('--use-new-wda', binding.useNewWDA);
    add('--allow-provisioning-device-registration', binding.allowProvisioningDeviceRegistration);
    add('--wda-launch-timeout', binding.wdaLaunchTimeout);
    add('--derived-data-path', binding.derivedDataPath);
  }
  return args;
}

module.exports = {
  buildExecutionEnvironment,
  canonicalJson,
  environmentAdapterArgs,
  executionEnvironmentSha,
  normalizeEnvironmentBinding,
  requiredEnvironmentFields,
  safeEnvironmentSummary,
  validateExecutionEnvironment,
};
