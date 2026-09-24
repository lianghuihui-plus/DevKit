#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRuntimeRequest } = require('../case-runtime/contract');
const {
  AGENT_FACING_CAPABILITIES,
  projectInitialState,
  projectPreviousAction,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const {
  projectAgentFacingResponse,
  translateAgentFacingRequest,
} = require('../case-runtime/agent-facing-translator');
const { run } = require('../case-runtime/agent-facing-client');
const runtimeStore = require('../case-runtime/store');
const agentResources = require('../case-runtime/agent-resource-store');
const { createActionSpatialEvidence, projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-facing-runtime-'));
const execDir = path.join(temp, 'execution-agent-facing');
fs.mkdirSync(path.join(execDir, 'scenes'), { recursive: true });
fs.mkdirSync(path.join(execDir, 'transactions'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), '长按录音按钮并验证录音状态');
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 14,
  runtime: 'case-runtime',
  executionId: 'execution-agent-facing',
  platform: 'harmony',
  targetBinding: { appId: 'com.example.agent-facing' },
  sourceSha: 'source-test',
  warmSessionId: 'warm-0001',
  warmSessionEpoch: 1,
  warmSessionGeneration: 1,
  startedAt: '2026-09-11T00:00:00.000Z',
  status: 'RUNNING',
  lifecycle: 'RUNNING',
  finalized: false,
});
writeJsonAtomic(path.join(execDir, 'runtime.json'), {
  schemaVersion: 1,
  executionId: 'execution-agent-facing',
  status: 'READY',
  entry: path.join(execDir, 'agent-facing-client.js'),
  broker: {
    allowedOperations: ['observe', 'act', 'runPlan', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status'],
  },
});
const scene = {
  schemaVersion: 2,
  sceneId: 'scene-0007',
  generation: 1,
  capturedAt: '2026-09-11T00:00:01.000Z',
  captureTiming: {
    order: ['layout', 'screenshot'],
    captureStartedAt: '2026-09-11T00:00:00.900Z',
    layoutCompletedAt: '2026-09-11T00:00:00.950Z',
    screenshotCompletedAt: '2026-09-11T00:00:01.000Z',
    spanMs: 100,
  },
  screenshot: { ref: 'screenshots/scene-0007.png', path: path.join(execDir, 'screenshots/scene-0007.png'), sha256: 'png-test', width: 1080, height: 1920 },
  evidenceChannels: {
    visual: { available: true, attachment: { path: path.join(execDir, 'screenshots/scene-0007.png') } },
    layout: { available: true },
    policy: 'COMBINE_VISUAL_AND_LAYOUT',
  },
  app: { appId: 'com.example.agent-facing', inTargetApp: true, page: 'voice' },
  signals: {},
  conflicts: [],
  elements: [
    { id: 'record-button', text: '按住说话', role: 'Button', bounds: [100, 1400, 980, 1800], clickable: true, checkable: false, editable: false, enabled: true, visible: true },
    { id: 'message-input', text: '', role: 'TextField', bounds: [80, 1200, 1000, 1380], clickable: false, checkable: false, editable: true, enabled: true, visible: true, focused: true },
    { id: 'hidden-button', text: '隐藏', role: 'Button', bounds: [0, 0, 1, 1], clickable: true, checkable: false, editable: false, enabled: true, visible: false },
  ],
  scrollContexts: [{ id: 'scroll-1', axis: 'VERTICAL', trackingStatus: 'TRACKING', bounds: [0, 0, 1080, 1920] }],
  capabilities: [
    { id: 'scene-0007:tap:record-button', kind: 'tap', label: '点击录音按钮', target: 'record-button' },
    { id: 'scene-0007:longPress:record-button', kind: 'longPress', label: '长按录音按钮', target: 'record-button', input: { durationMs: 'positive-integer' } },
    { id: 'scene-0007:inputText:message-input', kind: 'inputText', label: '输入消息', target: 'message-input', input: 'text' },
    { id: 'scene-0007:swipeUp:screen', kind: 'swipeUp', label: '向上滚动' },
  ],
  visual: { gestures: ['tap', 'doubleTap', 'longPress', 'swipe'], coordinates: 'normalized-0-to-1' },
  previousAction: null,
};
fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'screenshots', 'scene-0007.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
scene.screenshot.sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(execDir, 'screenshots', 'scene-0007.png'))).digest('hex');
const prePlanScene = { ...scene, sceneId: 'scene-preplan' };
writeJsonAtomic(path.join(execDir, 'current-scene.json'), prePlanScene);
writeJsonAtomic(path.join(execDir, 'scenes', `${prePlanScene.sceneId}.json`), prePlanScene);
const prePlanSceneRef = agentResources.publishScene(execDir, prePlanScene.sceneId).data.ref;


