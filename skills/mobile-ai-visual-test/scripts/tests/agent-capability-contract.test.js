#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  AGENT_FACING_INTERFACE_KIND: COORDINATOR_INTERFACE_KIND,
  COORDINATOR_CAPABILITIES,
  capabilityCards: coordinatorCapabilityCards,
  validateCoordinatorRequest,
} = require('../coordinator/agent-facing-contract');
const {
  AGENT_FACING_CAPABILITIES,
  AGENT_FACING_INTERFACE_KIND: CASE_INTERFACE_KIND,
  capabilityCards: caseCapabilityCards,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const {
  INTERNAL_INTERFACE_KIND: RUNTIME_INTERFACE_KIND,
  OPERATION_CONTRACT,
} = require('../case-runtime/runtime-operation-contract');
const {
  INTERNAL_INTERFACE_KIND: COORDINATOR_INTERNAL_INTERFACE_KIND,
  INTERFACE_CONTRACTS,
} = require('../lib/coordinator-interface-contract');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const INTERNAL_FIELDS = new Set([
  'batchId', 'executionId', 'definitionRef', 'sceneId', 'basedOnSceneId',
  'requestPath', 'command', 'token', 'claimToken', 'sequence', 'runtimeSha',
  'adapterSha', 'coordinatorSha', 'protocolSha', 'capabilityId', 'operation',
  'decision',
]);

function visit(value, callback, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, [...pathParts, index]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    callback(key, child, [...pathParts, key]);
    visit(child, callback, [...pathParts, key]);
  }
}

function assertExamples(cards, validate, { forbidPaths = false } = {}) {
  for (const [capability, card] of Object.entries(cards)) {
    assert.ok(card.example, `${capability} must provide a current valid example`);
    assert.deepStrictEqual(validate(card.example), [], `${capability} example must satisfy the Agent-facing validator`);
    visit(card.example, (key, value, fieldPath) => {
      assert.strictEqual(INTERNAL_FIELDS.has(key), false,
        `${capability} example must not expose internal field ${fieldPath.join('.')}`);
      if (forbidPaths && typeof value === 'string') {
        assert.strictEqual(value.startsWith('/'), false,
          `${capability} example must not expose an absolute framework path at ${fieldPath.join('.')}`);
      }
    });
  }
}

const coordinatorCards = coordinatorCapabilityCards();
assert.strictEqual(COORDINATOR_INTERFACE_KIND, 'AGENT_FACING');
assert.ok(COORDINATOR_CAPABILITIES.length <= 4, 'Main Agent active capability budget is 4');
assert.deepStrictEqual(Object.keys(coordinatorCards), COORDINATOR_CAPABILITIES);
assertExamples(coordinatorCards, validateCoordinatorRequest);

const caseCards = caseCapabilityCards();
assert.strictEqual(CASE_INTERFACE_KIND, 'AGENT_FACING');
assert.ok(AGENT_FACING_CAPABILITIES.length <= 6, 'Case Agent active capability budget is 6');
assert.deepStrictEqual(Object.keys(caseCards), AGENT_FACING_CAPABILITIES);
assertExamples(caseCards, validateAgentFacingRequest, { forbidPaths: true });

assert.strictEqual(RUNTIME_INTERFACE_KIND, 'INTERNAL');
assert.strictEqual(COORDINATOR_INTERNAL_INTERFACE_KIND, 'INTERNAL');
for (const [operation, definition] of Object.entries(OPERATION_CONTRACT)) {
  assert.strictEqual(definition.interfaceKind, 'INTERNAL', `${operation} Runtime contract must be internal`);
}
for (const [entrypoint, definition] of Object.entries(INTERFACE_CONTRACTS)) {
  assert.strictEqual(definition.interfaceKind, 'INTERNAL', `${entrypoint} Coordinator contract must be internal`);
}

for (const prompt of ['SKILL.md', 'prompts/case-agent.md']) {
  const source = read(prompt);
  assert.strictEqual(source.includes('requestSchema'), false, `${prompt} must not copy request schemas`);
  assert.strictEqual(/```json[\s\S]*?```/.test(source), false, `${prompt} must not embed request JSON manuals`);
}

console.log('agent capability contract tests passed');
