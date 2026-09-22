'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');
const { AGENT_FACING_PROTOCOL, AGENT_FACING_STATUSES, RESOURCE_DESCRIPTOR_SCHEMA, requestEnvelopeSchema } = require('../lib/agent-facing-envelope');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
const COORDINATOR_CAPABILITIES = Object.freeze(['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun', 'read']);
const STRING = { type: 'string', minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const BINDING = object({
  platform: { enum: ['harmony', 'android', 'ios'] }, deviceId: STRING, appId: STRING, entry: STRING,
  deviceType: { enum: ['simulator', 'realDevice'] }, deviceFormFactor: STRING,
  xcodeOrgId: STRING, xcodeSigningId: STRING, updatedWDABundleId: STRING,
}, ['platform', 'deviceId', 'appId']);
const INPUT_SCHEMAS = Object.freeze({
  prepareRun: object({ caseNos: { type: 'array', minItems: 1, items: STRING } }),
  confirmRun: { oneOf: [
    object({ decision: { const: 'USE_CURRENT' }, userInstruction: STRING }),
    object({ decision: { const: 'SELECT_PLATFORM' }, platform: { enum: ['harmony', 'android', 'ios'] }, deviceId: STRING }, ['decision', 'platform']),
    object({ decision: { const: 'CONFIRM_BINDING' }, userInstruction: STRING, binding: BINDING }),
  ] },
  advanceRun: object({}), cancelRun: object({ reason: STRING }), read: object({ ref: STRING }),
});
const REQUEST_SCHEMA = requestEnvelopeSchema(INPUT_SCHEMAS);
const RESOURCE_CATALOG = Object.freeze({
  runDecision: { summary: '当前环境、设备或绑定决策的不可变完整投影。' },
  caseDispatch: { summary: '不可变 Handoff 绑定的独立 Case Agent 启动信息。' },
  runProgress: { summary: '当前等待对象与已持久化进度事实的不可变快照。' },
  runSummary: { summary: '首次终态与报告发布结果的不可变快照。' },
  coordinatorDiagnostic: { summary: '当前运行已持久化诊断事实。' },
});
function error(group, retryable, summary, recovery) {
  return { group, retryable, summary, recovery, resourceTypes: ['environment', 'batch'].includes(group) ? ['coordinatorDiagnostic'] : [] };
}
const PUBLIC_ERRORS = Object.freeze({
  AGENT_INPUT_STALLED: error('input-state', false, '同类 Coordinator 输入错误连续发生。', '读取方法页和 issues 后修正请求。'),
  COORDINATOR_INPUT_INVALID: error('input-state', true, 'Coordinator 请求字段不合法。', '根据 issues 与方法页修正当前请求。'),
  COORDINATOR_STATE_INVALID: error('input-state', false, 'Coordinator 绑定状态无效。', '保留诊断，重新创建 run。'),
  COORDINATOR_TERMINAL: error('input-state', false, 'Coordinator 已终止，不能再确认。', '使用 read 或 advanceRun 读取终态。'),
  DECISION_NOT_ALLOWED: error('input-state', true, '决策不适用于当前阶段。', '按当前 runDecision 选择确认分支。'),
  ENVIRONMENT_NOT_READY: error('environment', true, '设备环境尚未就绪。', '恢复环境后通过原 command 提交 advanceRun。'),
  IOS_SIGNING_REQUIRED: error('environment', true, 'iOS 真机缺少签名字段。', '补齐 requiredBindingFields 后提交 CONFIRM_BINDING。'),
  INPUT_CAPABILITY_NOT_READY: error('environment', true, '设备输入能力准备未完成。', '恢复环境后通过原 command 提交 advanceRun。'),
  PLATFORM_UNAVAILABLE: error('environment', true, '平台或设备不可用。', '根据诊断核对连接和工具。'),
  BATCH_BLOCKED: error('batch', false, '批次已阻塞。', '读取诊断并保留终态。'),
  COORDINATOR_TECHNICAL: error('batch', false, 'Coordinator 技术异常。', '读取诊断并恢复外部条件。'),
  RESOURCE_UNKNOWN: error('resources', false, '资源引用未发布。', '使用同一 Facade 已返回的完整 ref。'),
  RESOURCE_SCOPE_MISMATCH: error('resources', false, '资源不属于当前 run。', '使用返回该 ref 的绑定 command。'),
  RESOURCE_INTEGRITY_INVALID: error('resources', false, '资源权威产物完整性校验失败。', '保留原始文件与引用，排查数据损坏。'),
});
const base = ['outcome', 'phase', 'command'];
const projection = (resultFields, primaryResourceType, associatedResourceTypes = []) => ({ resultFields, primaryResourceType, associatedResourceTypes });
const decision = projection(base, 'runDecision', ['coordinatorDiagnostic']);
const confirmed = projection(base, null);
const waiting = projection([...base, 'waitFor', 'caseNo'], 'runProgress', ['coordinatorDiagnostic']);
const terminal = projection([...base, 'reportStatus'], 'runSummary', ['coordinatorDiagnostic']);
const PROJECTIONS = Object.freeze({
  prepareRun: { NEED_USER_CONFIRMATION: decision },
  confirmRun: { NEED_USER_CONFIRMATION: decision, CONFIRMED: confirmed },
  advanceRun: { NEED_USER_CONFIRMATION: decision, CONFIRMED: confirmed,
    NEED_CASE_AGENT: projection([...base, 'caseNo'], 'caseDispatch'), WAITING: waiting, COMPLETE: terminal, BLOCKED: terminal },
  cancelRun: { WAITING: waiting, COMPLETE: terminal, BLOCKED: terminal },
  read: projection(['outcome', 'resourceRef', 'resourceType'], '$resourceType', '$declaredResources'),
});
const examples = {
  prepareRun: { caseNos: ['014'] }, confirmRun: { decision: 'SELECT_PLATFORM', platform: 'harmony' },
  advanceRun: {}, cancelRun: { reason: '用户取消测试' }, read: { ref: 'mavt:0123456789abcdef01234567:runDecision:published-identity' },
};
const summaries = {
  prepareRun: '在绑定工作空间中创建一次 run。', confirmRun: '确认当前环境、选择平台设备或确认绑定。',
  advanceRun: '推进当前确定性状态机。', cancelRun: '按用户要求取消当前 run。', read: '完整读取当前 run 已发布的不可变资源。',
};
const PUBLIC_METHODS = Object.freeze(Object.fromEntries(COORDINATOR_CAPABILITIES.map((name) => [name, Object.freeze({
  name, summary: summaries[name], inputSchema: INPUT_SCHEMAS[name],
  requestSchema: requestEnvelopeSchema({ [name]: INPUT_SCHEMAS[name] }).oneOf[0],
  parameterDescriptions: { operation: `固定为 ${name}`, input: '当前操作的业务参数；绑定作用域由 command 提供。' },
  conditionalRequirements: name === 'confirmRun' ? ['三个 decision 分支不得混用字段。'] : [],
  contextualValidationRules: [], successStatuses: ['SUCCEEDED'], errorCodes: Object.keys(PUBLIC_ERRORS),
  sideEffects: name === 'read' ? [] : ['保存当前 run 的确定性进度'],
  idempotency: name === 'prepareRun' ? '创建新 run。' : name === 'read' ? '只读，不推进状态。' : 'advanceRun/cancelRun 终态复用原 runSummary；confirmRun 终态拒绝。',
  minimalExample: { operation: name, input: examples[name] }, responseProjection: name === 'read' ? PROJECTIONS[name] : { outcomes: PROJECTIONS[name] },
})])));
const TRANSPORTS = Object.freeze({
  prepareCommand: { summary: '绑定 workspace 的启动命令。', input: 'stdin 提交一次 {operation,input}；prepareRun.input 只包含 caseNos。', rule: '原样执行 Workspace 提供的 command。', success: 'SUCCEEDED', errors: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_TECHNICAL'] },
  coordinatorCommand: { summary: '绑定 run 的单一命令。', input: 'stdin 提交 confirmRun、advanceRun、cancelRun 或 read 请求。', rule: '所有后续操作原样复用 result.command。', success: 'SUCCEEDED', errors: ['COORDINATOR_INPUT_INVALID', 'COORDINATOR_STATE_INVALID', 'COORDINATOR_TECHNICAL'] },
});
const PUBLIC_CONTRACT = Object.freeze({ interfaceKind: AGENT_FACING_INTERFACE_KIND, protocol: AGENT_FACING_PROTOCOL,
  statuses: AGENT_FACING_STATUSES, resourceDescriptorSchema: RESOURCE_DESCRIPTOR_SCHEMA,
  requestSchema: REQUEST_SCHEMA, resourceCatalog: RESOURCE_CATALOG, methods: PUBLIC_METHODS, errors: PUBLIC_ERRORS, transports: TRANSPORTS });
function documentationRefFor(code) {
  const documentedCode = PUBLIC_ERRORS[code] ? code : 'COORDINATOR_TECHNICAL';
  return `references/coordinator/errors/${PUBLIC_ERRORS[documentedCode].group}.md#error-${documentedCode.replace(/_/g, '-').toLowerCase()}`;
}
function operationDocumentationRefFor(operation) {
  const slug = typeof operation === 'string' ? operation.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() : '';
  return PUBLIC_METHODS[operation] ? `references/coordinator/methods/${slug}.md` : 'references/coordinator.md';
}
function validateCoordinatorRequest(request) {
  const schema = PUBLIC_METHODS[request?.operation]?.requestSchema || REQUEST_SCHEMA;
  return validateAgentJson(request, schema).map((issue) => ({ field: issue.fieldPath || 'request',
    message: issue.code === 'REQUIRED' ? `必须提供 ${issue.fieldPath}` : `${issue.fieldPath || 'request'} 应为 ${issue.expected}`, code: issue.code }));
}
module.exports = { AGENT_FACING_INTERFACE_KIND, AGENT_FACING_PROTOCOL, COORDINATOR_CAPABILITIES, PUBLIC_CONTRACT,
  documentationRefFor, operationDocumentationRefFor, validateCoordinatorRequest };
