#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRuntimeRequest } = require('../case-runtime/contract');
const {
  AGENT_FACING_CAPABILITIES,
  capabilityCards,
  projectInitialState,
  projectScene,
  validateAgentFacingRequest,
} = require('../case-runtime/agent-facing-contract');
const {
  finishExample,
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
  schemaVersion: 11,
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
  entry: path.join(execDir, 'runtime-client.js'),
  requestPath: path.join(execDir, 'runtime-request.json'),
  agentFacing: { entry: path.join(execDir, 'agent-facing-client.js'), requestPath: path.join(execDir, 'agent-request.json') },
  broker: {
    allowedOperations: ['observe', 'act', 'inspectVisual', 'inspectScene', 'knowledge', 'recover', 'finish', 'status'],
  },
});
const scene = {
  schemaVersion: 2,
  sceneId: 'scene-0007',
  generation: 1,
  capturedAt: '2026-09-11T00:00:01.000Z',
  screenshot: { ref: 'screenshots/scene-0007.png', path: path.join(execDir, 'screenshots/scene-0007.png'), sha256: 'png-test', width: 1080, height: 1920 },
  evidenceChannels: {
    visual: { available: true, attachment: { path: path.join(execDir, 'screenshots/scene-0007.png') } },
    layout: { available: true },
    policy: 'COMBINE_VISUAL_AND_LAYOUT',
  },
  app: { appId: 'com.example.agent-facing', inTargetApp: true, page: 'voice' },
  signals: {},
  conflicts: [],
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

assert.deepStrictEqual(AGENT_FACING_CAPABILITIES, ['observe', 'inspect', 'plan', 'act', 'knowledge', 'recover', 'finish']);
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

const cards = capabilityCards({ scene, caseModel: null, initialState });
assert.deepStrictEqual(Object.keys(cards), AGENT_FACING_CAPABILITIES);
for (const card of Object.values(cards)) {
  assert.ok(card.useWhen);
  assert.ok(Array.isArray(card.required));
  assert.ok(Array.isArray(card.optional));
  assert.ok(card.example);
  assert.deepStrictEqual(validateAgentFacingRequest(card.example), []);
}
assert.strictEqual(JSON.stringify(cards).includes('basedOnSceneId'), false);
assert.strictEqual(JSON.stringify(cards).includes('decision'), false);
assert.strictEqual(JSON.stringify(cards).includes('operation'), false);
assert.match(cards.plan.useWhen, /本次用例理解/);
assert.doesNotMatch(cards.act.useWhen, /已有执行计划/);
assert.doesNotMatch(cards.recover.useWhen, /已有执行计划/);
assert.deepStrictEqual(cards.recover.modes.map((item) => item.mode), [
  'ESTABLISH_APP_LOCAL_STATE', 'ESTABLISH_FRESH_INSTALL', 'RESTART_APP', 'RECORD_EXTERNAL_ACTION',
]);
for (const mode of cards.recover.modes) {
  assert.ok(mode.useWhen);
  assert.deepStrictEqual(validateAgentFacingRequest(mode.example), []);
}
assert.strictEqual(cards.recover.modes[0].authorized, true);
assert.strictEqual(cards.recover.modes[1].authorized, true);
assert.strictEqual(cards.recover.modes[1].example.targetState, 'FRESH_INSTALL');
assert.match(cards.finish.useWhen, /本次用例理解/);
assert.ok(validateAgentFacingRequest({ capability: 'plan', items: [] })
  .some((item) => item.field === 'understanding' && item.code === 'REQUIRED'));
assert.ok(validateAgentFacingRequest({
  capability: 'plan', understanding: '验证首页', preconditions: [], verificationPoints: [{ text: '首页正常' }], items: [], uncertainties: [],
})
  .some((item) => item.field === 'items' && item.code === 'MIN_ITEMS'));
assert.ok(validateAgentFacingRequest({
  capability: 'plan', understanding: '验证首页', preconditions: [], verificationPoints: [{ text: '首页正常' }], items: ['检查首页'], uncertainties: [], extra: true,
})
  .some((item) => item.field === 'extra' && item.code === 'FIELD_UNSUPPORTED'));

const projectedScene = projectScene(scene, { caseModel: null });
assert.strictEqual(Object.prototype.hasOwnProperty.call(projectedScene, 'schemaVersion'), false);
assert.strictEqual(projectedScene.sceneRef, scene.sceneId);
assert.strictEqual(projectedScene.actions.some((item) => item.actionRef === 'record-button:longPress'), true);
assert.strictEqual(projectedScene.actions.some((item) => item.actionRef === 'visual:swipe'), true);
for (const action of projectedScene.actions) assert.deepStrictEqual(validateAgentFacingRequest(action.example), []);
assert.deepStrictEqual(projectedScene.inspect.visual.example, {
  capability: 'inspect', channel: 'visual', observation: '描述截图中实际看到的事实', expectationRefs: [],
});
assert.deepStrictEqual(projectedScene.finish.example.checks, []);

const actionBeforePlan = translateAgentFacingRequest(execDir, {
  capability: 'act', actionRef: 'record-button:longPress', input: { durationMs: 1200 },
  purpose: '长按录入语音', expectationRefs: [],
});
assert.strictEqual(actionBeforePlan.operation, 'act');
assert.throws(() => translateAgentFacingRequest(execDir, finishExample({
  summary: '无法继续',
  checks: [
    { expectationRef: 'E1', status: 'INCONCLUSIVE', actual: '尚未完成' },
    { expectationRef: 'E2', status: 'INCONCLUSIVE', actual: '尚未完成' },
  ],
})), (error) => error?.code === 'AGENT_INPUT_INVALID' && error.issues.some((item) => item.code === 'CASE_MODEL_REQUIRED'));

const initialPlanRequest = {
  capability: 'plan',
  understanding: '验证语音录入过程和结果',
  preconditions: [],
  verificationPoints: [{ text: '显示录音状态' }, { text: '完成语音录入' }],
  items: ['检查当前首页', '长按录音按钮', '验证录音状态'],
  uncertainties: [],
};
assert.deepStrictEqual(translateAgentFacingRequest(execDir, initialPlanRequest), {
  operation: 'recordCaseModel',
  caseModel: {
    understanding: initialPlanRequest.understanding,
    preconditions: initialPlanRequest.preconditions,
    verificationPoints: initialPlanRequest.verificationPoints,
    items: initialPlanRequest.items,
    uncertainties: initialPlanRequest.uncertainties,
  },
});
const planned = run(execDir, initialPlanRequest, { now: '2026-09-11T00:00:01.600Z' });
assert.strictEqual(planned.status, 'CASE_MODEL_RECORDED');
assert.deepStrictEqual(planned.caseModel.items, initialPlanRequest.items);
assert.deepStrictEqual(planned.caseModel.verificationPoints.map((item) => item.ref), ['E1', 'E2']);

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
const sceneWithAction = projectScene(scene, { caseModel: planned.caseModel });
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.coordinateTransform, 'MATCHED');
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.deviceActual, null);
assert.strictEqual(sceneWithAction.previousAction.screenComparison.status, 'IDENTICAL');
assert.strictEqual(sceneWithAction.previousAction.observedEffect, undefined);
assert.strictEqual(sceneWithAction.previousAction.spatialEvidence.inspect.example.channel, 'action');
const actionInspection = run(execDir, {
  capability: 'inspect', channel: 'action', observation: '滑动轨迹位于目标卡片区域上方', expectationRefs: ['E1'],
}, { now: '2026-09-11T00:00:01.700Z' });
assert.strictEqual(actionInspection.status, 'ACTION_SPATIAL_INSPECTED');
const actionInspectionEvent = runtimeStore.events(execDir).find((event) => event.type === 'actionSpatialInspected');
assert.strictEqual(actionInspectionEvent.operationId, 'action-0001');
assert.strictEqual(actionInspectionEvent.caseModelRevision, 1);
const externalRecovery = run(execDir, {
  capability: 'recover',
  reason: 'Runtime 无法表达当前技术恢复操作',
  externalAction: { summary: '已使用平台原生工具恢复当前 App 连接', tool: 'platform-cli' },
}, { now: '2026-09-11T00:00:01.800Z' });
assert.strictEqual(externalRecovery.status, 'EXTERNAL_ACTION_RECORDED');
assert.strictEqual(externalRecovery.declaration.evidence, false);
assert.deepStrictEqual(externalRecovery.nextCall.example, { capability: 'observe' });
const externalEvent = runtimeStore.events(execDir).find((event) => event.type === 'externalActionDeclared');
assert.strictEqual(externalEvent.evidence, false);
assert.strictEqual(externalEvent.caseModelRevision, 1);

