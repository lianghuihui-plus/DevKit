#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../case-runtime/store');
const caseFlowService = require('../case-runtime/case-flow-service');
const { canonicalJson } = require('../lib/contract-utils');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-flow-'));
const execDir = path.join(temp, 'execution');
fs.mkdirSync(execDir, { recursive: true });
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14,
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
      { ref: 'N3', type: 'CHECK', text: '权限文案正确', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原文权限弹窗预期', requirement: 'CONDITIONAL', applicability: '出现权限弹窗' },
      { ref: 'N4', type: 'CHECK', text: '首页入口存在', verificationKind: 'SEARCH_EXISTENCE', sourceBasis: '原文首页入口预期', requirement: 'REQUIRED' },
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

expectCode(() => caseFlowService.prepareRevision(execDir, {
  baseRevision: null,
  summary: '没有检查点的初始流程',
  entryNodeRef: 'N1',
  nodes: [{ ref: 'N1', type: 'ACTION', text: '启动' }, { ref: 'N2', type: 'END', text: '结束' }],
  edges: [{ ref: 'L1', from: 'N1', to: 'N2' }],
  uncertainties: [],
}), 'CASE_FLOW_INVALID');

const first = caseFlowService.revise(execDir, flow(), { now: '2026-09-17T01:00:00.000Z' });
assert.strictEqual(first.status, 'CASE_FLOW_RECORDED');
assert.strictEqual(first.caseFlow.revision, 1);
assert.strictEqual(first.caseFlow.reason, 'INITIAL_CASE_FLOW');
assert.strictEqual(first.caseFlow.basedOnSceneRef, null);
const firstReplay = caseFlowService.revise(execDir, flow(), { now: '2026-09-17T01:00:00.500Z' });
assert.strictEqual(firstReplay.idempotent, true);
assert.strictEqual(firstReplay.caseFlow.eventId, first.caseFlow.eventId);
assert.strictEqual(firstReplay.caseFlow.revision, 1);
assert.strictEqual(caseFlowService.history(execDir).length, 1);
assert.deepStrictEqual(caseFlowService.baseline(execDir), first.caseFlow);
assert.deepStrictEqual(caseFlowService.checkpointRegistry(execDir).map((item) => ({
  ref: item.ref, requirement: item.requirement, introducedRevision: item.introducedRevision, baseline: item.baseline, active: item.active,
})), [
  { ref: 'N3', requirement: 'CONDITIONAL', introducedRevision: 1, baseline: true, active: true },
  { ref: 'N4', requirement: 'REQUIRED', introducedRevision: 1, baseline: true, active: true },
]);

expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '尝试改写基线动作',
  nodes: flow().nodes.map((node) => node.ref === 'N1' ? { ...node, text: '重新启动目标 App' } : node),
})), 'CASE_FLOW_NODE_IDENTITY_CHANGED');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '尝试改写基线分支',
  edges: flow().edges.map((edge) => edge.ref === 'L2' ? { ...edge, condition: '出现任意弹窗' } : edge),
})), 'CASE_FLOW_EDGE_IDENTITY_CHANGED');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '缺少检查点要求',
  nodes: flow().nodes.map((node) => node.ref === 'N4' ? { ...node, requirement: undefined } : node),
})), 'CASE_FLOW_INVALID');
expectCode(() => caseFlowService.prepareRevision(execDir, flow({
  baseRevision: 1,
  reason: '条件检查缺少适用条件',
  nodes: flow().nodes.map((node) => node.ref === 'N3' ? { ...node, applicability: undefined } : node),
})), 'CASE_FLOW_INVALID');

