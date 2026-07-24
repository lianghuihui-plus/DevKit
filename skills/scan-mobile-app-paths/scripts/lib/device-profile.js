'use strict';

const { hashObject } = require('./common');

function clean(value) {
  return value === undefined ? null : value;
}

function normalizeScreen(display = {}) {
  return {
    width: Number.isFinite(Number(display.width)) ? Number(display.width) : null,
    height: Number.isFinite(Number(display.height)) ? Number(display.height) : null,
    density: Number.isFinite(Number(display.density)) ? Number(display.density) : null,
    orientation: clean(display.orientation),
    fontScale: Number.isFinite(Number(display.fontScale)) ? Number(display.fontScale) : null
  };
}

function deviceProfileFrom({ scan = {}, observation = null, display = null } = {}) {
  const target = scan.target || {};
  const profile = {
    schemaVersion: 1,
    platform: target.platform || scan.platform || 'harmony',
    deviceId: target.deviceId || null,
    deviceType: target.deviceType || null,
    model: target.deviceModel || null,
    osVersion: target.osVersion || null,
    apiLevel: target.apiLevel || null,
    screen: normalizeScreen(display || observation?.display || {}),
    locale: target.locale || null,
    app: {
      bundleName: target.bundleName || observation?.foreground?.bundleName || null,
      environment: target.environment || null,
      appVersion: target.appVersion || null,
      buildVersion: target.buildVersion || null
    }
  };
  profile.profileId = hashObject(profile);
  return profile;
}

module.exports = { deviceProfileFrom };