function request(operation, input = {}) { return { operation, input }; }
function assertEnvelope(response, status = 'SUCCEEDED') {
  assert.strictEqual(response.status, status);
  assert.strictEqual(response.protocol, 'agent-facing');
  assert.deepStrictEqual(Object.keys(response).sort(), [
    'protocol', 'status', 'operation', 'result', 'resources',
    ...(response.data ? ['data'] : []), ...(response.error ? ['error'] : []),
  ].sort());
  for (const field of ['scene', 'caseState', 'knowledgeInvestigation', 'narrative', 'readiness', 'nextCall']) {
    assert.strictEqual(Object.hasOwn(response, field), false, field);
    assert.strictEqual(Object.hasOwn(response.result, field), false, field);
  }
}
const initialState = projectInitialState({
  platform: 'ios', initialStateRequirement: { targetState: 'KEEP_EXISTING' },
  preparationPolicy: { allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] },
});
assert.strictEqual(initialState.automaticPreparation, 'NONE');
assert.strictEqual(initialState.preparationFact, null);
assert.strictEqual(Object.hasOwn(initialState, 'currentAppState'), false);
assert.ok(initialState.availablePreparation.every((item) => item.authorized));
assert.deepStrictEqual(initialState.availablePreparation.map((item) => item.targetState), ['APP_LOCAL_STATE_EMPTY', 'FRESH_INSTALL']);
const preparedInitialState = projectInitialState({
  platform: 'ios', initialStateRequirement: { targetState: 'KEEP_EXISTING' },
  preparationPolicy: { allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] },
}, {
  status: 'SATISFIED', targetState: 'FRESH_INSTALL', sessionId: 'session-2', epoch: 2, generation: 1,
});
assert.deepStrictEqual(preparedInitialState.preparationFact, {
  status: 'SATISFIED', targetState: 'FRESH_INSTALL',
});
const failedInitialState = projectInitialState({
  platform: 'ios', initialStateRequirement: { targetState: 'KEEP_EXISTING' },
  preparationPolicy: { allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] },
}, {
  status: 'FAILED', targetState: null, code: 'APP_INITIAL_STATE_UNAVAILABLE', technicalFactRef: 'technical-fact-0001',
});
assert.deepStrictEqual(failedInitialState.preparationFact, {
  status: 'FAILED', targetState: null,
});
assert.strictEqual(JSON.stringify(failedInitialState).includes('technicalFactRef'), false);

assert.ok(validateAgentFacingRequest(request('plan', {}))
  .some((item) => item.field === 'input.caseFlow' && item.code === 'FIELD_REQUIRED'));
assert.ok(validateAgentFacingRequest({ capability: 'observe' })
  .some((item) => item.field === 'operation' && item.code === 'FIELD_REQUIRED'));
const actionBeforePlan = translateAgentFacingRequest(execDir, request('act', {
  sceneRef: prePlanSceneRef,
  action: { ref: 'record-button:longPress', input: { durationMs: 1200 } },
}));
assert.strictEqual(actionBeforePlan.operation, 'act', 'the wire migration must not add a planning gate');
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', `${scene.sceneId}.json`), scene);
assert.throws(() => translateAgentFacingRequest(execDir, request('finish', { mode: 'complete', summary: '无法继续' })),
  (error) => error.code === 'AGENT_INPUT_INVALID' && error.issues.some((item) => item.code === 'CASE_FLOW_REQUIRED'));

