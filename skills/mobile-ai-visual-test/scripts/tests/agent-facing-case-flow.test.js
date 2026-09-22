#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PUBLIC_CONTRACT,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const { translateAgentFacingRequest } = require('../case-runtime/agent-facing-translator');
const caseFlowService = require('../case-runtime/case-flow-service');
const {
  applyExpectationResults,
  buildCaseResultFromLedger,
} = require('../case-runtime/expectation-result-service');
const store = require('../case-runtime/store');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-case-flow-'));
const execDir = path.join(temp, 'execution');
fs.mkdirSync(path.join(execDir, 'scenes'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14, runtime: 'case-runtime', executionId: 'execution-case-flow-agent',
  platform: 'ios', status: 'RUNNING', finalized: false,
});
const scene = {
  sceneId: 'scene-1', capturedAt: '2026-09-17T02:00:00.000Z',
  screenshot: { ref: 'screenshots/scene-1.png', path: '/tmp/scene-1.png', width: 1, height: 1 },
  app: { inTargetApp: true }, elements: [], scrollContexts: [], visual: { gestures: [] }, signals: {}, conflicts: [],
};
writeJsonAtomic(path.join(execDir, 'scenes', 'scene-1.json'), scene);
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
store.appendEvent(execDir, 'sceneObserved', { sceneId: 'scene-1', screenshotRef: scene.screenshot.ref, app: scene.app });

const caseFlow = {
  baseRevision: null,
  summary: '验证首次启动授权条件分支',
  entryNodeRef: 'N1',
  nodes: [
    { ref: 'N1', type: 'ACTION', text: '启动 App' },
    { ref: 'N2', type: 'DECISION', text: '是否出现系统权限弹窗', sourceBasis: '执行步骤 2 和步骤 6' },
    { ref: 'N3', type: 'CHECK', text: '系统权限弹窗包含权限相关文案', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '执行步骤 2', requirement: 'CONDITIONAL', applicability: '系统权限弹窗出现' },
    { ref: 'N4', type: 'ACTION', text: '点击允许' },
    { ref: 'N5', type: 'CHECK', text: '系统权限弹窗关闭', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '执行步骤 4', requirement: 'CONDITIONAL', applicability: '系统权限弹窗出现且已点击允许' },
    { ref: 'N6', type: 'CHECK', text: '出现青少年守护相关文案弹窗', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '执行步骤 5', requirement: 'CONDITIONAL', applicability: '系统权限弹窗出现且已点击允许' },
    { ref: 'N7', type: 'END', text: '未出现权限弹窗，跳过授权并正常结束' },
    { ref: 'N8', type: 'END', text: '授权分支完成' },
  ],
  edges: [
    { ref: 'L1', from: 'N1', to: 'N2' },
    { ref: 'L2', from: 'N2', to: 'N3', condition: '出现' },
    { ref: 'L3', from: 'N2', to: 'N7', condition: '未出现' },
    { ref: 'L4', from: 'N3', to: 'N4' },
    { ref: 'L5', from: 'N4', to: 'N5' },
    { ref: 'L6', from: 'N5', to: 'N6' },
    { ref: 'L7', from: 'N6', to: 'N8' },
  ],
  uncertainties: [],
};

const planRules = PUBLIC_CONTRACT.methods.plan.contextualValidationRules;
assert.ok(planRules.some((rule) => rule.includes('完整阅读') && rule.includes('条件作用域')));
assert.ok(planRules.some((rule) => rule.includes('同一业务事实') && rule.includes('DECISION') && rule.includes('CHECK')));
assert.ok(planRules.some((rule) => rule.includes('正常 END') && rule.includes('REQUIRED CHECK')));

const plan = { operation: 'plan', input: { caseFlow } };
assert.deepStrictEqual(validateAgentFacingRequest(plan), []);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, plan), {
  operation: 'recordCaseFlow', caseFlow,
});
assert.ok(validateAgentFacingRequest({ operation: 'plan', input: { caseModel: {} } })
  .some((item) => item.field === 'input.caseFlow' && item.code === 'FIELD_REQUIRED'));

caseFlowService.revise(execDir, caseFlow);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, {
  operation: 'observe', input: { purpose: '确认分支', flowContext: { nodeRef: 'N2', selectedEdgeRef: 'L3' } },
}), {
  operation: 'observe', flowContext: { nodeRef: 'N2', selectedEdgeRef: 'L3' },
  decision: { purpose: '确认分支', expectationRefs: [] },
});
assert.throws(() => translateAgentFacingRequest(execDir, {
  operation: 'observe', input: { flowContext: { nodeRef: 'N3', selectedEdgeRef: 'L3' } },
}), (error) => error?.code === 'AGENT_INPUT_INVALID'
  && error.issues.some((item) => item.code === 'CASE_FLOW_CONTEXT_INVALID'));
assert.deepStrictEqual(validateAgentFacingRequest({
  operation: 'recordResult', input: {
    results: [{ checkNodeRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现系统权限弹窗', evidence: {} }],
  },
}), []);
assert.deepStrictEqual(translateAgentFacingRequest(execDir, {
  operation: 'recordResult', input: {
    results: [{ checkNodeRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现系统权限弹窗', evidence: {} }],
  },
}), {
  operation: 'recordExpectationResults',
  results: [{ expectationRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现系统权限弹窗', evidence: {} }],
});
assert.ok(validateAgentFacingRequest({
  operation: 'recordResult', input: { results: [{ expectationRef: 'N3', status: 'PASS', actual: '可见' }] },
}).some((item) => item.field.includes('expectationRef')));

applyExpectationResults(execDir, [
  { expectationRef: 'N3', status: 'NOT_APPLICABLE', actual: '本次未出现系统权限弹窗', evidence: {} },
  { expectationRef: 'N5', status: 'NOT_APPLICABLE', actual: '未进入授权操作分支', evidence: {} },
  { expectationRef: 'N6', status: 'NOT_APPLICABLE', actual: '未进入授权后的守护弹窗分支', evidence: {} },
]);
const skippedAuthorization = buildCaseResultFromLedger(execDir, {
  summary: '未出现系统权限弹窗，按原始用例分支跳过授权并正常结束', uncertainties: [],
});
assert.strictEqual(skippedAuthorization.verdict, 'PASS');
assert.deepStrictEqual(skippedAuthorization.checks.map((item) => item.status), [
  'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE',
]);

assert.deepStrictEqual(validateAgentFacingRequest({
  operation: 'finish', input: { mode: 'notRun', reason: '账号不具备前置条件',
    evidence: { sceneRefs: ['scene-1'], technicalRefs: [] }, summary: '未进入目标业务验证', uncertainties: [] },
}), []);
const notRun = translateAgentFacingRequest(execDir, {
  operation: 'finish', input: { mode: 'notRun', reason: '账号不具备前置条件',
    evidence: { sceneRefs: ['scene-1'], technicalRefs: [] }, summary: '未进入目标业务验证', uncertainties: [] },
});
assert.strictEqual(notRun.result.verdict, 'NOT_RUN');
assert.deepStrictEqual(notRun.result.checks, []);
assert.strictEqual(notRun.result.caseFlowRevision, 1);
assert.deepStrictEqual(notRun.result.notRunEvidence.sceneRefs, ['scene-1']);
assert.ok(validateAgentFacingRequest({
  operation: 'finish', input: { mode: 'notRun', reason: '前置条件不满足', summary: '未执行', uncertainties: [] },
}).some((item) => item.field === 'input.evidence' && item.code === 'FIELD_REQUIRED'));

fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing case flow passed');
