'use strict';

const { ACTION_FIELDS, describeActionConstraints } = require('./action-contract');
const { BASIS_VALUES, DISPOSITIONS } = require('./understanding-contract');
const { FINDING_STATUSES, VERDICTS, VERDICT_BASES } = require('../execution/contracts/result-contract');
const { KNOWLEDGE_ASSESSMENTS } = require('../execution/contracts/execution-event-contract');
const { canonicalJson, sha256 } = require('./contract-utils');

function sorted(values) {
  return [...values].sort();
}

function commandTemplates() {
  return {
    status: 'node scripts/agent/status.js --exec-dir <execution>',
    understand: "node scripts/agent/understand.js --exec-dir <execution> --request-json '<json>'",
    inspect: "node scripts/agent/inspect.js --exec-dir <execution> [--request-json '<json>']",
    step: "node scripts/agent/step.js --exec-dir <execution> --request-json '<json>'",
    markStart: "node scripts/agent/mark-start.js --exec-dir <execution> [--request-json '<json>']",
    requestRecovery: "node scripts/agent/request-recovery.js --exec-dir <execution> --request-json '<json>'",
    investigate: "node scripts/agent/investigate.js --exec-dir <execution> --request-json '<json>'",
    conclude: "node scripts/agent/conclude.js --exec-dir <execution> --request-json '<json>'",
  };
}

