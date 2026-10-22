'use strict';

const { normalizeDeviceFormFactor } = require('../../../../lib/startup-display');

function parseDeviceList(text) {
  const devices = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:-+\s*)+$/.test(trimmed) || /^Name\s+/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s{2,}/).map((item) => item.trim()).filter(Boolean);
    if (parts.length < 4) continue;
    const deviceFormFactor = normalizeDeviceFormFactor(parts.slice(3).join(' '));
    devices.push({
      name: parts[0],
      id: parts[1],
      serial: parts[1],
      kind: parts[2],
      deviceFormFactor,
    });
  }
  return devices;
}

function selectDeviceProfile(devices, deviceId) {
  const target = String(deviceId || '').trim();
  if (!target) return devices.length === 1 ? devices[0] : null;
  return devices.find((item) => item.id === target || item.serial === target || item.name === target) || null;
}

function lastNumber(text, name) {
  const matches = [...String(text || '').matchAll(new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*$`, 'gmi'))];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function parseDisplayState(text) {
  const rotation = lastNumber(text, 'Rotation') ?? lastNumber(text, 'ScreenRotation');
  const width = lastNumber(text, 'Width');
  const height = lastNumber(text, 'Height');
  let orientation = null;
  if (Number.isFinite(width) && Number.isFinite(height) && width !== height) {
    orientation = width > height ? 'landscape' : 'portrait';
  } else if (rotation === 0 || rotation === 180) {
    orientation = 'portrait';
  } else if (rotation === 90 || rotation === 270) {
    orientation = 'landscape';
  }
  return {
    orientation,
    rotation,
    width,
    height,
    source: 'DisplayManagerService',
    readable: orientation !== null,
  };
}

module.exports = {
  parseDeviceList,
  parseDisplayState,
  selectDeviceProfile,
};
