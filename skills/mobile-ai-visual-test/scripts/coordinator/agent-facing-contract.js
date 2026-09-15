'use strict';

const { validateAgentJson } = require('../lib/agent-json-contract');

const AGENT_FACING_INTERFACE_KIND = 'AGENT_FACING';
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

function capabilityCards() {
  return {
    prepareRun: {
      useWhen: '开始执行一个或一批已有用例',
      required: ['workspace', 'caseNos'],
      optional: [],
      source: { workspace: '用户指定的测试工作空间', caseNos: '用户指定的用例编号' },
      example: { capability: 'prepareRun', workspace: '/absolute/test-workspace', caseNos: ['014'] },
      returns: ['NEED_USER_CONFIRMATION'],
    },
    confirmRun: {
      useWhen: '当前响应要求选择平台或确认设备、App 和执行授权',
      required: ['当前 confirmChoices 所选 template 或 confirmTemplate 中预填的字段'],
      optional: ['iOS 发现多台设备时，按 deviceChoices[].template.deviceId 选择目标设备', 'iOS 真机未就绪时，补齐 requiredBindingFields 中的签名字段'],
      source: { request: '当前响应的 confirmChoices[].template 或 confirmTemplate' },
      example: { capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'harmony' },
      returns: ['NEED_USER_CONFIRMATION', 'IOS_SIGNING_REQUIRED', 'SELECT_DEVICE', 'CONFIRMED'],
    },
    advanceRun: {
      useWhen: '执行已准备好，或 Case Agent、等待步骤已经结束',
      required: [],
      optional: [],
      source: { request: '原样执行当前响应的 commands.advance' },
      example: { capability: 'advanceRun' },
      returns: ['NEED_USER_CONFIRMATION', 'NEED_CASE_AGENT', 'WAITING', 'TECHNICAL', 'COMPLETE', 'BLOCKED'],
    },
    cancelRun: {
      useWhen: '用户明确要求停止当前批次',
      required: ['reason'],
      optional: [],
      source: { reason: '用户的取消原因' },
      example: { capability: 'cancelRun', reason: '用户取消测试' },
      returns: ['COMPLETE', 'BLOCKED'],
    },
  };
}

module.exports = {
  AGENT_FACING_INTERFACE_KIND,
  COORDINATOR_CAPABILITIES,
  capabilityCards,
  validateCoordinatorRequest,
};