const initialPlanRequest = request('plan', { caseFlow: {
  baseRevision: null, summary: '验证语音录入过程和结果', entryNodeRef: 'N1',
  nodes: [
    { ref: 'N1', type: 'ACTION', text: '长按录音按钮' },
    { ref: 'N2', type: 'CHECK', text: '显示录音状态', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期', requirement: 'REQUIRED' },
    { ref: 'N3', type: 'CHECK', text: '完成语音录入', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期', requirement: 'REQUIRED' },
    { ref: 'N4', type: 'END', text: '完成' },
  ],
  edges: [{ ref: 'L1', from: 'N1', to: 'N2' }, { ref: 'L2', from: 'N2', to: 'N3' }, { ref: 'L3', from: 'N3', to: 'N4' }],
  uncertainties: [],
} });
let invalidPlanBrokerCalls = 0;
const rejectUnexpectedInvalidPlan = () => {
  invalidPlanBrokerCalls += 1;
  return { status: 'REQUEST_INVALID', code: 'CASE_FLOW_NODE_REF_INVALID', message: 'nodes[0].ref has invalid format' };
};
const invalidNodePlan = run(execDir, request('plan', { caseFlow: {
  ...initialPlanRequest.input.caseFlow,
  entryNodeRef: 'A1',
  nodes: [
    { ...initialPlanRequest.input.caseFlow.nodes[0], ref: 'A1' },
    ...initialPlanRequest.input.caseFlow.nodes.slice(1),
  ],
  edges: [
    { ...initialPlanRequest.input.caseFlow.edges[0], from: 'A1' },
    ...initialPlanRequest.input.caseFlow.edges.slice(1),
  ],
} }), { executeRequest: rejectUnexpectedInvalidPlan });
assertEnvelope(invalidNodePlan, 'REJECTED');
assert.strictEqual(invalidNodePlan.error.code, 'AGENT_INPUT_INVALID');
const invalidNodeRefIssue = invalidNodePlan.error.issues.find((item) => item.field === 'input.caseFlow.nodes[0].ref');
assert.strictEqual(invalidNodeRefIssue.expected, 'string matching ^N[1-9]\\d*$');
assert.match(invalidNodeRefIssue.message, /N1.*A1/);

const invalidEdgePlan = run(execDir, request('plan', { caseFlow: {
  ...initialPlanRequest.input.caseFlow,
  edges: [
    { ...initialPlanRequest.input.caseFlow.edges[0], ref: 'E1' },
    ...initialPlanRequest.input.caseFlow.edges.slice(1),
  ],
} }), { executeRequest: rejectUnexpectedInvalidPlan });
assertEnvelope(invalidEdgePlan, 'REJECTED');
assert.strictEqual(invalidEdgePlan.error.code, 'AGENT_INPUT_INVALID');
const invalidEdgeRefIssue = invalidEdgePlan.error.issues.find((item) => item.field === 'input.caseFlow.edges[0].ref');
assert.strictEqual(invalidEdgeRefIssue.expected, 'string matching ^L[1-9]\\d*$');
assert.match(invalidEdgeRefIssue.message, /L1.*E1/);
assert.strictEqual(invalidPlanBrokerCalls, 0, 'invalid Case Flow refs must be rejected before Runtime execution');

const fallbackNodeRefError = run(execDir, initialPlanRequest, { executeRequest: () => ({
  status: 'REQUEST_INVALID',
  code: 'CASE_FLOW_NODE_REF_INVALID',
  message: 'nodes[0].ref has invalid format',
  issues: [{
    fieldPath: 'request',
    expected: 'a valid recordCaseFlow request',
    code: 'CASE_FLOW_NODE_REF_INVALID',
  }],
}) });
assertEnvelope(fallbackNodeRefError, 'REJECTED');
assert.strictEqual(fallbackNodeRefError.error.code, 'AGENT_INPUT_INVALID');
assert.strictEqual(fallbackNodeRefError.error.retryable, true);
const fallbackNodeRefIssue = fallbackNodeRefError.error.issues.find((item) => item.field === 'input.caseFlow.nodes[0].ref');
assert.strictEqual(fallbackNodeRefIssue.expected, 'string matching ^N[1-9]\\d*$');
assert.match(fallbackNodeRefIssue.message, /N1.*A1/);

const fallbackEdgeRefError = run(execDir, initialPlanRequest, { executeRequest: () => ({
  status: 'REQUEST_INVALID',
  code: 'CASE_FLOW_EDGE_REF_INVALID',
  message: 'edges[0].ref has invalid format',
}) });
assertEnvelope(fallbackEdgeRefError, 'REJECTED');
assert.strictEqual(fallbackEdgeRefError.error.code, 'AGENT_INPUT_INVALID');
const fallbackEdgeRefIssue = fallbackEdgeRefError.error.issues.find((item) => item.field === 'input.caseFlow.edges[0].ref');
assert.strictEqual(fallbackEdgeRefIssue.expected, 'string matching ^L[1-9]\\d*$');
assert.match(fallbackEdgeRefIssue.message, /L1.*E1/);

const fallbackGraphError = run(execDir, initialPlanRequest, { executeRequest: () => ({
  status: 'REQUEST_INVALID',
  code: 'CASE_FLOW_UNREACHABLE_NODE',
  message: 'nodes are unreachable from entry: N4',
}) });
assertEnvelope(fallbackGraphError, 'REJECTED');
assert.strictEqual(fallbackGraphError.error.code, 'AGENT_INPUT_INVALID');
assert.strictEqual(fallbackGraphError.error.retryable, true);
assert.ok(fallbackGraphError.error.issues.some((item) => item.field === 'input.caseFlow'
  && item.code === 'CASE_FLOW_UNREACHABLE_NODE'
  && item.message === 'nodes are unreachable from entry: N4'));

assert.deepStrictEqual(translateAgentFacingRequest(execDir, initialPlanRequest), {
  operation: 'recordCaseFlow', caseFlow: initialPlanRequest.input.caseFlow,
});
const planned = run(execDir, initialPlanRequest, { now: '2026-09-11T00:00:01.600Z' });
assertEnvelope(planned);
assert.strictEqual(planned.result.outcome, 'CASE_FLOW_RECORDED');
assert.strictEqual(planned.result.revision, 1);
assert.strictEqual(planned.data, undefined);
const replayedPlan = run(execDir, initialPlanRequest, { now: '2026-09-11T00:00:01.700Z' });
assertEnvelope(replayedPlan);
assert.strictEqual(replayedPlan.result.idempotent, true);
assert.strictEqual(replayedPlan.result.revision, 1);
assert.strictEqual(runtimeStore.events(execDir).filter((event) => event.type === 'caseFlowRevised').length, 1);

const spatialRef = createActionSpatialEvidence(execDir, {
  operationId: 'action-0001',
  action: { type: 'swipe', fromX: 0, fromY: 0, toX: 0, toY: 0, coordinateSource: 'visual' },
  request: { basisObservationRef: 'screenshots/scene-0007.png' },
}, { deviceExecution: { dispatchedFrom: { x: 0, y: 0 }, dispatchedTo: { x: 0, y: 0 } } });
scene.previousAction = {
  operationId: 'action-0001', action: { type: 'swipe' },
  spatialEvidence: projectActionSpatialEvidence(execDir, spatialRef, { operationId: 'action-0001', actionType: 'swipe' }),
  observedEffect: { status: 'UNCHANGED', beforeSceneRef: 'scene-0006', afterSceneRef: scene.sceneId },
};
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', scene.sceneId + '.json'), scene);
const sceneRef = agentResources.publishScene(execDir, scene.sceneId).data.ref;
const previous = projectPreviousAction(scene.previousAction);
assert.strictEqual(previous.spatialEvidence.available, true);
assert.deepStrictEqual(previous.spatialEvidence.requested, { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } });
assert.deepStrictEqual(previous.spatialEvidence.dispatched, { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } });
assert.strictEqual(previous.observedEffect, undefined);
const acceptedAction = projectPreviousAction({
  operationId: 'action-accepted', action: { type: 'tap' }, command: { status: 'ACCEPTED' },
});
assert.strictEqual(acceptedAction.deliveryStatus, 'COMMAND_RESPONSE_RECORDED');
assert.strictEqual(acceptedAction.commandDeliveryKnown, true);
assert.strictEqual(Object.hasOwn(acceptedAction, 'outcomeKnown'), false);
const inputMismatch = projectPreviousAction({
  operationId: 'action-0002', action: { type: 'inputText', text: '[REDACTED]' },
  command: { status: 'ACCEPTED' },
  deviceExecution: { status: 'FAILED', verification: 'INPUT_EFFECT', failureCode: 'ACTION_EFFECT_MISMATCH' },
  failureCode: 'ACTION_EFFECT_MISMATCH',
  inputEffect: { status: 'MISMATCH', attempts: 7, settledMs: 7652, expectedLength: 11, observedLength: 5, expectedText: '13223222360', actualText: '13223' },
});
assert.deepStrictEqual(inputMismatch.technicalResult, {
  deviceStatus: 'FAILED', verification: 'INPUT_EFFECT', failureCode: 'ACTION_EFFECT_MISMATCH',
  inputEffect: { status: 'MISMATCH', verificationAttempts: 7, verificationElapsedMs: 7652, expectedLength: 11, observedLength: 5 },
});
assert.ok(!JSON.stringify(inputMismatch).includes('13223'));

