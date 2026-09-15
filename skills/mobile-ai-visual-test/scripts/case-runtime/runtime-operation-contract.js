'use strict';

const INTERNAL_INTERFACE_KIND = 'INTERNAL';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const STRING = { type: 'string', minLength: 1 };
const STRING_ARRAY = { type: 'array', items: STRING };

const AGENT_CONTRACT_DEFINITIONS = deepFreeze({
  decision: {
    type: 'object', required: ['purpose', 'expectationRefs'], additionalProperties: false,
    properties: {
      purpose: STRING, expectationRefs: STRING_ARRAY, assessment: STRING, observation: STRING,
      conclusion: STRING, expectedOutcome: STRING,
      knowledgeReview: { $ref: 'knowledgeReview' }, uncertainties: STRING_ARRAY,
    },
  },
  knowledgeReview: {
    type: 'object', required: ['queryId', 'conclusion', 'assessments'], additionalProperties: false,
    properties: {
      queryId: STRING,
      conclusion: { enum: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
      assessments: { type: 'array', items: { $ref: 'knowledgeAssessment' } },
    },
  },
  knowledgeAssessment: {
    type: 'object', required: ['entryId', 'status', 'reason'], additionalProperties: false,
    properties: {
      entryId: STRING,
      status: { enum: ['APPLICABLE', 'NOT_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'] },
      reason: STRING,
    },
  },
  capabilityInput: {
    type: 'object', additionalProperties: false,
    properties: {
      text: STRING, mode: { enum: ['replace', 'append'] },
      durationMs: { type: 'integer', minimum: 1 }, ms: { type: 'integer', minimum: 0 },
    },
    constraints: [
      'Use text and optional mode for an inputText capability.',
      'Use durationMs for a longPress capability.',
      'Use ms for a wait capability.',
      'Omit input when the selected capability declares no input.',
    ],
  },
  visualAction: {
    oneOf: [
      {
        title: 'tap-or-double-tap', type: 'object', required: ['gesture', 'point'], additionalProperties: false,
        properties: { gesture: { enum: ['tap', 'doubleTap'] }, point: { $ref: 'normalizedPoint' } },
      },
      {
        title: 'long-press', type: 'object', required: ['gesture', 'point', 'durationMs'], additionalProperties: false,
        properties: {
          gesture: { const: 'longPress' }, point: { $ref: 'normalizedPoint' },
          durationMs: { type: 'integer', minimum: 1 },
        },
      },
      {
        title: 'swipe', type: 'object', required: ['gesture', 'from', 'to'], additionalProperties: false,
        properties: {
          gesture: { const: 'swipe' }, from: { $ref: 'normalizedPoint' }, to: { $ref: 'normalizedPoint' },
        },
      },
    ],
  },
  normalizedPoint: {
    type: 'array', minItems: 2, maxItems: 2,
    items: { type: 'number', minimum: 0, maximum: 1 },
  },
  observationPolicy: {
    type: 'object', required: ['duringActionAtMs'], additionalProperties: false,
    properties: { duringActionAtMs: { type: 'integer', minimum: 20 } },
    constraints: ['duringActionAtMs must be less than visual.durationMs for longPress.'],
  },
  caseResult: {
    type: 'object', required: ['verdict', 'summary', 'checks'], additionalProperties: false,
    properties: {
      verdict: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'] }, summary: STRING,
      checks: { type: 'array', items: { $ref: 'resultCheck' } }, uncertainties: STRING_ARRAY,
      caseModelRevision: { type: 'integer', minimum: 1 },
    },
  },
  resultCheck: {
    type: 'object', required: ['expectationRef', 'status', 'actual'], additionalProperties: false,
    properties: {
      expectationRef: STRING, status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'] }, actual: STRING,
      sceneRefs: STRING_ARRAY, knowledgeRefs: STRING_ARRAY, technicalRefs: STRING_ARRAY,
      evidenceBasis: { $ref: 'searchAbsenceEvidence' },
    },
  },
  searchAbsenceEvidence: {
    type: 'object', required: ['type', 'sceneRef', 'scrollContextRef'], additionalProperties: false,
    properties: { type: { const: 'SEARCH_ABSENCE' }, sceneRef: STRING, scrollContextRef: STRING },
  },
  caseModelInput: {
    type: 'object',
    required: ['understanding', 'preconditions', 'verificationPoints', 'items', 'uncertainties'],
    additionalProperties: false,
    properties: {
      understanding: STRING,
      preconditions: STRING_ARRAY,
      verificationPoints: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['text'], additionalProperties: false,
          properties: { ref: STRING, text: STRING },
        },
      },
      items: { type: 'array', minItems: 1, items: STRING },
      uncertainties: STRING_ARRAY,
      reason: STRING,
    },
  },
});

