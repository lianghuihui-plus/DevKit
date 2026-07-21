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
  rule: '规则命中',
  flow: '前置条件 Flow',
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
  retry_visual_input: '重试视觉输入',
};

const ACTION_LABELS = {
  launchApp: '启动应用',
  restartApp: '冷启动应用',
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
