'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
const AGENT_FACING_PROTOCOL = 'agent-facing';
const COORDINATOR_CAPABILITIES = Object.freeze([
  'prepareRun',
  'confirmRun',
  'advanceRun',
  'cancelRun',
]);

const STRING = { type: 'string', minLength: 1 };

function object(properties, required) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const BINDING = {
  type: 'object',
  additionalProperties: true,
  required: ['platform', 'deviceId', 'appId'],
  properties: {
    platform: { enum: ['harmony', 'android', 'ios'] },
    deviceId: STRING,
    appId: STRING,
    entry: STRING,
    deviceType: { enum: ['simulator', 'realDevice'] },
    deviceFormFactor: STRING,
    xcodeOrgId: STRING,
    xcodeSigningId: STRING,
    updatedWDABundleId: STRING,
  },
};

const SCHEMAS = Object.freeze({
  prepareRun: object({
    capability: { const: 'prepareRun' },
    workspace: STRING,
    caseNos: { type: 'array', minItems: 1, items: STRING },
  }, ['capability', 'workspace', 'caseNos']),
  confirmRun: {
    oneOf: [
      object({
        capability: { const: 'confirmRun' }, decision: { const: 'USE_CURRENT' }, userInstruction: STRING,
      }, ['capability', 'decision', 'userInstruction']),
      object({
        capability: { const: 'confirmRun' }, decision: { const: 'SELECT_PLATFORM' },
        platform: { enum: ['harmony', 'android', 'ios'] }, deviceId: STRING,
      }, ['capability', 'decision', 'platform']),
      object({
        capability: { const: 'confirmRun' }, decision: { const: 'CONFIRM_BINDING' }, userInstruction: STRING, binding: BINDING,
      }, ['capability', 'decision', 'userInstruction', 'binding']),
    ],
  },
  advanceRun: object({ capability: { const: 'advanceRun' } }, ['capability']),
  cancelRun: object({ capability: { const: 'cancelRun' }, reason: STRING }, ['capability', 'reason']),
});

const PUBLIC_ERRORS = Object.freeze({
  COORDINATOR_INPUT_INVALID: { retryable: true, summary: 'Coordinator 请求字段不合法。' },
  COORDINATOR_STATE_INVALID: { retryable: false, summary: 'Coordinator run 状态缺失、损坏或绑定不一致。' },
  DECISION_NOT_ALLOWED: { retryable: true, summary: '确认决策不适用于当前阶段。' },
  ENVIRONMENT_NOT_READY: { retryable: true, summary: '平台、设备或 App 探测未就绪。' },
  IOS_SIGNING_REQUIRED: { retryable: true, summary: 'iOS 真机绑定缺少明确签名字段。' },
  INPUT_CAPABILITY_NOT_READY: { retryable: true, summary: '设备输入能力尚未准备完成。' },
  BATCH_BLOCKED: { retryable: false, summary: '批次存在不可自动恢复的终态阻塞。' },
  COORDINATOR_TECHNICAL: { retryable: false, summary: '未归类的批次级技术异常。' },
});

function method(name, summary, requestSchema, parameterDescriptions, options = {}) {
  return Object.freeze({
    name, summary, requestSchema, parameterDescriptions,
    conditionalRequirements: options.conditionalRequirements || [],
    contextualValidationRules: options.contextualValidationRules || [],
    successStatuses: options.successStatuses || [],
    errorCodes: options.errorCodes || ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'COORDINATOR_TECHNICAL'],
    sideEffects: options.sideEffects || [],
    idempotency: options.idempotency || 'Read-only.',
    minimalExample: options.minimalExample,
  });
}

