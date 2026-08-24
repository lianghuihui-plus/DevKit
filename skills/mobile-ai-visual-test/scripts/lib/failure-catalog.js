#!/usr/bin/env node
'use strict';

const { HISTORICAL_FAILURE_CATALOG } = require('./historical-failure-catalog');

const FAILURE_CATALOG = Object.freeze({
  ACTION_CONTRACT_INVALID: { status: 'BLOCKED', label: '动作参数不符合执行契约' },
  ACTION_EFFECT_MISMATCH: { status: 'BLOCKED', label: '动作执行结果与请求不一致' },
  CASE_TIME_LIMIT_REACHED: { status: 'BLOCKED', label: '已达到单用例时限' },
  DEVICE_OBSERVATION_OUTCOME_UNAVAILABLE: { status: 'BLOCKED', label: '观察事务无法在时限后恢复' },
  CURRENT_OBSERVATION_REQUIRED: { status: 'BLOCKED', label: '缺少最新现场证据' },
  BATCH_RECOVERY_COMMIT_INCOMPLETE: { status: 'BLOCKED', label: '应用恢复事务未完整提交' },
  KNOWLEDGE_SNAPSHOT_MISSING: { status: 'BLOCKED', label: '知识快照缺失' },
  KNOWLEDGE_SNAPSHOT_CHANGED: { status: 'BLOCKED', label: '知识快照已变化' },
  KNOWLEDGE_SNAPSHOT_INVALID: { status: 'BLOCKED', label: '知识快照无效' },
  WARM_SESSION_PROBE_FAILED: { status: 'BLOCKED', label: '暖会话探测失败' },
  WARM_SESSION_BINDING_MISMATCH: { status: 'BLOCKED', label: '暖会话设备绑定不一致' },
  ENV_UNCONFIRMED: { status: 'BLOCKED', label: '环境未确认' },
  ENVIRONMENT_BINDING_MISMATCH: { status: 'BLOCKED', label: '正式环境绑定不一致' },
  ENVIRONMENT_OPTION_OWNERSHIP: { status: 'BLOCKED', label: '环境参数不属于当前平台' },
  EXECUTION_ENVIRONMENT_UNBOUND: { status: 'BLOCKED', label: '执行环境未冻结绑定' },
  EXECUTION_ENVIRONMENT_CHANGED: { status: 'BLOCKED', label: '执行环境冻结内容已变化' },
  ACTIVE_EXECUTION_ENVIRONMENT_LOCKED: { status: 'BLOCKED', label: '运行中用例的环境不可修改' },
  PROBE_DEVICE_NOT_FOUND: { status: 'BLOCKED', label: '确认设备不在探测结果中' },
  PRECONDITION_INPUT_INVALID: { status: 'BLOCKED', label: '前置条件输入无效' },
  PRECONDITION_INPUT_CHANGED: { status: 'BLOCKED', label: '前置条件输入已变化' },
  ENV_UNAVAILABLE: { status: 'BLOCKED', label: '环境不可用' },
  ENV_AMBIGUOUS: { status: 'BLOCKED', label: '环境信息不明确' },
  PLATFORM_UNIMPLEMENTED: { status: 'BLOCKED', label: '平台能力未实现' },
  AGENT_PROTOCOL_MISMATCH: { status: 'BLOCKED', label: 'Agent 执行协议不一致' },
  AGENT_RUNTIME_UNAVAILABLE: { status: 'BLOCKED', label: 'Agent Runtime 不可用' },
  AGENT_RUNTIME_INTERRUPTED: { status: 'BLOCKED', label: 'Agent 会话异常中断' },
  AGENT_RUNTIME_RELEASE_FAILED: { status: 'BLOCKED', label: 'Agent 会话释放失败' },
  AGENT_RESULT_INVALID: { status: 'BLOCKED', label: 'Agent 返回结果无效' },
  TOOL_ERROR: { status: 'BLOCKED', label: '工具执行异常' },
  ACTION_RESULT_SOURCE_REQUIRED: { status: 'BLOCKED', label: '动作结果来源无效' },
  OBSERVATION_SOURCE_REQUIRED: { status: 'BLOCKED', label: '观察结果来源无效' },
  EVENT_SOURCE_REQUIRED: { status: 'BLOCKED', label: '框架事件来源无效' },
  OBSERVATION_ARTIFACT_INVALID: { status: 'BLOCKED', label: '截图产物无效' },
  OBSERVATION_ARTIFACT_CHANGED: { status: 'BLOCKED', label: '截图产物已变化' },
  VISUAL_INPUT_UNVERIFIABLE: { status: 'BLOCKED', label: '视觉输入无法可靠验证' },
  APP_CONTEXT_LOST: { status: 'BLOCKED', label: '应用上下文丢失' },
  APP_LEFT_FOREGROUND: { status: 'BLOCKED', label: '应用离开前台' },
  UNKNOWN_POPUP: { status: 'BLOCKED', label: '未知弹窗阻塞' },
  CASE_CONTRACT_INVALID: { status: 'BLOCKED', label: '用例执行契约无效' },
  EXECUTION_COMPLETION_INVALID: { status: 'BLOCKED', label: '完成态产物校验失败' },
  EXECUTION_ORPHANED: { status: 'BLOCKED', label: '遗留执行已确定性收尾' },
  ACTION_TARGET_NOT_FOUND: { status: 'CONTEXTUAL', label: '未找到操作目标' },
  PAGE_LOAD_BLOCKED: { status: 'CONTEXTUAL', label: '页面加载受阻' },
});

function failureStatus(code, fallbackStatus) {
  const configured = (FAILURE_CATALOG[code] || HISTORICAL_FAILURE_CATALOG[code])?.status;
  if (!configured) return fallbackStatus;
  if (configured === 'CONTEXTUAL') return ['FAIL', 'BLOCKED', 'UNKNOWN'].includes(fallbackStatus) ? fallbackStatus : 'FAIL';
  return configured;
}

function failureLabel(code) {
  return FAILURE_CATALOG[code]?.label || HISTORICAL_FAILURE_CATALOG[code]?.label || code || '';
}

module.exports = { FAILURE_CATALOG, failureLabel, failureStatus };
