'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
const AGENT_FACING_CAPABILITIES = Object.freeze(['observe', 'inspect', 'act', 'knowledge', 'recover', 'finish']);
const STRING = { type: 'string', minLength: 1 };
const STRING_ARRAY = { type: 'array', items: STRING };
const POINT = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1 } };

function object(properties, required) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const INPUT = object({
  durationMs: { type: 'integer', minimum: 1 },
  text: STRING,
  mode: { enum: ['replace', 'append'] },
  ms: { type: 'integer', minimum: 0 },
  point: POINT,
  from: POINT,
  to: POINT,
  duringActionAtMs: { type: 'integer', minimum: 20 },
}, []);

const ASSESSMENT = object({
  entryId: STRING,
  status: { enum: ['APPLICABLE', 'NOT_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
  reason: STRING,
}, ['entryId', 'status', 'reason']);

const CHECK = object({
  expectationRef: STRING,
  status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'] },
  actual: STRING,
  evidence: STRING_ARRAY,
  knowledgeRefs: STRING_ARRAY,
  technicalRefs: STRING_ARRAY,
  evidenceBasis: object({ type: { const: 'SEARCH_ABSENCE' }, sceneRef: STRING, scrollContextRef: STRING }, ['type', 'sceneRef', 'scrollContextRef']),
}, ['expectationRef', 'status', 'actual']);

const SCHEMAS = Object.freeze({
  observe: object({ capability: { const: 'observe' }, purpose: STRING, expectationRefs: STRING_ARRAY }, ['capability']),
  inspect: object({
    capability: { const: 'inspect' }, channel: { enum: ['visual', 'elements', 'capabilities', 'layout'] },
    observation: STRING, expectationRefs: STRING_ARRAY,
    filter: object({ interactiveOnly: { type: 'boolean' }, textContains: STRING, role: STRING, actionType: STRING, elementRef: STRING }, []),
  }, ['capability', 'channel']),
  act: object({ capability: { const: 'act' }, actionRef: STRING, input: INPUT, purpose: STRING, expectationRefs: STRING_ARRAY }, ['capability', 'actionRef', 'purpose']),
  knowledgeQuery: object({ capability: { const: 'knowledge' }, query: STRING, expectationRefs: STRING_ARRAY }, ['capability', 'query']),
  knowledgeReview: object({
    capability: { const: 'knowledge' }, queryId: STRING,
    conclusion: { enum: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
    assessments: { type: 'array', items: ASSESSMENT },
  }, ['capability', 'queryId', 'conclusion', 'assessments']),
  recover: object({ capability: { const: 'recover' }, reason: STRING }, ['capability', 'reason']),
  finish: object({ capability: { const: 'finish' }, summary: STRING, checks: { type: 'array', minItems: 1, items: CHECK }, uncertainties: STRING_ARRAY }, ['capability', 'summary', 'checks']),
});

function schemaFor(request) {
  if (request?.capability === 'knowledge') return request.queryId !== undefined ? SCHEMAS.knowledgeReview : SCHEMAS.knowledgeQuery;
  return SCHEMAS[request?.capability] || object({ capability: { enum: AGENT_FACING_CAPABILITIES } }, ['capability']);
}

function messageFor(issue) {
  if (issue.code === 'REQUIRED') return `必须提供 ${issue.fieldPath}`;
  if (issue.code === 'FIELD_UNSUPPORTED') return `${issue.fieldPath} 不是该能力支持的字段`;
  return `${issue.fieldPath || 'request'} 应为 ${issue.expected}`;
}

function validateAgentFacingRequest(request) {
  return validateAgentJson(request, schemaFor(request)).map((issue) => ({
    field: issue.fieldPath || 'request',
    message: messageFor(issue),
    code: issue.code,
  }));
}

function actionRefFor(capability) {
  return `${capability.target || 'screen'}:${capability.kind}`;
}

function actionExample(capability) {
  const example = {
    capability: 'act',
    actionRef: actionRefFor(capability),
    purpose: capability.label || '执行当前页面动作',
    expectationRefs: [],
  };
  if (capability.kind === 'longPress') example.input = { durationMs: 1200 };
  else if (capability.kind === 'inputText') example.input = { text: '测试文本', mode: 'replace' };
  else if (capability.kind === 'wait') example.input = { ms: 1000 };
  return example;
}

function visualActionExamples(scene) {
  const gestures = new Set(scene?.visual?.gestures || []);
  const values = [];
  if (gestures.has('tap')) values.push({ actionRef: 'visual:tap', label: '点击截图中的目标', requiredInput: ['point'], example: { capability: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] }, purpose: '点击截图中的目标', expectationRefs: [] } });
  if (gestures.has('doubleTap')) values.push({ actionRef: 'visual:doubleTap', label: '双击截图中的目标', requiredInput: ['point'], example: { capability: 'act', actionRef: 'visual:doubleTap', input: { point: [0.5, 0.5] }, purpose: '双击截图中的目标', expectationRefs: [] } });
  if (gestures.has('longPress')) values.push({ actionRef: 'visual:longPress', label: '长按截图中的目标', requiredInput: ['point', 'durationMs'], example: { capability: 'act', actionRef: 'visual:longPress', input: { point: [0.5, 0.5], durationMs: 1200, duringActionAtMs: 600 }, purpose: '长按截图中的目标并检查过程状态', expectationRefs: [] } });
  if (gestures.has('swipe')) values.push({ actionRef: 'visual:swipe', label: '在截图上滑动', requiredInput: ['from', 'to'], example: { capability: 'act', actionRef: 'visual:swipe', input: { from: [0.5, 0.75], to: [0.5, 0.25] }, purpose: '在截图上滑动', expectationRefs: [] } });
  return values;
}

function projectActions(scene) {
  const capabilities = (scene?.capabilities || []).map((capability) => ({
    actionRef: actionRefFor(capability),
    label: capability.label,
    requiredInput: capability.kind === 'longPress' ? ['durationMs']
      : capability.kind === 'inputText' ? ['text'] : capability.kind === 'wait' ? ['ms'] : [],
    example: actionExample(capability),
  }));
  return [...capabilities, ...visualActionExamples(scene)];
}

function finishTemplate(caseSpec) {
  return {
    capability: 'finish',
    summary: '简要说明本用例的最终结果',
    checks: (caseSpec?.expectations || []).map((item) => ({
      expectationRef: item.id,
      status: 'INCONCLUSIVE',
      actual: '说明该验证点的实际结果',
      evidence: ['current'],
    })),
    uncertainties: [],
  };
}

function capabilityCards({ scene = null, caseSpec = null } = {}) {
  const firstAction = projectActions(scene)[0]?.example || {
    capability: 'act', actionRef: 'visual:tap', input: { point: [0.5, 0.5] }, purpose: '点击截图中的目标', expectationRefs: [],
  };
  const finish = finishTemplate(caseSpec);
  if (!finish.checks.length) {
    finish.checks.push({ expectationRef: 'E1', status: 'INCONCLUSIVE', actual: '说明该验证点的实际结果', evidence: ['current'] });
  }
  return {
    observe: { useWhen: '没有 Scene，或页面可能已在外部发生变化', required: [], optional: ['purpose', 'expectationRefs'], source: {}, example: { capability: 'observe' }, returns: ['SCENE'] },
    inspect: { useWhen: '需要查看控件树、完整布局，或登记已实际查看的截图事实', required: ['channel'], optional: ['filter', 'observation', 'expectationRefs'], source: { channel: '当前调查意图' }, example: { capability: 'inspect', channel: 'elements' }, returns: ['SCENE_INSPECTION', 'VISUAL_INSPECTED'] },
    act: { useWhen: '当前 Scene 提供了可执行动作', required: ['actionRef', 'purpose'], optional: ['input', 'expectationRefs'], source: { actionRef: 'scene.actions[].actionRef', input: '对应 action 的 requiredInput/example' }, example: firstAction, returns: ['SCENE', 'SCENE_CHANGED'] },
    knowledge: { useWhen: '现场异常、无法解释、无法决定下一步，或负向结论需要知识支撑', required: ['query'], optional: ['expectationRefs'], source: { queryId: '知识查询响应的 nextCall.example' }, example: { capability: 'knowledge', query: '描述当前无法解释的问题', expectationRefs: [] }, returns: ['KNOWLEDGE', 'KNOWLEDGE_REVIEWED'] },
    recover: { useWhen: '目标 App 已无法继续交互，需要冷启动恢复', required: ['reason'], optional: [], source: {}, example: { capability: 'recover', reason: '目标 App 无法继续交互' }, returns: ['SCENE', 'RECOVERY_APPLIED'] },
    finish: { useWhen: '证据足够形成结论，或已无法安全继续', required: ['summary', 'checks'], optional: ['uncertainties'], source: { checks: 'Frozen CaseSpec expectations' }, example: finish, returns: ['COMPLETED', 'RESULT_INCOMPLETE'] },
  };
}

function projectScene(scene, { caseSpec = null } = {}) {
  if (!scene) return null;
  return {
    sceneRef: scene.sceneId,
    capturedAt: scene.capturedAt,
    screenshot: scene.screenshot,
    evidence: {
      visual: {
        available: scene.evidenceChannels?.visual?.available === true,
        tool: 'view_image',
        path: scene.screenshot?.path || null,
      },
      layout: {
        available: scene.evidenceChannels?.layout?.available === true,
        capability: 'inspect',
        channels: ['elements', 'capabilities', 'layout'],
      },
      policy: scene.evidenceChannels?.policy || null,
      conflictRule: scene.evidenceChannels?.conflictRule || null,
    },
    app: scene.app,
    signals: scene.signals,
    conflicts: scene.conflicts || [],
    previousAction: scene.previousAction || null,
    actions: projectActions(scene),
    inspect: {
      visual: { tool: 'view_image', path: scene.screenshot?.path || null, example: { capability: 'inspect', channel: 'visual', observation: '描述截图中实际看到的事实', expectationRefs: [] } },
      elements: { example: { capability: 'inspect', channel: 'elements' } },
      capabilities: { example: { capability: 'inspect', channel: 'capabilities' } },
      layout: { example: { capability: 'inspect', channel: 'layout' } },
    },
    finish: { example: finishTemplate(caseSpec) },
  };
}

module.exports = {
  AGENT_FACING_INTERFACE_KIND,
  AGENT_FACING_CAPABILITIES,
  actionRefFor,
  capabilityCards,
  finishTemplate,
  projectActions,
  projectScene,
  validateAgentFacingRequest,
};
