'use strict';

const DEVICE_FORM_FACTORS = new Set([
  'phone',
  'tablet',
  'foldable',
  'widefold',
  'triplefold',
  '2in1',
  '2in1 foldable',
  'wearable',
  'tv',
]);
const ORIENTATIONS = new Set(['portrait', 'preserve']);
const ENFORCEMENTS = new Set(['required', 'none']);

function normalizeDeviceFormFactor(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'smartphone') return 'phone';
  if (normalized === 'pad') return 'tablet';
  return DEVICE_FORM_FACTORS.has(normalized) ? normalized : null;
}

function defaultStartupDisplayPolicy(platform) {
  if (String(platform || '').trim().toLowerCase() === 'harmony') {
    return {
      orientation: 'portrait',
      enforcement: 'required',
      appliesTo: ['phone'],
    };
  }
  return {
    orientation: 'preserve',
    enforcement: 'none',
    appliesTo: [],
  };
}

function normalizeStartupDisplayPolicy(value, { platform } = {}) {
  const defaults = defaultStartupDisplayPolicy(platform);
  const input = typeof value === 'string' ? { orientation: value } : (value || {});
  const orientation = String(input.orientation || defaults.orientation).trim().toLowerCase();
  if (!ORIENTATIONS.has(orientation)) {
    throw new Error(`startupDisplayPolicy.orientation must be one of: ${Array.from(ORIENTATIONS).join(', ')}`);
  }
  const defaultEnforcement = orientation === 'portrait' ? 'required' : 'none';
  const enforcement = String(input.enforcement || defaultEnforcement).trim().toLowerCase();
  if (!ENFORCEMENTS.has(enforcement)) {
    throw new Error(`startupDisplayPolicy.enforcement must be one of: ${Array.from(ENFORCEMENTS).join(', ')}`);
  }
  const rawAppliesTo = input.appliesTo === undefined ? defaults.appliesTo : input.appliesTo;
  if (!Array.isArray(rawAppliesTo)) throw new Error('startupDisplayPolicy.appliesTo must be an array');
  const appliesTo = rawAppliesTo.map((item) => normalizeDeviceFormFactor(item));
  if (appliesTo.some((item) => !item)) throw new Error('startupDisplayPolicy.appliesTo contains an invalid device form factor');
  return {
    orientation,
    enforcement: orientation === 'preserve' ? 'none' : enforcement,
    appliesTo: orientation === 'preserve' ? [] : [...new Set(appliesTo)],
  };
}

function startupDisplayRequirement(policyValue, deviceFormFactor, { platform } = {}) {
  const policy = normalizeStartupDisplayPolicy(policyValue, { platform });
  if (policy.orientation === 'preserve') {
    return { required: false, policy, reason: 'POLICY_PRESERVE' };
  }
  if (policy.enforcement !== 'required') return { required: false, policy, reason: 'POLICY_NOT_ENFORCED' };
  const formFactor = normalizeDeviceFormFactor(deviceFormFactor);
  if (!policy.appliesTo.length) return { required: true, policy, reason: 'POLICY_ALL_DEVICES' };
  if (!formFactor) return { required: true, policy, reason: 'DEVICE_FORM_FACTOR_UNKNOWN' };
  if (!policy.appliesTo.includes(formFactor)) return { required: false, policy, reason: 'DEVICE_FORM_FACTOR_NOT_APPLICABLE' };
  return { required: true, policy, reason: 'POLICY_APPLIES' };
}

function startupDisplayVerified(policyValue, startupDisplay, deviceFormFactor, { platform } = {}) {
  const factor = startupDisplay?.deviceFormFactor || deviceFormFactor;
  const requirement = startupDisplayRequirement(policyValue, factor, { platform });
  const validation = validateStartupDisplayResult(requirement, startupDisplay, deviceFormFactor);
  return { ...requirement, verified: validation.valid, validation };
}

function validateStartupDisplayResult(requirement, startupDisplay, environmentDeviceFormFactor) {
  if (!requirement.required && !startupDisplay) return { valid: true, errors: [] };
  const errors = [];
  if (!startupDisplay || typeof startupDisplay !== 'object' || Array.isArray(startupDisplay)) {
    return { valid: false, errors: ['startupDisplay result is required'] };
  }
  const policy = requirement.policy;
  const resultFactor = normalizeDeviceFormFactor(startupDisplay.deviceFormFactor);
  const environmentFactor = normalizeDeviceFormFactor(environmentDeviceFormFactor);
  if (resultFactor && environmentFactor && resultFactor !== environmentFactor) errors.push('deviceFormFactor does not match execution environment');
  if (startupDisplay.requestedOrientation !== policy.orientation) errors.push('requestedOrientation does not match policy');
  if (startupDisplay.enforcement !== policy.enforcement) errors.push('enforcement does not match policy');
  if (!Array.isArray(startupDisplay.appliesTo) || JSON.stringify(startupDisplay.appliesTo) !== JSON.stringify(policy.appliesTo)) errors.push('appliesTo does not match policy');
  if (startupDisplay.required !== requirement.required) errors.push('required does not match resolved policy');
  if (requirement.required) {
    if (startupDisplay.status !== 'VERIFIED') errors.push('status must be VERIFIED');
    if (startupDisplay.verified !== true) errors.push('verified must be true');
    if (startupDisplay.afterLaunch?.orientation !== policy.orientation) errors.push('afterLaunch.orientation does not match policy');
  } else {
    if (startupDisplay.status !== 'SKIPPED') errors.push('non-required startup display result must be SKIPPED');
    if (startupDisplay.verified === true) errors.push('SKIPPED startup display result cannot be verified');
    if (!String(startupDisplay.skippedReason || '').trim()) errors.push('SKIPPED startup display result requires skippedReason');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  DEVICE_FORM_FACTORS,
  defaultStartupDisplayPolicy,
  normalizeDeviceFormFactor,
  normalizeStartupDisplayPolicy,
  startupDisplayRequirement,
  startupDisplayVerified,
  validateStartupDisplayResult,
};
