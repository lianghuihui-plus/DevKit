'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');
const { initialStateStrategy } = require('../lib/app-provisioning');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
const AGENT_FACING_PROTOCOL = 'agent-facing';
const AGENT_FACING_CAPABILITIES = Object.freeze(['observe', 'inspect', 'plan', 'recordResult', 'act', 'knowledge', 'recover', 'finish']);
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

const EXTERNAL_ACTION = object({ summary: STRING, tool: STRING }, ['summary']);

const VERIFICATION_POINT = object({ ref: STRING, text: STRING }, ['text']);
const CASE_MODEL_UPDATE = object({
  baseRevision: { oneOf: [{ type: 'integer', minimum: 1 }, { const: null }] },
  understanding: STRING,
  preconditions: STRING_ARRAY,
  verificationPoints: { type: 'array', minItems: 1, items: VERIFICATION_POINT },
  items: { type: 'array', minItems: 1, items: STRING },
  uncertainties: STRING_ARRAY,
  reason: STRING,
}, ['baseRevision', 'understanding', 'preconditions', 'verificationPoints', 'items', 'uncertainties']);
const RESULT_EVIDENCE = object({
  sceneRefs: STRING_ARRAY,
  knowledgeRefs: STRING_ARRAY,
  technicalRefs: STRING_ARRAY,
  searchAbsence: object({ sceneRef: STRING, scrollContextRef: STRING }, ['sceneRef', 'scrollContextRef']),
}, []);
const RESULT_REQUEST = object({
  expectationRef: STRING,
  status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'] },
  actual: STRING,
  evidence: RESULT_EVIDENCE,
}, ['expectationRef', 'status', 'actual']);