function schemas(platform) {
  const actionConstraints = describeActionConstraints(platform, 'case-business');
  return {
    understand: {
      required: ['understanding', 'checkpoints'],
      optional: ['reason'],
      understandingRequired: ['summary', 'sourceRefs', 'startConditions', 'requirements'],
      understandingOptional: ['uncertainties', 'requirementDispositions'],
      sourceRefRequired: ['id', 'sourceSha', 'lineStart', 'lineEnd', 'quote'],
      statementRequired: ['id', 'text', 'basis', 'sourceRefs'],
      basis: sorted(BASIS_VALUES),
      dispositions: sorted(DISPOSITIONS),
      checkpointRequired: ['id', 'goal', 'requirementRefs'],
      checkpointOptional: ['requiredAction'],
      generated: ['schemaVersion', 'turnId', 'understanding.revision', 'plan.revision', 'plan.planSha'],
      revision: 'submit only changed understanding or checkpoints; framework increments revisions',
    },
    inspect: {
      optional: ['stage', 'startConditionRef', 'checkpointRef', 'intent', 'expectedOutcome', 'purpose'],
      stage: ['PREPARE', 'BUSINESS'],
      generated: ['operationId', 'authorization', 'observationRef', 'observationView'],
    },
    step: {
      required: ['intent', 'action'],
      optional: ['stage', 'checkpointRef', 'startConditionRef', 'expectedOutcome'],
      stage: ['PREPARE', 'BUSINESS'],
      behavior: 'executes one Agent-selected action and automatically captures the post-action observation',
      generated: ['stepId', 'operationId', 'authorization', 'basisObservationRef', 'postActionObservation'],
    },
    semanticAction: {
      actionTypes: actionConstraints.actionTypes,
      commonRequired: ['type'],
      targetModes: {
        element: ['targetRef'],
        visual: ['normalizedPoint', 'normalizedBounds'],
        swipe: ['normalizedFrom', 'normalizedTo', 'normalizedBounds'],
        rawFallback: Object.fromEntries(actionConstraints.actionTypes.map((type) => [type, ACTION_FIELDS[type]])),
      },
      normalizedCoordinateRange: '0..1 relative to the original screenshot; framework converts to executable pixels',
      elementRef: 'use a ref from the latest observationView.elements whenever available',
      inputText: {
        required: ['text'],
        optional: ['targetRef', 'target', 'mode'],
        modes: ['replace', 'append'],
        platform: platform === 'harmony' ? 'targetRef or coordinates focus and input the field' : 'focus with a prior tap step, then input without coordinates',
      },
      ...(platform === 'ios' ? {
        dismissKeyboard: {
          required: [], optional: [],
          useWhen: 'observationView reports a visible keyboard with KEYBOARD_COORDINATE_SPACE_MISMATCH',
        },
      } : {}),
    },
    observationView: {
      required: ['observationRef', 'scope', 'usable', 'screenshot', 'layout', 'signals', 'stateChanges', 'conflicts', 'elements'],
      screenshotRequired: ['ref', 'width', 'height'],
      layoutRequired: ['usable', 'format', 'diagnostics'],
      elementRequired: ['ref', 'text', 'role', 'bounds', 'clickable', 'checkable', 'editable', 'enabled', 'visible', 'focused', 'secure', 'maskedLength', 'stateKey'],
      signals: ['keyboard', 'focusedElement', 'layoutViewport', 'adapterWindowRect', 'coordinateConsistency'],
      note: 'elements and technical signals are a compact deterministic projection of the current layout; stateChanges/conflicts are framework-derived and are not business decisions',
    },
    markStart: {
      optional: ['reason'],
      precondition: 'latest usable PREPARE observation belongs to the current understanding and warm-session generation',
      effect: 'records explicit startEstablished evidence and enters business execution',
    },
    requestRecovery: {
      required: ['reason'],
      optional: ['triggerType', 'incidentCategory'],
      triggerTypes: ['SOURCE_REQUIRED_COLD_START', 'AGENT_DECIDED_RESTART', 'APP_CRASH', 'SYSTEM_KILLED', 'UNKNOWN_EXIT', 'APP_UNRESPONSIVE', 'AUTOMATION_SESSION_LOST'],
      generated: ['recoveryId', 'executionId', 'checkpointId', 'sourceRefs', 'evidenceRefs', 'incident fields'],
      effect: 'yields execution to the batch coordinator; Agent stops until recovery completes',
    },
    investigate: {
      queryMode: { required: ['query'], optional: ['reason'], generated: ['queryId', 'candidates'] },
      assessmentMode: {
        required: ['queryId', 'assessments', 'conclusion', 'reason'],
        assessmentRequired: ['entryId', 'assessment', 'reason'],
        assessments: sorted(KNOWLEDGE_ASSESSMENTS),
        conclusions: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'],
        generated: ['knowledgeRef', 'sourceNamespace', 'relativePath', 'contentSha', 'knowledgeReview'],
      },
    },
    conclude: {
      required: ['verdict', 'summary', 'findings'],
      optional: ['verdictBasis', 'technicalFailureCode', 'uncertainties', 'queryRefs', 'sourceRecheck', 'recoveryExplanation', 'recoveryEvidenceRefs', 'reason'],
      verdicts: sorted(VERDICTS),
      verdictBases: sorted(VERDICT_BASES),
      findingRequired: ['requirementRef', 'status', 'reason'],
      findingOptional: ['evidenceRefs', 'knowledgeRefs', 'incidentRefs', 'necessityReason'],
      findingStatuses: sorted(FINDING_STATUSES),
      coverage: 'exactly one finding for every current requirement',
      knowledgeRule: 'direct-evidence PASS may use no query; FAIL, INCONCLUSIVE, and business BLOCKED require a query-level knowledgeReview; zero matches close automatically',
      generated: ['checkpointFinding', 'verdictReview', 'result identity', 'metrics', 'agentResult'],
    },
    runtimeState: {
      required: ['phase', 'finalized', 'currentObservationRef', 'activeCheckpointRef', 'frameworkRecoveryPending', 'controlRequestPending', 'timeLimitReached', 'remainingMs', 'conclusionConstraint', 'signals'],
      conclusionConstraint: 'TIME_LIMIT_OBSERVATION_GAP exposes only INCONCLUSIVE after the required knowledge review; NORMAL keeps verdict-specific guards',
      recoveryRule: 'internal transaction recovery belongs to the coordinator; Agent only waits for controlRequestPending to clear',
      timingNote: 'agentOrchestrationGapMs is residual Agent/tool orchestration time, not pure model thinking time',
    },
  };
}

