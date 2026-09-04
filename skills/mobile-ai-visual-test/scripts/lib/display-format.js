#!/usr/bin/env node
'use strict';

const { failureLabel } = require('./failure-catalog');

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
  PENDING_PUBLICATION: '待发布',
  FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复',
  NEEDS_RERUN: '需重新执行',
};

const EVENT_LABELS = {
  executionStart: '开始执行',
  environmentProbe: '环境探测',
  agentRuntime: 'Agent 会话',
  executionRecovery: '执行恢复',
  precondition: '前置条件',
  observation: '截图观察',
  evidenceCheck: '视觉证据复核',
  perception: '页面理解',
  decision: '执行决策',
  actionRejected: '动作契约拒绝',
  rule: '规则命中',
  flow: '前置条件 Flow',
  actionResult: '操作结果',
  assertion: '断言结果',
  popup: '弹窗处理',
  appForeground: '前台状态',
  budgetExceeded: '预算超限',
  timeLimitReached: '达到用例时限',
  result: '执行结果',
};

const DECISION_LABELS = {
  act: '执行操作',
  assert_pass: '断言通过',
  assert_fail: '断言失败',
  wait: '等待',
  blocked: '阻塞',
  retry_visual_input: '重试视觉输入',
};

const ACTION_LABELS = {
  launchApp: '启动应用',
  restartApp: '冷启动应用',
  tap: '点击',
  toggle: '切换开关',
  longPress: '长按',
  doubleTap: '双击',
  inputText: '输入文本',
  swipe: '滑动',
  back: '返回',
  home: '回到桌面',
  dismissKeyboard: '收起键盘',
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
    ['收起键盘', actions.dismissKeyboard],
    ['启动', actions.launchApp],
    ['冷启动', actions.restartApp],
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
  return failureLabel(value);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return value < 10000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')} 秒` : `${totalSeconds} 秒`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes} 分钟 ${seconds} 秒` : `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function formatDisplayTime(value) {
  if (!value) return '-';
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match && !(value instanceof Date)) return text;
  const parsed = value instanceof Date
    ? value
    : new Date(match[4] ? text.replace(' ', 'T') : `${match[1]}T${match[2]}${match[3] || ''}`);
  if (Number.isNaN(parsed.getTime())) return text;
  const pad = (part) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
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
