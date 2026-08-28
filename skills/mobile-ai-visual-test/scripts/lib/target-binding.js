'use strict';

function bindingError(message) {
  const error = new Error(message);
  error.code = 'DEVICE_BINDING_CONFLICT';
  return error;
}

function normalizeDeviceBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const binding = { ...value };
  if (Object.hasOwn(binding, 'device')) throw bindingError('binding.device is unsupported; use binding.deviceId');
  if (binding.deviceId !== undefined) binding.deviceId = String(binding.deviceId).trim();
  return binding;
}

module.exports = { normalizeDeviceBinding };
