'use strict';

const LABELS = {
  context: { guest: '未登录', authenticated: '已登录' },
  platform: { HarmonyOS: '鸿蒙', harmonyos: '鸿蒙', harmony: '鸿蒙' },
  environment: { test: '测试环境', testing: '测试环境', development: '开发环境', dev: '开发环境', staging: '预发环境', pre: '预发环境', production: '生产环境', prod: '生产环境' },
  snapshotStatus: { READY: '可用', PARTIAL: '部分可用', VERSION_UNKNOWN: '版本未知', BLOCKED: '已阻塞', FAILED: '生成失败' },
  runStatus: { COMPLETED: '已完成', PARTIAL: '部分完成', BLOCKED: '已阻塞', FAILED: '执行失败' },
  scanMode: { exploration: '全局探索', 'goal-directed': '目标扫描' },
  scanScope: { full: '完整范围', targeted: '目标范围' },
  profile: { quick: '快速', standard: '标准', deep: '深度', goal: '目标' },
  kind: { 'full-screen': '普通页面', modal: '业务弹窗', mixed: '混合状态' },
  actionType: { tap: '点击', longPress: '长按', swipe: '滑动', inputText: '输入文本', keyEvent: '按键' },
  key: { BACK: '返回键', HOME: '主页键', ENTER: '确认键', ESCAPE: '退出键', VOLUME_UP: '音量加键', VOLUME_DOWN: '音量减键' },
  replayability: { STABLE: '稳定', CONDITIONAL: '有条件', UNSTABLE: '不稳定' },
  replayStatus: { UNVERIFIED: '未验证', COLD_REPLAY_VERIFIED: '冷启动已验证', REPLAY_UNSTABLE: '重放不稳定', NONREPEATABLE: '不可重放', INVALIDATED: '验证已失效' },
  risk: { SAFE: '安全', LOW: '低风险', MEDIUM: '中风险', HIGH: '高风险', LOW_RISK_FORM: '低风险表单', TEST_DATA_WRITE: '测试数据写入', PROHIBITED: '禁止', UNKNOWN: '未知' },
  sideEffect: { NONE: '无', LOCAL: '本地变更', NETWORK: '网络请求', TEST_DATA_WRITE: '测试数据写入', EXTERNAL: '外部影响', UNKNOWN: '未知' },
  replayPolicy: { REPEATABLE: '可重复', NONREPEATABLE: '不可重复', CONDITIONAL: '有条件', AS_RECORDED: '按记录重放', COORDINATE_ONLY: '仅坐标重放', SEMANTIC_VERIFIED: '语义已验证' },
  locatorQuality: { SEMANTIC_PORTABLE: '语义可移植', SEMANTIC_WITH_FALLBACK: '语义+证据兜底', DEVICE_BOUND: '设备绑定', UNRESOLVED: '未解析' },
  authDiffStatus: { READY: '可对比', PARTIAL: '数据不完整', VERSION_UNKNOWN: '版本未知' },
  issueType: {
    BACK_TARGET_CONFLICT: '返回目标冲突',
    EDGE_ENDPOINT_UNRESOLVED: '跳转端点无法解析',
    EDGE_TARGET_CONFLICT: '跳转目标冲突',
    LEGACY_NON_GRAPH_ACTION_DROPPED: '已移除历史非路径动作',
    LEGACY_REACHABILITY_PRUNED: '已裁剪历史不可达状态',
    PROBABLE_VISUAL_DUPLICATE: '可能存在重复视觉状态',
    UNVERIFIED_EDGE: '路径尚未验证',
    REPLAY_UNSTABLE: '路径重放不稳定',
    FRONTIER_UNRESOLVED: '探索待办未收敛',
    VERIFICATION_UNRESOLVED: '验证待办未收敛'
  },
  issueReason: { DEPENDENT_ON_NON_GRAPH_ACTION: '依赖非路径动作', UNREACHABLE_FROM_ROOT: '从根状态不可达' }
};

function label(category, value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback ?? '-';
  return LABELS[category]?.[String(value)] || fallback || String(value);
}

function actionLabel(action = {}) {
  const type = label('actionType', action.type, '操作');
  if (action.type === 'keyEvent') return `${type} · ${label('key', action.key, action.key || '-')}`;
  const target = action.target || action.text || action.selector?.text || action.selector?.accessibilityLabel || action.selector?.resourceId;
  return target ? `${type} · ${target}` : type;
}

function issueSummary(item = {}) {
  switch (item.type) {
    case 'BACK_TARGET_CONFLICT':
      return `可达状态 ${item.reachableStateId || '-'} 存在不一致的返回目标。`;
    case 'EDGE_ENDPOINT_UNRESOLVED':
      return `扫描记录 ${item.runId || '-'} 中的跳转 ${item.sourceEdgeId || '-'} 存在无法解析的起点或终点。`;
    case 'EDGE_TARGET_CONFLICT':
      return `同一来源和操作对应了不同目标，共涉及 ${(item.sources || []).length} 条来源记录。`;
    case 'LEGACY_NON_GRAPH_ACTION_DROPPED':
      return `历史扫描 ${item.sourceRunId || '-'} 中的 ${item.count || item.sourceEdgeIds?.length || 0} 条等待动作已从路径图移除。`;
    case 'LEGACY_REACHABILITY_PRUNED':
      return `历史扫描 ${item.sourceRunId || '-'} 已裁剪 ${item.droppedReachableStateIds?.length || 0} 个不可达状态和 ${item.droppedEdgeIds?.length || 0} 条跳转，原因：${label('issueReason', item.reasonCode, '历史图归一化')}。`;
    case 'PROBABLE_VISUAL_DUPLICATE':
      return `视觉状态 ${item.visualStateId || '-'} 与同组其他状态可能重复，需要人工检查。`;
    case 'UNVERIFIED_EDGE':
      return `跳转 ${item.edgeId || '-'} 已发现但尚未完成冷启动路径验证。`;
    case 'REPLAY_UNSTABLE':
      return `跳转 ${item.edgeId || '-'} 的冷启动重放不稳定，发现事实仍被保留。`;
    case 'FRONTIER_UNRESOLVED':
      return `探索待办 ${item.frontierId || '-'} 尚未收敛，状态为 ${item.status || '-'}。`;
    case 'VERIFICATION_UNRESOLVED':
      return `验证任务 ${item.verificationId || '-'} 尚未收敛，状态为 ${item.status || '-'}。`;
    default:
      return '存在未分类的聚合问题，请检查当前地图快照的原始数据。';
  }
}

function localizeIssue(item = {}) {
  return { ...item, typeLabel: label('issueType', item.type, '未分类问题'), contextLabel: label('context', item.contextId, '未指定'), summary: issueSummary(item) };
}

module.exports = { LABELS, label, actionLabel, issueSummary, localizeIssue };
