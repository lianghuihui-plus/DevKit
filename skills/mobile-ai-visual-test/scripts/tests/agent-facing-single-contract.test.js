'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const caseContract = require('../case-runtime/agent-facing-contract');
const coordinatorContract = require('../coordinator/agent-facing-contract');
const currentExecution = require('../lib/readers/current-execution');
const { parseRequest } = require('../case-runtime/agent-facing-client');
const {
  AGENT_FACING_PROTOCOL,
  AGENT_FACING_STATUSES,
  RESOURCE_DESCRIPTOR_SCHEMA,
  requestEnvelopeSchema,
  successEnvelope,
  errorEnvelope,
} = require('../lib/agent-facing-envelope');

assert.strictEqual(AGENT_FACING_PROTOCOL, 'agent-facing');
assert.deepStrictEqual([...AGENT_FACING_STATUSES], ['SUCCEEDED', 'REJECTED', 'FAILED', 'UNKNOWN']);
assert.ok(Object.isFrozen(AGENT_FACING_STATUSES));
assert.deepStrictEqual(RESOURCE_DESCRIPTOR_SCHEMA.required, ['ref', 'type', 'role']);
assert.strictEqual(RESOURCE_DESCRIPTOR_SCHEMA.additionalProperties, false);
assert.deepStrictEqual(requestEnvelopeSchema({
  observe: { type: 'object', additionalProperties: false },
}).required, ['operation', 'input']);
assert.deepStrictEqual(successEnvelope({ operation: 'observe' }), {
  protocol: 'agent-facing', status: 'SUCCEEDED', operation: 'observe', result: {}, resources: [],
});
assert.deepStrictEqual(successEnvelope({
  operation: 'observe',
  result: { outcome: 'SCENE_CAPTURED' },
  data: { ref: 'scene-1', type: 'scene', content: {} },
  resources: [
    { ref: 'screenshot-1', type: 'screenshot', role: 'visual_evidence' },
    { ref: 'screenshot-1', type: 'screenshot', role: 'visual_evidence' },
  ],
}), {
  protocol: 'agent-facing', status: 'SUCCEEDED', operation: 'observe',
  result: { outcome: 'SCENE_CAPTURED' }, data: { ref: 'scene-1', type: 'scene', content: {} },
  resources: [{ ref: 'screenshot-1', type: 'screenshot', role: 'visual_evidence' }],
});
assert.deepStrictEqual(errorEnvelope({
  status: 'REJECTED', operation: 'act', code: 'AGENT_INPUT_INVALID', retryable: true,
}), {
  protocol: 'agent-facing', status: 'REJECTED', operation: 'act', result: {}, resources: [],
  error: { code: 'AGENT_INPUT_INVALID', retryable: true },
});
assert.throws(() => errorEnvelope({ status: 'UNKNOWN', operation: 'act', code: 'X', retryable: true }), /UNKNOWN.*retryable/);
assert.throws(() => errorEnvelope({ status: 'REJECTED', operation: 'act', code: 'not stable', retryable: true }), /stable/i);
assert.throws(() => errorEnvelope({ status: 'REJECTED', operation: 'act', code: 'X', retryable: 'true' }), /retryable/);
assert.throws(() => successEnvelope({ operation: 'observe', unexpected: true }), /unsupported/i);
assert.throws(() => errorEnvelope({ status: 'REJECTED', operation: 'act', code: 'X', retryable: true, data: {} }), /unsupported/i);

assert.strictEqual(caseContract.AGENT_FACING_PROTOCOL, 'agent-facing');
assert.strictEqual(coordinatorContract.AGENT_FACING_PROTOCOL, 'agent-facing');
assert.strictEqual(currentExecution.SCHEMA_VERSION, 13);
assert.deepStrictEqual(Object.keys(currentExecution).sort(), ['SCHEMA_VERSION', 'assertSchema']);

for (const name of ['capabilityCards', 'finishTemplate', 'projectActions']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(caseContract, name), false, `${name} must not be public`);
}
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract, 'capabilityCards'), false);
assert.ok(caseContract.validateAgentFacingRequest({
  capability: 'inspect', basedOnSceneRef: 'scene-1', channel: 'capabilities',
}).length > 0, 'capabilities inspect must not exist');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-single-contract-'));
const requestPath = path.join(temp, 'request.json');
fs.writeFileSync(requestPath, JSON.stringify({ capability: 'observe' }));
assert.throws(() => parseRequest([], ''), /stdin/i);
fs.rmSync(temp, { recursive: true, force: true });

assert.strictEqual(fs.existsSync(path.join(root, 'scripts/case-runtime/runtime-client.js')), false);
for (const relative of [
  'scripts/case-runtime/agent-facing-client.js',
  'scripts/case-runtime/lifecycle.js',
  'scripts/case-runtime/runtime-broker.js',
  'scripts/coordinator/agent-facing-contract.js',
  'scripts/workspace.js',
  'scripts/build-agent-contract.js',
]) {
  assert.doesNotMatch(read(relative), /capabilityCards|compatibilityMode/, `${relative} retains a parallel contract path`);
}

for (const relative of [
  'scripts/batch/completion.js',
  'scripts/batch/completion-service.js',
  'scripts/batch/dispatch-service.js',
  'scripts/batch/reconcile-service.js',
  'scripts/case-runtime/store.js',
  'scripts/case-runtime/result-integrity.js',
  'scripts/execution/contracts/validation-profile-contract.js',
  'scripts/lib/completion-contract.js',
  'scripts/lib/execution-artifact-manifest.js',
  'scripts/lib/execution-closure.js',
  'scripts/lib/execution-evidence-graph.js',
  'scripts/lib/execution-lifecycle.js',
  'scripts/lib/readers/current-execution.js',
]) {
  assert.doesNotMatch(read(relative), /\[11,\s*12\]|11,\s*12/, `${relative} must accept only the current execution schema`);
}

console.log('agent-facing single contract passed');
