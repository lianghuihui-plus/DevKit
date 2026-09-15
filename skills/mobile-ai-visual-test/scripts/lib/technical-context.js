'use strict';

const TECHNICAL_STATUSES = new Set(['TECHNICAL', 'BLOCKED']);

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function diagnosticLogRefs(response) {
  return strings([
    ...(response?.diagnostic?.logRefs || []),
    ...(response?.diagnostic?.logs || []),
    ...(response?.logRefs || []),
  ]);
}

function inferredResourceFacts(response) {
  return strings([
    response?.executionId ? `execution=${response.executionId}` : null,
    response?.batchId ? `batch=${response.batchId}` : null,
    response?.statePath ? `state=${response.statePath}` : null,
    response?.diagnostic?.stage ? `stage=${response.diagnostic.stage}` : null,
  ]);
}

function attachTechnicalContext(response, scope, resumeExample, options = {}) {
  if (!TECHNICAL_STATUSES.has(response?.status)) return response;
  if (response.technicalContext) return response;
  const resume = response?.nextCall?.example || resumeExample;
  return {
    ...response,
    technicalContext: {
      scope,
      code: response.code || response.diagnostic?.code || 'TECHNICAL_ERROR',
      summary: response.message || response.reason || response.diagnostic?.summary || '当前技术状态阻止流程继续',
      logRefs: strings([...diagnosticLogRefs(response), ...(options.logRefs || [])]),
      resourceFacts: strings([...inferredResourceFacts(response), ...(options.resourceFacts || [])]),
      resume,
    },
  };
}

module.exports = { attachTechnicalContext };
