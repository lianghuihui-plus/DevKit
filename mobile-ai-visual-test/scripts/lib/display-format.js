#!/usr/bin/env node
'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function className(value) {
  return String(value || 'UNKNOWN').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

const STATUS_LABELS = {
  PASS: '通过',
  FAIL: '失败',
  BLOCKED: '阻塞',
  UNKNOWN: '未知',
  NOT_RUN: '未执行',
  PENDING: '待执行',
  PREPARED: '已准备',
};

const EVENT_LABELS = {
  executionStart: '开始执行',
  environmentProbe: '环境探测',
  precondition: '前置条件',
  observation: '截图观察',
  perception: '页面理解',
  decision: '执行决策',
  rule: '规则命中',
  flowScan: 'Flow 扫描',
  flow: '业务路径 Flow',
  actionResult: '操作结果',
  assertion: '断言结果',
  popup: '弹窗处理',
  appForeground: '前台状态',
  budgetExceeded: '预算超限',
  result: '执行结果',
};

const DECISION_LABELS = {
  act: '执行操作',
  assert_pass: '断言通过',
  assert_fail: '断言失败',
  wait: '等待',
  blocked: '阻塞',
};

const ACTION_LABELS = {
  launchApp: '启动应用',
  tap: '点击',
  toggle: '切换开关',
  longPress: '长按',
  inputText: '输入文本',
  swipe: '滑动',
  back: '返回',
  home: '回到桌面',
  wait: '等待',
};

const STEP_GOAL_LABELS = {
  launch_app: '启动应用',
  tap: '点击',
  toggle: '切换开关',
  long_press: '长按',
  input_text: '输入文本',
  swipe: '滑动',
  back: '返回',
  wait: '等待',
  unknown: '操作',
  action: '操作',
  assertion: '断言',
};

const PRECONDITION_MODE_LABELS = {
  auto_check: '自动检查',
  auto_prepare: '自动准备',
  manual_context: '上下文',
  unsupported: '不支持',
};

const FAILURE_CODE_LABELS = {
  ENV_UNCONFIRMED: '环境未确认',
  ENV_UNAVAILABLE: '环境不可用',
  ENV_AMBIGUOUS: '环境信息不明确',
  PLATFORM_UNIMPLEMENTED: '平台能力未实现',
  PRECONDITION_FAILED: '前置条件不满足',
  PRECONDITION_NOT_MET: '前置条件不满足',
  PRECONDITION_UNMET: '前置条件未满足',
  PRECONDITION_UNKNOWN: '前置条件无法确认',
  PRECONDITION_UNSUPPORTED: '前置条件不支持自动处理',
  ASSERTION_FAILED: '断言不通过',
  ASSERTION_UNKNOWN: '断言证据不足',
  ACTION_TARGET_NOT_FOUND: '未找到操作目标',
  PAGE_LOAD_BLOCKED: '页面加载受阻',
  FLOW_NOT_FOUND: '未找到可用业务路径',
  FLOW_STEP_UNMATCHED: '业务路径步骤不匹配',
  FLOW_ACTION_FAILED: '业务路径操作失败',
  FLOW_UNSAFE: '业务路径存在风险',
  FLOW_SCAN_REQUIRED: '需要先扫描业务路径',
  FLOW_SCAN_MISSING: '缺少业务路径扫描',
  FLOW_MATCH_UNRESOLVED: '命中的业务路径未处理',
  APP_CONTEXT_LOST: '应用上下文丢失',
  APP_LEFT_FOREGROUND: '应用离开前台',
  UNKNOWN_POPUP: '未知弹窗阻塞',
  CASE_TIMEOUT: '用例执行超时',
  EXECUTION_BUDGET_EXCEEDED: '执行预算超限',
  TOOL_ERROR: '工具执行异常',
};

function displayStatus(value) {
  return STATUS_LABELS[value] || value || '-';
}

function displayEventType(value) {
  return EVENT_LABELS[value] || value || '-';
}

function displayDecision(value) {
  return DECISION_LABELS[value] || value || '-';
}

function displayAction(value) {
  return ACTION_LABELS[value] || value || '-';
}

function formatActionSummary(actions) {
  if (!actions) return '-';
  const parts = [
    ['点击', actions.tap],
    ['开关', actions.toggle],
    ['长按', actions.longPress],
    ['输入', actions.inputText],
    ['滑动', actions.swipe],
    ['返回', actions.back],
    ['启动', actions.launchApp],
    ['等待', actions.wait],
  ]
    .filter(([, count]) => count)
    .map(([label, count]) => `${label} ${count}`);
  return `${actions.total || 0} 次${parts.length ? `（${parts.join('，')}）` : ''}`;
}

function displayStepGoal(value) {
  return STEP_GOAL_LABELS[value] || value || '-';
}

function displayPreconditionMode(value) {
  return PRECONDITION_MODE_LABELS[value] || value || '-';
}

function displayFailureCode(value) {
  return FAILURE_CODE_LABELS[value] || value || '';
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return value < 10000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDisplayTime(value) {
  if (!value) return '-';
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/);
  return match ? `${match[1]} ${match[2]}` : text;
}

function formatCell(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

module.exports = {
  className,
  displayAction,
  displayDecision,
  displayEventType,
  displayFailureCode,
  displayPreconditionMode,
  displayStatus,
  displayStepGoal,
  escapeHtml,
  formatActionSummary,
  formatCell,
  formatDisplayTime,
  formatDuration,
};
