'use strict';

const { canonicalJson, contractError, sha256 } = require('./contract-utils');

const RECOVERY_TRIGGERS = new Set([
  'SOURCE_REQUIRED_COLD_START',
  'AGENT_DECIDED_RESTART',
  'APP_CRASH',
  'SYSTEM_KILLED',
  'UNKNOWN_EXIT',
  'APP_UNRESPONSIVE',
  'AUTOMATION_SESSION_LOST',
]);
const INCIDENT_RECOVERY_TRIGGERS = new Set([
  'APP_CRASH',
  'SYSTEM_KILLED',
  'UNKNOWN_EXIT',
  'APP_UNRESPONSIVE',
  'AUTOMATION_SESSION_LOST',
]);
const INCIDENT_CATEGORIES = new Set(['PRODUCT', 'TECHNICAL']);

function isIncidentRecovery(triggerType) {
  return INCIDENT_RECOVERY_TRIGGERS.has(triggerType);
}

function incidentCategory(value, options = {}) {
  const normalized = value === undefined ? 'TECHNICAL' : value;
  if (!INCIDENT_CATEGORIES.has(normalized)) {
    throw contractError(options.errorCode || 'RECOVERY_INVALID', 'incidentCategory must be PRODUCT or TECHNICAL', {
      fieldPath: 'incidentCategory',
      allowed: [...INCIDENT_CATEGORIES],
      received: value,
    });
  }
  return normalized;
}

function recoveryRequestSha(value) {
  return sha256(canonicalJson(value), 'recovery-request', 24);
}

module.exports = {
  INCIDENT_CATEGORIES,
  INCIDENT_RECOVERY_TRIGGERS,
  RECOVERY_TRIGGERS,
  incidentCategory,
  isIncidentRecovery,
  recoveryRequestSha,
};
