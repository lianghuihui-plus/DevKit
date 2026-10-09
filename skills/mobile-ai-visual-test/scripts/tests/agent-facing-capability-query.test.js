#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_OPERATIONS } = require('../case-runtime/runtime-operation-contract');
const { validateAgentFacingRequest } = require('../case-runtime/agent-facing-contract');
const { run } = require('../case-runtime/agent-facing-client');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-capability-query-'));
const execDir = path.join(root, 'execution-query');
fs.mkdirSync(execDir, { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14, runtime: 'case-runtime', executionId: 'execution-query', platform: 'harmony',
  targetBinding: { appId: 'com.example.test' }, lifecycle: 'RUNNING', finalized: false,
});
writeJsonAtomic(path.join(execDir, 'runtime.json'), {
  schemaVersion: 1, executionId: 'execution-query', status: 'READY', entry: path.join(execDir, 'agent-facing-client.js'),
  broker: { allowedOperations: AGENT_OPERATIONS },
});

let probes = 0;
let lists = 0;
const provider = {
  manifest: { id: 'fixture', version: '1.0.0', summary: 'Fixture provider' },
  probe() {
    probes += 1;
    return { status: 'READY', implementationVersion: 'fixture 1', diagnostic: null, discoverySeed: ['student.update'] };
  },
  listCapabilities(_context, probeResult) {
    lists += 1;
    assert.deepStrictEqual(probeResult.discoverySeed, ['student.update']);
    return [{
      name: 'student.update', summary: 'Update one student',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { studentId: { type: 'string', minLength: 1 } }, required: ['studentId'] },
    }];
  },
  invoke() { return { status: 'SUCCEEDED', summary: 'updated', output: {}, diagnostic: null }; },
};

assert.deepStrictEqual(validateAgentFacingRequest({ operation: 'queryCapabilities', input: {} }), []);
const first = run(execDir, { operation: 'queryCapabilities', input: {} }, {
  capabilityProviders: [provider], now: '2026-10-09T10:00:00.000Z',
});
assert.strictEqual(first.status, 'SUCCEEDED');
assert.deepStrictEqual(first.result, {
  outcome: 'CAPABILITY_CATALOG_READY', catalogRef: first.data.ref, availableCount: 1,
});
assert.strictEqual(first.data.type, 'capabilityCatalog');
assert.deepStrictEqual(first.data.content.available.map((item) => item.name), ['fixture.student.update']);
assert.strictEqual(first.resources.filter((item) => item.type === 'capabilityDefinition').length, 1);

const definition = run(execDir, { operation: 'read', input: {
  ref: first.data.content.available[0].capabilityRef,
} });
assert.strictEqual(definition.status, 'SUCCEEDED');
assert.strictEqual(definition.data.type, 'capabilityDefinition');
assert.deepStrictEqual(definition.data.content.inputSchema.required, ['studentId']);

const second = run(execDir, { operation: 'queryCapabilities', input: {} }, {
  capabilityProviders: [], now: '2026-10-09T11:00:00.000Z',
});
assert.strictEqual(second.status, 'SUCCEEDED');
assert.deepStrictEqual(second.data, first.data);
assert.strictEqual(probes, 1);
assert.strictEqual(lists, 1);

console.log('agent-facing capability query tests passed');
