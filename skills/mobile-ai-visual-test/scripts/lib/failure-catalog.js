#!/usr/bin/env node
'use strict';

const FAILURE_CATALOG = Object.freeze({
  ASSERTION_FAILED: { status: 'FAIL', label: '断言不通过' },
  ASSERTION_UNKNOWN: { status: 'FAIL', label: '断言证据不足' },
  ASSERTION_EVIDENCE_REQUIRED: { status: 'BLOCKED', label: '断言缺少观察证据' },
  STEP_ORDER_VIOLATION: { status: 'BLOCKED', label: '步骤顺序违规' },
  PRECONDITION_REQUIRED: { status: 'BLOCKED', label: '需要先处理前置条件' },
  PRECONDITION_FAILED: { status: 'BLOCKED', label: '前置条件不满足' },
  PRECONDITION_NOT_MET: { status: 'BLOCKED', label: '前置条件不满足' },
  PRECONDITION_UNMET: { status: 'BLOCKED', label: '前置条件未满足' },
  PRECONDITION_UNKNOWN: { status: 'BLOCKED', label: '前置条件无法确认' },
  PRECONDITION_UNSUPPORTED: { status: 'BLOCKED', label: '前置条件不支持自动处理' },
  PRECONDITION_FLOW_AMBIGUOUS: { status: 'BLOCKED', label: '前置条件 Flow 名称冲突' },
  PRECONDITION_FLOW_INVALID: { status: 'BLOCKED', label: '前置条件 Flow 配置无效' },
  PRECONDITION_FLOW_CHANGED: { status: 'BLOCKED', label: '前置条件 Flow 已变更' },
  PRECONDITION_FLOW_START_MISMATCH: { status: 'BLOCKED', label: '当前页面不符合 Flow 起点' },
  PRECONDITION_FLOW_OBSERVATION_FAILED: { status: 'BLOCKED', label: '前置条件 Flow 观察失败' },
  PRECONDITION_FLOW_ACTION_MISMATCH: { status: 'BLOCKED', label: '前置条件 Flow 动作不匹配' },
  PRECONDITION_FLOW_ACTION_FAILED: { status: 'BLOCKED', label: '前置条件 Flow 操作失败' },
  PRECONDITION_FLOW_TARGET_NOT_REACHED: { status: 'BLOCKED', label: '前置条件 Flow 未到达终点' },
  PRECONDITION_FLOW_UNSAFE: { status: 'BLOCKED', label: '前置条件 Flow 存在风险' },
  PRECONDITION_FLOW_BUDGET_EXCEEDED: { status: 'BLOCKED', label: '前置条件 Flow 超出预算' },
  ENV_UNCONFIRMED: { status: 'BLOCKED', label: '环境未确认' },
  ENVIRONMENT_BINDING_MISMATCH: { status: 'BLOCKED', label: '正式环境绑定不一致' },
  ENV_UNAVAILABLE: { status: 'BLOCKED', label: '环境不可用' },
  ENV_AMBIGUOUS: { status: 'BLOCKED', label: '环境信息不明确' },
  PLATFORM_UNIMPLEMENTED: { status: 'BLOCKED', label: '平台能力未实现' },
  TOOL_ERROR: { status: 'BLOCKED', label: '工具执行异常' },
  ACTION_RESULT_SOURCE_REQUIRED: { status: 'BLOCKED', label: '动作结果来源无效' },
  OBSERVATION_SOURCE_REQUIRED: { status: 'BLOCKED', label: '观察结果来源无效' },
  EVENT_SOURCE_REQUIRED: { status: 'BLOCKED', label: '框架事件来源无效' },
  OBSERVATION_ARTIFACT_INVALID: { status: 'BLOCKED', label: '截图产物无效' },
  OBSERVATION_ARTIFACT_CHANGED: { status: 'BLOCKED', label: '截图产物已变化' },
  VISUAL_INPUT_UNVERIFIABLE: { status: 'BLOCKED', label: '视觉输入无法可靠验证' },
  CASE_RESTART_FAILED: { status: 'BLOCKED', label: '用例冷启动失败' },
  CASE_TIMEOUT: { status: 'BLOCKED', label: '用例执行超时' },
  EXECUTION_BUDGET_EXCEEDED: { status: 'BLOCKED', label: '执行预算超限' },
  APP_CONTEXT_LOST: { status: 'BLOCKED', label: '应用上下文丢失' },
  APP_LEFT_FOREGROUND: { status: 'BLOCKED', label: '应用离开前台' },
  UNKNOWN_POPUP: { status: 'BLOCKED', label: '未知弹窗阻塞' },
  CASE_CONTRACT_INVALID: { status: 'BLOCKED', label: '用例执行契约无效' },
  CASE_STEPS_REQUIRED: { status: 'BLOCKED', label: '用例缺少测试步骤' },
  EXECUTION_RECOVERY_CONTRACT_CHANGED: { status: 'BLOCKED', label: '半提交恢复契约已变化' },
  ACTION_TARGET_NOT_FOUND: { status: 'CONTEXTUAL', label: '未找到操作目标' },
  PAGE_LOAD_BLOCKED: { status: 'CONTEXTUAL', label: '页面加载受阻' },
});

function failureStatus(code, fallbackStatus) {
  const configured = FAILURE_CATALOG[code]?.status;
  if (!configured || configured === 'CONTEXTUAL') {
    return configured === 'CONTEXTUAL' && fallbackStatus === 'BLOCKED' ? 'BLOCKED' : configured === 'CONTEXTUAL' ? 'FAIL' : fallbackStatus;
  }
  return configured;
}

function failureLabel(code) {
  return FAILURE_CATALOG[code]?.label || code || '';
}

module.exports = { FAILURE_CATALOG, failureLabel, failureStatus };