expectCode(() => caseFlowService.revise(execDir, flow({ baseRevision: 1, reason: null })), 'CASE_FLOW_REASON_REQUIRED');
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
  entryNodeRef: 'N11',
  nodes: [
    { ref: 'N11', type: 'DECISION', text: '选择路径', sourceBasis: '现场分支' },
    { ref: 'N12', type: 'CHECK', text: '检查', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原文', requirement: 'REQUIRED' },
    { ref: 'N13', type: 'ACTION', text: '循环一' },
    { ref: 'N14', type: 'ACTION', text: '循环二' },
    { ref: 'N15', type: 'END', text: '结束' },
  ],
  edges: [
    { ref: 'L11', from: 'N11', to: 'N12', condition: '正常路径' },
    { ref: 'L12', from: 'N11', to: 'N13', condition: '循环路径' },
    { ref: 'L13', from: 'N13', to: 'N14' },
    { ref: 'L14', from: 'N14', to: 'N13' },
    { ref: 'L15', from: 'N12', to: 'N15' },
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
assert.deepStrictEqual(caseFlowService.checkpointRegistry(execDir).map((item) => ({ ref: item.ref, baseline: item.baseline, active: item.active })), [
  { ref: 'N3', baseline: true, active: false },
  { ref: 'N4', baseline: true, active: true },
]);

const normalizedBaselineReplay = flow({
  summary: '  验证可选权限分支和首页入口  ',
  nodes: flow().nodes.map((node) => ({
    ...node,
    text: `  ${node.text}  `,
    ...(node.sourceBasis ? { sourceBasis: `  ${node.sourceBasis}  ` } : {}),
    ...(node.applicability ? { applicability: `  ${node.applicability}  ` } : {}),
    ...(node.ref === 'N3' ? { verificationKind: undefined } : {}),
  })),
  edges: flow().edges.map((edge) => ({
    ...edge,
    from: ` ${edge.from} `,
    to: ` ${edge.to} `,
    ...(edge.condition ? { condition: ` ${edge.condition} ` } : {}),
  })),
  reason: undefined,
});
const normalizedReplay = caseFlowService.revise(execDir, normalizedBaselineReplay, { now: '2026-09-17T01:01:01.000Z' });
assert.strictEqual(normalizedReplay.idempotent, true);
assert.strictEqual(normalizedReplay.caseFlow.eventId, first.caseFlow.eventId);
assert.strictEqual(normalizedReplay.caseFlow.revision, 1);
assert.strictEqual(caseFlowService.history(execDir).length, 2);
expectCode(() => caseFlowService.prepareRevision(execDir, {
  ...secondFlow,
  baseRevision: 2,
  reason: '尝试复用旧引用',
  nodes: [...secondFlow.nodes, { ref: 'N3', type: 'END', text: '复用引用' }],
}), 'CASE_FLOW_NODE_REF_INVALID');

const action = store.appendEvent(execDir, 'actionRequested', { operationId: 'action-1' });
assert.strictEqual(action.caseFlowRevision, 2);
assert.strictEqual(Object.prototype.hasOwnProperty.call(action, 'caseModelRevision'), false);

const collisionDir = path.join(temp, 'collision-execution');
fs.mkdirSync(collisionDir, { recursive: true });
fs.writeFileSync(path.join(collisionDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(collisionDir, 'execution.json'), {
  schemaVersion: 14,
  runtime: 'case-runtime',
  executionId: 'execution-case-flow-collision',
  status: 'RUNNING',
  finalized: false,
});
caseFlowService.revise(collisionDir, flow(), { now: '2026-09-17T02:00:00.000Z' });
const collisionRequest = flow({ summary: '语义不同但摘要被篡改为碰撞的流程' });
const collisionNormalized = {
  baseRevision: null,
  summary: collisionRequest.summary,
  entryNodeRef: collisionRequest.entryNodeRef,
  nodes: collisionRequest.nodes,
  edges: collisionRequest.edges,
  uncertainties: collisionRequest.uncertainties,
  reason: null,
};
const collisionDigest = crypto.createHash('sha256').update(canonicalJson(collisionNormalized)).digest('hex');
const collisionEventsPath = path.join(collisionDir, 'events.jsonl');
const collisionEvent = JSON.parse(fs.readFileSync(collisionEventsPath, 'utf8').trim());
fs.writeFileSync(collisionEventsPath, `${JSON.stringify({ ...collisionEvent, requestSha256: collisionDigest })}\n`);
expectCode(() => caseFlowService.revise(collisionDir, collisionRequest), 'CASE_FLOW_REQUEST_DIGEST_COLLISION');

fs.rmSync(temp, { recursive: true, force: true });
console.log('case flow service passed');