function examples() {
  return {
    understand: {
      understanding: {
        summary: '验证原文描述的目标状态',
        sourceRefs: [{ id: 'src-001', sourceSha: '<source-sha>', lineStart: 1, lineEnd: 1, quote: '<exact-source-line>' }],
        startConditions: [{ id: 'start-001', text: '可从当前现场建立目标起点', basis: 'implied', sourceRefs: ['src-001'] }],
        requirements: [{ id: 'req-001', text: '目标状态符合原文', basis: 'explicit', sourceRefs: ['src-001'] }],
        uncertainties: [],
      },
      checkpoints: [{ id: 'cp-001', goal: '观察并判断目标状态', requirementRefs: ['req-001'], requiredAction: false }],
      reason: '根据冻结原文建立初始检查点',
    },
    inspect: { stage: 'PREPARE', intent: '观察当前现场并判断起点是否满足' },
    markStart: { reason: '当前页面满足原文明示的执行起点' },
    requestRecovery: { reason: '目标 App 已意外退出，继续执行前需要受控恢复', triggerType: 'UNKNOWN_EXIT' },
    requestSourceColdStart: { reason: '冻结原文明示本用例必须从冷启动状态开始', triggerType: 'SOURCE_REQUIRED_COLD_START' },
    elementStep: {
      stage: 'BUSINESS', checkpointRef: 'cp-001', intent: '打开目标入口', expectedOutcome: '展示目标页面',
      action: { type: 'tap', targetRef: '<element-ref-from-latest-observation>' },
    },
    visualSwipeStep: {
      stage: 'BUSINESS', checkpointRef: 'cp-001', intent: '横向查看后续内容',
      action: { type: 'swipe', normalizedFrom: [0.85, 0.5], normalizedTo: [0.2, 0.5], normalizedBounds: [0.05, 0.3, 0.95, 0.7], velocity: 800 },
    },
    investigate: { query: { platform: 'harmony', page: '目标页面', symptom: '当前现场与预期不一致', keywords: ['目标状态'] } },
    assessKnowledge: {
      queryId: '<query-id>', conclusion: 'NO_APPLICABLE', reason: '候选与当前平台或页面状态不一致',
      assessments: [{ entryId: '<candidate-entry-id>', assessment: 'NOT_APPLICABLE', reason: '适用范围与当前现场不一致' }],
    },
    concludePass: {
      verdict: 'PASS', summary: '当前直接证据满足原文要求',
      findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态' }],
      uncertainties: [],
    },
  };
}

function buildCaseAgentRuntimeContract(options = {}) {
  const value = {
    schemaVersion: 1,
    role: 'case-executor',
    platform: options.platform,
    protocolSha: options.protocolSha,
    implementationSha: options.implementationSha,
    commands: commandTemplates(),
    schemas: schemas(options.platform),
    examples: examples(),
    behavior: {
      responsibility: 'Agent decides business intent, path, assertions, knowledge applicability, and verdict; framework derives protocol bookkeeping',
      initialTurn: 'understand once before device work; revise only for material understanding or checkpoint changes',
      executionLoop: 'consume observationView, submit one semantic step, then consume its automatic post-action observation; checkpointRef inherits the active checkpoint unless explicitly switched',
      start: 'mark-start explicitly confirms the usable start observation before BUSINESS steps',
      state: 'normal successful responses carry runtimeState; status is only for reconnect or uncertain transport',
      planRevision: 'ordinary actions and progress do not create plan revisions',
      knowledge: 'query only when the current scene needs investigation or the intended verdict requires it',
      finalize: 'conclude generates checkpoint facts, verdictReview, result, metrics, and AgentResult atomically',
      noNextWork: true,
    },
  };
  return { ...value, contractSha: sha256(canonicalJson(value), 'case-agent-runtime-contract', 24) };
}

module.exports = {
  buildCaseAgentRuntimeContract,
  commandTemplates,
  examples,
  schemas,
};
