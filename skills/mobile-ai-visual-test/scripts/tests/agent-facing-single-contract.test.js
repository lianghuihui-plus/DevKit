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
const { validateAgentJson } = require('../lib/agent-json-contract');
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
const envelopeSchema = requestEnvelopeSchema({
  act: {
    type: 'object', required: ['target'], additionalProperties: false,
    properties: { target: { type: 'string', minLength: 1 } },
  },
  read: {
    type: 'object', required: ['ref'], additionalProperties: false,
    properties: { ref: { type: 'string', minLength: 1 } },
  },
});
assert.strictEqual(envelopeSchema.oneOf.length, 2);
assert.strictEqual(validateAgentJson({ operation: 'act', input: { target: 'button-1' } }, envelopeSchema).length, 0);
assert.ok(validateAgentJson({ operation: 'act', input: { ref: 'scene-1' } }, envelopeSchema).length > 0,
  'operation must select its corresponding input schema');
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
assert.deepStrictEqual(successEnvelope({
  operation: 'observe',
  data: { ref: 'scene-1', type: 'scene', content: {} },
  resources: [{ ref: 'scene-1', type: 'scene', role: 'state_after_action' }],
}).resources, [], 'the primary resource must not be repeated in resources');
assert.throws(() => successEnvelope({
  operation: 'observe',
  data: { ref: 'scene-1', type: 'scene', content: {} },
  resources: [{ ref: 'scene-1', type: 'screenshot', role: 'visual_evidence' }],
}), /data\.type.*resources.*type/i);
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
assert.strictEqual(currentExecution.SCHEMA_VERSION, 14);
assert.deepStrictEqual(Object.keys(currentExecution).sort(), ['SCHEMA_VERSION', 'assertSchema']);
assert.strictEqual(currentExecution.assertSchema({ schemaVersion: 14, runtime: 'case-runtime' }).schemaVersion, 14);
assert.throws(() => currentExecution.assertSchema({ schemaVersion: 13, runtime: 'case-runtime' }),
  (error) => error.code === 'FORMAT_UNSUPPORTED');

for (const name of ['capabilityCards', 'finishTemplate', 'projectActions']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(caseContract, name), false, `${name} must not be public`);
}
assert.strictEqual(Object.prototype.hasOwnProperty.call(coordinatorContract, 'capabilityCards'), false);
assert.ok(caseContract.validateAgentFacingRequest({
  capability: 'inspect', basedOnSceneRef: 'scene-1', channel: 'capabilities',
}).length > 0, 'capabilities inspect must not exist');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-single-contract-'));
assert.throws(() => parseRequest([], ''), /stdin/i);
assert.throws(() => parseRequest(['--request', path.join(temp, 'request.json')], ''), /参数/,
  'a request-file argument must never select a parallel transport');
const unknownEffect = require('../case-runtime/store').technicalResponse(temp,
  Object.assign(new Error('delivery unavailable'), { actionOutcomeUnknown: true }), { operation: 'act' });
assert.deepStrictEqual(unknownEffect.diagnostic.recovery, { kind: 'OBSERVE_FIRST' },
  'persisted technical diagnostics must not embed obsolete public capability requests');
for (const field of ['ref', 'type', 'role']) {
  const descriptor = { ref: 'scene-1', type: 'scene', role: 'related' };
  delete descriptor[field];
  assert.throws(() => successEnvelope({ operation: 'read', resources: [descriptor] }),
    new RegExp(field), `resource descriptors must require ${field}`);
}
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
  'scripts/case-runtime/lifecycle.js',
  'scripts/case-runtime/agent-facing-client.js',
  'scripts/case-runtime/telemetry.js',
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
  assert.doesNotMatch(read(relative), /schemaVersion\s*[!=]={1,2}\s*13\b|(?:EXECUTION_SCHEMA_VERSION|SCHEMA_VERSION)\s*=\s*13\b/,
    `${relative} must not accept or write execution schema 13`);
  assert.doesNotMatch(read(relative), /(?:convert|migrate|upgrade)(?:Legacy|Historical|Schema13|Execution)|legacyReader|historicalReader|dualWriter/i,
    `${relative} must not restore execution compatibility paths`);
}

console.log('agent-facing single contract passed');
