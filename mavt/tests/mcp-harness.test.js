'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assessHarness } = require('../src/mobile-ai-visual-test/scripts/mcp/host-capabilities');
const profile = require('../hosts/codex/harness-requirements.json');

const handles = { realHandle: true, wait: true, cancel: true };
const independent = { fresh: true, separateFromCoordinator: true };

test('a child local-image viewer permits CLI visual delegation without MCP image visibility or a pre-Loader ref', () => {
  const result = assessHarness({ independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { localImageVisibleToChild: true } });
  assert.equal(result.canDelegateVisualCase, true);
  assert.equal(result.imageTransport, 'LOCAL_IMAGE');
  assert.deepEqual(result.missing, []);
  assert.equal(result.canUseMcpCase, false);
});

test('a child-visible MCP image selects preview transport but still requires a Loader ref before Case calls', () => {
  const evidence = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { mcpImageVisibleToChild: true } };
  const pre = assessHarness(evidence, { transportMode: 'MCP_PREVIEW' });
  assert.equal(pre.canDelegateVisualCase, true);
  assert.equal(pre.imageTransport, 'MCP_IMAGE');
  assert.equal(pre.canUseMcpCase, false);
  assert.deepEqual(pre.missing, []);

  const loaderResponse = { status: 'SUCCEEDED', role: 'case', scope: 'execution',
    contextRef: 'mavt-context:loader-issued', executionId: 'case-a', dispatchSequence: 2,
    result: { executionId: 'case-a', dispatchSequence: 2 } };
  const post = assessHarness({ ...evidence, loaderResponse }, { stage: 'POST_LOADER', transportMode: 'MCP_PREVIEW' });
  assert.equal(post.canUseMcpCase, true);
  assert.deepEqual(post.missing, []);
  assert.equal(post.claimsCallerAuthentication, false);
  assert.equal(post.claimsOsSandboxing, false);
});

test('MCP post-Loader assessment rejects invented or mismatched binding facts', () => {
  const evidence = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { mcpImageVisibleToChild: true } };
  assert.deepEqual(assessHarness({ ...evidence,
    scopedBinding: { strategy: 'STATIC_SCOPED_REFERENCES', contextRefPassedToChild: true } },
  { stage: 'POST_LOADER', transportMode: 'MCP_PREVIEW' }).missing, ['loader_claim', 'scoped_binding']);
  const loaderResponse = { status: 'SUCCEEDED', role: 'case', scope: 'execution',
    contextRef: 'mavt-context:loader-issued', executionId: 'case-a', dispatchSequence: 2,
    result: { executionId: 'case-a', dispatchSequence: 1 } };
  assert.equal(assessHarness({ ...evidence, loaderResponse }, { stage: 'POST_LOADER', transportMode: 'MCP_PREVIEW' }).canUseMcpCase, false);
});

test('CLI visual execution requires a successful child Loader claim, not just parent capabilities', () => {
  const evidence = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { localImageVisibleToChild: true } };
  const before = assessHarness(evidence, { stage: 'POST_LOADER' });
  assert.equal(before.canExecuteVisualCase, false);
  assert.deepEqual(before.missing, ['loader_claim']);
  const loaded = assessHarness({ ...evidence, loaderResponse: { status: 'SUCCEEDED',
    result: { executionId: 'case-a', dispatchSequence: 1 } } }, { stage: 'POST_LOADER' });
  assert.equal(loaded.canExecuteVisualCase, true);
  assert.equal(loaded.imageTransport, 'LOCAL_IMAGE');
});

test('an unusable MCP ref does not disable a proven child local-image fallback', () => {
  const evidence = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { mcpImageVisibleToChild: true, localImageVisibleToChild: true },
    loaderResponse: { status: 'SUCCEEDED', result: { executionId: 'case-a', dispatchSequence: 1 } } };
  const result = assessHarness(evidence, { stage: 'POST_LOADER', transportMode: 'MCP_PREVIEW' });
  assert.equal(result.canExecuteVisualCase, true);
  assert.equal(result.canUseMcpCase, false);
  assert.equal(result.imageTransport, 'LOCAL_IMAGE');
  assert.deepEqual(result.missing, []);
});

test('visual delegation still stops without genuine child image access, fresh context, or real handles', () => {
  const good = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { localImageVisibleToChild: true } };
  assert.deepEqual(assessHarness({ ...good, caseImageVisibility: {} }).missing, ['case_image_visibility']);
  assert.deepEqual(assessHarness({ ...good, independentContext: { fresh: false, separateFromCoordinator: true } }).missing,
    ['independent_context']);
  assert.deepEqual(assessHarness({ ...good, agentHandleWaitCancel: { realHandle: true, wait: true } }).missing,
    ['agent_handle_wait_cancel']);
  assert.equal(assessHarness({}).canDelegateVisualCase, false);
  const mcpOnly = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { mcpImageVisibleToChild: true } };
  assert.deepEqual(assessHarness(mcpOnly).missing, ['case_image_visibility'],
    'ordinary CLI execution needs a child local-image viewer');
});

test('capability profile requires local images for ordinary CLI and permits MCP-only images only in preview assessment', () => {
  const imageRequirements = profile.requirements.filter(item => item.id === 'case_image_visibility');
  assert.deepEqual(imageRequirements.find(item => item.transportMode === 'CLI_DEFAULT').evidenceFields,
    ['caseImageVisibility.localImageVisibleToChild']);
  assert.deepEqual(imageRequirements.find(item => item.transportMode === 'MCP_PREVIEW').anyEvidenceFields,
    ['caseImageVisibility.mcpImageVisibleToChild', 'caseImageVisibility.localImageVisibleToChild']);
  const mcpOnly = { independentContext: independent, agentHandleWaitCancel: handles,
    caseImageVisibility: { mcpImageVisibleToChild: true } };
  assert.equal(assessHarness(mcpOnly).canDelegateVisualCase, false);
  assert.equal(assessHarness(mcpOnly, { transportMode: 'MCP_PREVIEW' }).canDelegateVisualCase, true);
  const localOnly = { ...mcpOnly, caseImageVisibility: { localImageVisibleToChild: true } };
  assert.equal(assessHarness(localOnly).canDelegateVisualCase, true);
});
