#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-operation-contract');
const { validateAgentFacingRequest } = require('../case-runtime/agent-facing-contract');
const resources = require('../case-runtime/agent-resource-store');
const { run } = require('../case-runtime/agent-facing-client');
const store = require('../case-runtime/store');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-capability-invoke-'));
function execution(id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  writeJsonAtomic(path.join(dir, 'execution.json'), {
    schemaVersion: 14, runtime: 'case-runtime', executionId: id, platform: 'harmony',
    targetBinding: { appId: 'com.example.test' }, lifecycle: 'RUNNING', finalized: false,
  });
  writeJsonAtomic(path.join(dir, 'runtime.json'), {
    schemaVersion: 1, executionId: id, status: 'READY', entry: path.join(dir, 'agent-facing-client.js'),
    broker: { allowedOperations: AGENT_OPERATIONS },
  });
  return dir;
}

const calls = [];
const provider = {
  manifest: { id: 'fixture', version: '1.0.0', summary: 'Fixture provider' },
  probe() { return { status: 'READY', implementationVersion: 'fixture 1', discoverySeed: null }; },
  listCapabilities() {
    return [{
      name: 'student.update', summary: 'Update one student',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { studentId: { type: 'string', minLength: 1 }, token: { type: 'string', minLength: 1 } },
        required: ['studentId', 'token'],
      },
      invocation: { kind: 'fixture', id: 'student.update' },
    }];
  },
  invoke(request, context) {
    calls.push({ request, context });
    if (request.input.studentId === 'failed') {
      return { status: 'FAILED', summary: 'token=server-secret rejected', output: { authorization: 'Bearer hidden' }, diagnostic: 'password=hidden' };
    }
    if (request.input.studentId === 'unknown') {
      return { status: 'UNKNOWN', summary: 'connection closed', output: null, diagnostic: 'delivery uncertain' };
    }
    if (request.input.studentId === 'invalid-output') {
      return { status: 'SUCCEEDED', summary: 'provider returned a non-JSON output', output: 1n, diagnostic: null };
    }
    if (request.input.studentId === 'oversized-diagnostic') {
      return { status: 'FAILED', summary: 'oversized diagnostic', output: null,
        diagnostic: 'x'.repeat((4 * 1024 * 1024) + 1) };
    }
    return { status: 'SUCCEEDED', summary: 'student updated', output: { studentId: request.input.studentId, access_token: 'output-secret' }, diagnostic: null };
  },
};
const options = { capabilityProviders: [provider], now: '2026-10-09T10:00:00.000Z' };
const execDir = execution('execution-invoke');
const catalog = run(execDir, { operation: 'queryCapabilities', input: {} }, options);
const capabilityRef = catalog.data.content.available[0].capabilityRef;

assert.deepStrictEqual(validateAgentFacingRequest({ operation: 'useCapability', input: {
  capabilityRef, input: { studentId: '42', token: 'input-secret' }, purpose: 'Prepare student',
} }), []);

const invalid = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: '42' }, purpose: 'Prepare student',
} }, options);
assert.strictEqual(invalid.status, 'REJECTED');
assert.strictEqual(invalid.error.code, 'CAPABILITY_INPUT_INVALID');
assert.strictEqual(calls.length, 0, 'dynamic input validation must run before provider invocation');

const success = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: '42', token: 'input-secret' }, purpose: 'Prepare student',
  flowContext: { nodeRef: 'N1' },
} }, options);
assert.strictEqual(success.status, 'SUCCEEDED');
assert.strictEqual(success.result.outcome, 'CAPABILITY_COMPLETED');
assert.strictEqual(success.result.capabilityName, 'fixture.student.update');
assert.strictEqual(success.data.type, 'capabilityInvocation');
assert.strictEqual(success.result.invocationRef, success.data.ref);
assert.strictEqual(calls.length, 1);
assert.strictEqual(calls[0].request.input.token, 'input-secret', 'provider receives the validated unredacted input');
assert.strictEqual(calls[0].context.operationId, success.data.content.operationId);
assert.strictEqual(success.data.content.input.token, '[REDACTED]');
assert.strictEqual(success.data.content.output.access_token, '[REDACTED]');

