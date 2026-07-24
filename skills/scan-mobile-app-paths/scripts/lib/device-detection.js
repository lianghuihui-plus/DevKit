'use strict';

const { spawnSync } = require('child_process');

function normalizeDeviceType(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text) return null;
  if (text === 'phone' || text === 'smartphone') return 'phone';
  if (text === 'tablet' || text === 'pad') return 'tablet';
  if (['foldable', 'widefold', 'triplefold', 'wearable', 'tv'].includes(text)) return text;
  if (text === '2in1' || text === '2 in 1' || text === '2in1 foldable' || text === '2 in 1 foldable') return text.replace(/2 in 1/g, '2in1');
  return text;
}

function parseDeviceList(text, requestedDevice = null) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-\s]+$/.test(trimmed) || /^Name\s+Serial\s+Kind\s+Device Type$/i.test(trimmed) || /^Querying connected devices/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 4) continue;
    const row = { name: parts[0], serial: parts[1], kind: parts[2], deviceType: normalizeDeviceType(parts.slice(3).join(' ')) };
    rows.push(row);
  }
  if (requestedDevice) {
    const requested = String(requestedDevice);
    const matched = rows.find(row => row.serial === requested || row.name === requested);
    return matched || null;
  }
  return rows.length === 1 ? rows[0] : null;
}

function detectDeviceType({ deviceId = null, command = process.env.SMAP_DEVECOCLI || 'devecocli' } = {}) {
  const result = spawnSync(command, ['device', 'list'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    return { deviceType: null, source: 'devecocli-unavailable', diagnostics: String(result.stderr || result.error?.message || '').trim() };
  }
  const row = parseDeviceList(result.stdout, deviceId);
  return row
    ? { deviceType: row.deviceType, source: 'devecocli-device-list', deviceName: row.name, deviceSerial: row.serial, deviceKind: row.kind }
    : { deviceType: null, source: 'devecocli-device-list-unmatched' };
}

module.exports = { normalizeDeviceType, parseDeviceList, detectDeviceType };
