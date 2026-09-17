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
  projectScene,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const {
  projectAgentFacingResponse,
  translateAgentFacingRequest,
} = require('../case-runtime/agent-facing-translator');
const { run } = require('../case-runtime/agent-facing-client');
const runtimeStore = require('../case-runtime/store');
const { createActionSpatialEvidence, projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-facing-runtime-'));
const execDir = path.join(temp, 'execution-agent-facing');
fs.mkdirSync(path.join(execDir, 'scenes'), { recursive: true });
fs.mkdirSync(path.join(execDir, 'transactions'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), '长按录音按钮并验证录音状态');
fs.writeFileSync(path.join(execDir, 'events.jsonl'), '');
writeJsonAtomic(path.join(execDir, 'execution.json'), {
  schemaVersion: 12,
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
    allowedOperations: ['observe', 'act', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status'],
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
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', `${scene.sceneId}.json`), scene);

const forbiddenResponseKeys = new Set([
  'capabilities', 'actions', 'example', 'template', 'instruction', 'usage', 'useWhen', 'required',
  'optional', 'returns', 'retryWith', 'nextCall',
]);
function assertCompactResponse(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(assertCompactResponse);
  for (const [key, child] of Object.entries(value)) {
    assert.strictEqual(forbiddenResponseKeys.has(key), false, `forbidden response field: ${key}`);
    assertCompactResponse(child);
  }
}

assert.deepStrictEqual(AGENT_FACING_CAPABILITIES, ['observe', 'inspect', 'plan', 'recordResult', 'act', 'knowledge', 'recover', 'finish']);
const initialState = projectInitialState({
  platform: 'ios',
  initialStateRequirement: { targetState: 'KEEP_EXISTING' },
  preparationPolicy: {
    allowedEffects: ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'],
  },
});
assert.deepStrictEqual(initialState, {
  automaticPreparation: 'NONE',
  currentAppState: 'UNVERIFIED',
  availablePreparation: [
    {
      targetState: 'APP_LOCAL_STATE_EMPTY',
      meaning: '目标 App 本地状态为空',
      authorized: true,
      platformEffect: '卸载并使用工作区冻结制品重装目标 App',
    },
    {
      targetState: 'FRESH_INSTALL',
      meaning: '目标 App 处于首次安装状态',
      authorized: true,
      platformEffect: '卸载并使用工作区冻结制品重装目标 App',
    },
  ],
});
assert.strictEqual(JSON.stringify(initialState).includes('KEEP_EXISTING'), false);

assert.ok(validateAgentFacingRequest({ capability: 'plan', items: [] })
  .some((item) => item.field === 'caseFlow' && item.code === 'REQUIRED'));
assert.ok(validateAgentFacingRequest({
  capability: 'plan', caseModel: { baseRevision: null, understanding: '验证首页', preconditions: [], verificationPoints: [{ text: '首页正常' }], items: [], uncertainties: [] },
})
  .some((item) => item.field === 'caseFlow' && item.code === 'REQUIRED'));
assert.ok(validateAgentFacingRequest({
  capability: 'plan', caseFlow: {
    baseRevision: null, summary: '验证首页', entryNodeRef: 'N1',
    nodes: [
      { ref: 'N1', type: 'CHECK', text: '首页正常', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期' },
      { ref: 'N2', type: 'END', text: '完成' },
    ],
    edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [], extra: true,
  },
})
  .some((item) => item.field === 'caseFlow.extra' && item.code === 'FIELD_UNSUPPORTED'));

const projectedScene = projectScene(scene, { caseFlow: null });
assert.strictEqual(Object.prototype.hasOwnProperty.call(projectedScene, 'schemaVersion'), false);
assert.strictEqual(projectedScene.sceneRef, scene.sceneId);
assert.deepStrictEqual(projectedScene.captureTiming, scene.captureTiming);
assert.strictEqual(projectedScene.actions, undefined);
assert.strictEqual(projectedScene.capabilities, undefined);
assert.strictEqual(projectedScene.inspect, undefined);
assert.strictEqual(projectedScene.finish, undefined);
assert.strictEqual(projectedScene.caseModel, undefined);
assert.strictEqual(projectedScene.screenshot.sha256, undefined);
assert.strictEqual(projectedScene.controls.total, 2);
assert.strictEqual(projectedScene.controls.truncated, false);
assert.deepStrictEqual(projectedScene.controls.items.map((item) => item.ref), ['record-button', 'message-input']);
assert.strictEqual(projectedScene.interactionContext.verticalScroll, true);
assert.strictEqual(projectedScene.interactionContext.focusedElementRef, 'message-input');

const projectedBudgetScene = projectScene({
  ...scene,
  elements: Array.from({ length: 40 }, (_, index) => ({
    id: `control-${String(index).padStart(2, '0')}`,
    text: `第 ${index + 1} 个可交互控件`,
    role: 'Button',
    bounds: [0, index * 20, 400, index * 20 + 18],
    clickable: true, checkable: false, editable: false, enabled: true, visible: true,
  })),
}, { caseFlow: null });
assert.strictEqual(projectedBudgetScene.controls.items.length, 24);
assert.strictEqual(projectedBudgetScene.controls.truncated, true);
assert.ok(Buffer.byteLength(JSON.stringify(projectedBudgetScene)) <= 12 * 1024,
  'compact Scene fixture must remain within the Agent-facing byte budget');

const actionBeforePlan = translateAgentFacingRequest(execDir, {
  capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'record-button:longPress', input: { durationMs: 1200 },
  purpose: '长按录入语音',
});
assert.strictEqual(actionBeforePlan.operation, 'act');
assert.throws(() => translateAgentFacingRequest(execDir, { capability: 'finish',
  summary: '无法继续',
}), (error) => error?.code === 'AGENT_INPUT_INVALID' && error.issues.some((item) => item.code === 'CASE_FLOW_REQUIRED'));

const initialPlanRequest = {
  capability: 'plan',
  caseFlow: {
    baseRevision: null, summary: '验证语音录入过程和结果', entryNodeRef: 'N1',
    nodes: [
      { ref: 'N1', type: 'ACTION', text: '长按录音按钮' },
      { ref: 'N2', type: 'CHECK', text: '显示录音状态', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期' },
      { ref: 'N3', type: 'CHECK', text: '完成语音录入', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期' },
      { ref: 'N4', type: 'END', text: '完成' },
    ],
    edges: [
      { ref: 'L1', from: 'N1', to: 'N2' },
      { ref: 'L2', from: 'N2', to: 'N3' },
      { ref: 'L3', from: 'N3', to: 'N4' },
    ],
    uncertainties: [],
  },
};
assert.deepStrictEqual(translateAgentFacingRequest(execDir, initialPlanRequest), {
  operation: 'recordCaseFlow',
  caseFlow: { ...initialPlanRequest.caseFlow },
});
const planned = run(execDir, initialPlanRequest, { now: '2026-09-11T00:00:01.600Z' });
assert.strictEqual(planned.status, 'CASE_FLOW_RECORDED');
const plannedFlow = require('../case-runtime/case-flow-service').current(execDir);
assert.deepStrictEqual(plannedFlow.nodes.map((item) => item.ref), ['N1', 'N2', 'N3', 'N4']);
assert.deepStrictEqual(plannedFlow.nodes.filter((item) => item.type === 'CHECK').map((item) => item.ref), ['N2', 'N3']);
assert.strictEqual(planned.caseState.caseFlowRevision, 1);

fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(execDir, 'screenshots', 'scene-0007.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const spatialRef = createActionSpatialEvidence(execDir, {
  operationId: 'action-0001',
  action: { type: 'swipe', fromX: 0, fromY: 0, toX: 0, toY: 0, coordinateSource: 'visual' },
  request: { basisObservationRef: 'screenshots/scene-0007.png' },
}, { deviceExecution: { dispatchedFrom: { x: 0, y: 0 }, dispatchedTo: { x: 0, y: 0 } } });
scene.previousAction = {
  operationId: 'action-0001',
  action: { type: 'swipe' },
  spatialEvidence: projectActionSpatialEvidence(execDir, spatialRef, { operationId: 'action-0001', actionType: 'swipe' }),
  observedEffect: { status: 'UNCHANGED', beforeSceneRef: 'scene-0006', afterSceneRef: scene.sceneId },
};
writeJsonAtomic(path.join(execDir, 'current-scene.json'), scene);
writeJsonAtomic(path.join(execDir, 'scenes', `${scene.sceneId}.json`), scene);
const sceneWithAction = projectScene(scene, { caseFlow: plannedFlow });
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.available, true);
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.coordinateSource, 'visual');
assert.deepStrictEqual(sceneWithAction.previousAction.spatialEvidence.requested, {
  from: { x: 0, y: 0 }, to: { x: 0, y: 0 },
});
assert.deepStrictEqual(sceneWithAction.previousAction.spatialEvidence.dispatched, {
  from: { x: 0, y: 0 }, to: { x: 0, y: 0 },
});
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.deviceActual, null);
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.coordinateTransform, undefined);
assert.strictEqual(sceneWithAction.previousAction.screenComparison, 'IDENTICAL');
assert.strictEqual(sceneWithAction.previousAction.observedEffect, undefined);
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.annotatedScreenshotPath,
  scene.previousAction.spatialEvidence.annotatedScreenshot.path);
const actionInspection = run(execDir, {
  capability: 'inspect', basedOnSceneRef: scene.sceneId, channel: 'action', observation: '滑动轨迹位于目标卡片区域上方', checkNodeRefs: ['N2'],
}, { now: '2026-09-11T00:00:01.700Z' });
assert.strictEqual(actionInspection.status, 'ACTION_SPATIAL_INSPECTED');
const actionInspectionEvent = runtimeStore.events(execDir).find((event) => event.type === 'actionSpatialInspected');
assert.strictEqual(actionInspectionEvent.operationId, 'action-0001');
assert.strictEqual(actionInspectionEvent.caseFlowRevision, 1);
const externalRecovery = run(execDir, {
  capability: 'recover',
  basedOnSceneRef: scene.sceneId,
  reason: 'Runtime 无法表达当前技术恢复操作',
  externalAction: { summary: '已使用平台原生工具恢复当前 App 连接', tool: 'platform-cli' },
}, { now: '2026-09-11T00:00:01.800Z' });
assert.strictEqual(externalRecovery.status, 'EXTERNAL_ACTION_RECORDED');
assert.strictEqual(externalRecovery.declaration.evidence, false);
assert.strictEqual(externalRecovery.nextCall, undefined);
assertCompactResponse(externalRecovery);
const externalEvent = runtimeStore.events(execDir).find((event) => event.type === 'externalActionDeclared');
assert.strictEqual(externalEvent.evidence, false);
assert.strictEqual(externalEvent.caseFlowRevision, 1);
runtimeStore.appendEvent(execDir, 'visualInspected', {
  inspectionId: 'inspection-translation-fixture', sceneId: scene.sceneId,
  screenshotRef: scene.screenshot.ref, screenshotSha256: scene.screenshot.sha256,
  observation: '已查看当前截图', expectationRefs: [],
});

const translations = [
  [{ capability: 'observe' }, { operation: 'observe' }],
  [{ capability: 'inspect', basedOnSceneRef: scene.sceneId, channel: 'elements', filter: { interactiveOnly: true } }, {
    operation: 'inspectScene', basedOnSceneId: scene.sceneId, view: 'ELEMENTS', filter: { interactiveOnly: true },
  }],
  [{ capability: 'inspect', basedOnSceneRef: scene.sceneId, channel: 'visual', observation: '页面显示系统权限弹窗', checkNodeRefs: ['N2'] }, {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs: ['N2'], observation: '页面显示系统权限弹窗' },
  }],
  [{ capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'record-button:longPress', input: { durationMs: 1200 }, purpose: '长按录入语音' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:longPress:record-button', input: { durationMs: 1200 },
    decision: { purpose: '长按录入语音', expectationRefs: [] },
  }],
  [{ capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'message-input:inputText', input: { text: '测试', mode: 'replace' }, purpose: '输入消息' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:inputText:message-input', input: { text: '测试', mode: 'replace' },
    decision: { purpose: '输入消息', expectationRefs: [] },
  }],
  [{ capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'visual:tap', input: { point: [0.5, 0.4] }, purpose: '点击截图中的按钮' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'tap', point: [0.5, 0.4] },
    decision: { purpose: '点击截图中的按钮', expectationRefs: [] },
  }],
  [{ capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'visual:swipe', input: { from: [0.5, 0.8], to: [0.5, 0.2] }, purpose: '向上滚动' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] },
    decision: { purpose: '向上滚动', expectationRefs: [] },
  }],
  [{ capability: 'knowledge', basedOnSceneRef: scene.sceneId, query: '权限弹窗出现后语音录入无法继续', checkNodeRefs: ['N2'] }, {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: '权限弹窗出现后语音录入无法继续',
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs: ['N2'] },
  }],
  [{ capability: 'recover', basedOnSceneRef: scene.sceneId, reason: '目标 App 卡死' }, {
    operation: 'recover', basedOnSceneId: scene.sceneId, reason: '目标 App 卡死',
  }],
];
for (const [input, expected] of translations) {
  const translated = translateAgentFacingRequest(execDir, input);
  assert.deepStrictEqual(translated, expected);
  assert.doesNotThrow(() => validateRuntimeRequest(translated));
}