const inspected = run(execDir, request('inspect', {
  mode: 'action', sceneRef, observation: '滑动轨迹位于目标卡片区域上方', checkNodeRefs: ['N2'],
}), { now: '2026-09-11T00:00:01.700Z' });
assertEnvelope(inspected);
assert.strictEqual(inspected.result.outcome, 'ACTION_SPATIAL_OBSERVATION_RECORDED');
const inspectionEvent = runtimeStore.events(execDir).find((event) => event.type === 'actionSpatialInspected');
assert.strictEqual(inspectionEvent.operationId, 'action-0001');
assert.strictEqual(inspectionEvent.caseFlowRevision, 1);
const externalRecovery = run(execDir, request('recover', {
  mode: 'external', reason: 'Runtime 无法表达当前技术恢复操作',
  externalAction: { summary: '已使用平台原生工具恢复当前 App 连接', tool: 'platform-cli' },
}), { now: '2026-09-11T00:00:01.800Z' });
assertEnvelope(externalRecovery);
assert.strictEqual(externalRecovery.result.outcome, 'EXTERNAL_ACTION_RECORDED');
assert.strictEqual(externalRecovery.result.verificationRequired, true);
assert.strictEqual(externalRecovery.data, undefined);
assert.strictEqual(runtimeStore.events(execDir).find((event) => event.type === 'externalActionDeclared').evidence, false);

