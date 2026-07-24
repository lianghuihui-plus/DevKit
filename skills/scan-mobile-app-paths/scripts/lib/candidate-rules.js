'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./common');

const DEFAULT_RULES_FILE = path.join(__dirname, '..', '..', 'assets', 'candidate-rules.defaults.json');

function mergeCandidateRules(...rulesList) {
  const merged = { schemaVersion: 1, stableEntry: {}, dynamicData: {} };
  for (const rules of rulesList) {
    if (!rules || typeof rules !== 'object') continue;
    merged.stableEntry = { ...merged.stableEntry, ...(rules.stableEntry || {}) };
    merged.dynamicData = { ...merged.dynamicData, ...(rules.dynamicData || {}) };
  }
  return merged;
}

function defaultCandidateRules(bundleName = null) {
  const defaults = fs.existsSync(DEFAULT_RULES_FILE) ? readJson(DEFAULT_RULES_FILE, {}) : {};
  const bundleRules = bundleName && defaults.bundles?.[bundleName] ? defaults.bundles[bundleName] : {};
  return mergeCandidateRules(defaults, bundleRules);
}

function candidateRulesForScan(scanDir, scan = {}) {
  const appRoot = path.dirname(path.dirname(scanDir));
  const app = readJson(path.join(appRoot, 'app.json'), {});
  const appRules = app.candidateRules || app.pathScan?.candidateRules || {};
  return mergeCandidateRules(defaultCandidateRules(scan.target?.bundleName || app.bundleName), appRules);
}

module.exports = {
  defaultCandidateRules,
  candidateRulesForScan,
  mergeCandidateRules
};
