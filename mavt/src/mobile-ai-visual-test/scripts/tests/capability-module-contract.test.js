#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  validateCapabilityDefinition,
  validateProvider,
} = require('../case-runtime/capability-modules/contract');
const { createRegistry } = require('../case-runtime/capability-modules/registry');

const definition = {
  name: 'student_update',
  summary: 'Update one student',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { studentId: { type: 'string', minLength: 1 } },
    required: ['studentId'],
  },
};

const seen = [];
const readyProvider = {
  manifest: { id: 'fixture', version: '1.0.0', summary: 'Fixture provider' },
  probe(context) {
    seen.push(['probe', context.executionId]);
    return { status: 'READY', implementationVersion: 'fixture 1', diagnostic: null, discoverySeed: ['seed'] };
  },
  listCapabilities(context, probeResult) {
    seen.push(['list', context.executionId, probeResult.discoverySeed]);
    return [definition];
  },
  invoke() { return { status: 'SUCCEEDED', summary: 'updated', output: {}, diagnostic: null }; },
};
const unavailableProvider = {
  manifest: { id: 'offline', version: '1.0.0', summary: 'Offline fixture' },
  probe() { return { status: 'UNAVAILABLE', implementationVersion: null, diagnostic: 'not configured', discoverySeed: null }; },
  listCapabilities() { throw new Error('must not list an unavailable provider'); },
  invoke() { throw new Error('must not invoke an unavailable provider'); },
};
const brokenProvider = {
  manifest: { id: 'broken', version: '1.0.0', summary: 'Broken fixture' },
  probe() { throw new Error('credential token=secret-value'); },
  listCapabilities() { return []; },
  invoke() { return {}; },
};

assert.strictEqual(validateProvider(readyProvider), readyProvider);
assert.deepStrictEqual(validateCapabilityDefinition(definition), definition);
assert.throws(() => validateProvider({ manifest: { id: 'Bad ID', version: '1', summary: 'bad' } }),
  (error) => error.code === 'CAPABILITY_PROVIDER_INVALID' && /manifest.id/.test(error.message));
assert.throws(() => validateCapabilityDefinition({ ...definition, inputSchema: { type: 'string' } }),
  (error) => error.code === 'CAPABILITY_DEFINITION_INVALID' && /object schema/.test(error.message));
assert.throws(() => validateCapabilityDefinition({ ...definition, inputSchema: {
  type: 'object', properties: {}, additionalProperties: true,
} }), (error) => error.code === 'CAPABILITY_DEFINITION_INVALID' && /additionalProperties/.test(error.message));
assert.throws(() => validateCapabilityDefinition({ ...definition, inputSchema: {
  type: 'object', properties: { value: { format: 'email' } }, additionalProperties: false,
} }), (error) => error.code === 'CAPABILITY_DEFINITION_INVALID' && /format/.test(error.message));
assert.deepStrictEqual(validateCapabilityDefinition({ ...definition, inputSchema: {
  type: 'object', properties: { value: { type: 'string', description: 'Value', default: 'ready' } },
  additionalProperties: false,
} }).inputSchema.properties.value.default, 'ready');
assert.deepStrictEqual(validateCapabilityDefinition({ ...definition,
  sensitiveFields: { input: ['identity'], output: ['phone_number'] },
}).sensitiveFields, { input: ['identity'], output: ['phone_number'] });
assert.throws(() => validateCapabilityDefinition({ ...definition,
  sensitiveFields: { input: 'identity', output: [] },
}), (error) => error.code === 'CAPABILITY_DEFINITION_INVALID');
for (const inputSchema of [
  { type: 'object', properties: { value: { $ref: 'value' } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string', pattern: '[' } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string' } }, required: 42, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string', enum: 'ready' } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'object', const: { mode: 'ready' } } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string', minimum: 1 } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'integer', minLength: 1 } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string', minItems: 1 } }, additionalProperties: false },
  { type: 'object', properties: { value: { type: 'array', additionalProperties: false } }, additionalProperties: false },
]) {
  assert.throws(() => validateCapabilityDefinition({ ...definition, inputSchema }),
    (error) => error.code === 'CAPABILITY_DEFINITION_INVALID');
}

assert.throws(() => createRegistry([readyProvider, readyProvider]),
  (error) => error.code === 'CAPABILITY_PROVIDER_DUPLICATE');

const registry = createRegistry([readyProvider, unavailableProvider, brokenProvider]);
const context = { executionId: 'exec-1' };
assert.deepStrictEqual(registry.discover(context), {
  available: [{
    moduleId: 'fixture',
    moduleVersion: '1.0.0',
    moduleSummary: 'Fixture provider',
    implementationVersion: 'fixture 1',
    definitions: [definition],
    diagnostics: [],
  }],
  unavailable: [
    { moduleId: 'offline', summary: 'Offline fixture', diagnostic: 'not configured' },
    { moduleId: 'broken', summary: 'Broken fixture', diagnostic: 'provider probe failed' },
  ],
});
assert.deepStrictEqual(seen, [
  ['probe', 'exec-1'],
  ['list', 'exec-1', ['seed']],
]);
assert.strictEqual(registry.get('fixture'), readyProvider);
assert.strictEqual(registry.get('missing'), null);

console.log('capability module contract tests passed');
