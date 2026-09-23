'use strict';

const ANDROID_UI_BACKENDS = new Set(['auto', 'helper', 'uiautomator']);

function bindingError(message) {
  const error = new Error(message);
  error.code = 'DEVICE_BINDING_CONFLICT';
  return error;
}

function normalizeAndroidUiBackend(value) {
  const backend = String(value || '').trim().toLowerCase();
  if (!ANDROID_UI_BACKENDS.has(backend)) {
    throw bindingError(`invalid androidUiBackend ${value}`);
  }
  return backend;
}

function normalizeDeviceBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const binding = { ...value };
  if (Object.hasOwn(binding, 'device')) throw bindingError('binding.device is unsupported; use binding.deviceId');
  if (binding.deviceId !== undefined) binding.deviceId = String(binding.deviceId).trim();
  if (Object.hasOwn(binding, 'androidUiBackend')) {
    const platform = String(binding.platform || '').trim().toLowerCase();
    if (platform !== 'android') throw bindingError('androidUiBackend only belong to android');
    binding.androidUiBackend = normalizeAndroidUiBackend(binding.androidUiBackend);
  }
  return binding;
}

module.exports = { ANDROID_UI_BACKENDS, normalizeAndroidUiBackend, normalizeDeviceBinding };
