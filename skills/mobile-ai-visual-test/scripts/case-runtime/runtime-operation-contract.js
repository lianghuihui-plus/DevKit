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
  flowContext: {
    type: 'object', required: ['nodeRef'], additionalProperties: false,
    properties: { nodeRef: STRING, selectedEdgeRef: STRING },
  },
  caseResult: {
    type: 'object', required: ['verdict', 'summary', 'checks'], additionalProperties: false,
    properties: {
      verdict: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_RUN'] }, summary: STRING,
      checks: { type: 'array', items: { $ref: 'resultCheck' } }, uncertainties: STRING_ARRAY,
      caseFlowRevision: { type: 'integer', minimum: 1 },
      notRunReason: STRING,
      notRunEvidence: {
        type: 'object', additionalProperties: false, required: ['sceneRefs', 'technicalRefs'],
        properties: { sceneRefs: STRING_ARRAY, technicalRefs: STRING_ARRAY },
      },
    },
  },
  resultCheck: {
    type: 'object', required: ['status', 'actual'], additionalProperties: false,
    properties: {
      checkNodeRef: STRING,
      status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_APPLICABLE', 'WAIVED'] }, actual: STRING, reason: STRING,
      sceneRefs: STRING_ARRAY, knowledgeRefs: STRING_ARRAY, technicalRefs: STRING_ARRAY,
      evidenceBasis: { $ref: 'searchAbsenceEvidence' },
    },
  },
  expectationResultInput: {
    type: 'object', required: ['expectationRef', 'status', 'actual'], additionalProperties: false,
    properties: {
      expectationRef: STRING,
      status: { enum: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_APPLICABLE', 'WAIVED'] },
      actual: STRING, reason: STRING,
      evidence: {
        type: 'object', additionalProperties: false,
        properties: {
          sceneRefs: STRING_ARRAY,
          knowledgeRefs: STRING_ARRAY,
          technicalRefs: STRING_ARRAY,
          searchAbsence: {
            type: 'object', additionalProperties: false, required: ['sceneRef', 'scrollContextRef'],
            properties: { sceneRef: STRING, scrollContextRef: STRING },
          },
        },
      },
    },
  },
  searchAbsenceEvidence: {
    type: 'object', required: ['type', 'sceneRef', 'scrollContextRef'], additionalProperties: false,
    properties: { type: { const: 'SEARCH_ABSENCE' }, sceneRef: STRING, scrollContextRef: STRING },
  },
  caseFlowInput: {
    type: 'object',
    required: ['baseRevision', 'summary', 'entryNodeRef', 'nodes', 'edges', 'uncertainties'],
    additionalProperties: false,
    properties: {
      baseRevision: { oneOf: [{ type: 'integer', minimum: 1 }, { const: null }] },
      summary: STRING,
      entryNodeRef: STRING,
      nodes: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['ref', 'type', 'text'], additionalProperties: false,
          properties: {
            ref: STRING, type: { enum: ['ACTION', 'DECISION', 'CHECK', 'END'] }, text: STRING,
            sourceBasis: STRING, verificationKind: { enum: ['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE'] },
            requirement: { enum: ['REQUIRED', 'CONDITIONAL'] }, applicability: STRING,
          },
        },
      },
      edges: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['ref', 'from', 'to'], additionalProperties: false,
          properties: { ref: STRING, from: STRING, to: STRING, condition: STRING },
        },
      },
      uncertainties: STRING_ARRAY,
      reason: STRING,
    },
  },
});

