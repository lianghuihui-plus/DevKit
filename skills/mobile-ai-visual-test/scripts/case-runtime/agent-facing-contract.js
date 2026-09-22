'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');
const { initialStateStrategy } = require('../lib/app-provisioning');
const { safeActionTechnicalDetails } = require('../lib/action-result');
const { AGENT_FACING_PROTOCOL, AGENT_FACING_STATUSES, RESOURCE_DESCRIPTOR_SCHEMA, requestEnvelopeSchema } = require('../lib/agent-facing-envelope');
const { PLAN_STEP_SCHEMA, MAX_PLAN_STEPS, MAX_PLAN_DURATION_MS } = require('./plan-contract');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
const AGENT_FACING_CAPABILITIES = Object.freeze(['observe', 'read', 'inspect', 'plan', 'recordResult', 'act', 'runPlan', 'knowledge', 'recover', 'finish']);
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
}, []);
const ACTION = { oneOf: [
  object({ ref: STRING, input: INPUT }, ['ref']),
  object({ type: { enum: ['tap', 'doubleTap'] }, target: object({ point: POINT }, ['point']) }, ['type', 'target']),
  object({ type: { const: 'longPress' }, target: object({ point: POINT }, ['point']), durationMs: { type: 'integer', minimum: 1 } }, ['type', 'target', 'durationMs']),
  object({ type: { const: 'swipe' }, target: object({ from: POINT, to: POINT }, ['from', 'to']) }, ['type', 'target']),
] };

