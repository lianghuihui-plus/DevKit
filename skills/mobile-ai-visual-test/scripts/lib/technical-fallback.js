'use strict';

const TECHNICAL_STATUSES = new Set(['TECHNICAL', 'BLOCKED']);

function technicalFallback(scope, resume) {
  return {
    mode: 'AGENT_TECHNICAL_FALLBACK',
    scope,
    resume,
  };
}

function hasRecovery(response) {
  return Boolean(response?.nextCall || response?.recovery || response?.diagnostic?.recovery);
}

function attachTechnicalFallback(response, scope, resume) {
  if (!TECHNICAL_STATUSES.has(response?.status) || hasRecovery(response)) return response;
  return {
    ...response,
    technicalFallback: technicalFallback(scope, resume),
  };
}

module.exports = { attachTechnicalFallback, technicalFallback };
