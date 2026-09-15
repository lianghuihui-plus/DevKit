#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../case-runtime/store');
const caseModelService = require('../case-runtime/case-model-service');
const { validateAgentFacingRequest } = require('../case-runtime/agent-facing-contract');
const { translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-model-'));
const execDir = path.join(temp, 'execution');
fs.mkdirSync(execDir, { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), '验证首页卡片展示');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 11,
  runtime: 'case-runtime',
  executionId: 'execution-case-model',
  sourceSha: 'source-test',
  status: 'RUNNING',
  finalized: false,
});

const first = caseModelService.revise(execDir, {
  understanding: '验证首页卡片在横向滑动前后的展示',
  preconditions: ['已进入首页'],
  verificationPoints: [
    { text: '初始位置显示入口 A' },
    { text: '滑动后显示入口 B' },
  ],
  items: ['检查初始位置', '横向滑动卡片区域', '检查滑动后位置'],
  uncertainties: ['原始用例未定义滑动距离'],
}, { now: '2026-09-15T00:00:00.000Z' });

assert.strictEqual(first.status, 'CASE_MODEL_RECORDED');
assert.strictEqual(first.caseModel.revision, 1);
assert.deepStrictEqual(first.caseModel.verificationPoints.map((item) => item.ref), ['E1', 'E2']);
assert.deepStrictEqual(first.caseModel.retiredVerificationRefs, []);
assert.strictEqual(first.caseModel.basedOnSceneRef, null);

assert.throws(() => caseModelService.revise(execDir, {
  understanding: first.caseModel.understanding,
  preconditions: first.caseModel.preconditions,
  verificationPoints: first.caseModel.verificationPoints.map(({ ref, text }) => ({ ref, text })),
  items: first.caseModel.items,
  uncertainties: [],
}), (error) => error?.code === 'CASE_MODEL_REASON_REQUIRED');

const second = caseModelService.revise(execDir, {
  understanding: '滑动必须发生在卡片容器内部',
  preconditions: ['已进入首页'],
  verificationPoints: [
    { ref: 'E2', text: '在卡片容器内滑动后显示入口 B' },
    { text: '卡片顺序保持连续' },
  ],
  items: ['查看上一动作落点', '在卡片容器内部重新滑动', '检查入口和顺序'],
  uncertainties: [],
  reason: '上一动作轨迹位于卡片容器之外',
}, { now: '2026-09-15T00:01:00.000Z' });

assert.strictEqual(second.caseModel.revision, 2);
assert.deepStrictEqual(second.caseModel.verificationPoints.map((item) => item.ref), ['E2', 'E3']);
assert.deepStrictEqual(second.caseModel.retiredVerificationRefs, ['E1']);
assert.throws(() => caseModelService.revise(execDir, {
  understanding: '不允许恢复已取消的验证点',
  preconditions: [],
  verificationPoints: [{ ref: 'E1', text: '尝试恢复 E1' }],
  items: ['停止'],
  uncertainties: [],
  reason: '验证引用保护测试',
}), (error) => error?.code === 'CASE_MODEL_VERIFICATION_REF_INVALID');

const actionEvent = store.appendEvent(execDir, 'actionRequested', {
  operationId: 'action-0001',
}, { now: '2026-09-15T00:02:00.000Z' });
assert.strictEqual(actionEvent.caseModelRevision, 2);
assert.strictEqual(caseModelService.current(execDir).revision, 2);
assert.deepStrictEqual(caseModelService.history(execDir).map((item) => item.revision), [1, 2]);
const coverage = require('../case-runtime/result-integrity').validateExpectationCoverage(execDir, {
  checks: [{ expectationRef: 'E2' }, { expectationRef: 'E3' }],
}, store.events(execDir));
assert.deepStrictEqual(coverage.expectations.map((item) => item.ref), ['E2', 'E3']);
assert.deepStrictEqual(coverage.coveredExpectationRefs, ['E2', 'E3']);
assert.throws(() => require('../case-runtime/result-integrity').validateExpectationCoverage(execDir, {
  checks: [{ expectationRef: 'E1' }, { expectationRef: 'E2' }, { expectationRef: 'E3' }],
}, store.events(execDir)), (error) => error?.code === 'CASE_RESULT_INCOMPLETE');

const agentPlan = {
  capability: 'plan',
  understanding: '验证首页卡片展示',
  preconditions: ['已进入首页'],
  verificationPoints: [{ text: '首页显示入口 A' }],
  items: ['检查首页入口'],
  uncertainties: [],
  reason: '为当前执行重新整理业务理解',
};
assert.deepStrictEqual(validateAgentFacingRequest(agentPlan), []);
assert.ok(validateAgentFacingRequest({ capability: 'plan', items: ['旧格式计划'] })
  .some((item) => item.field === 'understanding' && item.code === 'REQUIRED'));
assert.deepStrictEqual(translateAgentFacingRequest(execDir, agentPlan), {
  operation: 'recordCaseModel',
  caseModel: {
    understanding: agentPlan.understanding,
    preconditions: agentPlan.preconditions,
    verificationPoints: agentPlan.verificationPoints,
    items: agentPlan.items,
    uncertainties: agentPlan.uncertainties,
    reason: agentPlan.reason,
  },
});

fs.rmSync(temp, { recursive: true, force: true });
console.log('case model service passed');