const failed = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: 'failed', token: 'input-secret' }, purpose: 'Prepare failure',
} }, options);
assert.strictEqual(failed.status, 'FAILED');
assert.strictEqual(failed.error.code, 'CAPABILITY_EXECUTION_FAILED');
assert.ok(failed.resources.some((item) => item.type === 'capabilityInvocation'));
const failedRecord = resources.readPublishedResource(execDir,
  failed.resources.find((item) => item.type === 'capabilityInvocation').ref).data.content;
assert.doesNotMatch(JSON.stringify(failedRecord), /server-secret|Bearer hidden|password=hidden|input-secret/);
assert.ok(failed.resources.some((item) => item.type === 'technicalFact'));

const unknown = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: 'unknown', token: 'input-secret' }, purpose: 'Prepare uncertain state',
} }, options);
assert.strictEqual(unknown.status, 'UNKNOWN');
assert.strictEqual(unknown.error.code, 'CAPABILITY_OUTCOME_UNKNOWN');
assert.strictEqual(unknown.error.retryable, false);

const invalidOutput = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: 'invalid-output', token: 'input-secret' }, purpose: 'Reject invalid provider output',
} }, options);
assert.strictEqual(invalidOutput.status, 'UNKNOWN');
assert.strictEqual(invalidOutput.error.code, 'CAPABILITY_OUTCOME_UNKNOWN');
assert.ok(invalidOutput.resources.some((item) => item.type === 'capabilityInvocation'));
const invalidOutputRecord = resources.readPublishedResource(execDir,
  invalidOutput.resources.find((item) => item.type === 'capabilityInvocation').ref).data.content;
assert.strictEqual(invalidOutputRecord.status, 'UNKNOWN');
assert.match(invalidOutputRecord.diagnostic, /JSON-serializable/);

const oversized = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: 'oversized-diagnostic', token: 'input-secret' }, purpose: 'Bound provider diagnostic',
} }, options);
assert.strictEqual(oversized.status, 'FAILED');
const oversizedRecord = resources.readPublishedResource(execDir,
  oversized.resources.find((item) => item.type === 'capabilityInvocation').ref).data.content;
assert.ok(Buffer.byteLength(oversizedRecord.diagnostic) < 100);
assert.match(oversizedRecord.diagnostic, /^\[TRUNCATED: originalBytes=\d+\]$/);
const oversizedTechnical = resources.readPublishedResource(execDir,
  oversized.resources.find((item) => item.type === 'technicalFact').ref).data.content;
assert.strictEqual(oversizedTechnical.message, oversizedRecord.diagnostic);

const fakeRef = resources.resourceRef(execDir, 'capabilityDefinition', 'not-published');
const unknownRef = run(execDir, { operation: 'useCapability', input: {
  capabilityRef: fakeRef, input: {}, purpose: 'Try an unknown capability',
} }, options);
assert.strictEqual(unknownRef.status, 'REJECTED');
assert.strictEqual(unknownRef.error.code, 'CAPABILITY_UNKNOWN');

const otherDir = execution('execution-other');
const crossScope = run(otherDir, { operation: 'useCapability', input: {
  capabilityRef, input: {}, purpose: 'Try a foreign capability',
} }, options);
assert.strictEqual(crossScope.status, 'REJECTED');
assert.strictEqual(crossScope.error.code, 'CAPABILITY_SCOPE_MISMATCH');

store.updateExecution(execDir, { finalized: true, lifecycle: 'FINALIZED' });
const finalized = run(execDir, { operation: 'useCapability', input: {
  capabilityRef, input: { studentId: '42', token: 'input-secret' }, purpose: 'Too late',
} }, options);
assert.strictEqual(finalized.status, 'REJECTED');
assert.strictEqual(finalized.error.code, 'CASE_RUNTIME_FINALIZED');

const events = store.events(execDir);
assert.strictEqual(events.filter((event) => event.type === 'capabilityInvocationRequested').length, 5);
assert.strictEqual(events.filter((event) => [
  'capabilityInvocationCompleted', 'capabilityInvocationFailed', 'capabilityInvocationOutcomeUnknown',
].includes(event.type)).length, 5);

console.log('agent-facing capability invocation tests passed');