runtimeStore.appendEvent(execDir, 'knowledgeQueried', {
  queryId: 'knowledge-0001',
  query: '权限弹窗出现后语音录入无法继续', candidateCount: 1, expectationRefs: ['N2'], sceneId: scene.sceneId,
  candidates: [{ entryId: 'K-voice-001', title: '语音权限规则', snapshotRef: 'knowledge/k.md', expired: false }],
}, { now: '2026-09-11T00:00:02.000Z' });
const review = {
  capability: 'knowledge', basedOnSceneRef: scene.sceneId, queryId: 'knowledge-0001', conclusion: 'APPLICABLE_FOUND',
  assessments: [{ entryId: 'K-voice-001', status: 'APPLICABLE', reason: '当前权限弹窗与规则一致' }],
};
const translatedReview = translateAgentFacingRequest(execDir, review);
assert.deepStrictEqual(translatedReview, {
  operation: 'reviewKnowledge', basedOnSceneId: scene.sceneId,
  decision: {
    purpose: '登记知识候选复核结果', expectationRefs: ['N2'],
    knowledgeReview: {
      queryId: 'knowledge-0001', conclusion: 'APPLICABLE_FOUND',
      assessments: [{ entryId: 'K-voice-001', status: 'APPLICABLE', reason: '当前权限弹窗与规则一致' }],
    },
  },
});
assert.doesNotThrow(() => validateRuntimeRequest(translatedReview));
const completedReview = run(execDir, review, { now: '2026-09-11T00:00:03.000Z' });
assert.strictEqual(completedReview.status, 'KNOWLEDGE_REVIEWED');
assert.strictEqual(completedReview.queryId, 'knowledge-0001');
assert.strictEqual(require('../case-runtime/store').events(execDir).filter((event) => event.type === 'knowledgeReviewed').length, 1);