const translations = [
  [{ capability: 'observe' }, { operation: 'observe' }],
  [{ capability: 'inspect', channel: 'elements', filter: { interactiveOnly: true } }, {
    operation: 'inspectScene', basedOnSceneId: scene.sceneId, view: 'ELEMENTS', filter: { interactiveOnly: true },
  }],
  [{ capability: 'inspect', channel: 'visual', observation: '页面显示系统权限弹窗', expectationRefs: ['E1'] }, {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs: ['E1'], observation: '页面显示系统权限弹窗' },
  }],
  [{ capability: 'act', actionRef: 'record-button:longPress', input: { durationMs: 1200 }, purpose: '长按录入语音', expectationRefs: ['E1'] }, {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:longPress:record-button', input: { durationMs: 1200 },
    decision: { purpose: '长按录入语音', expectationRefs: ['E1'] },
  }],
  [{ capability: 'act', actionRef: 'message-input:inputText', input: { text: '测试', mode: 'replace' }, purpose: '输入消息' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, capabilityId: 'scene-0007:inputText:message-input', input: { text: '测试', mode: 'replace' },
    decision: { purpose: '输入消息', expectationRefs: [] },
  }],
  [{ capability: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.4] }, purpose: '点击截图中的按钮' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'tap', point: [0.5, 0.4] },
    decision: { purpose: '点击截图中的按钮', expectationRefs: [] },
  }],
  [{ capability: 'act', actionRef: 'visual:swipe', input: { from: [0.5, 0.8], to: [0.5, 0.2] }, purpose: '向上滚动' }, {
    operation: 'act', basedOnSceneId: scene.sceneId, visual: { gesture: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] },
    decision: { purpose: '向上滚动', expectationRefs: [] },
  }],
  [{ capability: 'knowledge', query: '权限弹窗出现后语音录入无法继续', expectationRefs: ['E1'] }, {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: '权限弹窗出现后语音录入无法继续',
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs: ['E1'] },
  }],
  [{ capability: 'recover', reason: '目标 App 卡死' }, {
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
  query: '权限弹窗出现后语音录入无法继续', candidateCount: 1, expectationRefs: ['E1'], sceneId: scene.sceneId,
  candidates: [{ entryId: 'K-voice-001', title: '语音权限规则', snapshotRef: 'knowledge/k.md', expired: false }],
}, { now: '2026-09-11T00:00:02.000Z' });
const review = {
  capability: 'knowledge', queryId: 'knowledge-0001', conclusion: 'APPLICABLE_FOUND',
  assessments: [{ entryId: 'K-voice-001', status: 'APPLICABLE', reason: '当前权限弹窗与规则一致' }],
};
const translatedReview = translateAgentFacingRequest(execDir, review);
assert.deepStrictEqual(translatedReview, {
  operation: 'reviewKnowledge', basedOnSceneId: scene.sceneId,
  decision: {
    purpose: '登记知识候选复核结果', expectationRefs: ['E1'],
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
  ...initialPlanRequest, items: ['处理权限弹窗', '重新验证录音状态'],
});
assert.strictEqual(unexplainedPlanUpdate.status, 'INPUT_INVALID');
assert.ok(unexplainedPlanUpdate.issues.some((item) => item.field === 'reason' && item.code === 'REQUIRED'));
assert.deepStrictEqual(unexplainedPlanUpdate.retryWith, {
  ...initialPlanRequest,
  reason: '说明本次用例理解或计划变化原因',
  items: ['处理权限弹窗', '重新验证录音状态'],
});

const revisedPlan = run(execDir, {
  ...initialPlanRequest,
  verificationPoints: [{ ref: 'E1', text: '权限处理后显示录音状态' }, { ref: 'E2', text: '完成语音录入' }],
  capability: 'plan', reason: '权限弹窗改变了执行路径和验证条件',
  items: ['处理权限弹窗', '重新长按录音按钮', '验证录音状态'],
}, { now: '2026-09-11T00:00:03.100Z' });
assert.strictEqual(revisedPlan.status, 'CASE_MODEL_RECORDED');
assert.strictEqual(revisedPlan.caseModel.revision, 2);
assert.strictEqual(revisedPlan.caseModel.reason, '权限弹窗改变了执行路径和验证条件');

const knowledgeResponse = projectAgentFacingResponse(execDir, {
  status: 'KNOWLEDGE', queryId: 'knowledge-0001', query: '权限弹窗出现后语音录入无法继续',
  candidates: [{ entryId: 'K-voice-001', title: '语音权限规则' }],
  requiredReview: { template: { queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE', assessments: [{ entryId: 'K-voice-001', status: 'NOT_APPLICABLE', reason: '<reason>' }] } },
  scene,
});
assert.deepStrictEqual(knowledgeResponse.nextCall.example, {
  capability: 'knowledge', queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE',
  assessments: [{ entryId: 'K-voice-001', status: 'NOT_APPLICABLE', reason: '说明该候选对当前现场是否适用' }],
});
assert.deepStrictEqual(validateAgentFacingRequest(knowledgeResponse.nextCall.example), []);
assert.strictEqual(JSON.stringify(knowledgeResponse).includes('decision.knowledgeReview'), false);

const finish = finishExample({
  summary: '系统权限弹窗阻止语音录入',
  checks: [
    { expectationRef: 'E1', status: 'FAIL', actual: '长按后显示系统权限弹窗', evidence: ['current'] },
    { expectationRef: 'E2', status: 'INCONCLUSIVE', actual: '受权限弹窗阻止，未能完成录入', evidence: ['current'] },
  ],
});
const translatedFinish = translateAgentFacingRequest(execDir, finish);
assert.strictEqual(translatedFinish.operation, 'finish');
assert.strictEqual(translatedFinish.result.verdict, 'FAIL');
assert.deepStrictEqual(translatedFinish.result.checks.map((item) => item.sceneRefs), [[scene.sceneId], [scene.sceneId]]);
assert.deepStrictEqual(translatedFinish.decision.expectationRefs, ['E1', 'E2']);
assert.doesNotThrow(() => validateRuntimeRequest(translatedFinish));

let brokerCalls = 0;
const executeRequest = (directory, request) => {
  brokerCalls += 1;
  assert.strictEqual(directory, execDir);
  return { status: 'SCENE_INSPECTION', sceneId: request.basedOnSceneId, view: request.view, items: [] };
};
const invalid = run(execDir, { capability: 'act', actionRef: 'record-button:longPress', purpose: '长按录入语音' }, { executeRequest });
assert.strictEqual(invalid.status, 'INPUT_INVALID');
assert.strictEqual(invalid.code, 'AGENT_INPUT_INVALID');
assert.ok(invalid.issues.some((item) => item.field === 'input.durationMs'));
assert.deepStrictEqual(validateAgentFacingRequest(invalid.retryWith), []);
assert.strictEqual(brokerCalls, 0, 'invalid Agent input must not reach the Runtime broker');
const stalled = run(execDir, { capability: 'act', actionRef: 'record-button:longPress', purpose: '再次长按录入语音' }, { executeRequest });
assert.strictEqual(stalled.status, 'AGENT_INPUT_STALLED');
assert.strictEqual(stalled.code, 'AGENT_INPUT_STALLED');
assert.strictEqual(stalled.retryWith, undefined);
assert.strictEqual(brokerCalls, 0, 'repeated invalid Agent input must not reach the Runtime broker');
assert.strictEqual(Object.prototype.hasOwnProperty.call(readJson(path.join(execDir, 'agent-facing-state.json')), 'schemaVersion'), false);

const recovered = run(execDir, { capability: 'inspect', channel: 'elements' }, { executeRequest });
assert.strictEqual(recovered.status, 'SCENE_INSPECTION');
assert.strictEqual(brokerCalls, 1);
const invalidAgain = run(execDir, { capability: 'act', actionRef: 'record-button:longPress', purpose: '长按录入语音' }, { executeRequest });
assert.strictEqual(invalidAgain.status, 'INPUT_INVALID', 'a successful call resets the consecutive invalid-input guard');

const translationFailure = run(execDir, { capability: 'observe' }, {
  executeRequest: () => ({ status: 'REQUEST_INVALID', code: 'CASE_RUNTIME_REQUEST_INVALID', message: 'unexpected internal mismatch' }),
});
assert.strictEqual(translationFailure.status, 'TECHNICAL');
assert.strictEqual(translationFailure.code, 'FACADE_TRANSLATION_ERROR');
assert.deepStrictEqual(translationFailure.technicalContext, {
  scope: 'EXECUTION',
  code: 'FACADE_TRANSLATION_ERROR',
  summary: 'Facade 生成的内部请求未通过 Runtime：unexpected internal mismatch',
  logRefs: [],
  resourceFacts: ['stage=FACADE_TRANSLATION', 'execution=execution-agent-facing'],
  resume: { capability: 'observe' },
});

const guidedTechnical = projectAgentFacingResponse(execDir, {
  status: 'TECHNICAL',
  code: 'SCENE_CHANGED',
  nextCall: { reason: 'OBSERVE_CURRENT_SCENE', example: { capability: 'observe' } },
});
assert.deepStrictEqual(guidedTechnical.technicalContext.resume, { capability: 'observe' });
assert.strictEqual(guidedTechnical.technicalContext.scope, 'EXECUTION');

fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing Case Runtime passed');
