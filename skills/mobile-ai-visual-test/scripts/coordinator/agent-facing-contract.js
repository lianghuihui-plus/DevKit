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
  AGENT_INPUT_STALLED: { group: 'input-state', retryable: false, summary: '同类 Coordinator 输入错误连续发生，停止自动猜测。', recovery: '停止修改字段，读取当前方法页和响应 issues；保留 run 状态，需要时进行技术排障。' },
  COORDINATOR_INPUT_INVALID: { group: 'input-state', retryable: true, summary: 'Coordinator 请求字段不合法。', recovery: '根据 issues 修正当前方法请求；只重试一次，不添加方法签名之外的字段。' },
  COORDINATOR_STATE_INVALID: { group: 'input-state', retryable: false, summary: 'Coordinator run 状态缺失、损坏或绑定不一致。', recovery: '保留 run 文件和诊断事实，重新从 prepareRun 建立新 run；不要直接修改状态文件。' },
  DECISION_NOT_ALLOWED: { group: 'input-state', retryable: true, summary: '确认决策不适用于当前阶段。', recovery: '读取当前 reason、choices 和 required fields，选择该响应允许的 confirmRun 分支。' },
  ENVIRONMENT_NOT_READY: { group: 'environment', retryable: true, summary: '平台、设备或 App 探测未就绪。', recovery: '按 facts 中缺失的设备、App 或工具事实完成环境处置，再执行当前 commands.advance 重新探测。' },
  IOS_SIGNING_REQUIRED: { group: 'environment', retryable: true, summary: 'iOS 真机绑定缺少明确签名字段。', recovery: '补齐响应 requiredBindingFields 指定的签名字段，再使用 CONFIRM_BINDING 提交同一设备绑定。' },
  INPUT_CAPABILITY_NOT_READY: { group: 'environment', retryable: true, summary: '设备输入能力尚未准备完成。', recovery: '检查 facts 中的平台输入准备结果；恢复平台依赖后执行当前 commands.advance，Agent 不自行安装输入组件。' },
  PLATFORM_UNAVAILABLE: { group: 'environment', retryable: true, summary: '目标平台或设备当前不可用。', recovery: '根据 facts 核对设备连接、平台工具和资源所有权；恢复后创建新的 run 或执行当前允许的 advanceRun。' },
  BATCH_BLOCKED: { group: 'batch', retryable: false, summary: '批次存在不可自动恢复的终态阻塞。', recovery: '读取 facts 和 diagnostic 定位阻塞阶段；保留终态，只有外部条件确实修复后才创建新的 run。' },
  COORDINATOR_TECHNICAL: { group: 'batch', retryable: false, summary: '未归类的批次级技术异常。', recovery: '使用 diagnostic.stage、logRefs 和 resourceFacts 排障；恢复后从当前状态允许的 Facade 方法继续。' },
});

const TRANSPORTS = Object.freeze({
  prepareCommand: {
    summary: '执行协调 Agent 用于创建 Coordinator run 的直接 Facade 启动命令。',
    input: '只传 workspace 和用户选择的 caseNos。',
    rule: '从 Workspace 返回的绝对 coordinatorFacade.command 启动；参数名按 prepareRun 方法页和 Skill 入口构造。',
    success: '返回 NEED_USER_CONFIRMATION 或明确错误。',
    errors: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_TECHNICAL'],
  },
  coordinatorCommands: {
    summary: 'Coordinator 响应中的 confirm、advance 和 cancel 预绑定命令。',
    input: 'confirm/cancel 请求写入响应给出的 requestPath；advance 不附加输入。',
    rule: '命令由 Coordinator 生成，Agent 必须原样执行，不增删 --state 或其他参数。',
    success: '返回一个 Agent-facing Coordinator 状态。',
    errors: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'COORDINATOR_TECHNICAL'],
  },
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
    errorCodes: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'ENVIRONMENT_NOT_READY', 'PLATFORM_UNAVAILABLE', 'BATCH_BLOCKED', 'COORDINATOR_TECHNICAL'],
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
  transports: TRANSPORTS,
});

function documentationRefFor(code) {
  const documentedCode = PUBLIC_ERRORS[code] ? code : 'COORDINATOR_TECHNICAL';
  const normalized = documentedCode.replace(/_/g, '-').toLowerCase();
  const definition = PUBLIC_ERRORS[documentedCode];
  return `references/coordinator/errors/${definition.group}.md#error-${normalized}`;
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