const unexplainedPlanUpdate = run(execDir, {
  ...initialPlanRequest,
  caseFlow: { ...initialPlanRequest.caseFlow, baseRevision: 1 },
});
assert.strictEqual(unexplainedPlanUpdate.status, 'INPUT_INVALID');
assert.ok(unexplainedPlanUpdate.issues.some((item) => item.field === 'caseFlow.reason' && item.code === 'REQUIRED'));
assert.strictEqual(unexplainedPlanUpdate.retryWith, undefined);

const revisedPlan = run(execDir, {
  ...initialPlanRequest,
  caseFlow: {
    ...initialPlanRequest.caseFlow,
    baseRevision: 1,
    reason: '权限弹窗改变了执行路径和验证条件',
    nodes: initialPlanRequest.caseFlow.nodes.map((node) => node.ref === 'N2'
      ? { ...node, text: '权限处理后显示录音状态' } : node),
  },
}, { now: '2026-09-11T00:00:03.100Z' });
assert.strictEqual(revisedPlan.status, 'CASE_FLOW_RECORDED');
const revisedFlow = require('../case-runtime/case-flow-service').current(execDir);
assert.strictEqual(revisedFlow.revision, 2);
assert.strictEqual(revisedFlow.reason, '权限弹窗改变了执行路径和验证条件');

