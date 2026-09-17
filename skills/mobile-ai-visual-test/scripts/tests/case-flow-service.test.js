#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../case-runtime/store');
const caseFlowService = require('../case-runtime/case-flow-service');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-flow-'));
const execDir = path.join(temp, 'execution');
fs.mkdirSync(execDir, { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 12,
  runtime: 'case-runtime',
  executionId: 'execution-case-flow',
  status: 'RUNNING',
  finalized: false,
});

function flow(overrides = {}) {
  return {
    baseRevision: null,
    summary: '验证可选权限分支和首页入口',
    entryNodeRef: 'N1',
    nodes: [
      { ref: 'N1', type: 'ACTION', text: '启动目标 App' },
      { ref: 'N2', type: 'DECISION', text: '是否出现权限弹窗', sourceBasis: '原文说明若出现则处理' },
      { ref: 'N3', type: 'CHECK', text: '权限文案正确', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原文权限弹窗预期' },
      { ref: 'N4', type: 'CHECK', text: '首页入口存在', verificationKind: 'SEARCH_EXISTENCE', sourceBasis: '原文首页入口预期' },
      { ref: 'N5', type: 'END', text: '用例完成' },
    ],
    edges: [
      { ref: 'L1', from: 'N1', to: 'N2' },
      { ref: 'L2', from: 'N2', to: 'N3', condition: '出现权限弹窗' },
      { ref: 'L3', from: 'N2', to: 'N4', condition: '未出现权限弹窗' },
      { ref: 'L4', from: 'N3', to: 'N4' },
      { ref: 'L5', from: 'N4', to: 'N5' },
    ],
    uncertainties: [],
    reason: null,
    ...overrides,
  };
}

function expectCode(build, code) {
  assert.throws(build, (error) => error?.code === code, code);
}

const first = caseFlowService.revise(execDir, flow(), { now: '2026-09-17T01:00:00.000Z' });
assert.strictEqual(first.status, 'CASE_FLOW_RECORDED');
assert.strictEqual(first.caseFlow.revision, 1);
assert.strictEqual(first.caseFlow.reason, 'INITIAL_CASE_FLOW');

expectCode(() => caseFlowService.revise(execDir, flow({ baseRevision: 1, reason: null })), 'CASE_FLOW_REASON_REQUIRED');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验缺少检查点',
  nodes: flow().nodes.filter((node) => node.type !== 'CHECK'),
  edges: flow().edges.filter((edge) => edge.from !== 'N3' && edge.to !== 'N3'),
})), 'CASE_FLOW_INVALID');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验缺少结束节点',
  nodes: flow().nodes.filter((node) => node.type !== 'END'),
  edges: flow().edges.filter((edge) => edge.from !== 'N5' && edge.to !== 'N5'),
})), 'CASE_FLOW_INVALID');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验不可达节点',
  nodes: [...flow().nodes, { ref: 'N9', type: 'END', text: '不可达结束' }],
})), 'CASE_FLOW_UNREACHABLE_NODE');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验无法到达结束的闭环',
  nodes: [
    { ref: 'N1', type: 'DECISION', text: '选择路径', sourceBasis: '现场分支' },
    { ref: 'N2', type: 'CHECK', text: '检查', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原文' },
    { ref: 'N3', type: 'ACTION', text: '循环一' },
    { ref: 'N4', type: 'ACTION', text: '循环二' },
    { ref: 'N5', type: 'END', text: '结束' },
  ],
  edges: [
    { ref: 'L1', from: 'N1', to: 'N2', condition: '正常路径' },
    { ref: 'L2', from: 'N1', to: 'N3', condition: '循环路径' },
    { ref: 'L3', from: 'N3', to: 'N4' },
    { ref: 'L4', from: 'N4', to: 'N3' },
    { ref: 'L5', from: 'N2', to: 'N5' },
  ],
})), 'CASE_FLOW_END_UNREACHABLE');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验分支条件',
  edges: flow().edges.map((edge) => edge.ref === 'L3' ? { ...edge, condition: undefined } : edge),
})), 'CASE_FLOW_EDGE_INVALID');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '校验动作隐式分支',
  edges: [...flow().edges, { ref: 'L6', from: 'N1', to: 'N5' }],
})), 'CASE_FLOW_EDGE_INVALID');

const secondFlow = flow({
  baseRevision: 1,
  reason: '现场确认权限分支无需形成独立检查',
  nodes: flow().nodes.filter((node) => node.ref !== 'N3'),
  edges: [
    { ref: 'L1', from: 'N1', to: 'N2' },
    { ref: 'L3', from: 'N2', to: 'N4', condition: '未出现权限弹窗' },
    { ref: 'L6', from: 'N2', to: 'N4', condition: '出现并已处理权限弹窗' },
    { ref: 'L5', from: 'N4', to: 'N5' },
  ],
});
const second = caseFlowService.revise(execDir, secondFlow, { now: '2026-09-17T01:01:00.000Z' });
assert.strictEqual(second.caseFlow.revision, 2);
assert.deepStrictEqual(second.caseFlow.retiredNodeRefs, ['N3']);
assert.ok(second.caseFlow.retiredEdgeRefs.includes('L2'));
assert.ok(second.caseFlow.retiredEdgeRefs.includes('L4'));
expectCode(() => caseFlowService.prepareRevision(execDir, {
  ...secondFlow,
  baseRevision: 2,
  reason: '尝试复用旧引用',
  nodes: [...secondFlow.nodes, { ref: 'N3', type: 'END', text: '复用引用' }],
}), 'CASE_FLOW_NODE_REF_INVALID');

const action = store.appendEvent(execDir, 'actionRequested', { operationId: 'action-1' });
assert.strictEqual(action.caseFlowRevision, 2);
assert.strictEqual(Object.prototype.hasOwnProperty.call(action, 'caseModelRevision'), false);

fs.rmSync(temp, { recursive: true, force: true });
console.log('case flow service passed');
