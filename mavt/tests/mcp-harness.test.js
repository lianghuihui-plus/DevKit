'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assessHarness } = require('../src/mobile-ai-visual-test/scripts/mcp/host-capabilities');

const handles = { realHandle: true, wait: true, cancel: true };
const independent = { fresh: true, separateFromCoordinator: true };
function evidence(images = { mcpImageVisibleToChild: true }) {
  return { independentContext: independent, agentHandleWaitCancel: handles,
    caseTools: { availableToChild: true }, caseImageVisibility: images };
}
function loader() {
  return { status: 'SUCCEEDED', role: 'case', scope: 'execution',
    contextRef: 'mavt-context:loader-issued', executionId: 'case-a', dispatchSequence: 2,
    result: { executionId: 'case-a', dispatchSequence: 2 } };
}

test('MCP is the default but Case calls require the child Loader binding', () => {
  const pre = assessHarness(evidence());
  assert.equal(pre.canDelegateVisualCase, true);
  assert.equal(pre.imageTransport, 'MCP_IMAGE');
  assert.equal(pre.canUseMcpCase, false);
  assert.deepEqual(pre.missing, []);
  const post = assessHarness({ ...evidence(), loaderResponse: loader() }, { stage: 'POST_LOADER' });
  assert.equal(post.canUseMcpCase, true);
  assert.deepEqual(post.missing, []);
  assert.equal(post.claimsCallerAuthentication, false);
  assert.equal(post.claimsOsSandboxing, false);
});

test('MCP calls can use child local images while still requiring the scoped binding', () => {
  const result = assessHarness({ ...evidence({ localImageVisibleToChild: true }), loaderResponse: loader() },
    { stage: 'POST_LOADER' });
  assert.equal(result.canUseMcpCase, true);
  assert.equal(result.imageTransport, 'LOCAL_IMAGE');
});

test('local images still require the Loader binding', () => {
  const result = assessHarness({ ...evidence({ localImageVisibleToChild: true }),
    loaderResponse: { status: 'SUCCEEDED', result: { executionId: 'case-a', dispatchSequence: 1 } } },
  { stage: 'POST_LOADER' });
  assert.equal(result.canExecuteVisualCase, false);
  assert.deepEqual(result.missing, ['scoped_binding']);
});

test('MCP assessment rejects invented or mismatched Loader binding facts', () => {
  const invented = assessHarness({ ...evidence(), scopedBinding: { contextRefPassedToChild: true } },
    { stage: 'POST_LOADER' });
  assert.deepEqual(invented.missing, ['loader_claim', 'scoped_binding']);
  const mismatch = loader(); mismatch.result.dispatchSequence = 1;
  assert.equal(assessHarness({ ...evidence(), loaderResponse: mismatch }, { stage: 'POST_LOADER' }).canUseMcpCase, false);
});

test('delegation does not require observations from a child that has not been created', () => {
  const pre = assessHarness({ independentContext: independent, agentHandleWaitCancel: handles });
  assert.equal(pre.canDelegateVisualCase, true);
  assert.equal(pre.canExecuteVisualCase, false);
  assert.deepEqual(pre.missing, []);
});

test('Case execution requires the child to discover its own tools and image capability', () => {
  const post = { ...evidence(), loaderResponse: loader() };
  for (const [field, missing] of [['caseTools', 'case_tool_visibility'], ['caseImageVisibility', 'case_image_visibility']]) {
    const result = assessHarness({ ...post, [field]: {} }, { stage: 'POST_LOADER' });
    assert.equal(result.canDelegateVisualCase, true);
    assert.equal(result.canExecuteVisualCase, false);
    assert.deepEqual(result.missing, [missing]);
  }
});

test('MCP delegation requires independent context and actual agent handles', () => {
  assert.deepEqual(assessHarness({ ...evidence(), independentContext: { fresh: false } }).missing, ['independent_context']);
  assert.deepEqual(assessHarness({ ...evidence(), agentHandleWaitCancel: { realHandle: true, wait: true } }).missing,
    ['agent_handle_wait_cancel']);
  assert.equal(assessHarness({}).canDelegateVisualCase, false);
});