// Coordinates remain autonomous Agent choices, guarded only by existing visual inspection.
assert.throws(() => translateAgentFacingRequest(execDir, request('act', {
  sceneRef, action: { type: 'tap', target: { point: [0.2, 0.4] } },
})), (error) => error.issues.some((item) => item.code === 'VISUAL_INSPECTION_REQUIRED'));
runtimeStore.appendEvent(execDir, 'visualInspected', {
  inspectionId: 'inspection-translation-fixture', sceneId: scene.sceneId,
  screenshotRef: scene.screenshot.ref, screenshotSha256: scene.screenshot.sha256,
  observation: '已查看当前截图', expectationRefs: [],
});
const translations = [
  [request('observe'), { operation: 'observe' }],
  [request('read', { ref: sceneRef }), { operation: 'read', ref: sceneRef }],
  [request('inspect', { mode: 'visual', sceneRef, observation: '页面显示系统权限弹窗', checkNodeRefs: ['N2'] }), {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs: ['N2'], observation: '页面显示系统权限弹窗' },
  }],
  [request('act', { sceneRef, action: { ref: 'record-button:longPress', input: { durationMs: 1200 } }, purpose: '长按录入语音' }), {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:longPress:record-button', input: { durationMs: 1200 },
    decision: { purpose: '长按录入语音', expectationRefs: [] },
  }],
  [request('act', { sceneRef, action: { ref: 'message-input:inputText', input: { text: '测试', mode: 'replace' } }, purpose: '输入消息' }), {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:inputText:message-input', input: { text: '测试', mode: 'replace' },
    decision: { purpose: '输入消息', expectationRefs: [] },
  }],
  [request('act', { sceneRef, action: { type: 'tap', target: { point: [0.5, 0.4] } }, purpose: '点击截图中的按钮' }), {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'tap', point: [0.5, 0.4] },
    decision: { purpose: '点击截图中的按钮', expectationRefs: [] },
  }],
  [request('act', { sceneRef, action: { type: 'swipe', target: { from: [0.5, 0.8], to: [0.5, 0.2] } }, purpose: '向上滚动' }), {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] },
    decision: { purpose: '向上滚动', expectationRefs: [] },
  }],
  [request('knowledge', { mode: 'query', sceneRef, query: '权限弹窗出现后语音录入无法继续', checkNodeRefs: ['N2'] }), {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: '权限弹窗出现后语音录入无法继续',
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs: ['N2'] },
  }],
  [request('recover', { mode: 'restart', sceneRef, reason: '目标 App 卡死' }), {
    operation: 'recover', basedOnSceneId: scene.sceneId, reason: '目标 App 卡死',
  }],
  [request('recover', { mode: 'prepare', targetState: 'FRESH_INSTALL', reason: '初始状态' }), {
    operation: 'prepare', preparation: { targetState: 'FRESH_INSTALL' },
  }],
];
for (const [input, expected] of translations) {
  const translated = translateAgentFacingRequest(execDir, input);
  assert.deepStrictEqual(translated, expected);
  if (input.operation !== 'read') assert.doesNotThrow(() => validateRuntimeRequest(translated));
}
for (const action of [
  { ref: 'record-button:tap', input: {} },
  { ref: 'visual:tap', input: { point: [0.5, 0.5] } },
  { ref: 'record-button:longPress' },
]) assert.throws(() => translateAgentFacingRequest(execDir, request('act', { sceneRef, action })),
  (error) => error.code === 'AGENT_INPUT_INVALID');

fs.mkdirSync(path.join(execDir, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'knowledge/k.md'), '# 语音权限规则\n权限弹窗处理后继续录音。\n');
runtimeStore.appendEvent(execDir, 'knowledgeQueried', {
  queryId: 'knowledge-0001', query: '权限弹窗出现后语音录入无法继续', candidateCount: 1,
  expectationRefs: ['N2'], sceneId: scene.sceneId,
  candidates: [{ entryId: 'K-voice-001', title: '语音权限规则', snapshotRef: 'knowledge/k.md', expired: false }],
});
const review = request('knowledge', {
  mode: 'review', sceneRef, queryId: 'knowledge-0001', conclusion: 'APPLICABLE_FOUND',
  assessments: [{ entryId: 'K-voice-001', status: 'APPLICABLE', reason: '当前权限弹窗与规则一致' }],
});
const translatedReview = translateAgentFacingRequest(execDir, review);
assert.strictEqual(translatedReview.operation, 'reviewKnowledge');
assert.deepStrictEqual(translatedReview.decision.knowledgeReview.assessments, review.input.assessments);
assert.doesNotThrow(() => validateRuntimeRequest(translatedReview));
const completedReview = run(execDir, review);
assertEnvelope(completedReview);
assert.strictEqual(completedReview.result.outcome, 'KNOWLEDGE_REVIEWED');
assert.strictEqual(completedReview.result.conclusion, 'APPLICABLE_FOUND');
assert.strictEqual(runtimeStore.events(execDir).filter((event) => event.type === 'knowledgeReviewed').length, 1);
const knowledgeDocumentRef = agentResources.publishArtifact(execDir, 'knowledgeDocument', 'knowledge/k.md').data.ref;

const unexplainedPlanUpdate = run(execDir, request('plan', {
  caseFlow: { ...initialPlanRequest.input.caseFlow, baseRevision: 1 },
}));
assertEnvelope(unexplainedPlanUpdate, 'REJECTED');
assert.ok(unexplainedPlanUpdate.error.issues.some((item) => item.field === 'input.caseFlow.reason'));
const revisedPlan = run(execDir, request('plan', { caseFlow: {
  ...initialPlanRequest.input.caseFlow, baseRevision: 1, reason: '权限弹窗改变执行路径', entryNodeRef: 'N5',
  nodes: [{ ref: 'N5', type: 'ACTION', text: '处理现场权限弹窗' }, ...initialPlanRequest.input.caseFlow.nodes],
  edges: [{ ref: 'L4', from: 'N5', to: 'N1' }, ...initialPlanRequest.input.caseFlow.edges],
} }));
assertEnvelope(revisedPlan);
assert.strictEqual(revisedPlan.result.revision, 2);