const SCHEMAS = Object.freeze({
  observe: object({
    capability: { const: 'observe' }, purpose: STRING,
  }, ['capability']),
  inspect: object({
    capability: { const: 'inspect' }, basedOnSceneRef: STRING,
    channel: { enum: ['visual', 'action', 'elements', 'layout'] },
    observation: STRING, expectationRefs: STRING_ARRAY,
    filter: object({ interactiveOnly: { type: 'boolean' }, textContains: STRING, role: STRING }, []),
  }, ['capability', 'basedOnSceneRef', 'channel']),
  plan: object({ capability: { const: 'plan' }, caseModel: CASE_MODEL_UPDATE }, ['capability', 'caseModel']),
  recordResult: object({
    capability: { const: 'recordResult' },
    results: { type: 'array', minItems: 1, items: RESULT_REQUEST },
  }, ['capability', 'results']),
  act: object({
    capability: { const: 'act' }, basedOnSceneRef: STRING, actionRef: STRING,
    input: INPUT, purpose: STRING,
  }, ['capability', 'basedOnSceneRef', 'actionRef', 'purpose']),
  knowledgeQuery: object({
    capability: { const: 'knowledge' }, basedOnSceneRef: STRING, query: STRING, expectationRefs: STRING_ARRAY,
  }, ['capability', 'basedOnSceneRef', 'query']),
  knowledgeReview: object({
    capability: { const: 'knowledge' }, basedOnSceneRef: STRING, queryId: STRING,
    conclusion: { enum: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
    assessments: { type: 'array', items: ASSESSMENT },
  }, ['capability', 'basedOnSceneRef', 'queryId', 'conclusion', 'assessments']),
  recover: object({
    capability: { const: 'recover' }, basedOnSceneRef: STRING, reason: STRING,
    targetState: { enum: ['APP_LOCAL_STATE_EMPTY', 'FRESH_INSTALL'] },
    externalAction: EXTERNAL_ACTION,
  }, ['capability', 'reason']),
  finish: object({
    capability: { const: 'finish' }, summary: STRING, uncertainties: STRING_ARRAY,
  }, ['capability', 'summary']),
});

const PUBLIC_ERRORS = Object.freeze({
  AGENT_INPUT_INVALID: { retryable: true, summary: '请求结构、类型或条件字段不合法。' },
  AGENT_INPUT_STALLED: { retryable: false, summary: '同类输入错误连续发生，停止自动猜测。' },
  PROTOCOL_MISMATCH: { retryable: false, summary: 'Prompt、文档、客户端或 execution 协议不一致。' },
  BINDING_INVALID: {
    retryable: false,
    summary: 'Execution 或 dispatch 绑定无效。',
    recovery: '读取 facts.technical.code：sequence 不匹配时原样复用当前 Loader/Brief 中的 command；只有 HANDOFF_REPLACED 才表示该 dispatch 已被真实 continuation 取代；HANDOFF_NOT_CLAIMED 表示 Loader 尚未成功 claim。',
  },
  SCENE_REQUIRED: { retryable: true, summary: '当前方法需要 Scene，但 execution 尚无 Scene。' },
  SCENE_CHANGED: { retryable: true, summary: '动作所依据的 Scene 已不是当前 Scene。' },
  ACTION_NOT_AVAILABLE: { retryable: true, summary: 'ActionRef 对当前 Scene 不成立。' },
  ACTION_INPUT_INVALID: { retryable: true, summary: '动作输入缺失、越界或包含不支持字段。' },
  VISUAL_INSPECTION_REQUIRED: { retryable: true, summary: '当前视觉动作或结论要求先登记图片事实。' },
  CASE_MODEL_REQUIRED: { retryable: true, summary: '当前 execution 尚无 Case Model。' },
  CASE_MODEL_REVISION_CONFLICT: { retryable: true, summary: 'Case Model baseRevision 不是当前 revision。' },
  EXPECTATION_UNKNOWN: { retryable: true, summary: 'ExpectationRef 不属于当前 ACTIVE 模型。' },
  RECORD_RESULT_INVALID: { retryable: true, summary: '验证结果缺少有效证据或字段不符合当前验证点。' },
  EVIDENCE_REFERENCE_INVALID: { retryable: true, summary: 'Scene、知识、技术或滚动证据引用无效。' },
  KNOWLEDGE_QUERY_UNKNOWN: { retryable: true, summary: '知识 queryId 不存在或不属于当前 execution。' },
  KNOWLEDGE_REVIEW_INVALID: { retryable: true, summary: '知识候选复核不满足当前 query 约束。' },
  APP_INITIAL_STATE_UNAVAILABLE: { retryable: true, summary: '授权的初始状态准备未完成。' },
  ACTION_OUTCOME_UNKNOWN: { retryable: false, summary: '动作可能已经投递，禁止自动重放。' },
  CASE_RESULT_INCOMPLETE: { retryable: true, summary: 'Ledger 仍有 unresolved 或 conflicts。' },
  TIME_LIMIT: { retryable: false, summary: '已停止新的设备动作。' },
  CASE_RUNTIME_TECHNICAL: { retryable: false, summary: '未归类的 execution 技术异常。' },
});

function method(name, summary, requestSchema, parameterDescriptions, options = {}) {
  return Object.freeze({
    name,
    summary,
    requestSchema,
    parameterDescriptions,
    conditionalRequirements: options.conditionalRequirements || [],
    contextualValidationRules: options.contextualValidationRules || [],
    successStatuses: options.successStatuses || [],
    errorCodes: options.errorCodes || ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: options.sideEffects || [],
    idempotency: options.idempotency || 'Read-only.',
    minimalExample: options.minimalExample,
  });
}

const PUBLIC_METHODS = Object.freeze({
  observe: method('observe', '采集一个新 Scene，不执行业务动作。', SCHEMAS.observe, {
    capability: '固定为 observe', purpose: '本次观察目的',
  }, {
    successStatuses: ['SCENE'], sideEffects: ['采集一个新 Scene'],
    idempotency: '设备采集不重放未知 effect；重复 observe 生成新的现场事实。', minimalExample: { capability: 'observe' },
  }),
  inspect: method('inspect', '登记视觉事实，或按需读取 elements 或 layout。', SCHEMAS.inspect, {
    capability: '固定为 inspect', basedOnSceneRef: '被检查的 Scene', channel: '检查通道',
    observation: 'visual/action 通道看到的事实', expectationRefs: '相关验证点', filter: 'elements 过滤器',
  }, {
    conditionalRequirements: ['visual/action 必须提供 observation。'],
    contextualValidationRules: ['历史 Scene 可登记事实；读取通道只返回所请求投影。'],
    successStatuses: ['VISUAL_INSPECTED', 'ACTION_SPATIAL_INSPECTED', 'SCENE_INSPECTION'],
    sideEffects: ['visual/action 追加事实事件'], idempotency: '相同 submission 不重复追加事实。',
    minimalExample: { capability: 'inspect', basedOnSceneRef: 'scene-1', channel: 'elements' },
  }),
  plan: method('plan', '单独创建或修订 Case Model。', SCHEMAS.plan, {
    capability: '固定为 plan', caseModel: '完整 Case Model 快照',
  }, {
    conditionalRequirements: ['首次 baseRevision 为 null；修订时等于当前 revision 且 reason 必填。'],
    contextualValidationRules: ['继续存在的验证点保留 ref；新验证点省略 ref。'],
    successStatuses: ['CASE_MODEL_RECORDED'], sideEffects: ['追加 Case Model revision'],
    idempotency: '相同 submission 只写一次 revision。',
    minimalExample: { capability: 'plan', caseModel: { baseRevision: null, understanding: '验证目标', preconditions: [], verificationPoints: [{ text: '结果可见' }], items: ['观察并验证'], uncertainties: [] } },
  }),
  recordResult: method('recordResult', '独立记录验证点结果，不采集 Scene、不执行动作。', SCHEMAS.recordResult, {
    capability: '固定为 recordResult', results: '已形成判断的验证结果和证据引用',
  }, {
    contextualValidationRules: ['所有结果先完整校验；任一结果无效时整批不写入。'],
    successStatuses: ['RESULTS_RECORDED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'EXPECTATION_UNKNOWN', 'EVIDENCE_REFERENCE_INVALID', 'RECORD_RESULT_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['追加 expectation result 事件'], idempotency: '相同结果重复提交不追加重复事件。',
    minimalExample: { capability: 'recordResult', results: [{ expectationRef: 'E1', status: 'PASS', actual: '目标结果可见', evidence: { sceneRefs: ['scene-1'] } }] },
  }),
  act: method('act', '基于当前 Scene 执行一个 ActionRef，并采集新 Scene。', SCHEMAS.act, {
    capability: '固定为 act', basedOnSceneRef: '当前 Scene', actionRef: '控件、屏幕或视觉动作引用',
    purpose: '业务动作目的', input: '动作类型对应输入',
  }, {
    conditionalRequirements: ['actionRef 对应动作所需 input 字段必须存在。'],
    contextualValidationRules: ['ActionRef、动态输入或 Scene 无效时拒绝 effect；业务判断通过 inspect 和 recordResult 单独提交。'],
    successStatuses: ['SCENE'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_CHANGED', 'ACTION_NOT_AVAILABLE', 'ACTION_INPUT_INVALID', 'VISUAL_INSPECTION_REQUIRED', 'ACTION_OUTCOME_UNKNOWN', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['最多投递一个设备动作', '采集新 Scene'],
    idempotency: '已投递且结果未知的动作永不重放。',
    minimalExample: { capability: 'act', basedOnSceneRef: 'scene-1', actionRef: 'button-1:tap', purpose: '继续' },
  }),
  knowledge: method('knowledge', '查询知识，或登记指定 query 的候选复核结果。', { oneOf: [SCHEMAS.knowledgeQuery, SCHEMAS.knowledgeReview] }, {
    capability: '固定为 knowledge', basedOnSceneRef: '当前 Scene', query: '待调查问题', queryId: '已有查询引用',
    expectationRefs: '相关验证点', conclusion: '候选复核结论', assessments: '逐候选适用性判断',
  }, {
    conditionalRequirements: ['query 与 queryId 两种模式互斥。'],
    contextualValidationRules: ['复核必须覆盖当前 query 候选约束。'],
    successStatuses: ['KNOWLEDGE', 'KNOWLEDGE_REVIEWED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_REQUIRED', 'KNOWLEDGE_QUERY_UNKNOWN', 'KNOWLEDGE_REVIEW_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['保存查询或复核事件'], idempotency: '重复 queryId 复核按内部事件规则处理。',
    minimalExample: { capability: 'knowledge', basedOnSceneRef: 'scene-1', query: '解释当前异常' },
  }),
  recover: method('recover', '建立授权的 App 初始状态、重启恢复或登记框架外事实。', SCHEMAS.recover, {
    capability: '固定为 recover', basedOnSceneRef: '重启恢复所依据的 Scene', reason: '恢复原因',
    targetState: '授权的目标 App 状态', externalAction: '已实际完成的框架外事实',
  }, {
    conditionalRequirements: ['targetState 与 externalAction 互斥。'],
    contextualValidationRules: ['有当前 Scene 的重启恢复必须绑定当前 Scene。'],
    successStatuses: ['SCENE', 'EXTERNAL_ACTION_RECORDED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_CHANGED', 'APP_INITIAL_STATE_UNAVAILABLE', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['执行授权恢复或保存外部事实'], idempotency: '由现有恢复事务保证。',
    minimalExample: { capability: 'recover', reason: '目标 App 无法继续交互' },
  }),
  finish: method('finish', '从 expectation ledger 收口并完成用例。', SCHEMAS.finish, {
    capability: '固定为 finish', summary: '最终摘要', uncertainties: '仍需披露的不确定性',
  }, {
    contextualValidationRules: ['不接收 updates 或全量 checks；Runtime 从 ledger 组装并执行完整性校验。'],
    successStatuses: ['COMPLETED', 'RESULT_INCOMPLETE'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'CASE_MODEL_REQUIRED', 'CASE_RESULT_INCOMPLETE', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['就绪后持久化最终结果'], idempotency: '复用现有可恢复 finish 事务。',
    minimalExample: { capability: 'finish', summary: '验证完成' },
  }),
});

const PUBLIC_CONTRACT = Object.freeze({
  interfaceKind: AGENT_FACING_INTERFACE_KIND,
  protocol: AGENT_FACING_PROTOCOL,
  methods: PUBLIC_METHODS,
  errors: PUBLIC_ERRORS,
});

function documentationRefFor(code) {
  const normalized = String(code || 'CASE_RUNTIME_TECHNICAL').replace(/_/g, '-').toLowerCase();
  return `references/case-runtime/errors.md#error-${normalized}`;
}

function schemaFor(request) {
  if (request?.capability === 'knowledge') return request.queryId !== undefined ? SCHEMAS.knowledgeReview : SCHEMAS.knowledgeQuery;
  if (request?.capability === 'recover') return SCHEMAS.recover;
  return SCHEMAS[request?.capability]
    || object({ capability: { enum: AGENT_FACING_CAPABILITIES } }, ['capability']);
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

function screenComparison(effect) {
  return effect?.status === 'CHANGED' ? 'DIFFERENT'
    : effect?.status === 'UNCHANGED' ? 'IDENTICAL' : 'UNAVAILABLE';
}

function projectPreviousAction(previousAction) {
  if (!previousAction) return null;
  const unknown = previousAction.outcomeKnown === false
    || previousAction.status === 'ACTION_OUTCOME_UNKNOWN'
    || previousAction.deliveryStatus === 'UNKNOWN';
  const commandStatus = previousAction.command?.status;
  const deliveryStatus = unknown ? 'UNKNOWN'
    : commandStatus === 'REJECTED' ? 'NOT_SENT'
      : previousAction.observedEffect || commandStatus === 'ACCEPTED' ? 'RESULT_RECORDED'
        : previousAction.deliveryStatus || 'UNKNOWN';
  const annotatedScreenshotPath = previousAction.spatialEvidence?.annotatedScreenshot?.path
    || previousAction.spatialEvidence?.annotatedScreenshotPath;
  const spatial = previousAction.spatialEvidence;
  return {
    operationRef: previousAction.operationRef || previousAction.operationId,
    type: previousAction.action?.type || previousAction.type || 'unknown',
    deliveryStatus,
    outcomeKnown: deliveryStatus !== 'UNKNOWN',
    screenComparison: screenComparison(previousAction.observedEffect),
    ...(spatial ? {
      spatialEvidence: {
        available: true,
        coordinateSource: spatial.source || spatial.coordinateSource || null,
        requested: spatial.requested || null,
        dispatched: spatial.dispatched || null,
        deviceActual: spatial.deviceActual ?? spatial.actual ?? null,
        ...(annotatedScreenshotPath ? { annotatedScreenshotPath } : {}),
      },
    } : {}),
  };
}

const PREPARATION_TARGETS = Object.freeze([
  { targetState: 'APP_LOCAL_STATE_EMPTY', meaning: '目标 App 本地状态为空' },
  { targetState: 'FRESH_INSTALL', meaning: '目标 App 处于首次安装状态' },
]);

function projectInitialState(execution, preparation = null) {
  const automaticTarget = execution?.initialStateRequirement?.targetState;
  const allowedEffects = new Set(execution?.preparationPolicy?.allowedEffects || []);
  return {
    automaticPreparation: automaticTarget && automaticTarget !== 'KEEP_EXISTING'
      ? automaticTarget : 'NONE',
    currentAppState: preparation?.status === 'SATISFIED' && preparation.targetState
      ? preparation.targetState : 'UNVERIFIED',
    availablePreparation: PREPARATION_TARGETS.map(({ targetState, meaning }) => {
      const strategy = initialStateStrategy(execution?.platform, targetState);
      return {
        targetState,
        meaning,
        authorized: strategy.requiredEffects.every((effect) => allowedEffects.has(effect)),
        platformEffect: strategy.strategy === 'REINSTALL_APP'
          ? '卸载并使用工作区冻结制品重装目标 App'
          : '清除目标 App 数据并冷启动',
      };
    }),
  };
}

function projectScene(scene, { caseModel = null } = {}) {
  if (!scene) return null;
  const interactive = (scene.elements || []).filter((element) => element.visible !== false
    && element.enabled !== false && Array.isArray(element.bounds)
    && (element.clickable || element.checkable || element.editable));
  const controls = interactive.slice(0, 24).map((element) => ({
    ref: element.id,
    ...(element.text ? { text: element.text } : {}),
    ...(element.role ? { role: element.role } : {}),
    bounds: element.bounds.map(Number),
    clickable: element.clickable === true,
    checkable: element.checkable === true,
    editable: element.editable === true,
    ...(element.focused === true ? { focused: true } : {}),
  }));
  const verticalScroll = (scene.scrollContexts || []).some((item) => item.axis === 'VERTICAL'
    && item.trackingStatus === 'TRACKING');
  const horizontalScroll = (scene.scrollContexts || []).some((item) => item.axis === 'HORIZONTAL'
    && item.trackingStatus === 'TRACKING');
  const focusedElement = interactive.find((element) => element.focused)
    || (scene.signals?.focusedElement && interactive.find((element) => element.id === scene.signals.focusedElement));
  const inForeground = scene.app?.inTargetApp !== false;
  const signals = scene.signals && Object.keys(scene.signals).length ? scene.signals : null;
  const conflicts = (scene.conflicts || []).length ? scene.conflicts : null;
  return {
    sceneRef: scene.sceneId,
    capturedAt: scene.capturedAt,
    ...(scene.captureTiming ? { captureTiming: scene.captureTiming } : {}),
    screenshot: {
      ref: scene.screenshot?.ref,
      path: scene.screenshot?.path,
      width: scene.screenshot?.width,
      height: scene.screenshot?.height,
    },
    targetApp: {
      inForeground,
      ...(!inForeground ? { actualApp: scene.app?.appId || scene.app?.bundleId || scene.app?.packageName } : {}),
    },
    controls: { total: interactive.length, truncated: interactive.length > 24, items: controls },
    interactionContext: {
      verticalScroll,
      horizontalScroll,
      ...(focusedElement ? { focusedElementRef: focusedElement.id } : {}),
      keyboardShown: scene.signals?.keyboard?.shown === true,
      visualGestures: [...(scene.visual?.gestures || [])],
    },
    ...(signals ? { signals } : {}),
    ...(conflicts ? { conflicts } : {}),
    ...(scene.previousAction ? { previousAction: projectPreviousAction(scene.previousAction) } : {}),
  };
}

module.exports = {
  AGENT_FACING_INTERFACE_KIND,
  AGENT_FACING_PROTOCOL,
  AGENT_FACING_CAPABILITIES,
  PUBLIC_CONTRACT,
  documentationRefFor,
  projectInitialState,
  projectPreviousAction,
  projectScene,
  validateAgentFacingRequest,
};
