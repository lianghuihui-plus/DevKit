'use strict';

const { fail } = require('../common');
const exploration = require('./exploration');
const goalDirected = require('./goal-directed');
const { MODE_CONTRACTS, modeContract } = require('./contracts');

const MODES = Object.freeze({
  exploration,
  'goal-directed': goalDirected
});

function modeId(input) {
  return typeof input === 'string' ? input : input?.scanMode;
}

function modeFor(input) {
  const id = modeId(input);
  const mode = MODES[id];
  if (!mode) fail(`Unsupported scanMode: ${id}`, 'SCAN_MODE_INVALID');
  return mode;
}

function modeForScan(scan) {
  return modeFor(scan);
}

function scanScopeForMode(scanMode) {
  return modeFor(scanMode).scanScope;
}

function verificationRuleForMode(scanMode) {
  return modeFor(scanMode).verificationRule;
}

function strategyForMode(scanMode) {
  return modeFor(scanMode).strategy;
}

function recommendedProfileForMode(scanMode) {
  return modeFor(scanMode).recommendedProfile;
}

module.exports = {
  MODES,
  MODE_CONTRACTS,
  modeContract,
  modeFor,
  modeForScan,
  scanScopeForMode,
  verificationRuleForMode,
  strategyForMode,
  recommendedProfileForMode
};