const recordedResults = run(execDir, {
  capability: 'recordResult',
  results: [
    { checkNodeRef: 'N2', status: 'PASS', actual: '权限处理后显示录音状态', evidence: { sceneRefs: [scene.sceneId] } },
    { checkNodeRef: 'N3', status: 'INCONCLUSIVE', actual: '当前现场不足以确认完整录音结果', evidence: { sceneRefs: [scene.sceneId] } },
  ],
}, { now: '2026-09-11T00:00:03.200Z' });
assert.strictEqual(recordedResults.status, 'RESULTS_RECORDED');
assert.deepStrictEqual(recordedResults.recorded, ['N2', 'N3']);
assert.deepStrictEqual(recordedResults.unchanged, []);
assert.strictEqual(recordedResults.readiness.ready, false);
const repeatedResults = run(execDir, {
  capability: 'recordResult',
  results: [
    { checkNodeRef: 'N2', status: 'PASS', actual: '权限处理后显示录音状态', evidence: { sceneRefs: [scene.sceneId] } },
    { checkNodeRef: 'N3', status: 'INCONCLUSIVE', actual: '当前现场不足以确认完整录音结果', evidence: { sceneRefs: [scene.sceneId] } },
  ],
}, { now: '2026-09-11T00:00:03.300Z' });
assert.deepStrictEqual(repeatedResults.recorded, []);
assert.deepStrictEqual(repeatedResults.unchanged, ['N2', 'N3']);
const resultEventCount = runtimeStore.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length;
const invalidResults = run(execDir, {
  capability: 'recordResult',
  results: [
    { checkNodeRef: 'N2', status: 'PASS', actual: '仍然可见', evidence: { sceneRefs: [scene.sceneId] } },
    { checkNodeRef: 'N9', status: 'PASS', actual: '未知验证点', evidence: { sceneRefs: [scene.sceneId] } },
  ],
});
assert.strictEqual(invalidResults.status, 'INPUT_INVALID');
assert.strictEqual(invalidResults.code, 'EXPECTATION_UNKNOWN');
assert.strictEqual(runtimeStore.events(execDir).filter((event) => event.type === 'expectationResultUpdated').length, resultEventCount);