function operationSchema(operation, properties, required = ['operation']) {
  return {
    type: 'object', required, additionalProperties: false,
    properties: { operation: { const: operation }, ...properties },
  };
}

function example(name, request) {
  return { name, request };
}

function decision(purpose, expectationRefs = []) {
  return { purpose, expectationRefs };
}

function passingResult() {
  return {
    verdict: 'PASS', summary: '验证点均符合预期',
    checks: [{
      expectationRef: 'E1', status: 'PASS', actual: '当前 Scene 显示预期结果',
      sceneRefs: ['scene-0002'], knowledgeRefs: [], technicalRefs: [],
    }],
    uncertainties: [],
  };
}

function defineOperation(definition) {
  return deepFreeze({
    interfaceKind: INTERNAL_INTERFACE_KIND,
    ...definition,
    requestFields: Object.keys(definition.requestSchema.properties),
  });
}

const OPERATION_CONTRACT = deepFreeze({
  prepare: defineOperation({
    agentAccessible: false,
    summary: 'Establish the frozen App initial state before Case Agent dispatch.',
    whenToUse: ['Lifecycle only; never available to a Case Agent.'],
    requestSchema: operationSchema('prepare', {
      preparation: {
        type: 'object', required: ['targetState'], additionalProperties: false,
        properties: { targetState: { enum: ['KEEP_EXISTING', 'APP_LOCAL_STATE_EMPTY', 'FRESH_INSTALL'] } },
      },
      decision: { $ref: 'decision' },
    }, ['operation', 'preparation']),
    examples: [example('prepare-initial-state', {
      operation: 'prepare', preparation: { targetState: 'APP_LOCAL_STATE_EMPTY' },
    })],
    responses: ['PREPARED', 'SCENE', 'TECHNICAL'],
  }),
  observe: defineOperation({
    agentAccessible: true,
    summary: 'Capture a new Scene for the current App state.',
    whenToUse: ['No Scene is available.', 'The current UI may have changed without an act request.'],
    requestSchema: operationSchema('observe', { purpose: STRING, decision: { $ref: 'decision' } }),
    examples: [example('observe-current-scene', {
      operation: 'observe', decision: decision('建立当前页面基线'),
    })],
    responses: ['SCENE', 'TIME_LIMIT', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  act: defineOperation({
    agentAccessible: true,
    summary: 'Execute one capability or normalized visual gesture against the current Scene.',
    whenToUse: ['A current Scene supports a concrete next action.'],
    requestSchema: {
      ...operationSchema('act', {
        basedOnSceneId: STRING, capabilityId: STRING, visual: { $ref: 'visualAction' },
        input: { $ref: 'capabilityInput' }, observationPolicy: { $ref: 'observationPolicy' },
        decision: { $ref: 'decision' },
      }, ['operation', 'basedOnSceneId', 'decision']),
      exactlyOneOf: ['capabilityId', 'visual'],
    },
    examples: [
      example('capability-tap', {
        operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:tap:el-1',
        decision: decision('进入目标页面', ['E1']),
      }),
      example('capability-long-press', {
        operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:longPress:el-1',
        input: { durationMs: 1200 }, decision: decision('长按目标控件', ['E1']),
      }),
      example('capability-input-text', {
        operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:inputText:el-1',
        input: { text: '测试文本', mode: 'replace' }, decision: decision('向目标输入框录入文本', ['E1']),
      }),
      example('visual-tap', {
        operation: 'act', basedOnSceneId: 'scene-0001', visual: { gesture: 'tap', point: [0.5, 0.5] },
        decision: decision('点击截图中的目标', ['E1']),
      }),
      example('visual-long-press', {
        operation: 'act', basedOnSceneId: 'scene-0001',
        visual: { gesture: 'longPress', point: [0.5, 0.5], durationMs: 1200 },
        observationPolicy: { duringActionAtMs: 600 }, decision: decision('长按截图中的目标并记录过程', ['E1']),
      }),
      example('visual-swipe', {
        operation: 'act', basedOnSceneId: 'scene-0001',
        visual: { gesture: 'swipe', from: [0.5, 0.75], to: [0.5, 0.25] },
        decision: decision('向上滚动当前页面', ['E1']),
      }),
    ],
    responses: ['SCENE', 'SCENE_CHANGED', 'RECOVERY_APPLIED', 'TIME_LIMIT', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  inspectVisual: defineOperation({
    agentAccessible: true,
    summary: 'Register a visual observation after the Agent has actually opened a Scene screenshot.',
    whenToUse: ['A screenshot was opened with the host visual tool and its pixel content was inspected.'],
    requestSchema: operationSchema('inspectVisual', {
      basedOnSceneId: STRING, decision: { $ref: 'decision' },
    }, ['operation', 'basedOnSceneId', 'decision']),
    constraints: ['decision.observation is required.'],
    examples: [example('register-visual-inspection', {
      operation: 'inspectVisual', basedOnSceneId: 'scene-0001',
      decision: { ...decision('记录当前截图的视觉事实', ['E1']), observation: '页面显示系统权限弹窗' },
    })],
    responses: ['VISUAL_INSPECTED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  inspectScene: defineOperation({
    agentAccessible: true,
    summary: 'Read full elements, capabilities, or layout from an existing Scene without observing the device again.',
    whenToUse: ['The Scene summary is insufficient for locating controls or understanding structure.'],
    requestSchema: operationSchema('inspectScene', {
      basedOnSceneId: STRING,
      view: { enum: ['ELEMENTS', 'CAPABILITIES', 'LAYOUT', 'ACTION'] },
      observation: STRING,
      expectationRefs: { type: 'array', items: STRING },
      filter: {
        type: 'object', additionalProperties: false,
        properties: {
          interactiveOnly: { type: 'boolean' }, textContains: STRING, role: STRING,
          actionType: STRING, elementRef: STRING,
        },
        constraints: [
          'ELEMENTS allows interactiveOnly, textContains, and role.',
          'CAPABILITIES allows actionType and elementRef.',
          'LAYOUT does not accept filter fields.',
          'ACTION records the Agent observation of the previous action annotation and does not accept filter fields.',
        ],
      },
    }, ['operation', 'basedOnSceneId', 'view']),
    examples: [
      example('inspect-elements', {
        operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'ELEMENTS', filter: { interactiveOnly: true },
      }),
      example('inspect-capabilities', {
        operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'CAPABILITIES', filter: { actionType: 'longPress' },
      }),
      example('inspect-layout', { operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'LAYOUT' }),
      example('inspect-action', { operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'ACTION', observation: '标注轨迹位于目标容器上方', expectationRefs: ['E1'] }),
    ],
    responses: ['SCENE_INSPECTION', 'ACTION_SPATIAL_INSPECTED', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  knowledge: defineOperation({
    agentAccessible: true,
    summary: 'Search the frozen knowledge base for explanations or rules outside the current Scene.',
    whenToUse: ['The current state is abnormal, unexplained, blocked, or needs external knowledge before a negative conclusion.'],
    requestSchema: operationSchema('knowledge', {
      basedOnSceneId: STRING, query: STRING,
      context: {
        type: 'object', additionalProperties: false,
        properties: { page: STRING, operation: STRING },
      },
      decision: { $ref: 'decision' },
    }, ['operation', 'basedOnSceneId', 'query']),
    examples: [example('query-knowledge', {
      operation: 'knowledge', basedOnSceneId: 'scene-0001', query: '权限弹窗出现后语音录入无法继续',
      context: { page: '语音录入页', operation: '长按录音按钮' },
      decision: decision('调查当前异常是否存在已知规则', ['E1']),
    })],
    responses: ['KNOWLEDGE', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  reviewKnowledge: defineOperation({
    agentAccessible: false,
    summary: 'Record a knowledge review translated by the Agent-facing Facade without a device action.',
    whenToUse: ['Agent-facing Facade only; never exposed as a Case Agent capability.'],
    requestSchema: operationSchema('reviewKnowledge', {
      basedOnSceneId: STRING, decision: { $ref: 'decision' },
    }, ['operation', 'basedOnSceneId', 'decision']),
    constraints: ['decision.knowledgeReview is required.'],
    examples: [example('record-knowledge-review', {
      operation: 'reviewKnowledge', basedOnSceneId: 'scene-0001',
      decision: {
        ...decision('登记知识候选复核结果', ['E1']),
        knowledgeReview: {
          queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE',
          assessments: [{ entryId: 'K-example-001', status: 'NOT_APPLICABLE', reason: '与当前现场不匹配' }],
        },
      },
    })],
    responses: ['KNOWLEDGE_REVIEWED', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  recordCaseModel: defineOperation({
    agentAccessible: false,
    summary: 'Record a complete Agent-authored Case Model revision without touching the device.',
    whenToUse: ['Agent-facing Facade only; never exposed as a separate Case Agent capability.'],
    requestSchema: operationSchema('recordCaseModel', {
      caseModel: { $ref: 'caseModelInput' },
    }, ['operation', 'caseModel']),
    examples: [example('record-case-model', {
      operation: 'recordCaseModel',
      caseModel: {
        understanding: '验证当前页面结果',
        preconditions: [],
        verificationPoints: [{ text: '目标结果可见' }],
        items: ['观察当前页面', '验证目标结果'],
        uncertainties: [],
      },
    })],
    responses: ['CASE_MODEL_RECORDED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  recover: defineOperation({
    agentAccessible: true,
    summary: 'Cold-start the target App and capture a new Scene after an unrecoverable interaction state.',
    whenToUse: ['The App is no longer usable and a fresh App process is required to continue.'],
    requestSchema: operationSchema('recover', {
      basedOnSceneId: STRING, reason: STRING, decision: { $ref: 'decision' },
      externalAction: {
        type: 'object', additionalProperties: false, required: ['summary'],
        properties: { summary: STRING, tool: STRING },
      },
    }, ['operation', 'reason']),
    constraints: ['basedOnSceneId is required for App restart recovery; externalAction may be recorded before the first Scene exists.'],
    examples: [example('recover-app', {
      operation: 'recover', basedOnSceneId: 'scene-0001', reason: '目标 App 卡死且当前交互无法继续',
      decision: decision('恢复目标 App 后重新判断现场', ['E1']),
    })],
    responses: ['SCENE', 'RECOVERY_APPLIED', 'EXTERNAL_ACTION_RECORDED', 'SCENE_CHANGED', 'TIME_LIMIT', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  finish: defineOperation({
    agentAccessible: true,
    summary: 'Validate and persist the final CaseResult for every frozen expectation.',
    whenToUse: ['Evidence is sufficient for a verdict or no further safe progress is possible.'],
    requestSchema: operationSchema('finish', {
      basedOnSceneId: STRING, result: { $ref: 'caseResult' }, decision: { $ref: 'decision' },
    }, ['operation', 'result']),
    constraints: ['basedOnSceneId is required when the execution has a current Scene; it is omitted only by framework-owned closure before any Scene exists.'],
    examples: [
      example('finish-pass', {
        operation: 'finish', basedOnSceneId: 'scene-0002',
        decision: decision('保存最终结论', ['E1']), result: passingResult(),
      }),
      example('finish-with-knowledge-review', {
        operation: 'finish', basedOnSceneId: 'scene-0002',
        decision: {
          ...decision('完成知识复核并保存最终结论', ['E1']),
          knowledgeReview: {
            queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE',
            assessments: [{
              entryId: 'K-example-001', status: 'NOT_APPLICABLE',
              reason: '候选知识与当前页面和操作条件不匹配',
            }],
          },
        },
        result: passingResult(),
      }),
    ],
    responses: ['COMPLETED', 'RESULT_INCOMPLETE', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  status: defineOperation({
    agentAccessible: true,
    summary: 'Read the current execution status without changing device or execution state.',
    whenToUse: ['The Agent needs to confirm runtime, budget, preparation, or completion state.'],
    requestSchema: operationSchema('status', {}),
    examples: [example('read-status', { operation: 'status' })],
    responses: ['RUNNING', 'COMPLETED', 'CANCELLED', 'TECHNICAL'],
  }),
});

const RUNTIME_OPERATIONS = Object.freeze(Object.keys(OPERATION_CONTRACT));
const AGENT_OPERATIONS = Object.freeze(RUNTIME_OPERATIONS
  .filter((operation) => OPERATION_CONTRACT[operation].agentAccessible));
function isSupportedBroker(broker) {
  if (!broker || typeof broker !== 'object') return false;
  return JSON.stringify(broker.allowedOperations) === JSON.stringify(AGENT_OPERATIONS);
}

function projectAgentCapabilities(allowedOperations) {
  const allowed = new Set(allowedOperations || []);
  return Object.fromEntries(AGENT_OPERATIONS
    .filter((operation) => allowed.has(operation))
    .map((operation) => {
      const { agentAccessible, requestFields, ...visible } = OPERATION_CONTRACT[operation];
      return [operation, visible];
    }));
}

function requestCorrection(operation, error = {}) {
  const definition = OPERATION_CONTRACT[operation];
  const issues = Array.isArray(error.issues) && error.issues.length
    ? error.issues
    : [{
      fieldPath: error.fieldPath || 'request',
      expected: error.expected || (definition ? `a valid ${operation} request` : `operation: ${RUNTIME_OPERATIONS.join(' | ')}`),
      code: error.code || 'REQUEST_INVALID',
    }];
  if (!definition) return { issues, allowedOperations: [...RUNTIME_OPERATIONS] };
  return {
    issues,
    allowedFields: [...definition.requestFields],
    requiredFields: [...(definition.requestSchema.required || [])],
    example: definition.examples[0].request,
  };
}

module.exports = {
  AGENT_CONTRACT_DEFINITIONS,
  AGENT_OPERATIONS,
  INTERNAL_INTERFACE_KIND,
  OPERATION_CONTRACT,
  RUNTIME_OPERATIONS,
  isSupportedBroker,
  projectAgentCapabilities,
  requestCorrection,
};
