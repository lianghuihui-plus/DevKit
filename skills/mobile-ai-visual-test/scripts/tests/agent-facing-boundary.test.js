#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  AGENT_FACING_CAPABILITIES,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');

function assertValid(request, message) {
  const issues = validateAgentFacingRequest(request);
  assert.deepStrictEqual(issues, [], message || JSON.stringify(issues));
}

function assertInvalid(request, field, message) {
  const issues = validateAgentFacingRequest(request);
  assert.ok(issues.some((item) => item.field === field), message || JSON.stringify(issues));
}

assert.ok(AGENT_FACING_CAPABILITIES.includes('recordResult'));
assert.ok(AGENT_FACING_CAPABILITIES.includes('runPlan'));

assertValid({
  capability: 'runPlan',
  submissionId: 'submission-1',
  basedOnSceneRef: 'scene-0001',
  purpose: '完成短时交互',
  maxDurationMs: 2500,
  onFailure: 'STOP',
  steps: [
    { id: 'tap', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
    { id: 'shot', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
  ],
});

assertValid({
  capability: 'recordResult',
  results: [{
    checkNodeRef: 'N1',
    status: 'PASS',
    actual: '目标内容可见',
    evidence: { sceneRefs: ['scene-0001'] },
  }],
}, 'recordResult should be a public capability');

assertInvalid({ capability: 'observe', updates: {} }, 'updates', 'observe must not accept updates');
assertInvalid({
  capability: 'act', basedOnSceneRef: 'scene-0001', actionRef: 'button-1:tap', purpose: '继续', updates: {},
}, 'updates', 'act must not accept updates');
assertInvalid({ capability: 'finish', summary: '完成', uncertainties: [], updates: {} }, 'updates', 'finish must not accept updates');

console.log('agent-facing boundary contract passed');