const knowledgeResponse = projectAgentFacingResponse(execDir, {
  status: 'KNOWLEDGE', queryId: 'knowledge-0001', query: '权限弹窗出现后语音录入无法继续',
  candidates: [{ entryId: 'K-voice-001', title: '语音权限规则' }],
  requiredReview: { template: { queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE', assessments: [{ entryId: 'K-voice-001', status: 'NOT_APPLICABLE', reason: '<reason>' }] } },
  scene,
});
assert.strictEqual(knowledgeResponse.nextCall, undefined);
assertCompactResponse(knowledgeResponse);
assert.strictEqual(JSON.stringify(knowledgeResponse).includes('decision.knowledgeReview'), false);
assert.strictEqual(JSON.stringify(knowledgeResponse).includes('expectationRefs'), false);

assert.ok(validateAgentFacingRequest({
  capability: 'finish', summary: '系统权限弹窗阻止语音录入', checks: [],
}).some((item) => item.field === 'checks' && item.code === 'FIELD_UNSUPPORTED'));

let brokerCalls = 0;
const executeRequest = (directory, request) => {
  brokerCalls += 1;
  assert.strictEqual(directory, execDir);
  return { status: 'SCENE_INSPECTION', sceneId: request.basedOnSceneId, view: request.view, items: [] };
};
const invalid = run(execDir, { capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'record-button:longPress', purpose: '长按录入语音' }, { executeRequest });
assert.strictEqual(invalid.status, 'INPUT_INVALID');
assert.strictEqual(invalid.code, 'ACTION_INPUT_INVALID');
assert.ok(invalid.issues.some((item) => item.field === 'input.durationMs'));
assert.strictEqual(invalid.retryWith, undefined);
assert.strictEqual(brokerCalls, 0, 'invalid Agent input must not reach the Runtime broker');
assertCompactResponse(invalid);
assert.strictEqual(invalid.protocol, 'agent-facing');
assert.match(invalid.documentationRef, /references\/case-runtime\/errors\.md#error-/);
const stalled = run(execDir, { capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'record-button:longPress', purpose: '再次长按录入语音' }, { executeRequest });
assert.strictEqual(stalled.status, 'AGENT_INPUT_STALLED');
assert.strictEqual(stalled.code, 'AGENT_INPUT_STALLED');
assert.strictEqual(stalled.retryWith, undefined);
assert.strictEqual(brokerCalls, 0, 'repeated invalid Agent input must not reach the Runtime broker');
assert.strictEqual(Object.prototype.hasOwnProperty.call(readJson(path.join(execDir, 'agent-facing-state.json')), 'schemaVersion'), false);

const recovered = run(execDir, { capability: 'inspect', basedOnSceneRef: scene.sceneId, channel: 'elements' }, { executeRequest });
assert.strictEqual(recovered.status, 'SCENE_INSPECTION');
assert.strictEqual(brokerCalls, 1);
const invalidAgain = run(execDir, { capability: 'act', basedOnSceneRef: scene.sceneId, actionRef: 'record-button:longPress', purpose: '长按录入语音' }, { executeRequest });
assert.strictEqual(invalidAgain.status, 'INPUT_INVALID', 'a successful call resets the consecutive invalid-input guard');

const translationFailure = run(execDir, { capability: 'observe' }, {
  executeRequest: () => ({ status: 'REQUEST_INVALID', code: 'CASE_RUNTIME_REQUEST_INVALID', message: 'unexpected internal mismatch' }),
});
assert.strictEqual(translationFailure.status, 'TECHNICAL');
assert.strictEqual(translationFailure.technicalContext, undefined);
assert.strictEqual(translationFailure.diagnostic, undefined);
assert.strictEqual(translationFailure.code, 'CASE_RUNTIME_TECHNICAL');
assert.deepStrictEqual(translationFailure.facts, {
  technical: { code: 'CASE_RUNTIME_REQUEST_INVALID', stage: 'FACADE_TRANSLATION' },
});
assert.match(translationFailure.documentationRef, /error-case-runtime-technical$/);
assertCompactResponse(translationFailure);

const guidedTechnical = projectAgentFacingResponse(execDir, {
  status: 'TECHNICAL',
  code: 'SCENE_CHANGED',
  nextCall: { reason: 'OBSERVE_CURRENT_SCENE', example: { capability: 'observe' } },
  diagnostic: { recovery: { nextCall: { capability: 'observe' } } },
});
assert.strictEqual(guidedTechnical.technicalContext, undefined);
assert.strictEqual(guidedTechnical.nextCall, undefined);
assert.strictEqual(guidedTechnical.diagnostic, undefined);
assert.match(guidedTechnical.documentationRef, /error-scene-changed$/);
assertCompactResponse(guidedTechnical);

fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing Case Runtime passed');