const resultsRequest = request('recordResult', { results: [
  { checkNodeRef: 'N2', status: 'PASS', actual: '权限处理后显示录音状态', evidence: { sceneRefs: [sceneRef], knowledgeRefs: [knowledgeDocumentRef] } },
  { checkNodeRef: 'N3', status: 'INCONCLUSIVE', actual: '当前现场不足以确认完整录音结果', evidence: { sceneRefs: [sceneRef] } },
] });
const recorded = run(execDir, resultsRequest);
assertEnvelope(recorded);
assert.strictEqual(recorded.result.outcome, 'RESULTS_RECORDED');
assert.strictEqual(recorded.data, undefined);
assert.deepStrictEqual(runtimeStore.events(execDir).filter((event) => event.type === 'expectationResultUpdated')
  .find((event) => event.expectationRef === 'N2').evidence.knowledgeRefs, ['K-voice-001']);
const repeated = run(execDir, resultsRequest);
assertEnvelope(repeated);
assert.deepStrictEqual(repeated.result.idempotentCheckNodeIds, ['N2', 'N3']);
const resultCount = runtimeStore.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length;
const invalidResults = run(execDir, request('recordResult', { results: [
  resultsRequest.input.results[0], { checkNodeRef: 'N9', status: 'PASS', actual: '未知验证点', evidence: { sceneRefs: [sceneRef] } },
] }));
assertEnvelope(invalidResults, 'REJECTED');
assert.strictEqual(invalidResults.error.code, 'EXPECTATION_UNKNOWN');
assert.strictEqual(runtimeStore.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, resultCount);

let brokerCalls = 0;
const executeRequest = () => { brokerCalls += 1; return { status: 'SCENE', scene }; };
const invalidAction = request('act', { sceneRef, action: { ref: 'record-button:longPress' } });
const invalid = run(execDir, invalidAction, { executeRequest });
assertEnvelope(invalid, 'REJECTED');
assert.strictEqual(invalid.error.code, 'ACTION_INPUT_INVALID');
assert.ok(invalid.error.issues.some((item) => item.field === 'input.action.input.durationMs'));
assert.match(invalid.error.documentationRef, /error-action-input-invalid$/);
assert.match(invalid.error.operationDocumentationRef, /methods\/act\.md$/);
const stalled = run(execDir, invalidAction, { executeRequest });
assertEnvelope(stalled, 'REJECTED');
assert.strictEqual(stalled.error.code, 'AGENT_INPUT_STALLED');
assert.strictEqual(stalled.error.retryable, false);
assert.strictEqual(brokerCalls, 0);
assertEnvelope(run(execDir, request('observe'), { executeRequest }));
assert.strictEqual(brokerCalls, 1);
assert.strictEqual(run(execDir, invalidAction, { executeRequest }).error.code, 'ACTION_INPUT_INVALID');
const technical = run(execDir, request('observe'), {
  executeRequest: () => ({ status: 'REQUEST_INVALID', code: 'CASE_RUNTIME_REQUEST_INVALID', message: 'internal mismatch' }),
});
assertEnvelope(technical, 'FAILED');
assert.strictEqual(technical.error.code, 'CASE_RUNTIME_TECHNICAL');