const ASSESSMENT = object({
  entryId: STRING,
  status: { enum: ['APPLICABLE', 'NOT_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
  reason: STRING,
}, ['entryId', 'status', 'reason']);

const EXTERNAL_ACTION = object({ summary: STRING, tool: STRING }, ['summary']);

const CASE_FLOW_NODE = {
  oneOf: [
    object({ ref: STRING, type: { const: 'ACTION' }, text: STRING }, ['ref', 'type', 'text']),
    object({ ref: STRING, type: { const: 'DECISION' }, text: STRING, sourceBasis: STRING }, ['ref', 'type', 'text', 'sourceBasis']),
    object({
      ref: STRING, type: { const: 'CHECK' }, text: STRING, sourceBasis: STRING,
      verificationKind: { enum: ['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE'] }, requirement: { const: 'REQUIRED' },
    }, ['ref', 'type', 'text', 'sourceBasis', 'verificationKind', 'requirement']),
    object({
      ref: STRING, type: { const: 'CHECK' }, text: STRING, sourceBasis: STRING,
      verificationKind: { enum: ['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE'] },
      requirement: { const: 'CONDITIONAL' }, applicability: STRING,
    }, ['ref', 'type', 'text', 'sourceBasis', 'verificationKind', 'requirement', 'applicability']),
    object({ ref: STRING, type: { const: 'END' }, text: STRING }, ['ref', 'type', 'text']),
  ],
};
const CASE_FLOW_EDGE = object({ ref: STRING, from: STRING, to: STRING, condition: STRING }, ['ref', 'from', 'to']);
const CASE_FLOW_UPDATE = object({
  baseRevision: { oneOf: [{ type: 'integer', minimum: 1 }, { const: null }] },
  summary: STRING,
  entryNodeRef: STRING,
  nodes: { type: 'array', minItems: 1, items: CASE_FLOW_NODE },
  edges: { type: 'array', minItems: 1, items: CASE_FLOW_EDGE },
  uncertainties: STRING_ARRAY,
  reason: STRING,
}, ['baseRevision', 'summary', 'entryNodeRef', 'nodes', 'edges', 'uncertainties']);
const RESULT_EVIDENCE = object({
  sceneRefs: STRING_ARRAY,
  knowledgeRefs: STRING_ARRAY,
  technicalRefs: STRING_ARRAY,
  searchAbsence: object({ sceneRef: STRING, scrollContextRef: STRING }, ['sceneRef', 'scrollContextRef']),
}, []);
const RESULT_REQUEST = object({
  checkNodeRef: STRING,
  status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_APPLICABLE', 'WAIVED'] },
  actual: STRING,
  reason: STRING,
  evidence: RESULT_EVIDENCE,
}, ['checkNodeRef', 'status', 'actual']);
const NOT_RUN_EVIDENCE = object({ sceneRefs: STRING_ARRAY, technicalRefs: STRING_ARRAY }, ['sceneRefs', 'technicalRefs']);
const FLOW_CONTEXT = object({ nodeRef: STRING, selectedEdgeRef: STRING }, ['nodeRef']);

const SCHEMAS = Object.freeze({
  observe: object({
    purpose: STRING, flowContext: FLOW_CONTEXT,
  }, []),
  read: object({ ref: STRING }, ['ref']),
  inspect: { type: 'object', oneOf: ['visual', 'action'].map((mode) => object({
    mode: { const: mode }, sceneRef: STRING,
    observation: STRING, checkNodeRefs: STRING_ARRAY, flowContext: FLOW_CONTEXT,
  }, ['mode', 'sceneRef', 'observation'])) },
  plan: object({ caseFlow: CASE_FLOW_UPDATE }, ['caseFlow']),
  recordResult: object({
    results: { type: 'array', minItems: 1, items: RESULT_REQUEST },
  }, ['results']),
  act: object({
    sceneRef: STRING, action: ACTION, purpose: STRING, flowContext: FLOW_CONTEXT,
  }, ['sceneRef', 'action']),
  runPlan: object({
    submissionId: STRING, sceneRef: STRING,
    purpose: STRING, maxDurationMs: { type: 'integer', minimum: 1, maximum: MAX_PLAN_DURATION_MS }, onFailure: { enum: ['STOP', 'CONTINUE'] },
    steps: { type: 'array', minItems: 1, maxItems: MAX_PLAN_STEPS, items: PLAN_STEP_SCHEMA },
    flowContext: FLOW_CONTEXT,
  }, ['submissionId', 'sceneRef', 'purpose', 'maxDurationMs', 'onFailure', 'steps']),
  knowledgeQuery: object({
    mode: { const: 'query' }, sceneRef: STRING, query: STRING, checkNodeRefs: STRING_ARRAY, flowContext: FLOW_CONTEXT,
  }, ['mode', 'sceneRef', 'query']),
  knowledgeReview: object({
    mode: { const: 'review' }, sceneRef: STRING, queryId: STRING,
    conclusion: { enum: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
    assessments: { type: 'array', items: ASSESSMENT }, flowContext: FLOW_CONTEXT,
  }, ['mode', 'sceneRef', 'queryId', 'conclusion', 'assessments']),
  recover: { type: 'object', oneOf: [
    object({ mode: { const: 'restart' }, sceneRef: STRING, reason: STRING, flowContext: FLOW_CONTEXT }, ['mode', 'sceneRef', 'reason']),
    object({ mode: { const: 'prepare' }, reason: STRING, targetState: { enum: ['APP_LOCAL_STATE_EMPTY', 'FRESH_INSTALL'] }, flowContext: FLOW_CONTEXT }, ['mode', 'reason', 'targetState']),
    object({ mode: { const: 'external' }, reason: STRING, externalAction: EXTERNAL_ACTION, flowContext: FLOW_CONTEXT }, ['mode', 'reason', 'externalAction']),
  ] },
  finish: { type: 'object', oneOf: [object({
    mode: { const: 'complete' }, summary: STRING, uncertainties: STRING_ARRAY, flowContext: FLOW_CONTEXT,
  }, ['mode', 'summary']), object({
    mode: { const: 'notRun' }, reason: STRING,
    evidence: NOT_RUN_EVIDENCE, summary: STRING, uncertainties: STRING_ARRAY, flowContext: FLOW_CONTEXT,
  }, ['mode', 'reason', 'evidence', 'summary'])] },
});

const PUBLIC_ERRORS = Object.freeze({
  CASE_RUNTIME_FINALIZED: { group: 'transport', retryable: false, summary: 'Execution 已完成，只能读取已保存资源。', recovery: '使用 read 读取已有资源。' },
  RESOURCE_UNKNOWN: { group: 'transport', retryable: true, summary: '资源引用尚未发布。', recovery: '原样复制当前绑定发布的资源 ref。' },
  RESOURCE_SCOPE_MISMATCH: { group: 'transport', retryable: false, summary: '资源引用属于其他作用域。', recovery: '使用发布该引用的已绑定 command。' },
  RESOURCE_INTEGRITY_INVALID: { group: 'runtime', retryable: false, summary: '已发布资源缺失或完整性校验失败。', recovery: '保留现场并报告资源完整性故障。' },
  AGENT_INPUT_INVALID: { group: 'transport', retryable: true, summary: '请求结构、类型或条件字段不合法。', recovery: '根据 issues 修正当前方法请求一次；字段只取自当前方法页和 Runtime 响应。' },
  AGENT_INPUT_STALLED: { group: 'transport', retryable: false, summary: '同类输入错误连续发生，停止自动猜测。', recovery: '停止修改参数，读取当前方法页并核对绑定命令；仍不一致时保留请求和响应进行技术排障。' },
  PROTOCOL_MISMATCH: { group: 'transport', retryable: false, summary: 'Prompt、文档、客户端或 execution 协议不一致。', recovery: '停止执行该 execution，保留 Loader 输出和摘要；使用当前 Skill 新建 execution，不修改旧 execution。' },
  BINDING_INVALID: {
    group: 'transport',
    retryable: false,
    summary: 'Execution 或 dispatch 绑定无效。',
    recovery: '按 technicalFact 资源核对绑定：sequence 不匹配时原样复用当前 Loader/Brief 中的 command；只有 HANDOFF_REPLACED 才表示该 dispatch 已被真实 continuation 取代；HANDOFF_NOT_CLAIMED 表示 Loader 尚未成功 claim。',
  },
  SCENE_REQUIRED: { group: 'scene-action', retryable: true, summary: '当前方法需要 Scene，但 execution 尚无 Scene。', recovery: '先调用 observe 采集当前 Scene，再使用返回的 sceneRef 调用原方法。' },
  SCENE_CHANGED: { group: 'scene-action', retryable: true, resourceTypes: ['scene', 'screenshot'], summary: '动作所依据的 Scene 已不是当前 Scene。', recovery: '调用 observe 获取新 Scene，重新 inspect 并从新 Scene 选择 ActionRef；不要复用旧动作。' },
  ACTION_NOT_AVAILABLE: { group: 'scene-action', retryable: true, summary: 'ActionRef 对当前 Scene 不成立。', recovery: '读取当前 Scene 的 action 投影；必要时重新 observe，不手工拼接或猜测 ActionRef。' },
  ACTION_INPUT_INVALID: { group: 'scene-action', retryable: true, summary: '动作输入缺失、越界或包含不支持字段。', recovery: '按当前 ActionRef 返回的输入约束修正 input；坐标使用 0 到 1 的归一化值。' },
  ACTION_EFFECT_MISMATCH: { group: 'scene-action', retryable: true, resourceTypes: ['scene', 'screenshot', 'actionSpatialEvidence', 'technicalFact'], summary: '动作结果已知，但技术核验未满足所请求的输入效果。', recovery: '读取动作技术证据和当前 Scene；Agent 判断可安全重试时有限重试，不直接据此判定产品 FAIL。' },
  VISUAL_INSPECTION_REQUIRED: { group: 'scene-action', retryable: true, summary: '当前视觉动作或结论要求先登记图片事实。', recovery: '对同一 Scene 调用 inspect(mode="visual") 登记实际看到的事实，再重试视觉动作或结果记录。' },
  CASE_FLOW_REQUIRED: { group: 'flow-result', retryable: true, summary: '当前 execution 尚无 Case Flow。', recovery: '读取原始用例并调用 plan 创建完整 Case Flow，然后从 entryNodeRef 开始执行。' },
  CASE_FLOW_REVISION_CONFLICT: { group: 'flow-result', retryable: true, summary: 'Case Flow baseRevision 不是当前 revision。', recovery: '读取响应中的当前 Case Flow revision，合并仍需要的调整理由后基于该 revision 重新提交。' },
  CASE_FLOW_CONTEXT_INVALID: { group: 'flow-result', retryable: true, summary: 'flowContext 的节点或分支不属于当前 Case Flow revision。', recovery: '使用当前 Case Flow 返回的 nodeRef 和 edgeRef；不要复用已 retired 的引用。' },
  CASE_FLOW_NODE_IDENTITY_CHANGED: { group: 'flow-result', retryable: true, summary: 'Case Flow 节点 ref 被用于不同含义。', recovery: '保留 Baseline 节点和既有 CHECK 的原始含义；现场适配或语义修正使用新的节点 ref 后重新提交。' },
  CASE_FLOW_EDGE_IDENTITY_CHANGED: { group: 'flow-result', retryable: true, summary: 'Baseline Flow 边 ref 的端点或条件被改写。', recovery: '保留 Baseline 边的 from、to 和 condition；分支语义变化时使用新的边 ref 后重新提交。' },
  EXPECTATION_UNKNOWN: { group: 'flow-result', retryable: true, summary: 'checkNodeRef 不属于可处置的 CHECK 节点。', recovery: '使用 Baseline CHECK 或最终 Working Flow 中仍活跃的补充 CHECK；已退休的补充检查点只能保留历史结果。' },
  RECORD_RESULT_INVALID: { group: 'flow-result', retryable: true, summary: '验证结果缺少有效证据或字段不符合当前验证点。', recovery: '按响应 issues 补齐 actual 和匹配当前验证类型的证据；证据不足时使用 INCONCLUSIVE。' },
  EVIDENCE_REFERENCE_INVALID: { group: 'flow-result', retryable: true, summary: 'Scene、知识、技术或滚动证据引用无效。', recovery: '只引用当前 execution 已登记并由 Runtime 返回的证据 ref；缺失时先采集或登记事实。' },
  KNOWLEDGE_QUERY_UNKNOWN: { group: 'knowledge-recovery', retryable: true, summary: '知识 queryId 不存在或不属于当前 execution。', recovery: '先调用 knowledge(query) 创建查询，并使用该响应返回的 queryId 复核候选。' },
  KNOWLEDGE_REVIEW_INVALID: { group: 'knowledge-recovery', retryable: true, summary: '知识候选复核不满足当前 query 约束。', recovery: '逐条覆盖当前 query 返回的候选并给出适用性原因，再提交同一 queryId。' },
  APP_INITIAL_STATE_UNAVAILABLE: { group: 'knowledge-recovery', retryable: true, summary: '授权的初始状态准备未完成。', recovery: '读取 technical facts 确认制品、设备或平台准备失败原因；完成技术处置后重试同一 recover.targetState。' },
  ACTION_OUTCOME_UNKNOWN: { group: 'scene-action', retryable: false, resourceTypes: ['scene', 'screenshot', 'actionSpatialEvidence', 'technicalFact'], summary: '动作可能已经投递，禁止自动重放。', recovery: '禁止重放动作；先 observe 当前现场，并结合 action 落点证据判断下一步。' },
  PLAN_INVALID: { group: 'plan', retryable: true, summary: '命令计划不满足步数、时限、引用或定位类型约束。', recovery: '按 issues 修正有限步骤和前向引用；不要添加循环、脚本或未注册定位类型。' },
  PLAN_STEP_FAILED: { group: 'plan', retryable: true, summary: '计划在指定步骤发生确定性技术失败。', recovery: '检查已完成前缀、失败步骤和证据；根据当前 Scene 重新形成新的 submissionId。' },
  PLAN_SUBMISSION_CONFLICT: { group: 'plan', retryable: false, summary: '同一 submissionId 对应了不同的规范化请求。', recovery: '原请求重试必须保持内容不变；业务上确需新计划时使用新的 submissionId。' },
  PLAN_RECORD_INCOMPLETE: { group: 'plan', retryable: false, summary: '计划快照缺失、未终结或摘要校验失败。', recovery: '停止重放可能已执行的动作，保留 execution 进行技术排障。' },
  LOCATOR_UNSUPPORTED: { group: 'plan', retryable: true, summary: '当前 Runtime 不支持所声明的定位类型。', recovery: '改用当前 Scene 可验证的 ELEMENT_REF、POINT 或 REGION；不能可靠定位时交回 Agent。' },
  TARGET_NOT_FOUND: { group: 'plan', retryable: true, summary: '声明的 Scene、控件或定位目标不存在。', recovery: '查看计划已采集的 Scene 证据，重新选择可验证引用；不要猜测目标坐标。' },
  PLAN_CHECK_FAILED: { group: 'plan', retryable: true, summary: '技术检查无法执行或谓词不受支持。', recovery: '只使用文档列出的确定性技术谓词；业务判断留给 Agent。' },
  PLAN_ACTION_OUTCOME_UNKNOWN: { group: 'plan', retryable: false, resourceTypes: ['planResult', 'scene', 'screenshot', 'actionSpatialEvidence', 'planEvidence', 'technicalFact'], summary: '计划动作可能已投递，结果未知。', recovery: '禁止重放计划或动作；先检查已有证据并 observe 当前现场。' },
  PLAN_TIMEOUT: { group: 'plan', retryable: true, summary: '计划未能在声明的有限时限内完成。', recovery: '检查已完成前缀和各步耗时；缩短计划或在新 Scene 上使用新的 submissionId。' },
  CASE_RESULT_INCOMPLETE: { group: 'flow-result', retryable: true, summary: 'Ledger 仍有 unresolved 或 conflicts。', recovery: '逐项处置全部 Baseline CHECK 和最终活跃的补充 CHECK；可用 PASS、FAIL、BLOCKED、INCONCLUSIVE、条件检查的 NOT_APPLICABLE，或提供理由的 WAIVED。' },
  TIME_LIMIT: { group: 'flow-result', retryable: false, summary: '已停止新的设备动作。', recovery: '不再执行设备动作；使用已有证据收口可判断项，并披露未完成项和时间限制。' },
  CASE_RUNTIME_TECHNICAL: { group: 'knowledge-recovery', retryable: false, resourceTypes: ['technicalFact'], summary: '未归类的 execution 技术异常。', recovery: '读取 technical.stage、logRefs 和 resourceFacts 排障；恢复后先 observe 核验现场，再回到原业务节点。' },
});

const TRANSPORTS = Object.freeze({
  loaderCommand: {
    summary: 'Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。',
    input: '不附加输入。',
    rule: '必须原样执行，不修改哈希、sequence、claim token 或路径。',
    success: 'SUCCEEDED；唯一 caseBrief 主数据包含冻结 prompt 和预绑定 Runtime Client。',
    errors: ['BINDING_INVALID', 'PROTOCOL_MISMATCH'],
  },
  runtimeClient: {
    summary: '当前 execution 的预绑定 Case Runtime Client。',
    input: '每轮通过 stdin 提交 {operation,input} 请求。',
    rule: '必须原样使用命令绑定；业务字段只按当前方法页构造。',
    success: '返回一个 Agent-facing Runtime 状态。',
    errors: ['AGENT_INPUT_INVALID', 'AGENT_INPUT_STALLED', 'BINDING_INVALID', 'CASE_RUNTIME_TECHNICAL'],
  },
});

function method(name, summary, requestSchema, parameterDescriptions, options = {}) {
  return Object.freeze({
    name,
    summary,
    inputSchema: requestSchema,
    requestSchema: requestEnvelopeSchema({ [name]: requestSchema }).oneOf[0],
    parameterDescriptions,
    conditionalRequirements: options.conditionalRequirements || [],
    contextualValidationRules: options.contextualValidationRules || [],
    successStatuses: ['SUCCEEDED'],
    errorCodes: options.errorCodes || ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: options.sideEffects || [],
    idempotency: options.idempotency || 'Read-only.',
    minimalExample: options.minimalExample,
    minimalExamples: [options.minimalExample, ...(options.additionalExamples || []).map((input) => ({ operation: name, input }))],
    responseProjection: options.responseProjection,
  });
}

function projection(resultFields, primaryResourceType, associatedResourceTypes) {
  return Object.freeze({ resultFields: ['outcome', ...resultFields], primaryResourceType, associatedResourceTypes });
}
const SCENE_RESOURCES = ['screenshot', 'layout', 'elementSet', 'actionSpatialEvidence', 'technicalFact'];

const PUBLIC_METHODS = Object.freeze({
  observe: method('observe', '采集一个新 Scene，不执行业务动作。', SCHEMAS.observe, {
    purpose: '本次观察目的', flowContext: '当前 Case Flow 节点和可选分支选择',
  }, {
    responseProjection: projection(['sceneRef'], 'scene', SCENE_RESOURCES),
    successStatuses: ['SCENE_CAPTURED'], sideEffects: ['采集一个新 Scene'],
    idempotency: '设备采集不重放未知 effect；重复 observe 生成新的现场事实。', minimalExample: { operation: 'observe', input: {} },
  }),
  read: method('read', '按原样引用读取一个资源。', SCHEMAS.read, { ref: '当前绑定发布的资源引用' }, {
    responseProjection: projection(['resourceRef', 'resourceType'], '$resourceType', '$declaredResources'),
    minimalExample: { operation: 'read', input: { ref: 'mavt:0123456789abcdef01234567:scene:scene-1' } },
    successStatuses: ['RESOURCE_READ'], errorCodes: ['AGENT_INPUT_INVALID', 'RESOURCE_UNKNOWN', 'RESOURCE_SCOPE_MISMATCH', 'RESOURCE_INTEGRITY_INVALID', 'CASE_RUNTIME_TECHNICAL'],
  }),
  inspect: method('inspect', '登记 Agent 已观察到的视觉或动作事实。', SCHEMAS.inspect, {
    sceneRef: '被检查的 Scene', mode: 'visual 或 action',
    observation: '实际看到的事实', checkNodeRefs: '相关 CHECK 节点', flowContext: '当前 Case Flow 节点和可选分支选择',
  }, {
    responseProjection: projection(['sceneRef', 'inspectionId', 'checkNodeIds'], null, ['scene', 'screenshot', 'actionSpatialEvidence']),
    conditionalRequirements: ['visual/action 必须提供 observation。'],
    contextualValidationRules: ['历史 Scene 可登记事实；读取资源使用 read。'],
    successStatuses: ['VISUAL_INSPECTED', 'ACTION_SPATIAL_INSPECTED'],
    sideEffects: ['visual/action 追加事实事件'], idempotency: '相同 submission 不重复追加事实。',
    minimalExample: { operation: 'inspect', input: { mode: 'visual', sceneRef: 'scene-1', observation: '目标按钮可见' } },
    additionalExamples: [{ mode: 'action', sceneRef: 'scene-1', observation: '上一动作标注落在目标内' }],
  }),
  plan: method('plan', '创建或修订完整 Case Flow。', SCHEMAS.plan, {
    caseFlow: '完整 Case Flow 快照',
  }, {
    responseProjection: projection(['caseFlowRef', 'revision', 'idempotent', 'retiredNodeIds', 'retiredEdgeIds', 'invalidatedResultRefs'], null, ['caseFlow', 'checkpointLedger', 'checkpointResult']),
    conditionalRequirements: ['首次 baseRevision 为 null；修订时等于当前 revision 且 reason 必填。', 'CHECK 必须声明 REQUIRED 或 CONDITIONAL；CONDITIONAL 必须提供 applicability。'],
    contextualValidationRules: [
      '首次 revision 是只基于原始用例的 Baseline Flow，不写入当前 Scene 的现场适配。',
      '提交首次 Flow 前完整阅读原始用例，结合后置的“若/如果/未出现则”等语句确定条件作用域。',
      '原始用例允许某事实的不同取值分别进入正常路径时，该事实只建 DECISION；分支内验证建 CONDITIONAL CHECK，同一业务事实不得再建导致另一正常分支失败的 REQUIRED CHECK。',
      '提交前逐条检查原始用例允许的正常 END 路径；任何正常 END 都不得天然要求某个 REQUIRED CHECK 为 FAIL 或依赖 WAIVED 才能收口。',
      'Baseline 节点和边不可改义；既有 CHECK 不可改义，现场适配或语义修正使用新 ref。',
      '修订可改变 Working Flow 导航，但删除 Baseline CHECK 不会取消其最终处置责任。',
    ],
    successStatuses: ['CASE_FLOW_RECORDED'], sideEffects: ['追加 Case Flow revision'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'CASE_FLOW_REVISION_CONFLICT', 'CASE_FLOW_NODE_IDENTITY_CHANGED', 'CASE_FLOW_EDGE_IDENTITY_CHANGED', 'CASE_RUNTIME_TECHNICAL'],
    idempotency: '规范化后语义等价的 Case Flow 请求只写一次 revision，幂等键由框架内部派生。',
    minimalExample: { operation: 'plan', input: { caseFlow: { baseRevision: null, summary: '验证目标', entryNodeRef: 'N1', nodes: [{ ref: 'N1', type: 'CHECK', text: '结果可见', verificationKind: 'DIRECT_OBSERVATION', sourceBasis: '原始用例预期', requirement: 'REQUIRED' }, { ref: 'N2', type: 'END', text: '完成' }], edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [] } } },
  }),
  recordResult: method('recordResult', '独立记录验证点结果，不采集 Scene、不执行动作。', SCHEMAS.recordResult, {
    results: '已形成判断的验证结果和证据引用',
  }, {
    responseProjection: projection(['recordedResultRefs', 'idempotentCheckNodeIds'], null, ['checkpointResult', 'checkpointLedger']),
    conditionalRequirements: ['WAIVED 必须提供独立非空 reason；其他状态不得提供 reason。', 'NOT_APPLICABLE 只允许用于 CONDITIONAL 检查点。'],
    contextualValidationRules: ['所有结果先完整校验；任一结果无效时整批不写入。', 'Baseline CHECK 始终可处置；补充 CHECK 仅在最终 Working Flow 中活跃时进入结束闭环。', '知识、Scene 和技术事实可支撑豁免，但 Runtime 不要求知识命中，也不判断豁免理由是否充分。'],
    successStatuses: ['RESULTS_RECORDED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'EXPECTATION_UNKNOWN', 'EVIDENCE_REFERENCE_INVALID', 'RECORD_RESULT_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['追加 expectation result 事件'], idempotency: '相同结果重复提交不追加重复事件。',
    minimalExample: { operation: 'recordResult', input: { results: [{ checkNodeRef: 'N1', status: 'PASS', actual: '目标结果可见', evidence: { sceneRefs: ['scene-1'] } }] } },
  }),
  act: method('act', '基于当前 Scene 执行一个 ActionRef，并采集新 Scene。', SCHEMAS.act, {
    sceneRef: '当前 Scene', action: '发布的 ActionRef 或 Agent 自主视觉坐标动作',
    purpose: '可选的业务动作目的', flowContext: '当前 Case Flow 节点和可选分支选择',
  }, {
    responseProjection: projection(['operationId', 'deliveryStatus', 'outcomeKnown', 'sceneRef'], 'scene', SCENE_RESOURCES),
    conditionalRequirements: ['action.ref 与 action.type 互斥；ActionRef 所需 action.input 字段必须存在。'],
    contextualValidationRules: ['ActionRef、动态输入或 Scene 无效时拒绝 effect；业务判断通过 inspect 和 recordResult 单独提交。'],
    successStatuses: ['SCENE'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_CHANGED', 'ACTION_NOT_AVAILABLE', 'ACTION_INPUT_INVALID', 'VISUAL_INSPECTION_REQUIRED', 'ACTION_OUTCOME_UNKNOWN', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['最多投递一个设备动作', '采集新 Scene'],
    idempotency: '已投递且结果未知的动作永不重放。',
    minimalExample: { operation: 'act', input: { sceneRef: 'scene-1', action: { ref: 'button-1:tap' } } },
  }),
  runPlan: method('runPlan', '连续执行受约束的短时动作、等待、采集、定位和技术检查计划。', SCHEMAS.runPlan, {
    submissionId: '本次计划提交的幂等键', sceneRef: '当前 Scene',
    purpose: '计划的业务目的', maxDurationMs: `计划总时限，1 到 ${MAX_PLAN_DURATION_MS} 毫秒`, onFailure: 'STOP 或受限 CONTINUE',
    steps: '最多 12 个声明式步骤', flowContext: '当前 Case Flow 节点和可选分支选择',
  }, {
    responseProjection: projection(['planResultRef', 'planId', 'idempotent'], 'planResult', ['scene', 'screenshot', 'actionSpatialEvidence', 'planEvidence', 'technicalFact']),
    conditionalRequirements: ['步骤 id 唯一；$<stepId>.<field> 只能引用已完成的先前步骤。capture 输出 sceneRef，locate 输出 point，可用于 act.input.pointRef。', '包含 act 时 onFailure 必须为 STOP。需要间隔点击时使用 act/wait/act。'],
    contextualValidationRules: ['Runtime 只执行确定性命令并返回证据；视觉变化和业务结论由 Agent 判断。'],
    successStatuses: ['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_CHANGED', 'PLAN_INVALID', 'PLAN_STEP_FAILED', 'PLAN_SUBMISSION_CONFLICT', 'PLAN_RECORD_INCOMPLETE', 'LOCATOR_UNSUPPORTED', 'TARGET_NOT_FOUND', 'PLAN_CHECK_FAILED', 'PLAN_ACTION_OUTCOME_UNKNOWN', 'PLAN_TIMEOUT', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['按顺序投递计划中的设备动作', '保存步骤事件和 Scene 证据'],
    idempotency: '相同 submissionId 和请求摘要返回原计划；未知动作结果永不重放。',
    minimalExample: {
      operation: 'runPlan', input: { submissionId: 'run-plan-1', sceneRef: 'scene-1', purpose: '完成短时交互',
      maxDurationMs: 2500, onFailure: 'STOP',
      steps: [{ id: 'shot', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false }] },
    },
  }),
  knowledge: method('knowledge', '查询知识，或登记指定 query 的候选复核结果。', { type: 'object', oneOf: [SCHEMAS.knowledgeQuery, SCHEMAS.knowledgeReview] }, {
    mode: 'query 或 review', sceneRef: '当前 Scene', query: '待调查问题', queryId: '已有查询引用',
    checkNodeRefs: '相关 CHECK 节点', conclusion: '候选复核结论', assessments: '逐候选适用性判断', flowContext: '当前 Case Flow 节点和可选分支选择',
  }, {
    responseProjection: { modes: {
      query: projection(['knowledgeQueryRef', 'candidateSetRef', 'candidateCount', 'reviewRequired'], 'candidateSet', ['knowledgeQuery', 'knowledgeDocument']),
      review: projection(['knowledgeQueryRef', 'knowledgeReviewRef', 'conclusion', 'idempotent'], null, ['knowledgeQuery', 'candidateSet', 'knowledgeReview']),
    } },
    conditionalRequirements: ['mode=query 和 mode=review 的字段不能混用。'],
    contextualValidationRules: ['复核必须覆盖当前 query 候选约束。'],
    successStatuses: ['KNOWLEDGE', 'KNOWLEDGE_REVIEWED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_REQUIRED', 'KNOWLEDGE_QUERY_UNKNOWN', 'KNOWLEDGE_REVIEW_INVALID', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['保存查询或复核事件'], idempotency: '重复 queryId 复核按内部事件规则处理。',
    minimalExample: { operation: 'knowledge', input: { mode: 'query', sceneRef: 'scene-1', query: '解释当前异常' } },
    additionalExamples: [{ mode: 'review', sceneRef: 'scene-1', queryId: 'query-1', conclusion: 'NO_APPLICABLE', assessments: [] }],
  }),
  recover: method('recover', '建立授权的 App 初始状态、重启恢复或登记框架外事实。', SCHEMAS.recover, {
    mode: 'restart、prepare 或 external', sceneRef: '重启恢复所依据的 Scene', reason: '恢复原因',
    targetState: '授权的目标 App 状态', externalAction: '已实际完成的框架外事实', flowContext: '异常发生时正在处理的 Case Flow 节点',
  }, {
    responseProjection: { modes: {
      restart: projection(['sceneRef', 'preparationState'], 'scene', ['screenshot', 'layout', 'elementSet', 'technicalFact']),
      prepare: projection(['sceneRef', 'preparationState'], 'scene', ['screenshot', 'layout', 'elementSet', 'technicalFact']),
      external: projection(['externalActionDeclarationRef', 'verificationRequired'], null, ['externalActionDeclaration', 'technicalFact']),
    } },
    conditionalRequirements: ['targetState 与 externalAction 互斥。'],
    contextualValidationRules: ['有当前 Scene 的重启恢复必须绑定当前 Scene。'],
    successStatuses: ['SCENE', 'EXTERNAL_ACTION_RECORDED'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'SCENE_CHANGED', 'APP_INITIAL_STATE_UNAVAILABLE', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['执行授权恢复或保存外部事实'], idempotency: '由现有恢复事务保证。',
    minimalExample: { operation: 'recover', input: { mode: 'restart', sceneRef: 'scene-1', reason: '目标 App 无法继续交互' } },
    additionalExamples: [
      { mode: 'prepare', reason: '用例要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY' },
      { mode: 'external', reason: '登记已执行技术恢复', externalAction: { summary: '已重启自动化服务' } },
    ],
  }),
  finish: method('finish', '从 CHECK ledger 收口并完成用例。', SCHEMAS.finish, {
    mode: 'complete 或 notRun', summary: '最终摘要', uncertainties: '仍需披露的不确定性',
    reason: 'NOT_RUN 的业务原因', evidence: 'NOT_RUN 引用的已登记 Scene 或技术事实', flowContext: '实际到达的 END 节点',
  }, {
    responseProjection: projection(['executionId', 'verdict', 'caseResultRef', 'idempotent'], null, ['caseResult', 'checkpointLedger', 'technicalFact']),
    contextualValidationRules: ['正常收口由 Runtime 从 ledger 组装；全部 Baseline CHECK 和最终活跃补充 CHECK 必须已处置。', 'WAIVED 与 NOT_APPLICABLE 不降低聚合后的 PASS；报告会单独披露豁免。', 'FAIL、INCONCLUSIVE、BLOCKED 和 WAIVED 不强制知识调查；已提交的证据引用仍必须有效。', 'NOT_RUN 必须提供原因和已登记证据。'],
    successStatuses: ['COMPLETED', 'RESULT_INCOMPLETE'],
    errorCodes: ['AGENT_INPUT_INVALID', 'BINDING_INVALID', 'CASE_FLOW_REQUIRED', 'CASE_RESULT_INCOMPLETE', 'CASE_RUNTIME_TECHNICAL'],
    sideEffects: ['就绪后持久化最终结果'], idempotency: '复用现有可恢复 finish 事务。',
    minimalExample: { operation: 'finish', input: { mode: 'complete', summary: '验证完成' } },
    additionalExamples: [{ mode: 'notRun', reason: '用例前置条件不满足', summary: '未运行', evidence: { sceneRefs: ['scene-1'], technicalRefs: [] } }],
  }),
});

const PUBLIC_CONTRACT = Object.freeze({
  interfaceKind: AGENT_FACING_INTERFACE_KIND,
  protocol: AGENT_FACING_PROTOCOL,
  statuses: AGENT_FACING_STATUSES,
  resourceDescriptorSchema: RESOURCE_DESCRIPTOR_SCHEMA,
  requestSchema: requestEnvelopeSchema(Object.fromEntries(Object.entries(PUBLIC_METHODS).map(([name, definition]) => [name, definition.inputSchema]))),
  resourceCatalog: Object.freeze({
    caseBrief: { summary: '冻结的 Case Agent prompt、用例和 execution 启动信息。' },
    scene: { summary: '一次采集的完整 Scene 与截图、布局、控件资源引用。' },
    screenshot: { summary: '完整截图文件位置与尺寸；使用宿主图片能力打开。' },
    layout: { summary: '该 Scene 的完整原始控件树。' },
    elementSet: { summary: '完整控件集合与确定性动作事实。' },
    caseFlow: { summary: 'Agent 提交的完整用例流程 revision。' },
    checkpointLedger: { summary: '检查点登记与处置账本的不可变快照。' },
    checkpointResult: { summary: '一次检查点结果提交。' },
    knowledgeQuery: { summary: '知识查询范围、查询事实与候选资源引用。' },
    candidateSet: { summary: '完整知识候选集合。' },
    knowledgeDocument: { summary: '完整知识条目正文。' },
    knowledgeReview: { summary: 'Agent 提交的知识适用性审查。' },
    actionSpatialEvidence: { summary: '动作落点、轨迹及标注截图资源。' },
    planResult: { summary: '命令组合的完整结果与步骤证据引用。' },
    planEvidence: { summary: '组合命令某一步的完整采集或技术检查证据。' },
    externalActionDeclaration: { summary: 'Agent 登记的框架外动作事实。' },
    technicalFact: { summary: '持久化的技术事实与诊断。' },
    caseResult: { summary: '最终用例结果与证据引用。' },
  }),
  methods: PUBLIC_METHODS,
  errors: PUBLIC_ERRORS,
  transports: TRANSPORTS,
});

function documentationRefFor(code) {
  const documentedCode = PUBLIC_ERRORS[code] ? code : 'CASE_RUNTIME_TECHNICAL';
  const normalized = documentedCode.replace(/_/g, '-').toLowerCase();
  const definition = PUBLIC_ERRORS[documentedCode];
  return `references/case-runtime/errors/${definition.group}.md#error-${normalized}`;
}

function schemaFor(request) {
  const methodDefinition = PUBLIC_METHODS[request?.operation];
  return methodDefinition?.requestSchema || object({ operation: { enum: AGENT_FACING_CAPABILITIES }, input: { type: 'object' } }, ['operation', 'input']);
}

function messageFor(issue) {
  if (issue.code === 'REQUIRED') return `必须提供 ${issue.fieldPath}`;
  if (issue.code === 'FIELD_UNSUPPORTED') return `${issue.fieldPath} 不是该能力支持的字段`;
  return `${issue.fieldPath || 'request'} 应为 ${issue.expected}`;
}

function validateAgentFacingRequest(request) {
  const issues = validateAgentJson(request, schemaFor(request)).map((issue) => ({
    field: issue.fieldPath || 'request',
    expected: issue.expected,
    message: messageFor(issue),
    code: issue.code === 'REQUIRED' ? 'FIELD_REQUIRED' : issue.code,
  }));
  if (!issues.length && request?.operation === 'runPlan') {
    const input = request.input;
    try {
      require('./plan-contract').validatePlanRequest({
        operation: 'runPlan', submissionId: input.submissionId, basedOnSceneId: input.sceneRef,
        purpose: input.purpose, maxDurationMs: input.maxDurationMs, onFailure: input.onFailure,
        steps: input.steps, ...(input.flowContext ? { flowContext: input.flowContext } : {}),
        decision: { purpose: input.purpose, expectationRefs: [] },
      });
    } catch (error) {
      return (error.issues || []).map((item) => ({
        field: `input.${item.fieldPath === 'basedOnSceneId' ? 'sceneRef' : item.fieldPath}`,
        expected: item.expected,
        message: `计划字段应为 ${item.expected}`,
        code: item.code,
      }));
    }
  }
  return issues;
}

function projectPreviousAction(previousAction) {
  if (!previousAction) return null;
  const unknown = previousAction.outcomeKnown === false
    || previousAction.status === 'ACTION_OUTCOME_UNKNOWN'
    || previousAction.deliveryStatus === 'UNKNOWN';
  const commandStatus = previousAction.command?.status;
  const deliveryStatus = unknown ? 'UNKNOWN'
    : commandStatus === 'REJECTED' ? 'NOT_SENT'
      : commandStatus === 'ACCEPTED' ? 'RESULT_RECORDED'
        : previousAction.deliveryStatus || 'UNKNOWN';
  const annotatedScreenshotPath = previousAction.spatialEvidence?.annotatedScreenshot?.path
    || previousAction.spatialEvidence?.annotatedScreenshotPath;
  const spatial = previousAction.spatialEvidence;
  const deviceExecution = previousAction.deviceExecution;
  const persistedTechnicalDetails = safeActionTechnicalDetails(previousAction);
  const persistedInputEffect = persistedTechnicalDetails.inputEffect;
  const technicalDetails = {
    ...(persistedTechnicalDetails.failureCode ? { failureCode: persistedTechnicalDetails.failureCode } : {}),
    ...(persistedInputEffect ? {
      inputEffect: {
        ...(persistedInputEffect.status ? { status: persistedInputEffect.status } : {}),
        ...(persistedInputEffect.attempts !== undefined ? { verificationAttempts: persistedInputEffect.attempts } : {}),
        ...(persistedInputEffect.settledMs !== undefined ? { verificationElapsedMs: persistedInputEffect.settledMs } : {}),
        ...(persistedInputEffect.expectedLength !== undefined ? { expectedLength: persistedInputEffect.expectedLength } : {}),
        ...(persistedInputEffect.observedLength !== undefined ? { observedLength: persistedInputEffect.observedLength } : {}),
      },
    } : {}),
  };
  return {
    operationRef: previousAction.operationRef || previousAction.operationId,
    type: previousAction.action?.type || previousAction.type || 'unknown',
    deliveryStatus,
    outcomeKnown: deliveryStatus !== 'UNKNOWN',
    ...(deviceExecution || Object.keys(technicalDetails).length ? {
      technicalResult: {
        ...(deviceExecution?.status ? { deviceStatus: deviceExecution.status } : {}),
        ...(deviceExecution?.verification ? { verification: deviceExecution.verification } : {}),
        ...technicalDetails,
      },
    } : {}),
    ...(previousAction.evidence ? { evidence: previousAction.evidence } : {}),
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

function projectScene(scene) {
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
