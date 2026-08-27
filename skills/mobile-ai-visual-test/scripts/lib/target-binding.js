'use strict';

function bindingError(message) {
  const error = new Error(message);
  error.code = 'DEVICE_BINDING_CONFLICT';
  return error;
}

function normalizeDeviceBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const binding = { ...value };
  const deviceId = String(binding.deviceId || '').trim();
  const legacyDevice = String(binding.device || '').trim();
  if (deviceId && legacyDevice && deviceId !== legacyDevice) {
    throw bindingError(`deviceId ${deviceId} conflicts with legacy device ${legacyDevice}`);
  }
  if (deviceId || legacyDevice) binding.deviceId = deviceId || legacyDevice;
  delete binding.device;
  return binding;
}

module.exports = { normalizeDeviceBinding };