// Only explicit operation fields and typed associations cross the boundary.
const injection = {
  status: 'CASE_FLOW_RECORDED', caseFlow: { revision: 2, requestNormalized: { huge: true } },
  scene, knowledgeInvestigation: { pendingReviews: Array(100).fill('large') },
  secretFutureField: { body: 'must not leak' },
  result: { revision: 2, secretFutureField: 'must not leak' },
  resources: [
    { ref: 'flow-real', type: 'caseFlow', role: 'recorded' },
    { ref: 'scene-0007', type: 'scene', role: 'unrelated' },
  ],
  data: { ref: 'scene-0007', type: 'scene', content: scene },
};
const onlyPlan = projectAgentFacingResponse(execDir, injection, initialPlanRequest);
assertEnvelope(onlyPlan);
assert.deepStrictEqual(onlyPlan.resources, [{ ref: 'flow-real', type: 'caseFlow', role: 'recorded' }]);
assert.strictEqual(onlyPlan.data, undefined);
assert.strictEqual(onlyPlan.result.secretFutureField, undefined);
const onlyRecord = projectAgentFacingResponse(execDir, { ...injection, status: 'RESULTS_RECORDED' }, resultsRequest);
assertEnvelope(onlyRecord);
assert.deepStrictEqual(onlyRecord.resources, []);
assert.strictEqual(onlyRecord.data, undefined);
const canonicalScene = { ref: sceneRef, type: 'scene', content: { sceneRef, controls: ['all controls'] } };
const observed = projectAgentFacingResponse(execDir, {
  status: 'SCENE', data: canonicalScene, result: { sceneRef },
  resources: [{ ref: sceneRef, type: 'scene', role: 'primary' }, { ref: 'shot-real', type: 'screenshot', role: 'visual' }],
}, request('observe'));
assertEnvelope(observed);
assert.strictEqual(observed.result.outcome, 'SCENE_CAPTURED');
assert.deepStrictEqual(observed.data, canonicalScene);
assert.deepStrictEqual(observed.resources, [{ ref: 'shot-real', type: 'screenshot', role: 'visual' }]);
const provided = projectAgentFacingResponse(execDir, { status: 'SCENE' }, request('observe'), {
  resourceProvider: () => ({ result: { sceneRef: canonicalScene.ref, unexpected: 'no' }, data: canonicalScene, resources: [] }),
});
assert.deepStrictEqual(provided.data, canonicalScene);
assert.strictEqual(provided.result.unexpected, undefined);
const acceptedAct = projectAgentFacingResponse(execDir, {
  status: 'SCENE', sceneId: scene.sceneId,
  action: { operationId: 'action-accepted', action: { type: 'tap' }, command: { status: 'ACCEPTED' } },
}, request('act'), {
  resourceProvider: () => ({ result: { sceneRef: scene.sceneId }, resources: [] }),
});
assertEnvelope(acceptedAct);
assert.strictEqual(acceptedAct.result.deliveryStatus, 'COMMAND_RESPONSE_RECORDED');
assert.strictEqual(acceptedAct.result.commandDeliveryKnown, true);
assert.strictEqual(Object.hasOwn(acceptedAct.result, 'outcomeKnown'), false);
for (const [input, internalStatus, disallowedType] of [
  [request('knowledge', { mode: 'review' }), 'KNOWLEDGE_REVIEWED', 'candidateSet'],
  [request('recover', { mode: 'external' }), 'EXTERNAL_ACTION_RECORDED', 'scene'],
  [request('finish', { mode: 'complete' }), 'COMPLETED', 'scene'],
  [request('inspect', { mode: 'visual' }), 'VISUAL_INSPECTED', 'scene'],
]) {
  const projected = projectAgentFacingResponse(execDir, {
    status: internalStatus, data: { ref: 'unrelated', type: disallowedType, content: { large: true } },
  }, input);
  assertEnvelope(projected);
  assert.strictEqual(projected.data, undefined, input.operation + ' must not inline an associated body');
}
const projectionFailure = run(execDir, request('observe'), {
  executeRequest, resourceProvider: () => { throw new Error('resource projection failed'); },
});
assertEnvelope(projectionFailure, 'FAILED');
assert.strictEqual(projectionFailure.error.code, 'CASE_RUNTIME_TECHNICAL');

for (const [response, status] of [
  [{ status: 'REQUEST_INVALID', code: 'ACTION_INPUT_INVALID' }, 'REJECTED'],
  [{ status: 'TECHNICAL', code: 'CASE_RUNTIME_TECHNICAL' }, 'FAILED'],
  [{ status: 'SCENE', code: 'ACTION_OUTCOME_UNKNOWN', action: { outcomeKnown: false } }, 'UNKNOWN'],
  [{ status: 'TECHNICAL', code: 'PLAN_ACTION_OUTCOME_UNKNOWN' }, 'UNKNOWN'],
  [{ status: 'SCENE', action: { operationId: 'action-unknown', status: 'UNKNOWN' } }, 'UNKNOWN'],
  [{ status: 'SCENE', action: { command: { status: 'UNKNOWN' } } }, 'UNKNOWN'],
  [{ status: 'SCENE_CHANGED', code: 'CASE_RUNTIME_SCENE_STALE' }, 'REJECTED'],
  [{ status: 'SCENE', action: { command: { status: 'ACCEPTED' }, deviceExecution: { status: 'FAILED' }, failureCode: 'ACTION_EFFECT_MISMATCH' } }, 'FAILED'],
]) {
  const projected = projectAgentFacingResponse(execDir, { ...response, scene, secret: true }, request('act'));
  assertEnvelope(projected, status);
  if (status === 'UNKNOWN') assert.strictEqual(projected.error.retryable, false);
  if (response.action?.failureCode === 'ACTION_EFFECT_MISMATCH') {
    assert.strictEqual(projected.error.code, 'ACTION_EFFECT_MISMATCH');
    assert.strictEqual(projected.error.retryable, true, 'known input mismatches preserve Agent safe retry decisions');
  }
}
const nestedScalar = projectAgentFacingResponse(execDir, {
  status: 'CASE_FLOW_RECORDED', result: { revision: { fullInternalSnapshot: scene } },
}, initialPlanRequest);
assert.strictEqual(nestedScalar.result.revision, undefined, 'allowlisted scalar fields cannot leak complex internal objects');

