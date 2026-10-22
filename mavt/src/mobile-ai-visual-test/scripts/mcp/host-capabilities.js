'use strict';
const profile = require('../../../../hosts/codex/harness-requirements.json');

function observed(evidence, field) {
  return field.split('.').reduce((value, key) => value?.[key], evidence) === true;
}

function verifiedLoaderClaim(loader) {
  return loader?.status === 'SUCCEEDED' && typeof loader.result?.executionId === 'string' &&
    loader.result.executionId.length > 0 && Number.isInteger(loader.result.dispatchSequence) &&
    loader.result.dispatchSequence > 0;
}

function verifiedLoaderBinding(loader) {
  return verifiedLoaderClaim(loader) && loader.role === 'case' && loader.scope === 'execution' &&
    /^mavt-context:[A-Za-z0-9_-]+$/.test(loader.contextRef || '') &&
    typeof loader.executionId === 'string' && loader.executionId.length > 0 &&
    Number.isInteger(loader.dispatchSequence) && loader.dispatchSequence > 0 &&
    loader.result?.executionId === loader.executionId &&
    loader.result?.dispatchSequence === loader.dispatchSequence;
}

function assessHarness(evidence = {}, { stage = 'PRE_DELEGATION', transportMode = 'CLI_DEFAULT' } = {}) {
  if (!['PRE_DELEGATION', 'POST_LOADER'].includes(stage)) throw new TypeError('Unknown Harness assessment stage');
  if (!['CLI_DEFAULT', 'MCP_PREVIEW'].includes(transportMode)) throw new TypeError('Unknown Harness transport mode');
  const mcpImage = evidence.caseImageVisibility?.mcpImageVisibleToChild === true;
  const localImage = evidence.caseImageVisibility?.localImageVisibleToChild === true;
  const mcpBinding = verifiedLoaderBinding(evidence.loaderResponse);
  const imageTransport = transportMode === 'MCP_PREVIEW' && mcpImage && (stage === 'PRE_DELEGATION' || mcpBinding)
    ? 'MCP_IMAGE' : localImage ? 'LOCAL_IMAGE' : transportMode === 'MCP_PREVIEW' && mcpImage ? 'MCP_IMAGE' : null;
  const applicable = profile.requirements.filter(requirement =>
    (!requirement.transportMode || requirement.transportMode === transportMode) &&
    (requirement.stage === 'PRE_DELEGATION' || stage === 'POST_LOADER' &&
      (requirement.stage === 'POST_LOADER' || requirement.stage === 'POST_LOADER_MCP' && imageTransport === 'MCP_IMAGE')));
  const missing = applicable.filter(requirement => {
    if (requirement.id === 'loader_claim') return !verifiedLoaderClaim(evidence.loaderResponse);
    if (requirement.id === 'scoped_binding') return !mcpBinding;
    if (requirement.id === 'case_image_visibility') return !imageTransport;
    if (requirement.anyEvidenceFields) return !requirement.anyEvidenceFields.some(field => observed(evidence, field));
    return requirement.evidenceFields.some(field => !observed(evidence, field));
  }).map(requirement => requirement.id);
  const canDelegateVisualCase = !applicable.filter(item => item.stage === 'PRE_DELEGATION')
    .some(item => missing.includes(item.id));
  const canExecuteVisualCase = stage === 'POST_LOADER' && missing.length === 0;
  return { canDelegateVisualCase, canExecuteVisualCase,
    canUseMcpCase: canExecuteVisualCase && imageTransport === 'MCP_IMAGE', imageTransport,
    bindingStrategy: profile.bindingStrategy,
    checks: applicable.map(requirement => ({ id: requirement.id,
      status: missing.includes(requirement.id) ? 'SESSION_REQUIRED' : 'OBSERVED' })),
    missing, evidence, claimsCallerAuthentication: false, claimsOsSandboxing: false };
}

module.exports = { assessHarness };
