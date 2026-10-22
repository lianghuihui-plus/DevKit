'use strict';
const profile = require('../../../../hosts/codex/harness-requirements.json');

function assessHarness(evidence = {}) {
  const missing = profile.requirements.filter(requirement => {
    if (requirement.strategy && evidence.scopedBinding?.strategy !== requirement.strategy) return true;
    return requirement.evidenceFields.some(field => field.split('.').reduce((value, key) => value?.[key], evidence) !== true);
  }).map(requirement => requirement.id);
  return { canExecuteVisualCase: missing.length === 0, bindingStrategy: profile.bindingStrategy,
    checks: profile.requirements.map(requirement => ({ id: requirement.id,
      status: missing.includes(requirement.id) ? 'SESSION_REQUIRED' : 'OBSERVED' })),
    missing, evidence, claimsCallerAuthentication: false, claimsOsSandboxing: false };
}

module.exports = { assessHarness };
