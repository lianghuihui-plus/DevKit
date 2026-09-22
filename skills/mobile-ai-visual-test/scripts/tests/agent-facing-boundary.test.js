#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  AGENT_FACING_CAPABILITIES,
  PUBLIC_CONTRACT,
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

assert.deepStrictEqual(AGENT_FACING_CAPABILITIES, ['observe', 'read', 'inspect', 'plan', 'recordResult', 'act', 'runPlan', 'knowledge', 'recover', 'finish']);
for (const method of Object.values(PUBLIC_CONTRACT.methods)) {
  assert.ok(method.responseProjection, `${method.name} must declare its response projection`);
  assertValid(method.minimalExample);
}
const SCENE_REF = 'mavt:0123456789abcdef01234567:scene:scene-1';
assertValid({ operation: 'read', input: { ref: SCENE_REF } });
assertInvalid({ operation: 'read', input: { ref: 'scene-1' } }, 'input.ref');
assertInvalid({ operation: 'act', input: {
  sceneRef: 'mavt:0123456789abcdef01234567:technicalFact:technical-1', action: { ref: 'button:tap' },
} }, 'input.sceneRef');
assertInvalid({ capability: 'observe' }, 'operation');
assertValid({ operation: 'observe', input: {} });
assertInvalid({ operation: 'observe' }, 'input');
assertInvalid({ operation: 'observe', input: {}, capability: 'observe' }, 'capability');
for (const action of [
  { ref: 'button:tap' }, { ref: 'field:inputText', input: { text: 'hello', mode: 'replace' } },
  { type: 'tap', target: { point: [0.2, 0.4] } },
  { type: 'doubleTap', target: { point: [0, 1] } },
  { type: 'longPress', target: { point: [0.2, 0.4] }, durationMs: 1200 },
  { type: 'swipe', target: { from: [0, 0], to: [1, 1] } },
]) assertValid({ operation: 'act', input: { sceneRef: SCENE_REF, action } });
for (const action of [
  { ref: 'button:tap', type: 'tap', target: { point: [0, 1] } },
  { type: 'tap', target: { point: [1.1, 0] } },
  { type: 'longPress', target: { point: [0, 1] } },
  { type: 'swipe', target: { point: [0, 1] } },
]) assert.ok(validateAgentFacingRequest({ operation: 'act', input: { sceneRef: SCENE_REF, action } }).length);
assertInvalid({ operation: 'act', input: { sceneRef: 'scene-1', action: { ref: 'button:tap' } } }, 'input.sceneRef');
for (const [operation, input] of [
  ['inspect', { mode: 'visual', sceneRef: SCENE_REF, observation: 'Visible' }],
  ['inspect', { mode: 'action', sceneRef: SCENE_REF, observation: 'Target matched' }],
  ['knowledge', { mode: 'query', sceneRef: SCENE_REF, query: 'Issue' }],
  ['knowledge', { mode: 'review', sceneRef: SCENE_REF, queryId: 'query-1', conclusion: 'NO_APPLICABLE', assessments: [] }],
  ['recover', { mode: 'restart', sceneRef: SCENE_REF, reason: 'Disconnected' }],
  ['recover', { mode: 'prepare', targetState: 'FRESH_INSTALL', reason: 'Precondition' }],
  ['recover', { mode: 'external', externalAction: { summary: 'Reconnected' }, reason: 'Transport restored' }],
  ['finish', { mode: 'complete', summary: 'Done' }],
  ['finish', { mode: 'notRun', summary: 'Unavailable', reason: 'Precondition', evidence: { sceneRefs: [SCENE_REF], technicalRefs: [] } }],
]) {
  assertValid({ operation, input });
  const { mode, ...withoutMode } = input;
  assert.ok(validateAgentFacingRequest({ operation, input: withoutMode }).length, `${operation} requires mode`);
}
for (const [operation, input] of [
  ['inspect', { mode: 'elements', sceneRef: 'scene-1' }],
  ['knowledge', { mode: 'query', sceneRef: 'scene-1', query: 'Issue', queryId: 'query-1' }],
  ['recover', { mode: 'prepare', targetState: 'FRESH_INSTALL', reason: 'Precondition', externalAction: { summary: 'Done' } }],
  ['finish', { mode: 'complete', summary: 'Done', reason: 'Not run' }],
]) assert.ok(validateAgentFacingRequest({ operation, input }).length, `${operation} rejects mixed modes`);

assertValid({ operation: 'runPlan', input: {
  submissionId: 'submission-1',
  sceneRef: SCENE_REF,
  purpose: '完成短时交互',
  maxDurationMs: 2500,
  onFailure: 'STOP',
  steps: [
    { id: 'tap', type: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] } },
    { id: 'shot', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false },
  ],
} });

assertValid({
  operation: 'recordResult', input: {
  results: [{
    checkNodeRef: 'N1',
    status: 'PASS',
    actual: '目标内容可见',
    evidence: { sceneRefs: [SCENE_REF] },
  }],
} }, 'recordResult should be a public capability');

assertInvalid({ operation: 'observe', input: { updates: {} } }, 'input.updates', 'observe must not accept updates');
assertInvalid({
  operation: 'act', input: { sceneRef: SCENE_REF, action: { ref: 'button-1:tap' }, updates: {} },
}, 'input.updates', 'act must not accept updates');
assert.ok(validateAgentFacingRequest({ operation: 'finish', input: { mode: 'complete', summary: '完成', updates: {} } }).length);

console.log('agent-facing boundary contract passed');
