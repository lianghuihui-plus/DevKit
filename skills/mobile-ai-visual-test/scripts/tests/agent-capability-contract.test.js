#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  AGENT_FACING_INTERFACE_KIND: COORDINATOR_INTERFACE_KIND,
  COORDINATOR_CAPABILITIES,
  PUBLIC_CONTRACT: COORDINATOR_PUBLIC_CONTRACT,
  validateCoordinatorRequest,
} = require('../coordinator/agent-facing-contract');
const {
  AGENT_FACING_CAPABILITIES,
  AGENT_FACING_INTERFACE_KIND: CASE_INTERFACE_KIND,
  PUBLIC_CONTRACT: CASE_PUBLIC_CONTRACT,
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
const { roleResources } = require('../lib/agent-contract-manifest');

const INTERNAL_FIELDS = new Set([
  'batchId', 'executionId', 'definitionRef', 'sceneId', 'basedOnSceneId',
  'requestPath', 'command', 'token', 'claimToken', 'sequence', 'runtimeSha',
    'adapterSha', 'coordinatorSha', 'protocolSha', 'capabilityId',
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

function assertExamples(methods, validate, { forbidPaths = false } = {}) {
  for (const [capability, method] of Object.entries(methods)) {
    assert.ok(method.minimalExample, `${capability} must provide one documentation example`);
    assert.deepStrictEqual(validate(method.minimalExample), [], `${capability} example must satisfy the Agent-facing validator`);
    visit(method.minimalExample, (key, value, fieldPath) => {
      assert.strictEqual(INTERNAL_FIELDS.has(key), false,
        `${capability} example must not expose internal field ${fieldPath.join('.')}`);
      if (forbidPaths && typeof value === 'string') {
        assert.strictEqual(value.startsWith('/'), false,
          `${capability} example must not expose an absolute framework path at ${fieldPath.join('.')}`);
      }
    });
  }
}

assert.strictEqual(COORDINATOR_PUBLIC_CONTRACT.protocol, 'agent-facing');
assert.deepStrictEqual(Object.keys(COORDINATOR_PUBLIC_CONTRACT.methods), COORDINATOR_CAPABILITIES);
assert.strictEqual(COORDINATOR_INTERFACE_KIND, 'AGENT_FACING');
assert.deepStrictEqual(COORDINATOR_CAPABILITIES, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun', 'read']);
assertExamples(COORDINATOR_PUBLIC_CONTRACT.methods, validateCoordinatorRequest);

assert.strictEqual(CASE_PUBLIC_CONTRACT.protocol, 'agent-facing');
assert.deepStrictEqual(Object.keys(CASE_PUBLIC_CONTRACT.methods), AGENT_FACING_CAPABILITIES);
assert.strictEqual(CASE_INTERFACE_KIND, 'AGENT_FACING');
assert.strictEqual(AGENT_FACING_CAPABILITIES.length, 10, 'Case Agent contract includes the uniform resource reader');
assertExamples(CASE_PUBLIC_CONTRACT.methods, validateAgentFacingRequest, { forbidPaths: true });
assert.ok(roleResources('case-executor').includes('references/case-execution-principles.md'));

assert.strictEqual(RUNTIME_INTERFACE_KIND, 'INTERNAL');
assert.strictEqual(COORDINATOR_INTERNAL_INTERFACE_KIND, 'INTERNAL');
for (const [operation, definition] of Object.entries(OPERATION_CONTRACT)) {
  assert.strictEqual(definition.interfaceKind, 'INTERNAL', `${operation} Runtime contract must be internal`);
}
for (const [entrypoint, definition] of Object.entries(INTERFACE_CONTRACTS)) {
  assert.strictEqual(definition.interfaceKind, 'INTERNAL', `${entrypoint} Coordinator contract must be internal`);
  assert.ok(definition.module, `${entrypoint} must have a documentation module`);
  assert.ok(definition.access, `${entrypoint} must have an access mode`);
  assert.ok(definition.roles.length > 0, `${entrypoint} must name its allowed roles`);
}

for (const prompt of ['SKILL.md', 'prompts/case-agent.md']) {
  const source = read(prompt);
  assert.strictEqual(source.includes('requestSchema'), false, `${prompt} must not copy request schemas`);
  assert.strictEqual(/```json[\s\S]*?```/.test(source), false, `${prompt} must not embed request JSON manuals`);
}
assert.match(read('SKILL.md'), /INITIALIZING_RUN/);
assert.match(read('SKILL.md'), /技术异常/);
assert.match(read('SKILL.md'), /读取.*日志/);
assert.match(read('SKILL.md'), /不直接修改.*Batch.*Execution.*Result/);
assert.match(read('SKILL.md'), /documentationRef/);
assert.match(read('SKILL.md'), /普通执行.*不读取.*commands/);
assert.match(read('references/interfaces.md'), /按需/);
assert.doesNotMatch(read('SKILL.md'), /confirmChoices|confirmTemplate|retryWith|technicalContext\.resume/);
assert.match(read('SKILL.md'), /app-packages\/ios/);
assert.match(read('SKILL.md'), /执行协调 Agent.*不.*询问.*安装包/);
assert.match(read('prompts/case-agent.md'), /技术异常/);
assert.match(read('prompts/case-agent.md'), /(读取|使用).*日志/);
assert.match(read('prompts/case-agent.md'), /不得直接.*修改.*Execution.*Result/);
assert.match(read('prompts/case-agent.md'), /首选能力.*不是排他的工具边界/);
assert.match(read('prompts/case-agent.md'), /recover.*input\.targetState.*三端.*Runtime/);
assert.match(read('prompts/case-agent.md'), /不.*提供.*安装包/);
assert.match(read('prompts/case-agent.md'), /ACTION_OUTCOME_UNKNOWN.*禁止.*重放/);
assert.match(read('prompts/case-agent.md'), /ACTION_EFFECT_MISMATCH.*产品 FAIL/);
assert.match(read('prompts/case-agent.md'), /verificationAttempts.*核验采样.*动作重放/);
assert.match(read('prompts/case-agent.md'), /editable.*优先.*inputText/);
assert.match(read('prompts/case-agent.md'), /不要.*逐个点击软键盘/);
assert.match(read('SKILL.md'), /目标级.*inputText/);
assert.match(read('prompts/case-agent.md'), /输入组件依赖.*Runtime.*自动/);
assert.match(read('SKILL.md'), /输入组件依赖.*Runtime.*自动/);
assert.doesNotMatch(read('prompts/case-agent.md'), /MAVT Input IME|mavtInputIme|androidImeNotReady/);
assert.doesNotMatch(read('SKILL.md'), /MAVT Input IME|mavtInputIme|androidImeNotReady/);
assert.match(read('references/failure-policy.md'), /APP_INITIAL_STATE_UNAVAILABLE.*原生.*安装态/);
assert.strictEqual(read('SKILL.md').includes('不能自己调用 Appium、WDA、xcodebuild 或读取内部日志'), false);

console.log('agent capability contract tests passed');