const PUBLIC_METHODS = Object.freeze({
  prepareRun: method('prepareRun', '为指定工作空间和用例创建一次 Coordinator run。', SCHEMAS.prepareRun, {
    capability: '固定为 prepareRun', workspace: '测试工作空间绝对路径', caseNos: '按用户顺序给出的用例编号',
  }, {
    successStatuses: ['NEED_USER_CONFIRMATION'], sideEffects: ['创建 Coordinator run 状态'],
    idempotency: '不保证自动复用相同输入的旧 run。',
    minimalExample: { capability: 'prepareRun', workspace: '/absolute/test-workspace', caseNos: ['014'] },
  }),
  confirmRun: method('confirmRun', '选择当前环境、平台设备或确认完整目标绑定。', SCHEMAS.confirmRun, {
    capability: '固定为 confirmRun', decision: '互斥确认分支', userInstruction: '用户确认原文',
    platform: '目标平台', deviceId: '响应要求时选择的设备', binding: '由探测事实形成的目标绑定',
  }, {
    conditionalRequirements: ['USE_CURRENT、SELECT_PLATFORM、CONFIRM_BINDING 三个分支字段不得混用。'],
    contextualValidationRules: ['binding 必须来自当前探测事实。'],
    successStatuses: ['NEED_USER_CONFIRMATION', 'CONFIRMED'],
    errorCodes: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'DECISION_NOT_ALLOWED', 'ENVIRONMENT_NOT_READY', 'IOS_SIGNING_REQUIRED', 'INPUT_CAPABILITY_NOT_READY', 'COORDINATOR_TECHNICAL'],
    sideEffects: ['保存用户确认并准备 execution'], idempotency: '由 Coordinator 状态机拒绝阶段外重复确认。',
    minimalExample: { capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'harmony' },
  }),
  advanceRun: method('advanceRun', '推进或恢复当前 run 的确定性状态机。', SCHEMAS.advanceRun, {
    capability: '固定为 advanceRun',
  }, {
    successStatuses: ['NEED_USER_CONFIRMATION', 'NEED_CASE_AGENT', 'WAITING', 'TECHNICAL', 'COMPLETE', 'BLOCKED'],
    errorCodes: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'ENVIRONMENT_NOT_READY', 'BATCH_BLOCKED', 'COORDINATOR_TECHNICAL'],
    sideEffects: ['推进当前 run'], idempotency: '持久化状态机恢复同一阶段；长进程不得重复启动。',
    minimalExample: { capability: 'advanceRun' },
  }),
  cancelRun: method('cancelRun', '仅在用户明确取消时停止当前 run。', SCHEMAS.cancelRun, {
    capability: '固定为 cancelRun', reason: '用户取消原因',
  }, {
    contextualValidationRules: ['取消不覆盖已持久化 execution 结果。'],
    successStatuses: ['COMPLETE', 'BLOCKED'], sideEffects: ['取消仍可取消的工作'],
    idempotency: '已终止 run 返回当前终态。', minimalExample: { capability: 'cancelRun', reason: '用户取消测试' },
  }),
});

const PUBLIC_CONTRACT = Object.freeze({
  interfaceKind: AGENT_FACING_INTERFACE_KIND,
  protocol: AGENT_FACING_PROTOCOL,
  methods: PUBLIC_METHODS,
  errors: PUBLIC_ERRORS,
});

function documentationRefFor(code) {
  const normalized = String(code || 'COORDINATOR_TECHNICAL').replace(/_/g, '-').toLowerCase();
  return `references/coordinator/errors.md#error-${normalized}`;
}

function validateCoordinatorRequest(request) {
  const schema = SCHEMAS[request?.capability]
    || object({ capability: { enum: COORDINATOR_CAPABILITIES } }, ['capability']);
  return validateAgentJson(request, schema).map((issue) => ({
    field: issue.fieldPath || 'request',
    message: issue.code === 'REQUIRED'
      ? `必须提供 ${issue.fieldPath}`
      : `${issue.fieldPath || 'request'} 应为 ${issue.expected}`,
    code: issue.code,
  }));
}

module.exports = {
  AGENT_FACING_INTERFACE_KIND,
  AGENT_FACING_PROTOCOL,
  COORDINATOR_CAPABILITIES,
  PUBLIC_CONTRACT,
  documentationRefFor,
  validateCoordinatorRequest,
};