for (const outcome of ['PLAN_PARTIAL', 'PLAN_INTERRUPTED']) {
  const knownPlan = projectAgentFacingResponse(execDir, {
    status: outcome, outcomeKnown: true, code: outcome === 'PLAN_PARTIAL' ? 'PLAN_CHECK_FAILED' : 'PLAN_TIMEOUT',
    planId: 'plan-known', data: { ref: 'plan-result-known', type: 'planResult', content: { steps: ['complete evidence'] } },
  }, request('runPlan'));
  assertEnvelope(knownPlan);
  assert.strictEqual(knownPlan.result.outcome, outcome);
  assert.strictEqual(knownPlan.result.planId, 'plan-known');
  assert.strictEqual(knownPlan.data.type, 'planResult');
}
const unknownPlan = projectAgentFacingResponse(execDir, {
  status: 'PLAN_INTERRUPTED', outcomeKnown: false, planId: 'plan-unknown', idempotent: true,
  result: { scene: { huge: true }, planId: 'plan-unknown', unexpected: 'must not leak' },
  data: { ref: 'plan-result-unknown', type: 'planResult', content: { huge: true } },
}, request('runPlan'), {
  resourceProvider: () => ({ result: { planResultRef: 'plan-result-unknown', unexpected: 'must not leak' } }),
});
assertEnvelope(unknownPlan, 'UNKNOWN');
assert.deepStrictEqual(unknownPlan.result, {
  outcome: 'PLAN_INTERRUPTED', planResultRef: 'plan-result-unknown', planId: 'plan-unknown', idempotent: true,
});
assert.strictEqual(unknownPlan.data, undefined);
assert.strictEqual(unknownPlan.error.retryable, false);
const rejectedAct = projectAgentFacingResponse(execDir, {
  status: 'SCENE_CHANGED', result: { sceneRef: scene.sceneId, revision: 999, action: { huge: true } },
}, request('act'));
assertEnvelope(rejectedAct, 'REJECTED');
assert.deepStrictEqual(rejectedAct.result, { outcome: 'SCENE_CHANGED', sceneRef: scene.sceneId });

// read bypasses the effect broker and remains available after finalization.
const missing = run(execDir, request('read', { ref: agentResources.resourceRef(execDir, 'scene', 'unknown') }), { executeRequest });
assertEnvelope(missing, 'REJECTED');
assert.strictEqual(missing.error.code, 'RESOURCE_UNKNOWN');
const executionPath = path.join(execDir, 'execution.json');
const execution = readJson(executionPath);
writeJsonAtomic(executionPath, { ...execution, finalized: true, lifecycle: 'FINALIZED' });
const countBeforeRead = brokerCalls;
for (const operation of AGENT_FACING_CAPABILITIES.filter((item) => item !== 'read')) {
  const example = require('../case-runtime/agent-facing-contract').PUBLIC_CONTRACT.methods[operation].minimalExample;
  const rejected = run(execDir, example, { executeRequest });
  assertEnvelope(rejected, 'REJECTED');
  assert.strictEqual(rejected.error.code, 'CASE_RUNTIME_FINALIZED');
}
const readResult = run(execDir, request('read', { ref: canonicalScene.ref }), {
  executeRequest,
  readResource: (ref) => {
    assert.strictEqual(ref, canonicalScene.ref);
    return { data: canonicalScene, resources: [
      { ref: 'shot-real', type: 'screenshot', role: 'visual' },
      { ref: 'unrelated', type: 'knowledgeDocument', role: 'unrelated' },
    ], declaredResources: [{ ref: 'shot-real', type: 'screenshot' }] };
  },
});
assertEnvelope(readResult);
assert.deepStrictEqual(readResult.data, canonicalScene);
assert.strictEqual(readResult.result.resourceRef, canonicalScene.ref);
assert.deepStrictEqual(readResult.resources, [{ ref: 'shot-real', type: 'screenshot', role: 'visual' }]);
assert.strictEqual(brokerCalls, countBeforeRead);
writeJsonAtomic(executionPath, { ...execution, schemaVersion: 13 });
const mismatch = run(execDir, request('observe'), { executeRequest });
assertEnvelope(mismatch, 'REJECTED');
assert.strictEqual(mismatch.error.code, 'PROTOCOL_MISMATCH');
writeJsonAtomic(executionPath, execution);
const immutableFlow = run(execDir, request('plan', { caseFlow: {
  ...initialPlanRequest.input.caseFlow, baseRevision: 2, reason: '错误复用节点',
} }), { executeRequest: () => ({ status: 'REQUEST_INVALID', code: 'CASE_FLOW_NODE_IDENTITY_CHANGED' }) });
assertEnvelope(immutableFlow, 'REJECTED');
assert.strictEqual(immutableFlow.error.code, 'CASE_FLOW_NODE_IDENTITY_CHANGED');
assert.match(immutableFlow.error.documentationRef, /error-case-flow-node-identity-changed$/);

const { main } = require('../case-runtime/agent-facing-client');
let stdout = '';
const originalWrite = process.stdout.write;
try {
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  main([], { execDir, stdin: JSON.stringify(request('observe')), executeRequest });
} finally { process.stdout.write = originalWrite; }
assert.strictEqual(stdout.trim().split('\n').length, 1, 'normal CLI emits one compact JSON object');
assertEnvelope(JSON.parse(stdout));
fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing Case Runtime passed');