function operationSchema(operation, properties, required = ['operation']) {
  return {
    type: 'object', required, additionalProperties: false,
    properties: { operation: { const: operation }, ...properties, flowContext: { $ref: 'flowContext' } },
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
      checkNodeRef: 'N1', status: 'PASS', actual: '当前 Scene 显示预期结果',
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
        decision: decision('进入目标页面', ['N1']),
      }),
      example('capability-long-press', {
        operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:longPress:el-1',
        input: { durationMs: 1200 }, decision: decision('长按目标控件', ['N1']),
      }),
      example('capability-input-text', {
        operation: 'act', basedOnSceneId: 'scene-0001', capabilityId: 'scene-0001:inputText:el-1',
        input: { text: '测试文本', mode: 'replace' }, decision: decision('向目标输入框录入文本', ['N1']),
      }),
      example('visual-tap', {
        operation: 'act', basedOnSceneId: 'scene-0001', visual: { gesture: 'tap', point: [0.5, 0.5] },
        decision: decision('点击截图中的目标', ['N1']),
      }),
      example('visual-long-press', {
        operation: 'act', basedOnSceneId: 'scene-0001',
        visual: { gesture: 'longPress', point: [0.5, 0.5], durationMs: 1200 },
        observationPolicy: { duringActionAtMs: 600 }, decision: decision('长按截图中的目标并记录过程', ['N1']),
      }),
      example('visual-swipe', {
        operation: 'act', basedOnSceneId: 'scene-0001',
        visual: { gesture: 'swipe', from: [0.5, 0.75], to: [0.5, 0.25] },
        decision: decision('向上滚动当前页面', ['N1']),
      }),
    ],
    responses: ['SCENE', 'SCENE_CHANGED', 'RECOVERY_APPLIED', 'TIME_LIMIT', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  runPlan: defineOperation({
    agentAccessible: true,
    summary: 'Execute a bounded declarative action/capture/locate/check plan under one Runtime lock.',
    whenToUse: ['A short-lived UI state cannot survive another Agent decision cycle.'],
    requestSchema: operationSchema('runPlan', {
      submissionId: STRING, basedOnSceneId: STRING, purpose: STRING,
      maxDurationMs: { type: 'integer', minimum: 1 }, onFailure: { enum: ['STOP', 'CONTINUE'] },
      steps: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object' } },
      decision: { $ref: 'decision' },
    }, ['operation', 'submissionId', 'basedOnSceneId', 'purpose', 'maxDurationMs', 'onFailure', 'steps']),
    examples: [example('transient-controls', {
      operation: 'runPlan', submissionId: 'run-plan-033-attempt-01', basedOnSceneId: 'scene-0012',
      purpose: '唤起视频控制栏并解除童锁', maxDurationMs: 2500, onFailure: 'STOP',
      steps: [{ id: 'controls', type: 'capture', mode: 'SCREENSHOT_ONLY', promote: false }],
    })],
    responses: ['PLAN_COMPLETED', 'PLAN_PARTIAL', 'PLAN_INTERRUPTED', 'REQUEST_INVALID', 'TECHNICAL'],
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
      decision: { ...decision('记录当前截图的视觉事实', ['N1']), observation: '页面显示系统权限弹窗' },
    })],
    responses: ['VISUAL_INSPECTED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  inspectScene: defineOperation({
    agentAccessible: true,
    summary: 'Read full elements or layout from an existing Scene without observing the device again.',
    whenToUse: ['The Scene summary is insufficient for locating controls or understanding structure.'],
    requestSchema: operationSchema('inspectScene', {
      basedOnSceneId: STRING,
      view: { enum: ['ELEMENTS', 'LAYOUT', 'ACTION'] },
      observation: STRING,
      expectationRefs: { type: 'array', items: STRING },
      filter: {
        type: 'object', additionalProperties: false,
        properties: {
          interactiveOnly: { type: 'boolean' }, textContains: STRING, role: STRING,
        },
        constraints: [
          'ELEMENTS allows interactiveOnly, textContains, and role.',
          'LAYOUT does not accept filter fields.',
          'ACTION records the Agent observation of the previous action annotation and does not accept filter fields.',
        ],
      },
    }, ['operation', 'basedOnSceneId', 'view']),
    examples: [
      example('inspect-elements', {
        operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'ELEMENTS', filter: { interactiveOnly: true },
      }),
      example('inspect-layout', { operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'LAYOUT' }),
      example('inspect-action', { operation: 'inspectScene', basedOnSceneId: 'scene-0001', view: 'ACTION', observation: '标注轨迹位于目标容器上方', expectationRefs: ['N1'] }),
    ],
    responses: ['SCENE_INSPECTION', 'ACTION_SPATIAL_INSPECTED', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  knowledge: defineOperation({
    agentAccessible: true,
    summary: 'Search the frozen knowledge base for explanations or rules outside the current Scene.',
    whenToUse: ['The conclusion depends on business rules outside the Scene, or the current anomaly cannot be explained from Scene evidence alone.'],
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
      decision: decision('调查当前异常是否存在已知规则', ['N1']),
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
        ...decision('登记知识候选复核结果', ['N1']),
        knowledgeReview: {
          queryId: 'knowledge-0001', conclusion: 'NO_APPLICABLE',
          assessments: [{ entryId: 'K-example-001', status: 'NOT_APPLICABLE', reason: '与当前现场不匹配' }],
        },
      },
    })],
    responses: ['KNOWLEDGE_REVIEWED', 'SCENE_CHANGED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  recordCaseFlow: defineOperation({
    agentAccessible: false,
    summary: 'Record a complete Agent-authored Case Flow revision without touching the device.',
    whenToUse: ['Agent-facing Facade only; never exposed as a separate Case Agent capability.'],
    requestSchema: operationSchema('recordCaseFlow', {
      caseFlow: { $ref: 'caseFlowInput' },
    }, ['operation', 'caseFlow']),
    examples: [example('record-case-flow', {
      operation: 'recordCaseFlow',
      caseFlow: {
        baseRevision: null, summary: '验证目标结果', entryNodeRef: 'N1',
        nodes: [
          { ref: 'N1', type: 'CHECK', text: '目标结果可见', sourceBasis: '原始用例预期', verificationKind: 'DIRECT_OBSERVATION', requirement: 'REQUIRED' },
          { ref: 'N2', type: 'END', text: '完成' },
        ],
        edges: [{ ref: 'L1', from: 'N1', to: 'N2' }], uncertainties: [],
      },
    })],
    responses: ['CASE_FLOW_RECORDED', 'REQUEST_INVALID', 'TECHNICAL'],
  }),
  recordExpectationResults: defineOperation({
    agentAccessible: false,
    summary: 'Record independent expectation results without observing or acting.',
    whenToUse: ['Agent-facing Facade only; Case Agent uses recordResult.'],
    requestSchema: operationSchema('recordExpectationResults', {
      results: { type: 'array', minItems: 1, items: { $ref: 'expectationResultInput' } },
    }, ['operation', 'results']),
    examples: [example('record-results', {
      operation: 'recordExpectationResults',
      results: [{ expectationRef: 'N1', status: 'PASS', actual: '目标结果可见', evidence: { sceneRefs: ['scene-0001'] } }],
    })],
    responses: ['RESULTS_RECORDED', 'REQUEST_INVALID', 'TECHNICAL'],
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
      decision: decision('恢复目标 App 后重新判断现场', ['N1']),
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
        decision: decision('保存最终结论', ['N1']), result: passingResult(),
      }),
      example('finish-with-knowledge-review', {
        operation: 'finish', basedOnSceneId: 'scene-0002',
        decision: {
          ...decision('完成知识复核并保存最终结论', ['N1']),
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
  requestCorrection,
};
