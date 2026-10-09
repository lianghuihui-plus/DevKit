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
assert.ok(validateCoordinatorRequest({ operation: 'read', input: { ref: 'run-summary-1' } })
  .some((item) => item.field === 'input.ref' && item.code === 'PATTERN_MISMATCH'));

assert.strictEqual(CASE_PUBLIC_CONTRACT.protocol, 'agent-facing');
assert.deepStrictEqual(Object.keys(CASE_PUBLIC_CONTRACT.methods), AGENT_FACING_CAPABILITIES);
assert.strictEqual(CASE_INTERFACE_KIND, 'AGENT_FACING');
assert.strictEqual(AGENT_FACING_CAPABILITIES.length, 12, 'Case Agent contract includes resource reading and capability query/use');
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
assert.match(read('SKILL.md'), /按需/);
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

const executionGranularityGuidance = [
  read('prompts/case-agent.md'),
  read('references/case-execution-principles.md'),
].join('\n');
assert.match(executionGranularityGuidance, /`act`.*一个动作.*完整新 Scene.*控制权.*Agent/);
assert.match(executionGranularityGuidance, /`runSequence`.*连续执行.*步骤间不交还控制权.*最终.*Scene/);
assert.match(executionGranularityGuidance, /同一执行意图.*两者.*优先.*`runSequence`/);
assert.doesNotMatch(executionGranularityGuidance, /动作后需要立即判断|两个及以上动作已由当前证据完整确定/);
assert.match(executionGranularityGuidance, /自动保存动作后截图.*最终完整 Scene.*不要机械添加 capture/);
assert.match(executionGranularityGuidance,
  /Toast、Snackbar.*同一 `runSequence`[\s\S]*动作、等待、`SCREENSHOT_ONLY`、等待、`SCREENSHOT_ONLY`/,
  'transient visual evidence must use two delayed lightweight captures in the triggering sequence');
assert.match(executionGranularityGuidance,
  /两次等待.*由 Agent.*按业务和平台.*分别决定.*不设统一时长/,
  'the Agent must choose both transient capture delays from the business and platform context');
assert.match(executionGranularityGuidance,
  /Runtime 自动.*最终完整 Scene.*不计入.*不能替代.*两次采集/,
  'the automatic final full Scene must not replace either transient capture');
assert.match(CASE_PUBLIC_CONTRACT.methods.act.summary, /一个动作.*新 Scene.*控制权.*Agent/);
assert.match(CASE_PUBLIC_CONTRACT.methods.runSequence.summary, /连续执行预先给定的动作.*步骤间不交还控制权.*最终 Scene/);
const knowledgeGuidance = [
  read('prompts/case-agent.md'),
  read('references/case-execution-principles.md'),
  ...CASE_PUBLIC_CONTRACT.methods.knowledge.contextualValidationRules,
  ...CASE_PUBLIC_CONTRACT.methods.finish.contextualValidationRules,
].join('\n');
assert.match(knowledgeGuidance, /预期不符.*操作无效果.*异常反复/,
  'knowledge guidance must cover the recurring execution symptoms that benefit from prior knowledge');
assert.match(knowledgeGuidance, /原因不明.*无法形成可靠判断/,
  'knowledge guidance must cover unexplained and uncertain outcomes');
assert.match(knowledgeGuidance, /优先.*尽早.*`?knowledge`?.*不要等到.*收口/,
  'knowledge investigation must happen while it can still improve the next decision');
assert.match(knowledgeGuidance, /现场证据.*明确技术事实.*完整解释.*才不查询/,
  'skipping knowledge must be the explicit exception for fully explained issues');
assert.doesNotMatch(knowledgeGuidance, /每条用例.*必须.*`?knowledge`?/,
  'stronger guidance must not become an unconditional query gate');
assert.match(read('references/case-runtime/errors/knowledge-recovery.md'), /APP_INITIAL_STATE_UNAVAILABLE[\s\S]*recover/);
assert.strictEqual(read('SKILL.md').includes('不能自己调用 Appium、WDA、xcodebuild 或读取内部日志'), false);

console.log('agent capability contract tests passed');
